import { describe, it, expect } from 'vitest'
import { parseComicInfoXml } from './comicinfo'
import { buildComicInfoXml } from './metadata/mappers'
import { makeFileMetadata, type FileMetadata } from './metadata/file-metadata'

/**
 * The read side. Building moved to the templates (see mappers.test.ts), but
 * reading has to keep up with everything already on disk — including files this
 * app wrote years ago and files other tools wrote.
 *
 * Round trips go through the real emitter and the real template on purpose: a
 * parser tested only against hand-written fixtures stops matching the writer
 * the moment someone edits the template.
 */

const AMP = '&'
const LT = '<'
const APOS = String.fromCharCode(39)

/** Minimal valid metadata; individual tests override what they care about. */
function meta(over: Partial<FileMetadata> = {}): FileMetadata {
  return makeFileMetadata({ title: 'A Title', artists: ['artist'], pageCount: 10, ...over })
}

describe('parseComicInfoXml — round trip', () => {
  it('recovers every field it wrote, with entities decoded', () => {
    const original = meta({
      title: `Ep 13 ${AMP} Jane${APOS}s Story ${LT}alt${LT}`,
      seriesName: `Smoking ${AMP} Hypnosis`,
      seriesIndex: 7,
      description: `A summary ${AMP} more`,
      artists: ['dr. stein', `second ${AMP} artist`],
      publisher: `Group ${AMP} Co`,
      genres: ['doujinshi'],
      tags: ['mind control', `x ${AMP} y`],
      characters: ['someone'],
      galleryId: 595016,
      pageCount: 143,
      language: 'en',
      releaseDate: new Date(2020, 0, 15)
    })
    const parsed = parseComicInfoXml(buildComicInfoXml(original))

    expect(parsed.title).toBe(original.title)
    expect(parsed.series).toBe(original.seriesName)
    expect(parsed.volume).toBe(7)
    expect(parsed.summary).toBe(original.description)
    expect(parsed.writers).toEqual(original.artists)
    expect(parsed.publisher).toBe(original.publisher)
    expect(parsed.genres).toEqual(original.genres)
    expect(parsed.tags).toEqual(original.tags)
    expect(parsed.characters).toEqual(original.characters)
    expect(parsed.webUrl).toBe('https://nhentai.net/g/595016')
    expect(parsed.pageCount).toBe(143)
    expect(parsed.languageIso).toBe('en')
    expect(parsed.manga).toBe('YesAndRightToLeft')
    expect(parsed.ageRating).toBe('Adults Only 18+')
  })

  it('does not leave entities in parsed values (they would reach the database)', () => {
    const parsed = parseComicInfoXml(buildComicInfoXml(meta({ title: `T ${AMP} U` })))
    expect(parsed.title).toBe(`T ${AMP} U`)
    expect(parsed.title).not.toContain('amp;')
  })

  it('recovers the gallery id from Web, for the scanner ID path', () => {
    const parsed = parseComicInfoXml(buildComicInfoXml(meta({ galleryId: 424242 })))
    expect(parsed.webUrl?.match(/nhentai\.net\/g\/(\d+)/)?.[1]).toBe('424242')
  })

  it('reads back an index written as Volume by the previous emitter', () => {
    // Every file written before the Number change carries Volume, and the
    // scanner takes seriesIndex from this. Reading only Number would drop the
    // index from all of them on the next rescan.
    const legacy = buildComicInfoXml(
      meta({ title: 'Ep 3', seriesName: 'S', seriesIndex: 3 })
    ).replace('<Number>3</Number>', '<Volume>3</Volume>')
    expect(parseComicInfoXml(legacy).volume).toBe(3)
  })

  it('tolerates unrelated or missing markup without throwing', () => {
    expect(() => parseComicInfoXml('')).not.toThrow()
    expect(() => parseComicInfoXml('<ComicInfo></ComicInfo>')).not.toThrow()
    expect(parseComicInfoXml('<ComicInfo></ComicInfo>').title).toBeUndefined()
  })

  it('does not confuse Series with SeriesGroup', () => {
    const xml = buildComicInfoXml(
      meta({ seriesName: 'Real Series', parodies: ['Collection X'], parodyAsCollection: true })
    )
    expect(parseComicInfoXml(xml).series).toBe('Real Series')
    expect(parseComicInfoXml(xml).seriesGroup).toBe('Collection X')
  })
})
