/**
 * The decisions behind series grouping, kept free of the database.
 *
 * Grouping is mostly a SQL problem, but four judgements are not, and each of
 * them was wrong in an obvious way on the first attempt against real data:
 * which names are worth grouping at all, which member's cover represents the
 * group, what order the members go in, and which missing volumes are worth
 * mentioning. They live here so they can be tested against the shapes the
 * library actually contains rather than inferred from the schema.
 */

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Members required before a group is shown as a series.
 *
 * A library of 4,636 items holds 2,733 distinct series names, but only 240 of
 * them name more than one item — the download and scan paths default
 * `series_name` to the title, so most "series" are a single one-shot wearing a
 * series field. Grouping those would wrap 2,493 items in a container that adds
 * nothing.
 *
 * This is applied when reading, never when writing, so a group forms the moment
 * a second volume lands and disappears again if it is deleted.
 */
export const DEFAULT_MIN_SERIES_MEMBERS = 2

/**
 * The widest run of missing volumes still reported as a gap.
 *
 * Beyond this a jump is not an absence, it is a change of numbering scheme:
 * real series here use 99 and 100 for bonus chapters after a main run ending at
 * 21. Reporting "77 volumes missing" would be noise, and would train the warning
 * to be ignored in the cases where it is true.
 */
const MAX_REPORTED_GAP = 10

/**
 * Series names that name nothing.
 *
 * `unspecified` is in the live library on four items by four different artists;
 * grouping by it would invent a series out of unrelated one-shots. Compared
 * lowercased and trimmed.
 */
export const UNGROUPABLE_NAMES: readonly string[] = [
  '',
  '-',
  '?',
  'n/a',
  'na',
  'none',
  'null',
  'unknown',
  'unspecified'
]

const UNGROUPABLE_SET = new Set(UNGROUPABLE_NAMES)

// ─── Names ───────────────────────────────────────────────────────────────────

/** Trim a series name, returning null when nothing usable is left. */
export function normaliseSeriesName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Whether a name should ever form a group.
 *
 * Deliberately does not reject a name equal to the item's title. Those are
 * usually a defaulted field, but two items genuinely sharing both a title and a
 * series are a series — and the member threshold already keeps the defaulted
 * ones invisible without having to guess.
 */
export function isGroupableSeriesName(name: string | null | undefined): boolean {
  const normalised = normaliseSeriesName(name)
  return normalised !== null && !UNGROUPABLE_SET.has(normalised.toLowerCase())
}

// ─── Members ─────────────────────────────────────────────────────────────────

/** The part of a library item that grouping cares about. */
export interface SeriesMember {
  id: number
  seriesIndex: number | null
  title: string
}

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Reading order: by volume, then by title.
 *
 * Members with no volume sort last rather than first. A missing index means
 * nobody has said where the item belongs, and putting it ahead of volume 1
 * would make the group open on an arbitrary item — seven items in the live
 * library are in this state.
 */
export function sortSeriesMembers<T extends SeriesMember>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => {
    const ai = a.seriesIndex
    const bi = b.seriesIndex
    if (ai == null && bi == null) return titleCollator.compare(a.title, b.title)
    if (ai == null) return 1
    if (bi == null) return -1
    // Thirteen series share a volume number between two members, so the title
    // is not a tiebreak of last resort here — it decides real cases.
    return ai !== bi ? ai - bi : titleCollator.compare(a.title, b.title)
  })
}

/**
 * Which member's cover stands for the group.
 *
 * Falls through the overrides to the lowest volume, which is the "cover of the
 * first gallery in the series" default. The `coverItemId` override is checked
 * against the current members on purpose: covers outlive the item they were
 * chosen from, and a group whose chosen cover was deleted should quietly fall
 * back rather than render blank.
 */
export function pickSeriesCover<T extends SeriesMember>(
  members: readonly T[],
  override?: { coverItemId?: number | null; coverPath?: string | null }
): { coverPath: string } | { memberId: number } | null {
  const path = normaliseSeriesName(override?.coverPath)
  if (path) return { coverPath: path }

  const chosen = override?.coverItemId
  if (chosen != null && members.some((m) => m.id === chosen)) return { memberId: chosen }

  const first = sortSeriesMembers(members)[0]
  return first ? { memberId: first.id } : null
}

// ─── Volume gaps ─────────────────────────────────────────────────────────────

/**
 * Whole volume numbers absent from the middle of a run.
 *
 * Only integers count: fractional indexes are extras slotted between volumes,
 * not a numbering the reader expects to be complete. Nothing before the lowest
 * or after the highest is reported — a series starting at 3 is missing 1 and 2
 * as far as the numbers go, but far more likely just numbered that way.
 */
export function findVolumeGaps(indexes: readonly (number | null)[]): number[] {
  const whole = [
    ...new Set(indexes.filter((n): n is number => n != null && Number.isInteger(n)))
  ].sort((a, b) => a - b)
  if (whole.length < 2) return []

  const gaps: number[] = []
  for (let i = 1; i < whole.length; i++) {
    const from = whole[i - 1]
    const to = whole[i]
    const missing = to - from - 1
    // A jump wider than this is a second numbering block (bonus chapters at 99
    // and 100 following a main run), not an incomplete one.
    if (missing <= 0 || missing > MAX_REPORTED_GAP) continue
    for (let v = from + 1; v < to; v++) gaps.push(v)
  }
  return gaps
}

// ─── Merged facts ────────────────────────────────────────────────────────────

/** A member as far as the aggregated header is concerned. */
export interface SeriesFactsMember {
  format: string | null
  language: string | null
  customLanguage: string | null
  primaryArtist: string | null
  customTags: string | null
}

export interface SeriesFacts {
  /** 'pdf' | 'cbz' | 'mixed', or null when no member states one. */
  format: string | null
  /** Distinct, most-used first. */
  artists: string[]
  languages: string[]
  /** Distinct, by how many members carry them, then alphabetically. */
  tags: string[]
}

/**
 * Count occurrences, then order by count and break ties alphabetically.
 *
 * The tiebreak is what makes this stable: without it the order of two
 * equally-common tags would follow member order, so the same series would
 * render its tags differently after an unrelated item was added.
 */
function byFrequency(values: readonly string[]): string[] {
  // Keyed case-insensitively so 'Netorare' and 'netorare' are one tag, while the
  // first spelling seen is the one displayed. Two maps rather than scanning the
  // keys for a case-insensitive match: a fifteen-volume series carries a few
  // hundred tag strings, and that scan is quadratic in the distinct count.
  const counts = new Map<string, number>()
  const display = new Map<string, string>()

  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (!display.has(key)) display.set(key, trimmed)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : titleCollator.compare(a[0], b[0])))
    .map(([key]) => display.get(key)!)
}

/** Union the members' metadata into the facts shown on a series. */
export function mergeSeriesFacts(members: readonly SeriesFactsMember[]): SeriesFacts {
  const formats = new Set(
    members.map((m) => (m.format ?? '').trim().toLowerCase()).filter((f) => f !== '')
  )

  return {
    format: formats.size === 0 ? null : formats.size === 1 ? [...formats][0] : 'mixed',
    artists: byFrequency(members.map((m) => m.primaryArtist ?? '')),
    // customLanguage overrides language on an item, so it has to win here too —
    // taking both would list a corrected language alongside the one it replaced.
    languages: byFrequency(members.map((m) => m.customLanguage?.trim() || m.language || '')),
    tags: byFrequency(members.flatMap((m) => (m.customTags ?? '').split(',')))
  }
}
