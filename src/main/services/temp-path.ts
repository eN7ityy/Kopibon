import { createHash } from 'crypto'
import { basename, dirname, join } from 'path'

/**
 * Temporary sibling paths that fit inside the filesystem's name limit.
 *
 * Files are written to `<final>.part` and renamed into place, so an interrupted
 * write never leaves something that looks like a finished file. The catch is
 * that the suffix makes the name longer, and Linux limits a single name to 255
 * **bytes**, not characters.
 *
 * A real library file hit this exactly:
 *
 *   the .cbz name      251 bytes  — fits
 *   the .cbz.part name 256 bytes  — one byte over, ENAMETOOLONG
 *
 * 99 characters, but Japanese text is three bytes per character in UTF-8, so a
 * name that looks nowhere near a limit is already against it. Conversion and
 * metadata writes both failed on that one file and would have kept failing.
 */

/**
 * The per-name byte limit on every filesystem this app targets.
 *
 * ext4, btrfs, xfs, NTFS and APFS all sit at 255. It is the *name* that is
 * limited here, not the path, which is why only the basename is measured.
 *
 * The 255 means different units per filesystem: bytes on ext4 and friends,
 * UTF-16 code units on NTFS. Measuring bytes is the conservative reading,
 * because a string's UTF-8 length is never less than its UTF-16 length —
 * ASCII is 1:1, CJK is 3 bytes to 1 unit, astral planes 4 bytes to 2. So a
 * name that passes this check always fits NTFS too; the cost is that Windows
 * sometimes gets a hashed name where the plain one would have fitted. Do not
 * "fix" this by measuring characters: that would be unsafe on Linux, which is
 * where the ENAMETOOLONG above actually came from.
 */
const MAX_NAME_BYTES = 255

/** Bytes a string occupies as UTF-8. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Cut a string to at most `maxBytes`, never splitting a character.
 *
 * Iterates code points rather than slicing the buffer: cutting UTF-8 mid
 * sequence produces a replacement character, which would both corrupt the name
 * and, being three bytes itself, could leave it over the limit anyway.
 *
 * Iterating `[...value]` also keeps surrogate pairs — emoji, and some CJK
 * extension characters — intact, which indexing by `.length` would not.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value

  let out = ''
  let used = 0
  for (const char of value) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/**
 * A temporary path beside `finalPath`, guaranteed to fit.
 *
 * Normally just `<final><suffix>`, which keeps the temp file recognisable next
 * to the thing it will become. When that would exceed the limit the name is cut
 * down and a short hash of the final name is added, so the result still fits,
 * stays unique, and remains traceable to its target.
 *
 * Always in the same directory as the final file, so the rename that follows is
 * atomic rather than a cross-device copy.
 */
export function tempSiblingPath(finalPath: string, suffix = '.part'): string {
  const dir = dirname(finalPath)
  const name = basename(finalPath)

  const plain = name + suffix
  if (byteLength(plain) <= MAX_NAME_BYTES) return join(dir, plain)

  // Distinguishes two long names that truncate to the same prefix.
  const stamp = `.${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
  const room = MAX_NAME_BYTES - byteLength(stamp) - byteLength(suffix)
  return join(dir, `${truncateToBytes(name, room)}${stamp}${suffix}`)
}
