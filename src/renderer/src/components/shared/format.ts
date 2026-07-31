/**
 * Shared display formatters.
 *
 * These existed as three private copies (`DownloadProgress`, `SyncProgressBar`,
 * `CbzConversionProgressBar`) that disagreed on output for the same input — one
 * rendered `~2m 5s`, another `2m 5s`, a third `ETA: 2m 5s`. Same numbers, three
 * different readings on screen.
 */

/**
 * Human-readable duration for a remaining-time estimate.
 *
 * Returns an empty string for null/zero/negative rather than a placeholder, so
 * callers can omit the element entirely instead of showing `--`.
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Byte count at a sensible unit. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Transfer rate, given a value already in KB/s. */
export function formatSpeed(kbps: number | null | undefined): string {
  if (kbps == null || !Number.isFinite(kbps) || kbps <= 0) return ''
  if (kbps < 1024) return `${kbps.toFixed(0)} KB/s`
  return `${(kbps / 1024).toFixed(1)} MB/s`
}
