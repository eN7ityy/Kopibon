/**
 * Tag presentation: one colour map, one order, shared by every view.
 *
 * The colour map was duplicated in GalleryDetail and DownloadItem, and the order
 * was whatever the API happened to return — which interleaved types, so a panel
 * could read Genre, Language, three tags, a Parody, then another Language. Type
 * is the most useful thing about a tag when scanning, so it should group.
 */

export interface TagLike {
  id: number
  type: string
  name: string
}

export const TAG_COLORS: Record<string, string> = {
  artist: 'bg-accent-wash text-accent',
  group: 'bg-tag-group/15 text-tag-group',
  category: 'bg-tag-category/15 text-tag-category',
  language: 'bg-tag-language/15 text-tag-language',
  parody: 'bg-tag-parody/15 text-tag-parody',
  character: 'bg-tag-character/15 text-tag-character',
  tag: 'bg-raised text-fg-muted'
}

export function tagClass(type: string): string {
  return TAG_COLORS[type] || TAG_COLORS.tag
}

/**
 * Display order by type. Broadest first, ending in the long tail of plain tags.
 *
 * `artist` and `group` are listed for completeness, but the detail panels render
 * those separately above the rest, since they identify the work rather than
 * describe it.
 */
const TYPE_ORDER = [
  'artist',
  'group',
  'category',
  'language',
  'parody',
  'character',
  'tag'
] as const

const RANK = new Map<string, number>(TYPE_ORDER.map((t, i) => [t, i]))

/** Unknown types sort after everything known, rather than jumping to the front. */
function rank(type: string): number {
  return RANK.get(type) ?? TYPE_ORDER.length
}

/**
 * Sort by type, then alphabetically within a type.
 *
 * Returns a new array — callers pass `detail.tags` straight in, and sorting that
 * in place would mutate the fetched object.
 */
export function sortTags<T extends { type: string; name: string }>(tags: readonly T[]): T[] {
  return [...tags].sort((a, b) => {
    const byType = rank(a.type) - rank(b.type)
    if (byType !== 0) return byType
    return a.name.localeCompare(b.name)
  })
}

/** Sort, and drop the types a panel shows separately. */
export function sortDescriptiveTags<T extends { type: string; name: string }>(
  tags: readonly T[],
  exclude: readonly string[] = ['artist', 'group']
): T[] {
  return sortTags(tags.filter((t) => !exclude.includes(t.type)))
}
