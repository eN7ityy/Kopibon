import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createLogger,
  getLogger,
  resetLogger,
  _getSharedStateForTest,
  newErrorId,
  type Logger
} from './logger'
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'logger-test-'))
}

function createTestLogger(overrides: {
  level?: 'error' | 'warn' | 'info' | 'debug'
  maxFileSize?: number
  maxFiles?: number
  retentionDays?: number
  ringBufferSize?: number
} = {}): { logger: Logger; dir: string } {
  const dir = tempDir()
  resetLogger()
  const logger = createLogger({ logDir: dir, level: overrides.level ?? 'debug' })

  // Mutate the shared state config directly for test overrides
  const state = _getSharedStateForTest()
  if (state) {
    if (overrides.maxFileSize !== undefined) state.config.maxFileSize = overrides.maxFileSize
    if (overrides.maxFiles !== undefined) state.config.maxFiles = overrides.maxFiles
    if (overrides.retentionDays !== undefined)
      state.config.retentionDays = overrides.retentionDays
    if (overrides.ringBufferSize !== undefined) {
      state.config.ringBufferSize = overrides.ringBufferSize
      // Re-create the ring buffer with the new size
      // Cast through a narrow shape rather than `any`: these two fields are
      // deliberately reset for ring-buffer sizing tests.
      const mutable = state as unknown as { ringBuffer: unknown[]; ringIndex: number }
      mutable.ringBuffer = new Array(overrides.ringBufferSize)
      mutable.ringIndex = 0
    }
  }

  return { logger, dir }
}

function readLogLines(dir: string): string[] {
  const logPath = join(dir, 'app.log')
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
}

function parseLogLines(dir: string): Record<string, unknown>[] {
  return readLogLines(dir).map((l) => JSON.parse(l))
}

// ─── Level filtering ─────────────────────────────────────────────────────────

