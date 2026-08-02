/**
 * Diagnostics bundle.
 *
 * This file is written specifically so a user can attach it to a bug report,
 * which makes it the one artifact in the app that is *expected* to be handed to
 * a stranger. Everything here follows from that.
 *
 * The previous implementation dumped `settingsRepo.getAll()` wholesale. That
 * returns every row unfiltered, including `nhentai_api_key` — and `encryptKey()`
 * falls back to storing the key verbatim whenever `safeStorage` is unavailable
 * (Linux without a keyring, VMs, some Windows contexts). So on those systems the
 * exported file contained the raw API key, in the one file the user is invited to
 * post publicly. Nothing scrubbed it: the "rewrite the file now that the secret
 * is registered" step re-serialised an already-built object and wrote identical
 * bytes.
 *
 * Two rules, both enforced here rather than at the call site:
 *
 * 1. Settings are an **allowlist**. A new setting is excluded until someone
 *    decides it is safe, which is the correct default for a file like this.
 * 2. The serialised text is scrubbed before it is written, so a secret that
 *    reached the bundle through some field nobody anticipated still does not
 *    leave the machine.
 *
 * Kept free of Electron and filesystem imports so it can be unit tested.
 */

import type { LogRecord } from './logger'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiagnosticsInput {
  appVersion: string
  versions: { electron: string; chrome: string; node: string }
  os: { platform: string; arch: string; release: string; cpus: number; totalMemGb: number }
  toolchain: unknown
  /** Raw settings map; filtered by the allowlist below. */
  settings: Record<string, string>
  libraryItemCount: number
  records: LogRecord[]
  /** Values to scrub from the finished text, e.g. the decrypted API key. */
  secrets?: string[]
  /** Replace user directory paths with placeholders. */
  redactPaths?: boolean
  exportedAt: string
}

export interface DiagnosticsBundle {
  exportedAt: string
  app: { version: string; electron: string; chrome: string; node: string }
  os: DiagnosticsInput['os']
  toolchain: unknown
  settings: Record<string, string>
  omittedSettings: string[]
  libraryItemCount: number
  recentRecords: LogRecord[]
}

/**
 * Settings safe to include.
 *
 * Deliberately an allowlist, not a denylist: `nhentai_api_key` was caught by
 * neither the field-name check nor anything else, because the whole map was
 * copied. Anything not named here is reported by key in `omittedSettings`, so
 * the bundle still shows *that* a setting exists without disclosing its value.
 */
export const SAFE_SETTING_KEYS = [
  'outputFormat',
  'downloadConcurrency',
  'compressPdf',
  'compressionQuality',
  'pageSize',
  'blackBackground',
  'showNotifications',
  'cbzMangaDirection',
  'cbzKeepOriginal',
  'completedRetentionDays',
  // Search defaults. `searchDefaultQuery` is deliberately absent: it is a query
  // the user chose, which can say a great deal about them, and it has no
  // diagnostic value. The blocked-value list is not here either — it lives in its
  // own table rather than app_settings, so it is never in scope for this export.
  'searchDefaultSort',
  'searchDefaultLanguage',
  'searchMinPages',
  'searchMinFavorites',
  'searchUploadedWithinDays',
  'searchRespectBlacklist'
] as const

const REDACTED = '[REDACTED]'

// ─── Path redaction ──────────────────────────────────────────────────────────

/**
 * Replace home and library directories with placeholders.
 *
 * A stack trace or a log line naming `/home/alice/...` discloses a username, and
 * library paths often say more about a person than the bug does. Structure is
 * preserved so the report stays diagnosable.
 */
function redactPaths(
  text: string,
  homeDir: string | undefined,
  libraryPath: string | undefined
): string {
  let out = text
  // Longest first: a library path under the home directory must not be
  // half-replaced by the home rule.
  const rules: Array<[string, string]> = []
  if (libraryPath && libraryPath.length > 3) rules.push([libraryPath, '<LIBRARY>'])
  if (homeDir && homeDir.length > 3) rules.push([homeDir, '<HOME>'])
  rules.sort((a, b) => b[0].length - a[0].length)

  for (const [needle, placeholder] of rules) {
    if (out.includes(needle)) out = out.split(needle).join(placeholder)
    // JSON-encoded Windows paths appear with doubled separators.
    const escaped = needle.replace(/\\/g, '\\\\')
    if (escaped !== needle && out.includes(escaped)) {
      out = out.split(escaped).join(placeholder)
    }
  }
  return out
}

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Assemble the bundle. Pure: same input, same output.
 */
export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsBundle {
  const settings: Record<string, string> = {}
  const omitted: string[] = []
  const allowed = new Set<string>(SAFE_SETTING_KEYS)

  for (const key of Object.keys(input.settings).sort()) {
    if (allowed.has(key)) settings[key] = input.settings[key]
    else omitted.push(key)
  }

  return {
    exportedAt: input.exportedAt,
    app: {
      version: input.appVersion,
      electron: input.versions.electron,
      chrome: input.versions.chrome,
      node: input.versions.node
    },
    os: input.os,
    toolchain: input.toolchain,
    settings,
    omittedSettings: omitted,
    libraryItemCount: input.libraryItemCount,
    recentRecords: input.records
  }
}

/**
 * Serialise the bundle for writing, scrubbing secrets and paths from the text.
 *
 * Scrubbing the finished string rather than walking the object is deliberate: it
 * covers every field, including log-record messages and stack traces, and it
 * cannot be defeated by a shape nobody anticipated.
 */
export function serializeDiagnostics(input: DiagnosticsInput, homeDir?: string): string {
  const bundle = buildDiagnostics(input)
  let text = JSON.stringify(bundle, null, 2)

  for (const secret of input.secrets ?? []) {
    // Short values would match ordinary text; a real credential is long.
    if (!secret || secret.length < 8) continue
    if (text.includes(secret)) text = text.split(secret).join(REDACTED)
    // Also catch the JSON-escaped form, in case the value contains quotes or
    // backslashes that stringify altered.
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret && text.includes(escaped)) {
      text = text.split(escaped).join(REDACTED)
    }
  }

  if (input.redactPaths) {
    text = redactPaths(text, homeDir, input.settings.libraryPath)
  }

  return text
}
