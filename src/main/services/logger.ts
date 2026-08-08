/**
 * Core logger for the Doujin Downloader app.
 *
 * Design (§1):
 * - Levels: error, warn, info, debug. Configurable, default 'info'.
 * - Records are NDJSON, one object per line.
 * - Scoped child loggers: `logger.scope('downloads')`.
 * - In-memory ring buffer of the last ~2000 records, shared across all scopes.
 * - Single writer — only the main process opens the file. Workers forward
 *   records over postMessage.
 * - Rotation at 5 MB, keep 5 files, retention in days (default 14).
 * - Redaction on the way in: field names and registered secret values.
 * - `newErrorId()` returns Crockford base32 identifiers.
 *
 * Writes are synchronous (appendFileSync). In a single-process Electron main
 * thread there is no concurrent writer, and the records are small enough that
 * the blocking time is negligible. Synchronous writes also mean the file is
 * immediately readable by tests and the ring buffer is always in sync.
 */

import {
  appendFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync
} from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

// ─── Types ───────────────────────────────────────────────────────────────────

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

export interface LogRecord {
  ts: string
  level: LogLevel
  scope: string
  msg: string
  errorId?: string
  jobId?: string
  err?: { name: string; message: string; stack?: string }
  [key: string]: unknown
}

export interface LoggerConfig {
  logDir: string
  level: LogLevel
  maxFileSize: number
  maxFiles: number
  retentionDays: number
  ringBufferSize: number
}

const DEFAULT_CONFIG: Omit<LoggerConfig, 'logDir'> = {
  level: 'info',
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  maxFiles: 5,
  retentionDays: 14,
  ringBufferSize: 2000
}

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  scope(name: string): Logger
  getRingBuffer(): LogRecord[]
  setLevel(level: LogLevel): void
  getConfig(): Readonly<LoggerConfig>
  /** Register a secret value that should be redacted from log output. */
  registerSecret(value: string): void
  /** Directly write a pre-built record (used for worker forwarding). */
  writeRecord(record: LogRecord): void
  /** Set the jobId that will be stamped on every record from this logger. */
  setJobId(jobId: string): void
}

// ─── Crockford Base32 ────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Generate a unique error identifier.
 *
 * Format: `E-` + 8 Crockford base32 characters (derived from 8 bytes of
 * cryptographic randomness — enough for ~1 billion IDs before the collision
 * probability reaches 1 %).
 */
export function newErrorId(): string {
  const buf = randomBytes(8)
  let bits = 0
  let bitsRemaining = 0
  const chars: string[] = []

  for (const byte of buf) {
    bits = (bits << 8) | byte
    bitsRemaining += 8
    while (bitsRemaining >= 5 && chars.length < 8) {
      bitsRemaining -= 5
      chars.push(CROCKFORD[(bits >> bitsRemaining) & 0x1f])
    }
  }
  while (chars.length < 8) {
    chars.push(CROCKFORD[bits & 0x1f])
    bits >>= 5
  }
  return `E-${chars.join('')}`
}

// ─── Redaction ───────────────────────────────────────────────────────────────

/** Field names whose values are always redacted. */
const SENSITIVE_FIELDS = new Set([
  'apikey',
  'api_key',
  'key',
  'token',
  'authorization',
  'cookie',
  'password',
  'nhentai_api_key',
  'kavitaapikey',
  'kavita_api_key'
])

const REDACTED = '[REDACTED]'

/**
 * Remove every occurrence of a registered secret from a string.
 *
 * Substring replacement, not equality. Exact-match redaction only catches a
 * secret that is the *whole* value of a field, which is the case that was never
 * the risk. Keys leak embedded in other text: a request URL with the key as a
 * query parameter, or the message of an HTTP error built from that URL. Those
 * were reaching the log file verbatim.
 */
function scrubSecrets(text: string, secrets: Set<string>): string {
  if (secrets.size === 0) return text
  let out = text
  for (const secret of secrets) {
    // Short values would match far too much ordinary text; a real key is long.
    if (secret.length < 8) continue
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Deep-redact sensitive data from a value recursively.
 *
 * - Keys matching `SENSITIVE_FIELDS` are replaced with `[REDACTED]`.
 * - Registered secrets are scrubbed out of any string, including substrings.
 * - Objects are recursed into; arrays are mapped.
 */
function redactValue(value: unknown, secrets: Set<string>, depth = 0): unknown {
  if (depth > 10) return value
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    return scrubSecrets(value, secrets)
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, secrets, depth + 1))
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
        out[k] = REDACTED
      } else {
        out[k] = redactValue(v, secrets, depth + 1)
      }
    }
    return out
  }

  return value
}

