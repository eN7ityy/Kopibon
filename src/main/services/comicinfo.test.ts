import { describe, it, expect } from 'vitest'
import { buildComicInfoXml, parseComicInfoXml, type ComicInfoMetadata } from './comicinfo'

const AMP = '&'
const LT = '<'
const APOS = String.fromCharCode(39)

/** Minimal valid metadata; individual tests override what they care about. */
function meta(over: Partial<ComicInfoMetadata> = {}): ComicInfoMetadata {
  return {
    title: 'A Title',
    series: 'A Title',
    writers: ['artist'],
    genres: [],
    tags: [],
    characters: [],
    pageCount: 10,
    ageRating: 'Adults Only 18+',
    manga: 'YesAndRightToLeft',
    ...over
  }
}

const field = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m ? m[1] : null
}

describe('buildComicInfoXml — structure', () => {
  it('declares the xsi prefix it uses (an undeclared prefix makes the XML unparseable)', () => {
    const root = buildComicInfoXml(meta()).split('\n')[1]
    const declared = [...root.matchAll(/xmlns:(\w+)=/g)].map((m) => m[1])
    const used = [...root.matchAll(/\s(\w+):[\w-]+=/g)]
      .map((m) => m[1])
      .filter((p) => p !== 'xmlns')
    for (const prefix of used) expect(declared).toContain(prefix)
  })

  it('emits an XML declaration and a closing root element', () => {
    const xml = buildComicInfoXml(meta())
    expect(xml.startsWith('<?xml')).toBe(true)
    expect(xml.trimEnd().endsWith('</ComicInfo>')).toBe(true)
  })

  it('never leaves a bare ampersand anywhere in the output', () => {
    const xml = buildComicInfoXml(
      meta({
        title: `T ${AMP} U`,
        series: `S ${AMP} V`,
        writers: [`A ${AMP} B`],
        tags: [`x ${AMP} y`],
        summary: `sum ${AMP} more`,
        publisher: `P ${AMP} Q`
      })
    )
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|#\d+);)/)
  })
})

describe('buildComicInfoXml — Kavita field rules', () => {
  it('always writes Series (§4.3 — otherwise Kavita parses the filename)', () => {
    expect(field(buildComicInfoXml(meta()), 'Series')).toBe('A Title')
  })

  it('omits Volume when Series is only a title fallback (§C.4)', () => {
    // ~1200 library rows have a series_index but no real series name; emitting
    // Volume there produces "volume 1 of a one-item series".
    const xml = buildComicInfoXml(meta({ title: 'Solo', series: 'Solo', volume: 1 }))
    expect(xml).not.toContain('<Volume>')
  })

  it('writes Volume for a genuine series', () => {
    const xml = buildComicInfoXml(meta({ title: 'Ep 7', series: 'Real Series', volume: 7 }))
    expect(field(xml, 'Volume')).toBe('7')
  })

  it('never writes Count (Kavita would mark the series Ended/Completed, §4.4)', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<Count>')
  })

  it('never writes Format (the listed values force Special treatment, §4.6)', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<Format>')
  })

  it('never writes Number alongside Volume', () => {
    expect(buildComicInfoXml(meta({ series: 'S', volume: 2 }))).not.toContain('<Number>')
  })

  it('mirrors writers into Penciller as well as Writer', () => {
    const xml = buildComicInfoXml(meta({ writers: ['one', 'two'] }))
    expect(field(xml, 'Writer')).toBe('one, two')
    expect(field(xml, 'Penciller')).toBe('one, two')
  })

  it('omits empty optional fields rather than writing empty elements', () => {
    const xml = buildComicInfoXml(meta())
    for (const tag of ['Summary', 'Publisher', 'Genre', 'Tags', 'Characters', 'Web', 'SeriesGroup']) {
      expect(xml).not.toContain(`<${tag}>`)
    }
  })

  it('always writes PageCount', () => {
    expect(field(buildComicInfoXml(meta({ pageCount: 143 })), 'PageCount')).toBe('143')
  })
})

