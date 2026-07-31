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
    try {
      return await fn(event, ...args)
    } catch (error) {
      const errorId = newErrorId()
      const err = error instanceof Error ? error : new Error(String(error))
      log.error(`IPC handler failed: ${err.message}`, { err, errorId })
      return { success: false, error: err.message, errorId }
    }
  })
}
