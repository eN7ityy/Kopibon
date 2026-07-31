import { useSyncProgressStore } from './sync-progress.store'
import { useCbzConversionStore } from './cbz-conversion.store'
import { useConversionStore } from './conversion.store'

/**
 * One long-running job, in the shape the shared progress component renders.
 *
 * Every background job in the app reduces to this, whatever its backend looks
 * like. Previously each had its own bespoke markup, colour and label order.
 */
export interface ProgressJob {
  /** Stable key, also used for ordering within the stack. */
  id: string
  label: string
  current: number
  /** 0 means indeterminate — show motion, not a fraction. */
  total: number
  /** Secondary text: failure counts, transfer rate, current filename. */
  detail?: string
  etaSeconds?: number | null
  tone?: JobTone
  /** Standing caveat shown under the bar while running. */
  note?: string
  onCancel?: () => void
  /** Terminal summary: rendered without a bar or spinner. */
  done?: boolean
}

/**
 * Colour carries meaning rather than decoration:
 * - `read` for jobs that only inspect files (scan, sync)
 * - `write` for jobs that rewrite or replace files (both conversions)
 * - `danger` for destructive work
 *
 * The distinction was already accidentally present; making it deliberate means
 * "this job is rewriting your library" is visible at a glance.
 */
export type JobTone = 'read' | 'write' | 'danger'

/**
 * Jobs owned by global stores, in a fixed display order.
 *
 * Page-local jobs (the library scan) are passed to the stack separately by the
 * page that owns them.
 */
export function useGlobalJobs(): ProgressJob[] {
  const sync = useSyncProgressStore()
  const cbz = useCbzConversionStore()
  const meta = useConversionStore()

  const jobs: ProgressJob[] = []

  if (sync.running || sync.lastMessage) {
    jobs.push({
      id: 'sync',
      label: sync.running ? sync.title || 'Syncing with nhentai' : sync.lastMessage!,
      current: sync.current,
      total: sync.total,
      etaSeconds: sync.etaSeconds,
      tone: 'read',
      done: !sync.running
    })
  }

  if (cbz.running || cbz.lastMessage) {
    const failed = cbz.failed > 0 ? `${cbz.failed} failed` : undefined
    jobs.push({
      id: 'cbz',
      label: cbz.running ? 'Converting to CBZ' : cbz.lastMessage!,
      current: cbz.current,
      total: cbz.total,
      detail: failed,
      etaSeconds: cbz.etaSeconds,
      tone: 'write',
      note: cbz.running
        ? 'Files being converted cannot be edited or deleted until they finish.'
        : undefined,
      onCancel: cbz.running ? () => void window.api.library.cancelConvertToCbz() : undefined,
      done: !cbz.running
    })
  }

  if (meta.running || meta.lastMessage) {
    const bits: string[] = []
    if (meta.converted > 0) bits.push(`${meta.converted} ok`)
    if (meta.failed > 0) bits.push(`${meta.failed} failed`)
    jobs.push({
      id: 'metadata',
      label: meta.running ? 'Rewriting file metadata' : meta.lastMessage!,
      current: meta.current,
      total: meta.total,
      detail: bits.length > 0 ? bits.join(' · ') : undefined,
      etaSeconds: meta.etaSeconds,
      tone: 'write',
      onCancel: meta.running ? () => void window.api.library.cancelConversion() : undefined,
      done: !meta.running
    })
  }

  return jobs
}
