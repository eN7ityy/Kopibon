import { describe, it, expect } from 'vitest'
import { resolveOutputFormat, DEFAULT_OUTPUT_FORMAT } from './output-format'

/**
 * Regression cover for a bug that made the CBZ feature invisible: the Settings
 * dropdown wrote `outputFormat` to the database and nothing ever read it, so
 * every download was queued as PDF regardless of the setting.
 */
describe('resolveOutputFormat', () => {
  it('honours the persisted setting when no explicit choice is given', () => {
    // The actual reported bug: setting was 'cbz', downloads came out as PDF.
    expect(resolveOutputFormat(undefined, 'cbz')).toBe('cbz')
  })

  it('lets an explicit per-download choice win over the setting', () => {
    expect(resolveOutputFormat('pdf', 'cbz')).toBe('pdf')
    expect(resolveOutputFormat('cbz', 'pdf')).toBe('cbz')
  })

  it('falls back to CBZ when neither is provided', () => {
    expect(resolveOutputFormat()).toBe(DEFAULT_OUTPUT_FORMAT)
    expect(resolveOutputFormat(undefined, undefined)).toBe('cbz')
    expect(resolveOutputFormat(null, null)).toBe('cbz')
  })

  it('ignores unsupported values rather than passing them downstream', () => {
    // An unknown format would be recorded in the queue row while the manager
    // silently routed it to the PDF worker — a mismatch between the database
    // and the file on disk.
    expect(resolveOutputFormat('epub', 'cbz')).toBe('cbz')
    expect(resolveOutputFormat(undefined, 'epub')).toBe('cbz')
    expect(resolveOutputFormat('', '')).toBe('cbz')
    expect(resolveOutputFormat('PDF', undefined)).toBe('cbz') // case-sensitive by design
  })

  it('only ever returns a format the pipeline can produce', () => {
    const inputs = [undefined, null, '', 'pdf', 'cbz', 'epub', 'CBZ', 'zip', ' cbz ']
    for (const a of inputs) {
      for (const b of inputs) {
        expect(['pdf', 'cbz']).toContain(resolveOutputFormat(a, b))
      }
    }
  })
})
