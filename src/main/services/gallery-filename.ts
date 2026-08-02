import { truncateToBytes } from './temp-path'

/**
 * The `[nhentai-<id>]` marker in a library filename.
 *
 * The name is not decoration. The scanner reads the id back out of it, the
 * ComicInfo rewrite tool matches files by it, and it is how a person tells at a
 * glance which gallery a file came from. So attaching an id by hand has to
 * change the name too, and detaching a wrong one has to remove it — otherwise
 * the database and the disk disagree about what a file is.
 */

/** Matches the marker wherever it sits, since both placements exist on disk. */
const ID_MARKER = /\s*\[nhentai-\d+\]\s*/g

/**
 * Linux caps a single filename at 255 bytes. Japanese titles are three bytes a
 * character, so adding a marker can push a name that looked short over the
 * edge — the same trap that broke conversion on a 251-byte name.
 */
const MAX_NAME_BYTES = 255

/** Split `name.cbz` into `['name', '.cbz']`, with no extension giving `''`. */
function splitExtension(fileName: string): [string, string] {
  const dot = fileName.lastIndexOf('.')
  // A leading dot is a hidden file, not an extension.
  if (dot <= 0) return [fileName, '']
  return [fileName.slice(0, dot), fileName.slice(dot)]
}

/**
 * Rewrite a filename so it carries `galleryId`, or none when null.
 *
 * Any existing marker is removed first, wherever it sits, so re-attaching a
 * corrected id replaces the old one rather than leaving both. Collapses the
 * whitespace that removal leaves behind.
 *
 * The result is kept within the byte limit by trimming the stem, never the
 * marker: the marker is the part that has to survive, since it is what the
 * scanner and the rewrite tool read.
 */
export function applyGalleryIdToFilename(fileName: string, galleryId: number | null): string {
  const [rawStem, ext] = splitExtension(fileName)

  const stem = rawStem.replace(ID_MARKER, ' ').replace(/\s+/g, ' ').trim()
  const marker = galleryId != null ? ` [nhentai-${galleryId}]` : ''

  // Never produce an empty name: a file called only `[nhentai-123].cbz` after
  // detaching would have nothing left at all.
  const safeStem = stem || 'Untitled'

  const room = MAX_NAME_BYTES - Buffer.byteLength(marker + ext, 'utf8')
  return `${truncateToBytes(safeStem, room).trimEnd()}${marker}${ext}`
}