// ─── Shared State ────────────────────────────────────────────────────────────

/**
 * Mutable state shared by the root logger and all its scoped children.
 *
 * Using a single heap object means every scope sees the same ring buffer,
 * config, and redaction secrets without any coordination overhead.
 */
interface SharedState {
  config: LoggerConfig
  ringBuffer: LogRecord[]
  ringIndex: number
  secrets: Set<string>
  currentLogPath: string
  jobId: string | null
}

// ─── Logger Implementation ───────────────────────────────────────────────────

class LoggerImpl implements Logger {
  private state: SharedState
  private scopeName: string

  constructor(state: SharedState, scopeName: string) {
    this.state = state
    this.scopeName = scopeName
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields)
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields)
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields)
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields)
  }

  scope(name: string): Logger {
    const childScope = this.scopeName === 'app' ? name : `${this.scopeName}:${name}`
    return new LoggerImpl(this.state, childScope)
  }

  getRingBuffer(): LogRecord[] {
    const { ringBuffer, ringIndex } = this.state
    const result: LogRecord[] = []
    for (let i = 0; i < ringBuffer.length; i++) {
      const idx = (ringIndex + i) % ringBuffer.length
      if (ringBuffer[idx] !== undefined) {
        result.push(ringBuffer[idx])
      }
    }
    return result
  }

  setLevel(level: LogLevel): void {
    this.state.config.level = level
  }

  getConfig(): Readonly<LoggerConfig> {
    return this.state.config
  }

  registerSecret(value: string): void {
    if (value && value.length > 0) {
      this.state.secrets.add(value)
    }
  }

  setJobId(jobId: string): void {
    this.state.jobId = jobId
  }

  /**
   * Write a record built somewhere else — in practice, forwarded from a worker
   * thread.
   *
   * This is a trust boundary, so it does the work `emit()` does rather than
   * taking the record at face value. Workers hold the API key (sync passes it
   * to the client, the download workers fetch with it), so a forwarded message
   * is exactly the kind that can carry a credential, and a worker cannot scrub
   * it — the secret set lives in this process. Level filtering belongs here for
   * the same reason: a worker doesn't know the user's configured level, so
   * without this check its debug output would bypass the setting.
   *
   * Structural fields are validated because a malformed `level` or a
   * non-string `ts` would otherwise reach the file and the log viewer.
   */
  writeRecord(record: LogRecord): void {
    const level: LogLevel =
      typeof record.level === 'string' && record.level in LEVEL_PRIORITY
        ? (record.level as LogLevel)
        : 'info'

    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.state.config.level]) return

    const secrets = this.state.secrets
    const { ts, scope, msg, ...rest } = record

    const safe: LogRecord = {
      ts: typeof ts === 'string' && ts.length > 0 ? ts : new Date().toISOString(),
      level,
      scope: typeof scope === 'string' && scope.length > 0 ? scope : 'worker',
      msg: scrubSecrets(typeof msg === 'string' ? msg : String(msg ?? ''), secrets)
    }

    // Remaining fields go through the same redaction pass as `emit()`, so a key
    // sitting in `err.stack` or a nested field is scrubbed too.
    const redacted = redactValue(rest, secrets) as Record<string, unknown>
    for (const [k, v] of Object.entries(redacted)) {
      if (k === 'ts' || k === 'level' || k === 'scope' || k === 'msg') continue
      safe[k] = v
    }

    // Errors from a worker get an ID on the same terms as local ones, so a user
    // can quote it from the log viewer whichever thread produced it.
    if (level === 'error' && !safe.errorId) {
      safe.errorId = newErrorId()
    }

    this.pushToRing(safe)
    this.writeToFile(safe)
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.state.config.level]) return

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: this.scopeName,
      // The message is scrubbed too, not just the fields. Callers interpolate
      // freely — `log.error(\`request failed for ${url}\`)` — and a URL carrying
      // the API key would otherwise land in the file untouched.
      msg: scrubSecrets(msg, this.state.secrets)
    }

    if (this.state.jobId) {
      record.jobId = this.state.jobId
    }

    // If there's an error object in the fields, normalise it early so the
    // redaction pass that follows can scrub any sensitive keys inside it.
    if (fields?.err) {
      const e = fields.err as Record<string, unknown>
      fields = {
        ...fields,
        err: {
          name: String(e.name || 'Error'),
          message: String(e.message || ''),
          stack: typeof e.stack === 'string' ? e.stack : undefined
        }
      }
    }

    // Merge fields, applying redaction
    if (fields) {
      const redacted = redactValue(fields, this.state.secrets) as Record<string, unknown>
      for (const [k, v] of Object.entries(redacted)) {
        // Never let user fields overwrite structural record keys
        if (k === 'ts' || k === 'level' || k === 'scope' || k === 'msg') continue
        record[k] = v
      }
    }

    // Every error record gets an errorId unless one was explicitly provided
    if (level === 'error' && !record.errorId) {
      record.errorId = newErrorId()
    }

    this.pushToRing(record)
    this.writeToFile(record)
  }

  private pushToRing(record: LogRecord): void {
    const state = this.state
    state.ringBuffer[state.ringIndex] = record
    state.ringIndex = (state.ringIndex + 1) % state.ringBuffer.length
  }

  private writeToFile(record: LogRecord): void {
    try {
      const line = JSON.stringify(record) + '\n'
      const state = this.state

      // Check rotation threshold before writing.
      // We accept that the file may overshoot by up to one record; that is the
      // trade-off for not stat-ing before every single log call.
      let size = 0
      try {
        size = statSync(state.currentLogPath).size
      } catch {
        // File doesn't exist yet — that's fine
      }

      if (size >= state.config.maxFileSize) {
        rotate(state)
      }

      appendFileSync(state.currentLogPath, line, 'utf-8')
    } catch {
      // Trap #2: a failure while writing must never throw or recurse.
      // The ring buffer already has the record; the file is best-effort.
    }
  }
}

