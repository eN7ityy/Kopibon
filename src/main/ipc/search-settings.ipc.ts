import { handle } from './handle'
import { settingsRepo } from '../db/repositories/settings.repo'
import { blockedRepo } from '../db/repositories/blocked.repo'
import { tagCacheRepo } from '../db/repositories/tag-cache.repo'
import { resolveGalleryTags } from '../services/tag-resolver'
import { getApiClient } from '../services/api-client'
import { buildSearchQuery, matchDimEntries, type SearchDefaults } from '../services/search-query'
import { getLogger } from '../services/logger'

const log = getLogger('search-settings')

// ─── Autocomplete cache ───────────────────────────────────────────────────────

/**
 * Bounded, time-limited cache for tag autocomplete, mirroring the gallery
 * cache in api.ipc.ts.
 *
 * The search box's live-suggestion dropdown re-queries the same prefix
 * constantly — retyping after a backspace, or two callers (the search box and
 * the blocklist picker in Settings) typing the same common word — against an
 * endpoint limited to 30 requests/minute per IP. Map preserves insertion
 * order, which gives LRU eviction for free by re-inserting on every hit.
 */
const AUTOCOMPLETE_CACHE_MAX_ENTRIES = 200
const AUTOCOMPLETE_CACHE_TTL_MS = 5 * 60_000

interface CachedAutocomplete {
  value: Array<{ id: number; type: string; name: string; count: number }>
  cachedAt: number
}

const autocompleteCache = new Map<string, CachedAutocomplete>()

/** `type` is part of the key: an artist-only and an all-types query for the same text are different requests. */
function autocompleteCacheKey(query: string, type: string | null | undefined): string {
  return `${type ?? ''}:${query.toLowerCase()}`
}

function getCachedAutocomplete(key: string): CachedAutocomplete['value'] | undefined {
  const hit = autocompleteCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.cachedAt > AUTOCOMPLETE_CACHE_TTL_MS) {
    autocompleteCache.delete(key)
    return undefined
  }
  autocompleteCache.delete(key)
  autocompleteCache.set(key, hit)
  return hit.value
}

function setCachedAutocomplete(key: string, value: CachedAutocomplete['value']): void {
  autocompleteCache.delete(key)
  autocompleteCache.set(key, { value, cachedAt: Date.now() })
  while (autocompleteCache.size > AUTOCOMPLETE_CACHE_MAX_ENTRIES) {
    const oldest = autocompleteCache.keys().next()
    if (oldest.done) break
    autocompleteCache.delete(oldest.value)
  }
}

/**
 * Settings keys for the Search tab.
 *
 * Stored in `app_settings` as strings like every other setting, rather than in a
 * table of their own — they are plain scalars, and the blocked list is the only
 * part of this feature with real structure.
 */
export const SEARCH_SETTING_KEYS = {
  defaultQuery: 'searchDefaultQuery',
  sort: 'searchDefaultSort',
  language: 'searchDefaultLanguage',
  minPages: 'searchMinPages',
  minFavorites: 'searchMinFavorites',
  uploadedWithinDays: 'searchUploadedWithinDays',
  respectBlacklist: 'searchRespectBlacklist',
  /**
   * Opt-in, default off. This app's search history is adult-content-specific,
   * so recording it is something the user turns on rather than something they
   * have to notice and turn off. Gates only the *recent-searches* dropdown —
   * live tag autocomplete while typing is a stateless per-keystroke lookup
   * against nhentai's own tag database and stores nothing, so it is not tied
   * to this setting.
   */
  rememberRecentSearches: 'searchRememberRecent'
} as const

const VALID_SORTS = ['date', 'popular', 'popular-today', 'popular-week', 'popular-month']

export interface SearchSettings extends SearchDefaults {
  respectBlacklist: boolean
  rememberRecentSearches: boolean
}

