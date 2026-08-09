import { describe, it, expect } from 'vitest'
import { basename, dirname, join } from 'path'
import { tempSiblingPath, truncateToBytes } from './temp-path'

/**
 * The reported failure, from the application log:
 *
 *   ENAMETOOLONG: name too long, open '.../母娘催●〜…[nhentai-625548].cbz.part'
 *
 * The .cbz name is 251 bytes and fits; appending '.part' makes it 256, one byte
 * over. The title is 99 characters — Japanese text is three bytes per character
 * in UTF-8, so a name that looks short is already at the limit.
 */

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

/** A basename of exactly `n` bytes using 3-byte characters plus padding. */
function nameOfBytes(n: number): string {
  const cjk = '母'.repeat(Math.floor(n / 3))
  return cjk + 'a'.repeat(n - bytes(cjk))
}

describe('truncateToBytes', () => {
  it('leaves a string that already fits', () => {
    expect(truncateToBytes('hello', 255)).toBe('hello')
  })

  it('never splits a multi-byte character', () => {
    // Cutting '母' (3 bytes) at 4 bytes must yield one character, not one and a
    // half — a partial sequence becomes U+FFFD, which is itself 3 bytes and
    // could push the name back over the limit.
    const out = truncateToBytes('母母母', 4)
    expect(out).toBe('母')
    expect(bytes(out)).toBeLessThanOrEqual(4)
    expect(out).not.toContain('�')
  })

  it('keeps surrogate pairs intact', () => {
    // '𠮷' is one code point spanning two UTF-16 units and four UTF-8 bytes.
    // Indexing by .length would cut it in half.
    expect(truncateToBytes('𠮷𠮷', 5)).toBe('𠮷')
    expect(truncateToBytes('𠮷𠮷', 3)).toBe('')
  })

  it('handles a zero budget', () => {
    expect(truncateToBytes('母', 0)).toBe('')
  })
})

describe('tempSiblingPath — the reported case', () => {
  /*
   * Built with join() rather than written as a literal, and every path below
   * is assembled the same way.
   *
   * tempSiblingPath returns path.join(dir, name), which is separator-native:
   * backslashes on Windows. That is correct behaviour there — the bug is an
   * expectation hardcoded to POSIX, which can only ever match on POSIX. Three
   * assertions here failed the first time the suite ran on Windows in CI,
   * comparing '\mnt\...' against '/mnt/...'. Routing the expected values
   * through the same module the implementation uses makes them agree on both.
   */
  const dir = join('/mnt', 'bragi', 'Kavita', 'Doujins', 'a', '長い名前')

  it('appends plainly when there is room', () => {
    const finalPath = join(dir, 'short.cbz')
    expect(tempSiblingPath(finalPath)).toBe(join(dir, 'short.cbz.part'))
  })

  it('fits a name that is one byte over, as the real file was', () => {
    // 251-byte name: '.part' would make it 256.
    const name = `${nameOfBytes(247)}.cbz`
    expect(bytes(name)).toBe(251)
    expect(bytes(name + '.part')).toBe(256)

    const temp = tempSiblingPath(join(dir, name))
    expect(bytes(basename(temp))).toBeLessThanOrEqual(255)
  })

  it('always stays within the limit, at every length around the boundary', () => {
    for (let n = 240; n <= 255; n++) {
      const temp = tempSiblingPath(join(dir, nameOfBytes(n)))
      expect(bytes(basename(temp))).toBeLessThanOrEqual(255)
    }
  })

  it('keeps the temp file in the same directory, so the rename stays atomic', () => {
    const finalPath = join(dir, nameOfBytes(254))
    expect(dirname(tempSiblingPath(finalPath))).toBe(dir)
  })

  it('still ends with the suffix when shortened', () => {
    const temp = tempSiblingPath(join(dir, nameOfBytes(254)))
    expect(temp.endsWith('.part')).toBe(true)
  })

  it('gives two different long names two different temp paths', () => {
    // They truncate to the same prefix, so only the hash separates them. A
    // collision would have one conversion overwrite another's part file.
    const a = join(dir, `${nameOfBytes(250)}aaa.cbz`)
    const b = join(dir, `${nameOfBytes(250)}bbb.cbz`)
    expect(tempSiblingPath(a)).not.toBe(tempSiblingPath(b))
  })

  it('is stable for the same input', () => {
    const finalPath = join(dir, nameOfBytes(254))
    expect(tempSiblingPath(finalPath)).toBe(tempSiblingPath(finalPath))
  })

  it('honours a different suffix', () => {
    expect(tempSiblingPath(join('/x', 'y.pdf'), '.tmp')).toBe(join('/x', 'y.pdf.tmp'))
    const long = tempSiblingPath(join('/x', nameOfBytes(254)), '.tmp')
    expect(long.endsWith('.tmp')).toBe(true)
    expect(bytes(basename(long))).toBeLessThanOrEqual(255)
  })
})
