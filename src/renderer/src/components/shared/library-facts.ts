import type { DownloadStatus } from '../../types/api.types'
import { displayLanguage } from './language'

/**
 * What the library knows about a gallery we may or may not own.
 *
 * Search and Favorites each already called `library.getByGalleryId` once per
 * card to work out the download status, then threw the rest of the row away.
 * Format, artist and language were all sitting in that response, so putting them
 * on the card costs no additional request — the two pages just needed to stop
 * discarding them.
 */
export interface LibraryFacts {
  status: DownloadStatus
  format: string | null
  artist: string | null
  language: string | null
}

export const UNOWNED: LibraryFacts = {
  status: 'not_downloaded',
  format: null,
  artist: null,
  language: null
}

/**
 * Resolve facts for a page of galleries.
 *
 * The library is the source of truth for whether something is on disk:
 * `isCustom === 2` is a placeholder written when a download starts, anything
 * else with a row is on disk.
 */
export async function resolveLibraryFacts(
  ids: number[]
): Promise<Record<number, LibraryFacts>> {
  const out: Record<number, LibraryFacts> = {}

  await Promise.all(
    ids.map(async (id) => {
      try {
        const result = await window.api.library.getByGalleryId(id)
        if (!result.success || !result.data) {
          out[id] = UNOWNED
          return
        }
        const item = result.data
        out[id] = {
          status: item.isCustom === 2 ? 'downloading' : 'in_library',
          // A placeholder has no file yet, so its format is not a fact.
          format: item.isCustom === 2 ? null : item.format || null,
          artist: item.primaryArtist || null,
          // `language` is null on every row in practice; `customLanguage` holds
          // the real value, in several different shapes. See displayLanguage().
          language: displayLanguage(item.language, item.customLanguage)
        }
      } catch {
        out[id] = UNOWNED
      }
    })
  )

  return out
}