/** Parse a stored string to a positive integer, or null when unset or unusable. */
function positiveInt(raw: string | null | undefined): number | null {
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function readSearchSettings(): SearchSettings {
  const sort = settingsRepo.get(SEARCH_SETTING_KEYS.sort)
  return {
    defaultQuery: settingsRepo.get(SEARCH_SETTING_KEYS.defaultQuery) || null,
    // An unrecognised sort would be rejected by the API with a 422, so fall back
    // rather than pass it through.
    sort: sort && VALID_SORTS.includes(sort) ? sort : 'date',
    language: settingsRepo.get(SEARCH_SETTING_KEYS.language) || null,
    minPages: positiveInt(settingsRepo.get(SEARCH_SETTING_KEYS.minPages)),
    minFavorites: positiveInt(settingsRepo.get(SEARCH_SETTING_KEYS.minFavorites)),
    uploadedWithinDays: positiveInt(settingsRepo.get(SEARCH_SETTING_KEYS.uploadedWithinDays)),
    respectBlacklist: settingsRepo.get(SEARCH_SETTING_KEYS.respectBlacklist) === 'true',
    rememberRecentSearches: settingsRepo.get(SEARCH_SETTING_KEYS.rememberRecentSearches) === 'true'
  }
}

export function registerSearchSettingsIpc(): void {
  // ─── Defaults ─────────────────────────────────────────────────────────────

  handle('searchSettings:get', async () => {
    return { success: true, data: readSearchSettings() }
  })

  handle('searchSettings:set', async (_event, patch: Partial<SearchSettings>) => {
    const writes: Record<string, string> = {}

    if (patch.defaultQuery !== undefined) {
      writes[SEARCH_SETTING_KEYS.defaultQuery] = (patch.defaultQuery ?? '').trim()
    }
    if (patch.sort !== undefined) {
      const sort = patch.sort ?? 'date'
      writes[SEARCH_SETTING_KEYS.sort] = VALID_SORTS.includes(sort) ? sort : 'date'
    }
    if (patch.language !== undefined) {
      writes[SEARCH_SETTING_KEYS.language] = (patch.language ?? '').trim()
    }
    if (patch.minPages !== undefined) {
      writes[SEARCH_SETTING_KEYS.minPages] = String(patch.minPages ?? 0)
    }
    if (patch.minFavorites !== undefined) {
      writes[SEARCH_SETTING_KEYS.minFavorites] = String(patch.minFavorites ?? 0)
    }
    if (patch.uploadedWithinDays !== undefined) {
      writes[SEARCH_SETTING_KEYS.uploadedWithinDays] = String(patch.uploadedWithinDays ?? 0)
    }
    if (patch.respectBlacklist !== undefined) {
      writes[SEARCH_SETTING_KEYS.respectBlacklist] = patch.respectBlacklist ? 'true' : 'false'
    }
    if (patch.rememberRecentSearches !== undefined) {
      writes[SEARCH_SETTING_KEYS.rememberRecentSearches] = patch.rememberRecentSearches
        ? 'true'
        : 'false'
    }

    settingsRepo.setAll(writes)
    return { success: true, data: readSearchSettings() }
  })

  // ─── Blocked values ───────────────────────────────────────────────────────

  handle('blocked:list', async () => {
    return { success: true, data: blockedRepo.list() }
  })

  /**
   * Add one or many values in one call.
   *
   * The dialog accepts several values at once, and doing them in a single call
   * keeps the list from re-rendering per entry.
   */
  handle(
    'blocked:add',
    async (_event, entries: Array<{ type: string; value: string; mode: string }>) => {
      const added = blockedRepo.addMany(entries)
      log.info(`Added ${added} blocked value(s) of ${entries.length} submitted`)
      return { success: true, data: { added, items: blockedRepo.list() } }
    }
  )

  handle('blocked:setMode', async (_event, id: number, mode: string) => {
    blockedRepo.setMode(id, mode)
    return { success: true, data: blockedRepo.list() }
  })

  handle('blocked:remove', async (_event, id: number) => {
    blockedRepo.remove(id)
    return { success: true, data: blockedRepo.list() }
  })

  // ─── Composed query, so the renderer never assembles syntax ───────────────

  /**
   * The query the API should actually receive.
   *
   * Composed here rather than in the renderer so the syntax rules and the blocked
   * list live in one place, and so the renderer cannot get out of step with what
   * is stored.
   */
  handle('searchSettings:buildQuery', async (_event, userQuery: string) => {
    const settings = readSearchSettings()
    const query = buildSearchQuery(userQuery ?? '', settings, blockedRepo.entries())
    return { success: true, data: { query, sort: settings.sort ?? 'date' } }
  })

  // ─── Tag resolution for dim mode ──────────────────────────────────────────

  /**
   * Resolve the tags for a page of search results, so the renderer can mark the
   * ones matching a `dim` entry.
   */
  handle(
    'tags:resolveForGalleries',
    async (_event, galleries: Array<{ id: number; tag_ids?: number[] }>) => {
      if (!Array.isArray(galleries) || galleries.length === 0) {
        return { success: true, data: {} }
      }
      const byGallery = await resolveGalleryTags(galleries)
      // A Map does not survive IPC structured cloning as a Map on the other side
      // in a usable form for our stores, so send a plain object.
      return { success: true, data: Object.fromEntries(byGallery) }
    }
  )

  /**
   * Decide which results to mark, and why.
   *
   * The matching runs here rather than in the renderer so the blocked list and
   * the rules stay together — the renderer only needs to know that a card is
   * marked and what matched.
   *
   * Resolving tags is best-effort: an unresolved result is simply not marked,
   * which is the safe direction. It shows something the user asked to
   * de-emphasise rather than hiding something they wanted.
   */
  handle(
    'search:evaluateResults',
    async (
      _event,
      galleries: Array<{ id: number; title?: string | null; tag_ids?: number[]; blacklisted?: boolean }>
    ) => {
      if (!Array.isArray(galleries) || galleries.length === 0) {
        return { success: true, data: {} }
      }

      const settings = readSearchSettings()
      const all = blockedRepo.entries()
      const dimEntries = all.filter((entry) => entry.mode === 'dim')

      /*
       * `exclude` entries are evaluated here too, which looks redundant given the
       * query already negates them — but only the /search endpoint takes a query.
       * The browse views (/galleries for latest, /galleries/popular) accept no
       * query at all, so on those an exclusion can only be applied to the results
       * after the fact. That gap is why "Hide the gallery" appeared to do nothing
       * while "Show it, but marked" worked: the default view never goes through
       * search.
       *
       * `matchDimEntries` only considers entries whose mode is 'dim', so the
       * exclude entries are recast before being passed in.
       */
      const excludeAsDim = all
        .filter((entry) => entry.mode === 'exclude')
        .map((entry) => ({ ...entry, mode: 'dim' as const }))

      const needsTags = [...dimEntries, ...excludeAsDim].some((entry) => entry.type !== 'text')
      const tagsByGallery = needsTags
        ? await resolveGalleryTags(galleries)
        : new Map<number, Array<{ type: string; name: string }>>()

      const out: Record<
        number,
        {
          matches: Array<{ type: string; value: string }>
          blacklisted: boolean
          excluded: boolean
        }
      > = {}

      for (const gallery of galleries) {
        const facts = {
          title: gallery.title ?? null,
          tags: tagsByGallery.get(gallery.id) ?? [],
          blacklisted: gallery.blacklisted
        }
        const matches = matchDimEntries(facts, dimEntries)
        const excluded = matchDimEntries(facts, excludeAsDim).length > 0
        const blacklisted = settings.respectBlacklist && gallery.blacklisted === true

        if (matches.length > 0 || blacklisted || excluded) {
          out[gallery.id] = { matches, blacklisted, excluded }
        }
      }

      return { success: true, data: out }
    }
  )

  handle('tags:autocomplete', async (_event, query: string, type?: string | null) => {
    const key = autocompleteCacheKey(query, type)
    const cached = getCachedAutocomplete(key)
    if (cached) return { success: true, data: cached }

    const results = await getApiClient().searchTags(query, { type, limit: 15 })
    const data = results.map((tag) => ({
      id: tag.id,
      type: tag.type,
      name: tag.name,
      count: tag.count
    }))
    setCachedAutocomplete(key, data)
    return { success: true, data }
  })

  handle('tags:cacheStats', async () => {
    return { success: true, data: { cached: tagCacheRepo.count() } }
  })
}