describe('buildComicInfoXml — release date', () => {
  it('emits Year/Month/Day for a valid date', () => {
    const xml = buildComicInfoXml(meta({ releaseDate: new Date(2021, 2, 5) }))
    expect(field(xml, 'Year')).toBe('2021')
    expect(field(xml, 'Month')).toBe('03')
    expect(field(xml, 'Day')).toBe('05')
  })

  it('omits the date entirely when absent (§C.2 — a wrong year corrupts the series)', () => {
    const xml = buildComicInfoXml(meta())
    expect(xml).not.toContain('<Year>')
  })

  it.each([[new Date('not-a-date')], [new Date(NaN)]])(
    'never emits NaN for an invalid date (%s)',
    (bad) => {
      const xml = buildComicInfoXml(meta({ releaseDate: bad }))
      expect(xml).not.toContain('NaN')
      expect(xml).not.toContain('<Year>')
    }
  )
})

describe('buildComicInfoXml — language', () => {
  it('maps a human-readable language to an ISO code', () => {
    expect(field(buildComicInfoXml(meta({ languageIso: 'english' })), 'LanguageISO')).toBe('en')
  })

  it('omits LanguageISO when absent', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<LanguageISO>')
  })

  it('omits LanguageISO rather than emitting an unmappable value', () => {
    // Regression: the emitter used `toIsoLanguage(v) || v`, so a value the
    // mapper deliberately rejected was written out raw. A real conversion
    // produced <LanguageISO>translated</LanguageISO> — 'translated' is an
    // nhentai language-*type* tag, not a language. toIsoLanguage returning null
    // means "omit", and the emitter has to honour that.
    for (const bad of ['translated', 'rewrite', 'speechless', 'nonsense']) {
      expect(buildComicInfoXml(meta({ languageIso: bad }))).not.toContain('<LanguageISO>')
    }
  })
})

describe('parseComicInfoXml — round trip', () => {
  it('recovers every field it wrote, with entities decoded', () => {
    const original = meta({
      title: `Ep 13 ${AMP} Jane${APOS}s Story ${LT}alt${LT}`,
      series: `Smoking ${AMP} Hypnosis`,
      volume: 7,
      summary: `A summary ${AMP} more`,
      writers: ['dr. stein', `second ${AMP} artist`],
      publisher: `Group ${AMP} Co`,
      genres: ['doujinshi'],
      tags: ['mind control', `x ${AMP} y`],
      characters: ['someone'],
      webUrl: 'https://nhentai.net/g/595016',
      notes: 'Tagged by Doujin Downloader — nhentai gallery 595016',
      pageCount: 143,
      languageIso: 'en',
      releaseDate: new Date(2020, 0, 15)
    })
    const parsed = parseComicInfoXml(buildComicInfoXml(original))

    expect(parsed.title).toBe(original.title)
    expect(parsed.series).toBe(original.series)
    expect(parsed.volume).toBe(7)
    expect(parsed.summary).toBe(original.summary)
    expect(parsed.writers).toEqual(original.writers)
    expect(parsed.publisher).toBe(original.publisher)
    expect(parsed.genres).toEqual(original.genres)
    expect(parsed.tags).toEqual(original.tags)
    expect(parsed.characters).toEqual(original.characters)
    expect(parsed.webUrl).toBe(original.webUrl)
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
    const parsed = parseComicInfoXml(
      buildComicInfoXml(meta({ webUrl: 'https://nhentai.net/g/424242' }))
    )
    expect(parsed.webUrl?.match(/nhentai\.net\/g\/(\d+)/)?.[1]).toBe('424242')
  })

  it('tolerates unrelated or missing markup without throwing', () => {
    expect(() => parseComicInfoXml('')).not.toThrow()
    expect(() => parseComicInfoXml('<ComicInfo></ComicInfo>')).not.toThrow()
    expect(parseComicInfoXml('<ComicInfo></ComicInfo>').title).toBeUndefined()
  })

  it('does not confuse Series with SeriesGroup', () => {
    const xml = buildComicInfoXml(meta({ series: 'Real Series', seriesGroup: 'Collection X' }))
    expect(parseComicInfoXml(xml).series).toBe('Real Series')
    expect(parseComicInfoXml(xml).seriesGroup).toBe('Collection X')
  })
})
