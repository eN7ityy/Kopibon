import { basename, join, relative, isAbsolute } from 'path'
import { settingsRepo } from '../db/repositories/settings.repo'
import { decryptKey } from '../ipc/auth.ipc'
import { getLogger } from './logger'

/**
 * Kavita API client.
 *
 * A deliberately thin wrapper around the handful of Kavita endpoints the app
 * needs. Everything is read from `settingsRepo` at call time rather than from
 * constructor args, so a config change takes effect on the very next call
 * without a restart.
 *
 * Auth is the `x-api-key` header (Kavita's mechanism — auth keys are generated
 * under User Settings → Manage Auth Keys), not a Bearer token.
 *
 * The UI-facing methods (`testConnection`, `getLibraries`) accept the form's
 * current URL/API key as optional overrides, because the settings pane tests
 * values that are not persisted to the database until the user clicks Save.
 * Without the overrides they would silently validate whatever was last saved.
 *
 * Fire-and-forget methods (`scanFolder`, `scanSeries`, `deleteSeries`) swallow
 * every failure internally: the file operations they follow are already done
 * and correct, so a dead Kavita must never surface to the user. UI-facing
 * methods carry their outcome back instead (`testConnection` returns the error
 * in-band; `getLibraries` throws so the IPC wrapper can turn it into
 * `{ success: false, error }` for the renderer).
 */

const log = getLogger('kavita')

/** A library as returned by GET /api/Library/libraries. */
export interface KavitaLibrary {
  id: number
  name: string
  /** Friendly type name (e.g. "Manga", "Comic") — the API sends an integer. */
  type: string
  /** Root folders Kavita scans for this library. */
  folders: string[]
}

/**
 * Kavita sends `type` as an integer enum; map it to a readable label.
 * 0 Manga · 1 Comic · 2 Book · 3 Image · 4 Light Novel · 5 Comic
 */
const LIBRARY_TYPE_NAMES: Record<number, string> = {
  0: 'Manga',
  1: 'Comic',
  2: 'Book',
  3: 'Image',
  4: 'Light Novel',
  5: 'Comic'
}

/**
 * Kavita sends `format` as an integer enum; map it to a readable label.
 * 0 Image · 1 Archive · 2 Unknown · 3 EPUB · 4 PDF
 */
const MANGA_FORMAT_NAMES: Record<number, string> = {
  0: 'Image',
  1: 'Archive',
  2: 'Unknown',
  3: 'EPUB',
  4: 'PDF'
}

/** Kavita detail for a library item's matching series, for the detail panel. */
export interface KavitaSeriesDetail {
  id: number
  name: string
  /** Kavita library id — part of the web URL (library/{id}/series/{seriesId}). */
  libraryId: number
  libraryName: string
  /** Number of pages Kavita counted for the series. */
  pageCount: number
  /**
   * The chapter that owns the item's file, when the item is a file inside the
   * series. Present only when the file was found among the series' chapters —
   * it lets the web link point at the reader, not the series page.
   */
  chapterId?: number
  /** Kavita's chapter label (often just the number), for the chapter row. */
  chapterTitle?: string
  /**
   * Number of chapters in the series. Present only when the item's file was
   * matched to a chapter; >1 means the item is part of a proper series (2+
   * galleries) rather than a standalone file.
   */
  chapterCount?: number
  /** Friendly format label ("Archive", "PDF", …). */
  format: string
  /** ISO timestamp of the last chapter/file Kavita added. */
  lastUpdated?: string
  /** The user's own read progress, when they have read anything. */
  pagesRead?: number
  totalReads?: number
}

/** A series-type hit from GET /api/Search/search. */
export interface KavitaSeriesResult {
  id: number
  name: string
}

/** Outcome of a connection test against GET /api/Account. */
export interface KavitaTestResult {
  ok: boolean
  /** The server's `kavitaVersion`, when the account call succeeded. */
  version?: string
  /** The authenticated user's username, for a "Connected as …" readout. */
  username?: string
  error?: string
}

