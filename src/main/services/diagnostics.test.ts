import { describe, it, expect } from 'vitest'
import {
  buildDiagnostics,
  serializeDiagnostics,
  SAFE_SETTING_KEYS,
  type DiagnosticsInput
} from './diagnostics'

/**
 * The diagnostics bundle is the one file the app expects a user to hand to a
 * stranger, so "no credential can reach it" is the property under test.
 *
 * The bug these cover: settings were copied wholesale from
 * `settingsRepo.getAll()`, which includes `nhentai_api_key`. Since
 * `encryptKey()` returns the key verbatim whenever safeStorage is unavailable,
 * the exported file could contain the raw key in cleartext.
 */

// Shape of a real stored key, and of the plaintext fallback.
const ENCRYPTED = 'djExK3FTL3BuUjFZV2d1SVJSQmhWWA=='
const PLAINTEXT = 'nhk_T9GIjTH19HsXassZ6dFQ3LC3W5zIC4noESmrbii9GhqUVHoR'

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '1.0.0',
    versions: { electron: '39.2.6', chrome: '138', node: '22.22.2' },
    os: { platform: 'linux', arch: 'x64', release: '7.1.4', cpus: 16, totalMemGb: 64 },
    toolchain: { ok: true },
    settings: {
      outputFormat: 'cbz',
      downloadConcurrency: '3',
      libraryPath: '/home/alice/Kavita/Doujins',
      nhentai_api_key: ENCRYPTED
    },
    libraryItemCount: 4627,
    records: [],
    exportedAt: '2026-07-31T12:00:00.000Z',
    ...overrides
  }
}

describe('buildDiagnostics — settings allowlist', () => {
  it('excludes the stored API key', () => {
    const b = buildDiagnostics(input())
    expect(b.settings.nhentai_api_key).toBeUndefined()
    expect(JSON.stringify(b)).not.toContain(ENCRYPTED)
  })

  it('reports omitted keys by name so the bundle stays informative', () => {
    const b = buildDiagnostics(input())
    expect(b.omittedSettings).toContain('nhentai_api_key')
    expect(b.omittedSettings).toContain('libraryPath')
  })

  it('keeps the settings that are useful for debugging', () => {
    const b = buildDiagnostics(input())
    expect(b.settings.outputFormat).toBe('cbz')
    expect(b.settings.downloadConcurrency).toBe('3')
  })

  it('excludes anything not on the allowlist, including future settings', () => {
    // An allowlist rather than a denylist means a setting added later is
    // withheld until someone decides it is safe, which is the right default.
    const b = buildDiagnostics(input({ settings: { somethingAddedLater: 'secret-ish' } }))
    expect(b.settings.somethingAddedLater).toBeUndefined()
    expect(b.omittedSettings).toContain('somethingAddedLater')
  })

  it('never lists a credential-looking key as safe', () => {
    for (const key of SAFE_SETTING_KEYS) {
      expect(key).not.toMatch(/key|token|password|secret|auth/i)
    }
  })

  it('is pure: same input, same output', () => {
    expect(buildDiagnostics(input())).toEqual(buildDiagnostics(input()))
  })
})

describe('serializeDiagnostics — secret scrubbing', () => {
  it('scrubs a secret that reached the text through a log record', () => {
    // The allowlist protects the settings block; records are free-form, so a key
    // can arrive inside a message or a stack trace.
    const text = serializeDiagnostics(
      input({
        secrets: [ENCRYPTED, PLAINTEXT],
        records: [
          {
            ts: '2026-07-31T12:00:00.000Z',
            level: 'error',
            scope: 'api',
            msg: `401 for https://nhentai.net/api/x?key=${PLAINTEXT}`
          }
        ]
      })
    )
    expect(text).not.toContain(PLAINTEXT)
    expect(text).toContain('[REDACTED]')
  })

  it('scrubs the encrypted blob as well as the plaintext', () => {
    // safeStorage falls back to storing the key verbatim, so both forms are
    // treated as secrets rather than trusting that the stored value is opaque.
    const text = serializeDiagnostics(
      input({
        secrets: [ENCRYPTED, PLAINTEXT],
        records: [
          { ts: 'x', level: 'info', scope: 's', msg: 'stored', stored: ENCRYPTED } as never
        ]
      })
    )
    expect(text).not.toContain(ENCRYPTED)
  })

  it('scrubs a secret nested inside a record field', () => {
    const text = serializeDiagnostics(
      input({
        secrets: [PLAINTEXT],
        records: [
          {
            ts: 'x',
            level: 'error',
            scope: 's',
            msg: 'failed',
            err: { name: 'Error', message: `key=${PLAINTEXT}`, stack: `at f (${PLAINTEXT})` }
          } as never
        ]
      })
    )
    expect(text).not.toContain(PLAINTEXT)
  })

  it('ignores trivially short secrets so ordinary text survives', () => {
    const text = serializeDiagnostics(input({ secrets: ['ab'] }))
    expect(text).toContain('linux')
    expect(text).not.toContain('[REDACTED]')
  })

  it('produces parseable JSON after scrubbing', () => {
    const text = serializeDiagnostics(
      input({
        secrets: [PLAINTEXT],
        records: [{ ts: 'x', level: 'info', scope: 's', msg: `k=${PLAINTEXT}` }]
      })
    )
    expect(() => JSON.parse(text)).not.toThrow()
    expect(JSON.parse(text).app.version).toBe('1.0.0')
  })
})

describe('serializeDiagnostics — path redaction', () => {
  it('replaces the home directory with a placeholder', () => {
    const text = serializeDiagnostics(
      input({
        redactPaths: true,
        records: [{ ts: 'x', level: 'info', scope: 's', msg: 'read /home/alice/notes.txt' }]
      }),
      '/home/alice'
    )
    expect(text).not.toContain('/home/alice')
    expect(text).toContain('<HOME>')
  })

  it('replaces the library path, which is longer than the home path', () => {
    // Longest-match-first matters: a library path under the home directory would
    // otherwise be half-rewritten into '<HOME>/Kavita/Doujins'.
    const text = serializeDiagnostics(
      input({
        redactPaths: true,
        records: [
          { ts: 'x', level: 'info', scope: 's', msg: 'scan /home/alice/Kavita/Doujins/a.cbz' }
        ]
      }),
      '/home/alice'
    )
    expect(text).toContain('<LIBRARY>')
    expect(text).not.toContain('/home/alice/Kavita/Doujins')
  })

  it('leaves paths alone when redaction is off', () => {
    const text = serializeDiagnostics(
      input({
        redactPaths: false,
        records: [{ ts: 'x', level: 'info', scope: 's', msg: 'read /home/alice/notes.txt' }]
      }),
      '/home/alice'
    )
    expect(text).toContain('/home/alice/notes.txt')
  })
})
