/**
 * Language display for cards.
 *
 * The stored data is inconsistent, because it accumulated from several writers
 * over the project's life. Measured across the 4,632 library rows:
 *
 *   custom_language:  eng 2390 | null 1165 | jpn 398 | en 236 | zho 221
 *                     translated 106 | japanese 79 | english 19
 *   language:         null on every row — the column is written by nothing
 *
 * So a card cannot just print the column. This maps every observed form to one
 * display label, and returns null when there is nothing worth showing rather
 * than rendering an empty chip.
 *
 * This duplicates the *intent* of `resolveLanguageName` in main/services, which
 * cannot be imported here — that one resolves a list of nhentai tags for writing
 * into file metadata, this one normalises a stored column for display. Keeping
 * them separate is deliberate; sharing would mean routing display formatting
 * through IPC.
 */

const DISPLAY: Record<string, string> = {
  // ISO 639-2, the most common stored form
  eng: 'English',
  jpn: 'Japanese',
  zho: 'Chinese',
  chi: 'Chinese',
  // ISO 639-1
  en: 'English',
  ja: 'Japanese',
  jp: 'Japanese',
  zh: 'Chinese',
  // Names as nhentai tags them
  english: 'English',
  japanese: 'Japanese',
  chinese: 'Chinese'
}

/**
 * `translated` is an nhentai language-*type* tag that is not a language. It is
 * the first language tag on a large share of galleries, which is why the file
 * metadata was getting it instead of the real language. Here it is a last
 * resort: shown only when nothing better exists, since it still tells the user
 * something.
 */
const TRANSLATED = 'translated'

function normalizeOne(raw: string): string | null {
  const key = raw.trim().toLowerCase()
  if (!key) return null
  if (DISPLAY[key]) return DISPLAY[key]
  // A locale like `en-US` reduces to its language subtag.
  const base = key.split(/[-_]/)[0]
  if (DISPLAY[base]) return DISPLAY[base]
  if (key === TRANSLATED) return 'Translated'
  return null
}

/**
 * Pick the best language label from however many candidate values exist.
 *
 * Candidates are tried in order, skipping `translated` on the first pass so a
 * real language always wins — the rule being that `translated` is only ever the
 * answer when it is the only thing available.
 */
export function displayLanguage(
  ...candidates: Array<string | null | undefined>
): string | null {
  const values = candidates.filter((v): v is string => typeof v === 'string' && v.trim() !== '')

  // Pass 1: anything that resolves to a real language.
  for (const v of values) {
    const label = normalizeOne(v)
    if (label && label !== 'Translated') return label
  }

  // Pass 2: accept `translated` only now that no real language turned up.
  for (const v of values) {
    if (normalizeOne(v) === 'Translated') return 'Translated'
  }

  return null
}

/**
 * Every distinct language across a series, as labels.
 *
 * A series card gets the raw stored values of its members, which is how a
 * fifteen-volume series came out claiming three languages — `eng`, `english`
 * and `zho` — when it holds two. Main deduplicates only by case, deliberately:
 * it has no business knowing that `eng` and `english` are one thing, for the
 * same reason `displayLanguage` lives here and not there.
 *
 * Input order is by how many members carry each raw spelling, and first-seen
 * order is preserved, so the dominant language leads. That ordering is
 * approximate in one case: two spellings of the same language that each rank
 * below a different language stay below it after merging. Cosmetic, and not
 * worth shipping member counts across IPC to fix.
 */
export function mergeDisplayLanguages(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const value of raw) {
    const label = displayLanguage(value)
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }

  // 'Translated' is a tag type, not a language. It earns a place only when
  // nothing else identified one — the same rule displayLanguage applies.
  const real = labels.filter((l) => l !== 'Translated')
  return real.length > 0 ? real : labels
}
