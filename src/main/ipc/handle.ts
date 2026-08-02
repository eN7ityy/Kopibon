/**
 * IPC handler wrapper (§1.4).
 *
 * Every `ipcMain.handle()` call that returns the app's standard
 * `{success, data?, error?, errorId?}` envelope should go through this
 * helper rather than writing its own try/catch. The wrapper:
 *
 * 1. Logs every failure with the channel name as scope and a fresh errorId.
 * 2. Returns `{success: false, error, errorId}` so the UI can surface both.
 * 3. Passes through successful returns untouched.
 *
 * Usage (replaces `ipcMain.handle('chan', async (e, ...args) => { ... })`):
 *
 *   handle('download:addToQueue', async (_e, galleryId, format) => {
 *     const id = downloadRepo.insert({...})
 *     return { success: true, data: { id } }
 *   })
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getLogger, newErrorId } from '../services/logger'

/**
 * Channels currently executing, and since when.
 *
 * Kept so a freeze can be attributed. When the window stops responding, the
 * useful question is "what was the app doing" — and with every IPC call routed
 * through this wrapper, the answer is here. Reported by the watchdog in the
 * main entry point.
 */
const inFlight = new Map<string, number>()

/** In-flight channels with how long each has been running, longest first. */
export function inFlightHandlers(): Array<{ channel: string; ms: number }> {
  const now = Date.now()
  return [...inFlight.entries()]
    .map(([channel, startedAt]) => ({ channel, ms: now - startedAt }))
    .sort((a, b) => b.ms - a.ms)
}

/**
 * How long a handler may run before it is worth a log line.
 *
 * Main is single-threaded: a handler that blocks for this long has stalled
 * every other IPC call behind it, and the window with them. 250ms is under the
 * threshold at which a person notices, so anything logged here is a real
 * candidate rather than noise.
 */
const SLOW_HANDLER_MS = 250

export function handle<T>(
  channel: string,
  // `any[]` rather than `unknown[]`: handlers declare concrete parameter types
  // (`(_event, id: number)`), and a contravariant `unknown[]` would reject every
  // one of them. The disable has to sit on this line, not above the function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>
): void {
  const log = getLogger(channel)

  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now()
    inFlight.set(channel, startedAt)
    try {
      const result = await fn(event, ...args)
      const elapsed = Date.now() - startedAt
      // Worth knowing even when it succeeds: a slow handler is a frozen window
      // for exactly as long as it runs.
      if (elapsed >= SLOW_HANDLER_MS) {
        log.warn(`Slow IPC handler: ${elapsed}ms`, { channel, ms: elapsed })
      }
      return result
    } catch (error) {
      const errorId = newErrorId()
      const err = error instanceof Error ? error : new Error(String(error))
      log.error(`IPC handler failed: ${err.message}`, { err, errorId })
      return { success: false, error: err.message, errorId }
    } finally {
      inFlight.delete(channel)
    }
  })
}