// ─── Rotation ────────────────────────────────────────────────────────────────

function rotate(state: SharedState): void {
  try {
    for (let i = state.config.maxFiles - 1; i >= 1; i--) {
      const oldPath = join(state.config.logDir, `app.${i}.log`)
      const newPath = join(state.config.logDir, `app.${i + 1}.log`)
      if (existsSync(oldPath)) {
        if (existsSync(newPath)) {
          unlinkSync(newPath)
        }
        renameSync(oldPath, newPath)
      }
    }

    const rotatedPath = join(state.config.logDir, 'app.1.log')
    if (existsSync(state.currentLogPath)) {
      if (existsSync(rotatedPath)) {
        unlinkSync(rotatedPath)
      }
      renameSync(state.currentLogPath, rotatedPath)
    }
  } catch {
    // Rotation failure is non-fatal — keep writing to the current file
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────

function pruneRetention(state: SharedState): void {
  try {
    const cutoff = Date.now() - state.config.retentionDays * 86_400_000
    let entries: string[]
    try {
      entries = readdirSync(state.config.logDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.startsWith('app') || !entry.endsWith('.log')) continue
      const fullPath = join(state.config.logDir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs < cutoff) {
          unlinkSync(fullPath)
        }
      } catch {
        // Individual file failures are not fatal
      }
    }
  } catch {
    // Retention pruning is best-effort
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let sharedState: SharedState | null = null

/**
 * Create (or return the existing) root logger.
 *
 * On first call, `logDir` is required. Subsequent calls return the singleton,
 * ignoring the config. The main process must call this once at startup with
 * `app.getPath('userData')` before any workers or IPC handlers log anything.
 */
export function createLogger(config: {
  logDir: string
  level?: LogLevel
  retentionDays?: number
}): Logger {
  if (sharedState) {
    if (config.level) sharedState.config.level = config.level
    if (config.retentionDays !== undefined)
      sharedState.config.retentionDays = config.retentionDays
    return new LoggerImpl(sharedState, 'app')
  }

  mkdirSync(config.logDir, { recursive: true })

  const state: SharedState = {
    config: {
      ...DEFAULT_CONFIG,
      logDir: config.logDir,
      level: config.level ?? DEFAULT_CONFIG.level,
      retentionDays: config.retentionDays ?? DEFAULT_CONFIG.retentionDays
    },
    ringBuffer: new Array(DEFAULT_CONFIG.ringBufferSize),
    ringIndex: 0,
    secrets: new Set(),
    currentLogPath: join(config.logDir, 'app.log'),
    jobId: null
  }

  sharedState = state
  pruneRetention(state)
  return new LoggerImpl(state, 'app')
}

/**
 * Get a logger for a specific scope.
 *
 * Returns a no-op stub until `createLogger()` has been called, so modules
 * that import the logger at module scope never throw.
 */
export function getLogger(scope?: string): Logger {
  // Always deferred, even when already initialised: `resetLogger()` in tests and
  // a re-init would otherwise leave callers holding a logger bound to dead
  // state. Resolving per call keeps every holder correct for the whole session.
  return new DeferredLogger(scope ?? 'app')
}

/**
 * Reset the singleton (for testing only).
 */
export function resetLogger(): void {
  sharedState = null
  noopInstance = null
}

/**
 * Expose the mutable SharedState for tests that need to override config values
 * (ring buffer size, file size caps, etc.) after creation.
 *
 * Returns null when the logger has not been initialised.
 */
export function _getSharedStateForTest(): SharedState | null {
  return sharedState
}

// ─── Deferred Logger (resolves on every call) ────────────────────────────────

/**
 * A logger that looks up the shared state each time it is used.
 *
 * `getLogger()` is routinely called at module scope — `const log =
 * getLogger('library')` at the top of an IPC module — and module bodies run at
 * import time, well before `createLogger()` is reached inside
 * `app.whenReady()`. Handing back a captured no-op stub there meant that
 * logger stayed silent for the life of the process: every call in the largest
 * IPC module was discarded, and the symptom was indistinguishable from an
 * application that simply had nothing to say.
 *
 * Resolving per call costs one property read and removes the ordering
 * requirement entirely, so where a logger is obtained no longer matters.
 */
class DeferredLogger implements Logger {
  private scopeName: string

  constructor(scopeName: string) {
    this.scopeName = scopeName
  }

  /** The real logger once initialised, otherwise null. */
  private target(): Logger | null {
    return sharedState ? new LoggerImpl(sharedState, this.scopeName) : null
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.target()?.error(msg, fields)
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.target()?.warn(msg, fields)
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.target()?.info(msg, fields)
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.target()?.debug(msg, fields)
  }
  scope(name: string): Logger {
    const child = this.scopeName === 'app' ? name : `${this.scopeName}:${name}`
    return new DeferredLogger(child)
  }
  getRingBuffer(): LogRecord[] {
    return this.target()?.getRingBuffer() ?? []
  }
  setLevel(level: LogLevel): void {
    this.target()?.setLevel(level)
  }
  getConfig(): Readonly<LoggerConfig> {
    return this.target()?.getConfig() ?? createNoopLogger().getConfig()
  }
  registerSecret(value: string): void {
    this.target()?.registerSecret(value)
  }
  writeRecord(record: LogRecord): void {
    this.target()?.writeRecord(record)
  }
  setJobId(jobId: string): void {
    this.target()?.setJobId(jobId)
  }
}

// ─── No-op Logger (config shape before init) ──────────────────────────────────

class NoopLogger implements Logger {
  error(): void {
    /* noop */
  }
  warn(): void {
    /* noop */
  }
  info(): void {
    /* noop */
  }
  debug(): void {
    /* noop */
  }
  scope(): Logger {
    return this
  }
  getRingBuffer(): LogRecord[] {
    return []
  }
  setLevel(): void {
    /* noop */
  }
  getConfig(): Readonly<LoggerConfig> {
    return {
      logDir: '',
      level: 'info',
      maxFileSize: 0,
      maxFiles: 0,
      retentionDays: 0,
      ringBufferSize: 0
    }
  }
  registerSecret(): void {
    /* noop */
  }
  writeRecord(): void {
    /* noop */
  }
  setJobId(): void {
    /* noop */
  }
}

let noopInstance: NoopLogger | null = null

function createNoopLogger(): Logger {
  if (!noopInstance) noopInstance = new NoopLogger()
  return noopInstance
}