/** How long to wait on any Kavita call before giving up. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Cache for the status bar's Kavita file count.
 *
 * There is no per-library file-count endpoint, so the count uses the server's
 * `chapterCount` (one chapter per file) from /api/Stats/server/stats — a single
 * fast request. On a single-library server that is exactly the library's file
 * count. The result is cached and invalidated when a scan or delete changes the
 * library.
 */
interface ItemCountCache {
  count: number | null
  fetchedAt: number
}
const itemCountCache: ItemCountCache = { count: null, fetchedAt: 0 }
/** Serve the cached count for this long before refetching. */
const ITEM_COUNT_STALE_MS = 60_000

interface KavitaConfig {
  url: string
  apiKey: string
  libraryId: string
}

class KavitaClient {
  /**
   * Resolve the effective config, trimmed and with a trailing slash stripped.
   *
   * Explicitly provided values win; anything not provided falls back to the
   * persisted settings, so the fire-and-forget integration points always use
   * the saved config while the settings pane can test unsaved form values.
   *
   * The persisted API key is decrypted here — this is the one reader that
   * goes straight to `settingsRepo`, bypassing the settings IPC layer that
   * otherwise handles that transparently. An explicit override is never
   * decrypted: it is always a plaintext value the caller already has in
   * hand, typically the settings pane's live, unsaved form field.
   */
  private readConfig(overrides?: Partial<KavitaConfig>): KavitaConfig {
    return {
      url: ((overrides?.url ?? settingsRepo.get('kavitaUrl')) || '')
        .trim()
        .replace(/\/+$/, ''),
      apiKey: (overrides?.apiKey ?? decryptKey(settingsRepo.get('kavitaApiKey') || '')).trim(),
      libraryId: ((overrides?.libraryId ?? settingsRepo.get('kavitaLibraryId')) || '').trim()
    }
  }

  /**
   * True when a scan or delete can actually be issued: the "Enable Kavita
   * integration" checkbox is on, and URL, API key and library id are all
   * present.
   *
   * The checkbox used to be decorative — every write path checked URL/key/
   * library alone, so unchecking it and leaving the fields filled in (the
   * normal way to pause the integration without re-entering the key later)
   * did not stop anything. It still does not gate the settings pane's own
   * test-connection and find-libraries calls, which pass their own overrides
   * and call the endpoints directly — you need to be able to finish setting
   * up a connection before switching it on.
   */
  isConfigured(): boolean {
    if (settingsRepo.get('kavitaEnabled') !== 'true') return false
    const { url, apiKey, libraryId } = this.readConfig()
    return Boolean(url && apiKey && libraryId)
  }

