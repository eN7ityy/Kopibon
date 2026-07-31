/**
 * Thin logger for worker threads.
 *
 * Workers cannot share the main-process file handle, and they cannot import
 * the main logger (which depends on Electron's `app`). Instead they post log
 * records to the main thread, which writes them through the singleton logger
 * via `writeRecord()`.
 *
 * The per-run scan-*.log and convert-*.log files are still written directly
 * by the workers that own them — those are job-specific and useful for long
 * jobs. The records forwarded here reach the main log so everything is in one
 * place, tagged with the same jobId.
 */

import { parentPort } from 'worker_threads'
import type { LogRecord } from './logger'

export interface WorkerLogger {
  error(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
}

/**
 * Create a logger that forwards records to the main process.
 *
 * @param scope   Subsystem name, e.g. 'worker:convert-cbz'
 * @param jobId   Identifier for the current job, so all records from one
 *                scan or conversion can be pulled out together
 */
export function createWorkerLogger(
  scope: string,
  jobId?: string
): WorkerLogger {
  function send(
    level: LogRecord['level'],
    msg: string,
    fields?: Record<string, unknown>
  ): void {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(jobId ? { jobId } : {}),
      ...(fields ? fields : {})
    }
    try {
      parentPort?.postMessage({ type: 'log', record })
    } catch {
      // Parent may be gone — nothing we can do
    }
  }

  return {
    error: (msg, fields) => send('error', msg, fields),
    warn: (msg, fields) => send('warn', msg, fields),
    info: (msg, fields) => send('info', msg, fields),
    debug: (msg, fields) => send('debug', msg, fields)
  }
}
