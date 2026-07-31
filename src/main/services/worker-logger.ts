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

import { parentPort, type Worker } from 'worker_threads'
import type { Logger, LogRecord } from './logger'

/**
 * The message workers post and the main process listens for.
 *
 * Declared once, here, because both ends have to agree on it and there are six
 * spawn sites. Each site already types its own inline message union for its own
 * traffic; forwarding attaches a separate listener instead of extending those
 * six literals, so adding it cannot disturb existing message handling.
 */
export interface WorkerLogMessage {
  type: 'log'
  record: LogRecord
}

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

// ─── Main-process side ───────────────────────────────────────────────────────

function isWorkerLogMessage(msg: unknown): msg is WorkerLogMessage {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return m.type === 'log' && typeof m.record === 'object' && m.record !== null
}

/**
 * Forward a worker's log records into the main log.
 *
 * Call this right after `new Worker(...)`, at every spawn site. It registers its
 * own `message` listener, which is why it composes with the handler each site
 * already has: EventEmitter runs both, and no existing site has a `default:`
 * case that would trip over a message type it doesn't recognise.
 *
 * The record is not trusted here — `logger.writeRecord()` validates it, applies
 * the configured level and scrubs secrets, none of which a worker can do for
 * itself.
 */
export function attachWorkerLogForwarding(worker: Worker, log: Logger): void {
  worker.on('message', (msg: unknown) => {
    if (isWorkerLogMessage(msg)) log.writeRecord(msg.record)
  })
}