  /**
   * Issue a request against the configured Kavita server and return the raw
   * Response, so callers can read headers (e.g. the series-count `Pagination`
   * header). Throws on anything but a 2xx, so callers decide how to treat a
   * failure (in-band for `testConnection`, via the IPC wrapper for
   * `getLibraries`, swallowed for the fire-and-forget methods).
   */
  private async rawRequest(
    path: string,
    options?: { method?: string; body?: unknown },
    config: KavitaConfig = this.readConfig()
  ): Promise<Response> {
    const { url, apiKey } = config
    if (!url || !apiKey) {
      throw new Error('Kavita is not configured (URL or API key missing)')
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-api-key': apiKey
    }
    const fetchOptions: RequestInit = {
      method: options?.method ?? 'GET',
      headers
    }
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      fetchOptions.body = JSON.stringify(options.body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${url}${path}`, {
        ...fetchOptions,
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`Kavita returned ${response.status} ${response.statusText}`)
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Parse a JSON response body. Throws on anything but a 2xx (via rawRequest).
   *
   * Some endpoints (scan-folder, scan-series) answer 200 with an empty body;
   * an empty response resolves to undefined rather than tripping over
   * JSON.parse('').
   */
  private async request<T>(
    path: string,
    options?: { method?: string; body?: unknown },
    config: KavitaConfig = this.readConfig()
  ): Promise<T> {
    const response = await this.rawRequest(path, options, config)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  /**
   * Validate the configured URL + API key by calling GET /api/Account.
   *
   * Never throws — failures come back as `{ ok: false, error }` so the settings
   * pane can render them without relying on the IPC wrapper.
   */
  async testConnection(url?: string, apiKey?: string): Promise<KavitaTestResult> {
    const config = this.readConfig({ url, apiKey })
    try {
      const user = await this.request<{
        kavitaVersion?: string | null
        username?: string | null
      }>('/api/Account', undefined, config)
      return {
        ok: true,
        version: user?.kavitaVersion || undefined,
        username: user?.username || undefined
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('connection test failed', { error: message })
      return { ok: false, error: message }
    }
  }

  /**
   * List every library on the server.
   *
   * Accepts the form's current URL/API key so the settings pane can list
   * libraries before saving. Throws on a network/HTTP failure so the IPC
   * wrapper surfaces a real error to the renderer's "Find Libraries" flow.
   */
  async getLibraries(url?: string, apiKey?: string): Promise<KavitaLibrary[]> {
    const config = this.readConfig({ url, apiKey })
    const libraries = await this.request<
      Array<{
        id: number
        name?: string | null
        type?: number | null
        folders?: string[] | null
      }>
    >('/api/Library/libraries', undefined, config)
    return (libraries ?? []).map((lib) => ({
      id: lib.id,
      name: lib.name || '',
      type: lib.type != null ? (LIBRARY_TYPE_NAMES[lib.type] ?? '') : '',
      folders: lib.folders ?? []
    }))
  }

  /**
   * Number of files Kavita has indexed (one chapter per file), for the status
   * bar. Uses the server's `chapterCount` from /api/Stats/server/stats — a
   * single fast request, so the bar never sits on 0 while a slow full walk
   * would run. On a single-library server this is exactly the library's file
   * count. Never throws; returns null when unconfigured or unreadable.
   */
  async getItemCount(url?: string, apiKey?: string): Promise<number | null> {
    // Same enabled check as isConfigured(). This does not call isConfigured()
    // itself only because it needs the override-aware config right after.
    if (settingsRepo.get('kavitaEnabled') !== 'true') return null
    const config = this.readConfig({ url, apiKey })
    if (!config.url || !config.apiKey || !config.libraryId) return null

    if (
      itemCountCache.count != null &&
      Date.now() - itemCountCache.fetchedAt < ITEM_COUNT_STALE_MS
    ) {
      return itemCountCache.count
    }

    try {
      const stats = await this.request<{ chapterCount?: number }>(
        '/api/Stats/server/stats',
        undefined,
        config
      )
      const count = typeof stats?.chapterCount === 'number' ? stats.chapterCount : null
      if (count != null) {
        itemCountCache.count = count
        itemCountCache.fetchedAt = Date.now()
      }
      return count
    } catch (err) {
      log.warn('Kavita item count failed', {
        error: err instanceof Error ? err.message : String(err)
      })
      return itemCountCache.count
    }
  }

  /**
   * Mark the cached count stale so the next read refetches it. Called after a
   * scan or delete so the status bar catches up without waiting for the TTL.
   */
  private markItemCountStale(): void {
    if (itemCountCache.count != null) itemCountCache.fetchedAt = 0
  }

  /**
   * Tell Kavita to scan a folder. Fire-and-forget: never throws.
   *
   * POST /api/Library/scan-folder { folderPath, apiKey } — this endpoint reads
   * the auth key from the body's `apiKey` field, not just the header, and it
   * only recognises Kavita's own folder paths, so the app path is translated
   * first.
   */
  async scanFolder(folderPath: string): Promise<void> {
    const config = this.readConfig()
    if (!config.url || !config.apiKey || !config.libraryId) return
    const kavitaPath = this.translateToKavitaPath(folderPath)
    try {
      // rawRequest: scan-folder answers 200 with an empty body, so there is no
      // response JSON to parse — only the status matters.
      await this.rawRequest(
        '/api/Library/scan-folder',
        { method: 'POST', body: { folderPath: kavitaPath, apiKey: config.apiKey } },
        config
      )
      log.info('requested a Kavita folder scan', { folderPath: kavitaPath })
      this.markItemCountStale()
    } catch (err) {
      log.warn('Kavita folder scan failed', {
        folderPath: kavitaPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Translate an app-side folder path into the path Kavita knows.
   *
   * The app writes under its own libraryPath (e.g. /mnt/bragi/Kavita/Doujins/)
   * while Kavita scans from its own kavitaLibraryRoot (e.g. /kavita/doujins) —
   * two mount points for the same files. The relative part is preserved and
   * re-rooted under Kavita's root. Falls back to the input when the path is not
   * under the app's library path.
   */
  private translateToKavitaPath(folderPath: string): string {
    const appRoot = (settingsRepo.get('libraryPath') || '').trim().replace(/\/+$/, '')
    const kavitaRoot = (settingsRepo.get('kavitaLibraryRoot') || '').trim().replace(/\/+$/, '')
    const normalized = folderPath.trim().replace(/\/+$/, '')
    if (!appRoot || !kavitaRoot || !normalized) return normalized
    const rel = relative(appRoot, normalized)
    if (rel === '') return kavitaRoot
    if (rel.startsWith('..') || isAbsolute(rel)) return normalized
    return join(kavitaRoot, rel)
  }

  /**
   * Tell Kavita to rescan a series. Fire-and-forget: never throws.
   *
   * POST /api/Series/scan { seriesId, libraryId }
   */
  async scanSeries(seriesId: number): Promise<void> {
    const { libraryId } = this.readConfig()
    if (!libraryId) return
    try {
      await this.request('/api/Series/scan', {
        method: 'POST',
        body: { seriesId, libraryId: Number(libraryId) }
      })
      log.info('requested a Kavita series scan', { seriesId })
      this.markItemCountStale()
    } catch (err) {
      log.warn('Kavita series scan failed', {
        seriesId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Search Kavita for a series by name, returning only series-type hits.
   *
   * GET /api/Search/search?queryString={name} — the response groups entities by
   * kind, so the `series` array is already series-only. Never throws; a failure
   * yields an empty list (callers run this inside their own fire-and-forget
   * block).
   */
  async searchSeries(name: string, url?: string, apiKey?: string): Promise<KavitaSeriesResult[]> {
    const config = this.readConfig({ url, apiKey })
    if (!config.url || !config.apiKey) return []
    try {
      const params = new URLSearchParams({ queryString: name })
      const result = await this.request<{
        series?: Array<{ seriesId: number; name?: string | null }>
      }>(`/api/Search/search?${params.toString()}`, undefined, config)
      return (result?.series ?? []).map((s) => ({
        id: s.seriesId,
        name: s.name || ''
      }))
    } catch (err) {
      log.warn('Kavita series search failed', {
        name,
        error: err instanceof Error ? err.message : String(err)
      })
      return []
    }
  }

  /**
   * Fetch one series' detail. Never throws; returns null when unconfigured,
   * unreachable, or the series no longer exists.
   *
   * GET /api/Series/{seriesId}
   */
  async getSeries(
    seriesId: number,
    url?: string,
    apiKey?: string
  ): Promise<KavitaSeriesDetail | null> {
    const config = this.readConfig({ url, apiKey })
    try {
      const s = await this.request<{
        id: number
        name?: string | null
        pages?: number
        format?: number
        libraryId?: number
        libraryName?: string | null
        lastChapterAdded?: string
        pagesRead?: number
        totalReads?: number
      }>(`/api/Series/${seriesId}`, undefined, config)
      return {
        id: s.id,
        name: s.name || '',
        libraryId: s.libraryId ?? 0,
        libraryName: s.libraryName || '',
        pageCount: s.pages ?? 0,
        format: s.format != null ? (MANGA_FORMAT_NAMES[s.format] ?? 'Unknown') : 'Unknown',
        lastUpdated: s.lastChapterAdded || undefined,
        pagesRead: s.pagesRead,
        totalReads: s.totalReads
      }
    } catch (err) {
      log.warn('Kavita series detail failed', {
        seriesId,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  /**
   * Find the Kavita series matching a title and return its detail.
   *
   * Searches by name and prefers an exact case-insensitive match, falling back
   * to the first hit. Never throws; returns null when nothing matches.
   */
  async findSeriesDetail(
    seriesName: string,
    title: string,
    url?: string,
    apiKey?: string,
    filePath?: string
  ): Promise<KavitaSeriesDetail | null> {
    // A gallery inside a series is indexed under the series name in Kavita
    // ("Teyvat Gravure"), not under the chapter title, so searching by the
    // item's own title finds nothing. Search by the series name first and fall
    // back to the item title for standalone files.
    let results: KavitaSeriesResult[] = []
    const name = (seriesName || '').trim()
    if (name) results = await this.searchSeries(name, url, apiKey)
    const fallback = (title || '').trim()
    if (results.length === 0 && fallback) {
      results = await this.searchSeries(fallback, url, apiKey)
    }
    if (results.length === 0) return null

    const exactTarget = name || fallback
    const match =
      results.find((r) => r.name.toLowerCase() === exactTarget.toLowerCase()) ?? results[0]
    const detail = await this.getSeries(match.id, url, apiKey)
    if (detail && filePath) {
      // The item is a file inside the series, so resolve the chapter that owns
      // it — the web link can then point at the reader, not the series page.
      const chapter = await this.findChapter(match.id, filePath, url, apiKey)
      if (chapter) {
        detail.chapterId = chapter.id
        detail.chapterTitle = chapter.title
        detail.chapterCount = chapter.chapterCount
      }
    }
    return detail
  }

  /**
   * The chapter that owns a given file within a series.
   *
   * GET /api/Series/volumes returns the volumes with their chapters and each
   * chapter's files; the file's basename is matched against them. Returns
   * undefined when nothing matches or the server is unreachable.
   */
  private async findChapter(
    seriesId: number,
    filePath: string,
    url?: string,
    apiKey?: string
  ): Promise<{ id: number; title?: string; chapterCount: number } | undefined> {
    const config = this.readConfig({ url, apiKey })
    if (!config.url || !config.apiKey) return undefined
    const needle = basename(filePath).toLowerCase()
    try {
      const volumes = await this.request<
        Array<{
          chapters?: Array<{
            id: number
            title?: string | null
            files?: Array<{ filePath?: string | null }>
          }>
        }>
      >(`/api/Series/volumes?seriesId=${seriesId}`, undefined, config)
      let chapterCount = 0
      let match: { id: number; title?: string } | undefined
      for (const volume of volumes ?? []) {
        const chapters = volume.chapters ?? []
        chapterCount += chapters.length
        if (!match) {
          for (const chapter of chapters) {
            for (const file of chapter.files ?? []) {
              if (file.filePath && basename(file.filePath).toLowerCase() === needle) {
                match = { id: chapter.id, title: chapter.title || undefined }
                break
              }
            }
            if (match) break
          }
        }
      }
      if (!match) return undefined
      return { ...match, chapterCount }
    } catch (err) {
      log.warn('Kavita chapter lookup failed', {
        seriesId,
        error: err instanceof Error ? err.message : String(err)
      })
      return undefined
    }
  }

  /**
   * Delete a series from Kavita's database (files on disk are untouched).
   * Fire-and-forget: never throws.
   *
   * DELETE /api/Series/{seriesId}
   */
  async deleteSeries(seriesId: number): Promise<void> {
    try {
      await this.request(`/api/Series/${seriesId}`, { method: 'DELETE' })
      log.info('deleted a series from Kavita', { seriesId })
      this.markItemCountStale()
    } catch (err) {
      log.warn('Kavita series delete failed', {
        seriesId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Delete several series from Kavita at once. Fire-and-forget: never throws.
   *
   * POST /api/Series/delete-multiple { seriesIds }
   */
  async deleteMultipleSeries(seriesIds: number[], url?: string, apiKey?: string): Promise<void> {
    const ids = seriesIds.filter((id) => Number.isInteger(id) && id > 0)
    if (ids.length === 0) return
    try {
      await this.request(
        '/api/Series/delete-multiple',
        { method: 'POST', body: { seriesIds: ids } },
        this.readConfig({ url, apiKey })
      )
      log.info('deleted series from Kavita', { count: ids.length })
      this.markItemCountStale()
    } catch (err) {
      log.warn('Kavita series delete-multiple failed', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Delete the Kavita series corresponding to the given library items.
   *
   * Each item is matched to a Kavita series by name (its series name first, the
   * item title as a fallback), deduplicated, and deleted in one call. Fire-and-
   * forget: never throws.
   *
   * Requires an exact case-insensitive name match. Kavita's search is a
   * substring match rather than a similarity ranking, so on a library of any
   * size it will readily return an unrelated series for a query that shares a
   * common word — "Volume", a character name, anything generic. Falling back
   * to "the first hit" the way the rescan path does would mean an unrelated
   * series' reading progress and collections get deleted from Kavita because
   * *this* item's name didn't happen to match anything. An item with no exact
   * match in Kavita is simply left alone; it is logged so a miss is visible.
   */
  async deleteItemsFromKavita(
    items: Array<{ title?: string | null; seriesName?: string | null }>,
    url?: string,
    apiKey?: string
  ): Promise<void> {
    const ids = new Set<number>()
    for (const item of items) {
      const id = await this.findSeriesIdForItem(item.title, item.seriesName, url, apiKey, true)
      if (id != null) {
        ids.add(id)
      } else {
        log.warn('Kavita delete skipped: no exact-name series match', {
          title: (item.title || '').trim() || null,
          seriesName: (item.seriesName || '').trim() || null
        })
      }
    }
    const seriesIds = [...ids]
    if (seriesIds.length === 0) return
    if (seriesIds.length === 1) {
      await this.deleteSeries(seriesIds[0])
    } else {
      await this.deleteMultipleSeries(seriesIds, url, apiKey)
    }
  }

  /**
   * Best-matching Kavita series id for a library item, by name.
   *
   * `requireExactMatch` decides what happens when nothing matches exactly:
   *
   * - false (the default) — falls back to the first search hit. Safe for a
   *   rescan, which is idempotent: guessing wrong just re-indexes a series
   *   that was already correct, at worst wasting one scan.
   * - true — returns null instead. Kavita's search is a general substring
   *   match, not a similarity ranking, so "no exact hit" can mean the query
   *   matched an unrelated series that happens to share a word. That is an
   *   acceptable guess to scan; it is not an acceptable guess to delete.
   *   `deleteItemsFromKavita` passes true for exactly this reason.
   */
  private async findSeriesIdForItem(
    title?: string | null,
    seriesName?: string | null,
    url?: string,
    apiKey?: string,
    requireExactMatch = false
  ): Promise<number | null> {
    const name = (seriesName || '').trim()
    let results = name ? await this.searchSeries(name, url, apiKey) : []
    const fallback = (title || '').trim()
    if (results.length === 0 && fallback) {
      results = await this.searchSeries(fallback, url, apiKey)
    }
    if (results.length === 0) return null
    const exactTarget = name || fallback
    const exact = results.find((r) => r.name.toLowerCase() === exactTarget.toLowerCase())
    if (exact) return exact.id
    return requireExactMatch ? null : results[0].id
  }

  /**
   * Rescan the Kavita series that best matches a library item, by name.
   *
   * The series is resolved exactly the way `findSeriesIdForItem` does it —
   * series name first, the item title as a fallback, an exact case-insensitive
   * match preferred, otherwise the first hit. An item whose stored series name
   * differs slightly from Kavita's (or which has no series name at all) still
   * gets its series scanned. Fire-and-forget: never throws; logs a warning when
   * nothing matched so a miss is diagnosable from the logs.
   */
  async scanSeriesForLibraryItem(
    title?: string | null,
    seriesName?: string | null
  ): Promise<void> {
    const id = await this.findSeriesIdForItem(title, seriesName)
    if (id == null) {
      log.warn('Kavita series scan skipped: no matching series found', {
        seriesName: (seriesName || '').trim() || null,
        title: (title || '').trim() || null
      })
      return
    }
    await this.scanSeries(id)
  }
}

let instance: KavitaClient | null = null

/** Singleton getter — the client holds no config, so one instance is enough. */
export function getKavitaClient(): KavitaClient {
  if (!instance) instance = new KavitaClient()
  return instance
}
