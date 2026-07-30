/**
 * Output format resolution for downloads.
 *
 * Kept as a pure function with no Electron or database dependency so it can be
 * unit tested. The rule it encodes is small but was missing entirely: the
 * persisted `outputFormat` setting was written by the Settings page and never
 * read by anything, so choosing CBZ had no effect and every download came out
 * as a PDF.
 */

/** Formats the download pipeline can actually produce. */
export const SUPPORTED_OUTPUT_FORMATS = ['pdf', 'cbz'] as const

export type OutputFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number]

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'pdf'

function isSupported(value: string | null | undefined): value is OutputFormat {
  return !!value && (SUPPORTED_OUTPUT_FORMATS as readonly string[]).includes(value)
}

/**
 * Decide the output format for a queue item.
 *
 * Precedence: an explicit per-download choice, then the persisted setting, then
 * PDF. Unrecognised values at either level fall through rather than reaching
 * the download manager, which would otherwise route an unknown format to the
 * PDF worker while recording something else in the database.
 *
 * @param explicit - Format requested for this specific download, if any
 * @param stored - The persisted `outputFormat` setting value, if any
 */
export function resolveOutputFormat(
  explicit?: string | null,
  stored?: string | null
): OutputFormat {
  if (isSupported(explicit)) return explicit
  if (isSupported(stored)) return stored
  return DEFAULT_OUTPUT_FORMAT
}
