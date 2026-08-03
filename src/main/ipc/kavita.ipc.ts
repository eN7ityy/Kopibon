import { handle } from './handle'
import { getKavitaClient } from '../services/kavita-client'

/**
 * Kavita IPC handlers — settings-pane helpers only.
 *
 * The scan/delete operations are deliberately not exposed here: they are fired
 * server-side by the file-operation handlers that know which folder or series
 * changed. The renderer only needs the connection test and the library list.
 */
export function registerKavitaIpc(): void {
  /**
   * The renderer passes the form's current URL/API key, which may not be
   * persisted to the database yet — that happens on Save. Falling back to the
   * client's own settingsRepo read keeps these callable without arguments.
   */
  handle('kavita:testConnection', async (_event, url?: string, apiKey?: string) => {
    const result = await getKavitaClient().testConnection(url, apiKey)
    if (result.ok) {
      return {
        success: true,
        data: { serverVersion: result.version, username: result.username }
      }
    }
    return { success: false, error: result.error || 'Could not connect to Kavita' }
  })

  handle('kavita:getLibraries', async (_event, url?: string, apiKey?: string) => {
    // The client throws on a failed request so the wrapper turns it into
    // { success: false, error } for the renderer's inline error.
    const libraries = await getKavitaClient().getLibraries(url, apiKey)
    return { success: true, data: libraries }
  })

  handle('kavita:getItemCount', async (_event, url?: string, apiKey?: string) => {
    // Never throws — returns null when unconfigured or unreachable, which the
    // status bar treats as "hide the figure".
    const count = await getKavitaClient().getItemCount(url, apiKey)
    return { success: true, data: count }
  })

  /**
   * Detail for the Kavita series matching a library item's title.
   *
   * The client searches Kavita by name, picks the best match, then fetches the
   * series. Returns { success: true, data: null } when there is no match or the
   * server is unreachable, so the detail panel renders nothing.
   */
  handle(
    'kavita:getSeriesDetail',
    async (
      _event,
      seriesName: string,
      title: string,
      url?: string,
      apiKey?: string,
      filePath?: string
    ) => {
      const detail = await getKavitaClient().findSeriesDetail(
        seriesName,
        title,
        url,
        apiKey,
        filePath
      )
      return { success: true, data: detail }
    }
  )
}