describe('level filtering', () => {
  let logger: Logger
  let dir: string

  beforeEach(() => {
    const t = createTestLogger({ level: 'info' })
    logger = t.logger
    dir = t.dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('writes info and above when level is info', () => {
    logger.debug('debug msg')
    logger.info('info msg')
    logger.warn('warn msg')
    logger.error('error msg')

    const lines = parseLogLines(dir)
    expect(lines.length).toBe(3)
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn', 'error'])
  })

  it('writes all levels when level is debug', () => {
    const t2 = createTestLogger({ level: 'debug' })
    t2.logger.debug('d')
    t2.logger.info('i')
    t2.logger.warn('w')
    t2.logger.error('e')

    const lines = parseLogLines(t2.dir)
    expect(lines.length).toBe(4)
    rmSync(t2.dir, { recursive: true, force: true })
  })

  it('writes only errors when level is error', () => {
    const t2 = createTestLogger({ level: 'error' })
    t2.logger.debug('d')
    t2.logger.info('i')
    t2.logger.warn('w')
    t2.logger.error('e')

    const lines = parseLogLines(t2.dir)
    expect(lines.length).toBe(1)
    expect(lines[0].level).toBe('error')
    rmSync(t2.dir, { recursive: true, force: true })
  })
})

// ─── NDJSON records ──────────────────────────────────────────────────────────

describe('NDJSON records', () => {
  it('produces valid JSON, one object per line', () => {
    const { logger, dir } = createTestLogger()
    logger.info('hello')
    logger.info('world')

    const lines = readLogLines(dir)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('includes ts, level, scope, and msg on every record', () => {
    const { logger, dir } = createTestLogger()
    logger.info('test message')

    const records = parseLogLines(dir)
    expect(records.length).toBe(1)
    const r = records[0]
    expect(typeof r.ts).toBe('string')
    expect(r.level).toBe('info')
    expect(r.scope).toBe('app')
    expect(r.msg).toBe('test message')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('merges extra fields into the record', () => {
    const { logger, dir } = createTestLogger()
    logger.info('with fields', { userId: 42, action: 'login' })

    const records = parseLogLines(dir)
    expect(records[0].userId).toBe(42)
    expect(records[0].action).toBe('login')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('never lets fields overwrite ts, level, scope, or msg', () => {
    const { logger, dir } = createTestLogger()
    logger.info('real msg', {
      ts: 'fake',
      level: 'error',
      scope: 'hacked',
      msg: 'evil'
    })

    const records = parseLogLines(dir)
    expect(records[0].ts).not.toBe('fake')
    expect(records[0].level).toBe('info')
    expect(records[0].scope).toBe('app')
    expect(records[0].msg).toBe('real msg')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('normalises err objects to {name, message, stack}', () => {
    const { logger, dir } = createTestLogger()
    const err = new Error('boom')
    logger.error('failed', { err })

    const records = parseLogLines(dir)
    const r = records[0]
    expect(r.err).toBeDefined()
    expect((r.err as Record<string, unknown>).name).toBe('Error')
    expect((r.err as Record<string, unknown>).message).toBe('boom')
    expect(typeof (r.err as Record<string, unknown>).stack).toBe('string')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Scoped child loggers ────────────────────────────────────────────────────

describe('scoped child loggers', () => {
  it('sets the scope on every record from that child', () => {
    const { logger, dir } = createTestLogger()
    const dl = logger.scope('downloads')
    dl.info('downloading')

    const records = parseLogLines(dir)
    expect(records.length).toBe(1)
    expect(records[0].scope).toBe('downloads')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('shares the ring buffer across scopes', () => {
    const { logger } = createTestLogger()
    const dl = logger.scope('downloads')
    const lib = logger.scope('library')

    dl.info('d1')
    lib.info('l1')

    const buf = logger.getRingBuffer()
    const msgs = buf.map((r) => r.msg)
    expect(msgs).toContain('d1')
    expect(msgs).toContain('l1')

    resetLogger()
  })

  it('can nest scopes', () => {
    const { logger, dir } = createTestLogger()
    const dl = logger.scope('downloads')
    const worker = dl.scope('worker')

    worker.info('page 1')

    const records = parseLogLines(dir)
    expect(records[0].scope).toBe('downloads:worker')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Redaction ───────────────────────────────────────────────────────────────

describe('redaction', () => {
  it('redacts fields with sensitive names', () => {
    const { logger, dir } = createTestLogger()
    logger.info('auth', { apiKey: 'secret-123', username: 'test' })

    const records = parseLogLines(dir)
    expect(records[0].apiKey).toBe('[REDACTED]')
    expect(records[0].username).toBe('test')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('redacts fields named key, token, authorization, cookie, password', () => {
    const { logger, dir } = createTestLogger()
    logger.info('auth', {
      key: 'k1',
      token: 't1',
      authorization: 'a1',
      cookie: 'c1',
      password: 'p1',
      normal: 'n1'
    })

    const records = parseLogLines(dir)
    const r = records[0]
    expect(r.key).toBe('[REDACTED]')
    expect(r.token).toBe('[REDACTED]')
    expect(r.authorization).toBe('[REDACTED]')
    expect(r.cookie).toBe('[REDACTED]')
    expect(r.password).toBe('[REDACTED]')
    expect(r.normal).toBe('n1')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('redacts the nhentai_api_key field name', () => {
    const { logger, dir } = createTestLogger()
    logger.info('settings', { nhentai_api_key: 'abc-encrypted' })

    const records = parseLogLines(dir)
    expect(records[0].nhentai_api_key).toBe('[REDACTED]')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('redacts a value that matches a registered secret', () => {
    const { logger, dir } = createTestLogger()
    logger.registerSecret('my-super-secret-key')
    logger.info('request', {
      url: 'https://api.example.com',
      xApiKey: 'my-super-secret-key'
    })

    const records = parseLogLines(dir)
    expect(records[0].xApiKey).toBe('[REDACTED]')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('redacts nested sensitive fields', () => {
    const { logger, dir } = createTestLogger()
    logger.info('nested', {
      config: { apiKey: 'nested-secret', retries: 3 },
      headers: { authorization: 'Bearer token' }
    })

    const records = parseLogLines(dir)
    const r = records[0]
    expect((r.config as Record<string, unknown>).apiKey).toBe('[REDACTED]')
    expect((r.config as Record<string, unknown>).retries).toBe(3)
    expect((r.headers as Record<string, unknown>).authorization).toBe('[REDACTED]')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Error ID format and uniqueness ──────────────────────────────────────────

describe('error IDs', () => {
  it('starts with E- followed by 8 Crockford base32 characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = newErrorId()
      expect(id).toMatch(/^E-[0-9A-HJKMNP-TV-Z]{8}$/)
    }
  })

  it('uses only valid Crockford characters (no I, L, O, U)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = newErrorId()
      expect(id).not.toMatch(/[ILOU]/)
    }
  })

  it('generates unique IDs across a large batch', () => {
    const count = 50_000
    const ids = new Set<string>()
    for (let i = 0; i < count; i++) {
      ids.add(newErrorId())
    }
    expect(ids.size).toBe(count)
  })

  it('every error() call gets an auto-assigned errorId', () => {
    const { logger, dir } = createTestLogger()
    logger.error('fail1')
    logger.error('fail2')

    const records = parseLogLines(dir)
    expect(records[0].errorId).toMatch(/^E-/)
    expect(records[1].errorId).toMatch(/^E-/)
    expect(records[0].errorId).not.toBe(records[1].errorId)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('preserves a caller-supplied errorId', () => {
    const { logger, dir } = createTestLogger()
    logger.error('fail', { errorId: 'E-CUSTOM1' })

    const records = parseLogLines(dir)
    expect(records[0].errorId).toBe('E-CUSTOM1')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('does not auto-assign errorId to non-error levels', () => {
    const { logger, dir } = createTestLogger()
    logger.warn('warning')
    logger.info('info')

    const records = parseLogLines(dir)
    expect(records[0].errorId).toBeUndefined()
    expect(records[1].errorId).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Ring buffer bounds ──────────────────────────────────────────────────────

describe('ring buffer', () => {
  it('holds at most ringBufferSize entries', () => {
    const { logger } = createTestLogger({ ringBufferSize: 5 })

    for (let i = 0; i < 10; i++) {
      logger.info(`msg ${i}`)
    }

    const buf = logger.getRingBuffer()
    expect(buf.length).toBeLessThanOrEqual(5)
    // Oldest entries should be gone
    const msgs = buf.map((r) => r.msg)
    expect(msgs).not.toContain('msg 0')
    expect(msgs).toContain('msg 9')

    resetLogger()
  })

  it('returns entries in FIFO order (oldest first)', () => {
    const { logger } = createTestLogger({ ringBufferSize: 3 })

    logger.info('a')
    logger.info('b')
    logger.info('c')
    logger.info('d') // kicks out 'a'

    const buf = logger.getRingBuffer()
    expect(buf.length).toBe(3)
    expect(buf[0].msg).toBe('b')
    expect(buf[1].msg).toBe('c')
    expect(buf[2].msg).toBe('d')

    resetLogger()
  })

  it('returns empty array when nothing has been logged', () => {
    const { logger } = createTestLogger()
    expect(logger.getRingBuffer()).toEqual([])
    resetLogger()
  })
})

// ─── Rotation at size cap ────────────────────────────────────────────────────

describe('rotation', () => {
  it('rotates when the file exceeds maxFileSize', () => {
    const { logger, dir } = createTestLogger({ maxFileSize: 500 })

    // Write enough records to exceed 500 bytes
    for (let i = 0; i < 100; i++) {
      logger.info(`long message number ${i} with some padding to fill space quickly`)
    }

    // After rotation, we should have app.log
    expect(existsSync(join(dir, 'app.log'))).toBe(true)

    // Check if any rotated files exist
    const entries = readdirSync(dir).filter(
      (f) => f.startsWith('app') && f.endsWith('.log')
    )
    expect(entries.length).toBeGreaterThanOrEqual(1)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('never exceeds maxFiles rotated files', () => {
    const { logger, dir } = createTestLogger({ maxFileSize: 200, maxFiles: 3 })

    for (let i = 0; i < 300; i++) {
      logger.info(
        `msg ${i} with more bytes to fill the file up past its tiny limit`
      )
    }

    const entries = readdirSync(dir).filter(
      (f) => f.startsWith('app') && f.endsWith('.log')
    )
    // Current log (app.log) + up to maxFiles rotated files
    expect(entries.length).toBeLessThanOrEqual(4)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('every log file is valid NDJSON (no partial lines after rotation)', () => {
    const { logger, dir } = createTestLogger({ maxFileSize: 500 })

    for (let i = 0; i < 200; i++) {
      logger.info(
        `msg ${i} padding padding padding to reach the size limit`
      )
    }

    const logFiles = readdirSync(dir).filter(
      (f) => f.startsWith('app') && f.endsWith('.log')
    )
    for (const file of logFiles) {
      const content = readFileSync(join(dir, file), 'utf-8').trim()
      if (content.length === 0) continue
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Retention deletion ──────────────────────────────────────────────────────

describe('retention', () => {
  it('prunes log files older than retentionDays', () => {
    // Set up the directory with an old log file BEFORE creating the logger
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })

    // Create an old log file that matches the app*.log pattern
    const oldPath = join(dir, 'app.old.log')
    writeFileSync(oldPath, 'old log content')
    const oldTime = new Date(Date.now() - 2 * 86_400_000)
    utimesSync(oldPath, oldTime, oldTime)

    // Create logger with 1-day retention — prunes on construction
    const logger = createLogger({ logDir: dir, retentionDays: 1 })
    logger.info('trigger log write')

    // The old file should be gone because pruneRetention ran during construction
    expect(existsSync(oldPath)).toBe(false)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('keeps files newer than retentionDays', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })

    const recentPath = join(dir, 'app.recent.log')
    writeFileSync(recentPath, 'recent content')
    const recentTime = new Date(Date.now() - 1 * 86_400_000)
    utimesSync(recentPath, recentTime, recentTime)

    createLogger({ logDir: dir })

    expect(existsSync(recentPath)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('only prunes files matching the app*.log pattern', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })

    const otherPath = join(dir, 'other.txt')
    writeFileSync(otherPath, 'other content')
    const oldTime = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(otherPath, oldTime, oldTime)

    createLogger({ logDir: dir })

    expect(existsSync(otherPath)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Error normalisation ─────────────────────────────────────────────────────

describe('error fields', () => {
  it('captures name, message, and stack from an Error', () => {
    const { logger, dir } = createTestLogger()
    const err = new TypeError('type mismatch')
    logger.error('failed', { err })

    const records = parseLogLines(dir)
    expect(records[0].err).toEqual({
      name: 'TypeError',
      message: 'type mismatch',
      stack: expect.any(String)
    })

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('handles a plain object with err-like shape', () => {
    const { logger, dir } = createTestLogger()
    logger.error('failed', { err: { name: 'CustomError', message: 'custom' } })

    const records = parseLogLines(dir)
    expect(records[0].err).toEqual({
      name: 'CustomError',
      message: 'custom',
      stack: undefined
    })

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('coerces non-object err values safely', () => {
    const { logger, dir } = createTestLogger()
    logger.error('failed', { err: 'just a string' })

    const records = parseLogLines(dir)
    expect(records[0].err).toEqual({
      name: 'Error',
      message: '',
      stack: undefined
    })

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── jobId ───────────────────────────────────────────────────────────────────

describe('jobId', () => {
  it('stamps jobId on every record when set', () => {
    const { logger, dir } = createTestLogger()
    logger.setJobId('scan-20260731')
    logger.info('started')
    logger.info('done')

    const records = parseLogLines(dir)
    expect(records[0].jobId).toBe('scan-20260731')
    expect(records[1].jobId).toBe('scan-20260731')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('does not stamp jobId when not set', () => {
    const { logger, dir } = createTestLogger()
    logger.info('no job')

    const records = parseLogLines(dir)
    expect(records[0].jobId).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── Trap #2: logger never throws ────────────────────────────────────────────

describe('trap: logger never throws', () => {
  it('does not throw when the log directory is unwritable after creation', () => {
    const { logger, dir } = createTestLogger()

    // Make the log file a directory (appendFileSync will fail)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'app.log')
    mkdirSync(logPath) // app.log is now a directory — writes will fail

    expect(() => logger.info('should not throw')).not.toThrow()
    expect(() => logger.error('error should not throw either')).not.toThrow()

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

// ─── writeRecord for worker forwarding ───────────────────────────────────────

describe('writeRecord', () => {
  it('writes a pre-built record directly without modification', () => {
    const { logger, dir } = createTestLogger()
    logger.writeRecord({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: 'worker',
      msg: 'from worker',
      jobId: 'job-1'
    })

    const records = parseLogLines(dir)
    expect(records.length).toBe(1)
    expect(records[0].ts).toBe('2026-01-01T00:00:00.000Z')
    expect(records[0].scope).toBe('worker')
    expect(records[0].jobId).toBe('job-1')

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })

  it('adds to the ring buffer as well as the file', () => {
    const { logger, dir } = createTestLogger()
    logger.writeRecord({
      ts: new Date().toISOString(),
      level: 'warn',
      scope: 'worker',
      msg: 'worker warning'
    })

    const buf = logger.getRingBuffer()
    expect(buf.length).toBeGreaterThanOrEqual(1)
    expect(buf.some((r) => r.msg === 'worker warning')).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    resetLogger()
  })
})

describe('getLogger before initialisation', () => {
  afterEach(() => {
    resetLogger()
  })

  /**
   * The exact pattern used at the top of the IPC modules:
   *
   *   const log = getLogger('library')   // module scope, runs at import time
   *
   * Module bodies execute long before createLogger() is reached inside
   * app.whenReady(). getLogger used to hand back a captured no-op stub there, so
   * every call through that logger was discarded for the life of the process —
   * and a logger that writes nothing looks exactly like an app with nothing to
   * say, which is why it went unnoticed.
   */
  it('a logger captured before init still writes once initialised', () => {
    resetLogger()
    const captured = getLogger('library')

    // Nothing to write to yet: this must not throw.
    captured.info('before init')

    const dir = tempDir()
    createLogger({ logDir: dir, level: 'debug' })

    captured.error('after init, through the pre-init handle')

    const contents = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(contents).toContain('after init, through the pre-init handle')

    const record = contents
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((r) => r.msg === 'after init, through the pre-init handle')
    expect(record).toBeDefined()
    // Scope must survive the deferral, otherwise filtering by subsystem breaks.
    expect(record.scope).toBe('library')
    expect(record.errorId).toMatch(/^E-/)

    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps working across a reset and re-init', () => {
    resetLogger()
    const captured = getLogger('downloads')

    const first = tempDir()
    createLogger({ logDir: first, level: 'debug' })
    captured.info('first session')

    resetLogger()
    const second = tempDir()
    createLogger({ logDir: second, level: 'debug' })
    captured.info('second session')

    expect(readFileSync(join(first, 'app.log'), 'utf8')).toContain('first session')
    // The same handle must follow the new state rather than the dead one.
    expect(readFileSync(join(second, 'app.log'), 'utf8')).toContain('second session')

    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  })
})

describe('secret redaction of embedded values', () => {
  // A realistic key: long, prefixed, and the shape this app actually stores.
  const KEY = 'nhk_T9GIjTH19HsXassZ6dFQ3LC3W5zIC4noESmrbii9GhqUVHoR'

  afterEach(() => {
    resetLogger()
  })

  /**
   * Redaction used to compare for equality, which only catches a secret that is
   * the entire value of a field. That is not how keys leak. They leak inside
   * other text: a request URL carrying the key as a query parameter, or the
   * message of an HTTP error built from that URL.
   */
  it.each([
    ['a URL field', (log: Logger) => log.info('req', { url: `https://nhentai.net/api/x?key=${KEY}` })],
    ['the message itself', (log: Logger) => log.info(`request failed for key=${KEY}`)],
    ['an Error message', (log: Logger) => log.error('failed', { err: new Error(`401 (key=${KEY})`) })],
    ['a nested field', (log: Logger) => log.info('nested', { req: { headers: { via: `k=${KEY}` } } })],
    ['an array element', (log: Logger) => log.info('arr', { tried: [`url?key=${KEY}`] })]
  ])('scrubs a secret embedded in %s', (_label, emit) => {
    const { logger, dir } = createTestLogger()
    logger.registerSecret(KEY)
    emit(logger)

    const contents = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(contents).not.toContain(KEY)
    expect(contents).toContain('[REDACTED]')

    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves ordinary text alone and does not scrub trivially short secrets', () => {
    const { logger, dir } = createTestLogger()
    // Guard against over-matching: a short secret would redact innocent text.
    logger.registerSecret('ab')
    logger.info('a stable message about abc')

    const contents = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(contents).toContain('a stable message about abc')
    expect(contents).not.toContain('[REDACTED]')

    rmSync(dir, { recursive: true, force: true })
  })
})
