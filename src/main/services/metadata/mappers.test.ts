import { describe, it, expect } from 'vitest'
import { buildComicInfoXml, buildXmpXml, buildKeywordTokens, buildDocInfo } from './mappers'
import {
  makeFileMetadata,
  fileMetadataFromGallery,
  fileMetadataFromLibraryItem,
  fileMetadataFromPayload,
  type FileMetadata,
  type GalleryMetadata
} from './file-metadata'

/**
 * The write side: mappers plus the shipped templates, together.
 *
 * These run against the real template files rather than a fixture string. That
 * is the point — the templates are editable, so a test that mocked them would
 * pass while the app wrote something else. If someone edits a template in a way
 * that breaks a rule Kavita depends on, this is what should tell them.
 */

const AMP = '&'

function meta(over: Partial<FileMetadata> = {}): FileMetadata {
  return makeFileMetadata({ title: 'A Title', artists: ['artist'], pageCount: 10, ...over })
}

const field = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m ? m[1] : null
}

// ─── ComicInfo ───────────────────────────────────────────────────────────────

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
        seriesName: `S ${AMP} V`,
        artists: [`A ${AMP} B`],
        tags: [`x ${AMP} y`],
        description: `sum ${AMP} more`,
        publisher: `P ${AMP} Q`
      })
    )
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|#\d+);)/)
  })

  it('leaves no blank lines where optional elements were dropped', () => {
    expect(
      buildComicInfoXml(meta())
        .split('\n')
        .filter((l) => l.trim() === '')
    ).toEqual([])
  })
})

describe('buildComicInfoXml — Kavita field rules', () => {
  it('always writes Series (§4.3 — otherwise Kavita parses the filename)', () => {
    expect(field(buildComicInfoXml(meta()), 'Series')).toBe('A Title')
  })

  it('leaves a one-shot unnumbered', () => {
    // No series name means this is not part of anything. Numbering it would
    // make Kavita show a one-chapter series per file.
    const xml = buildComicInfoXml(meta({ title: 'Solo', seriesIndex: 1 }))
    expect(xml).not.toContain('<Number>')
    expect(xml).not.toContain('<Volume>')
  })

  it('numbers a genuine series member', () => {
    // The reported failure: instalments arrived in Kavita loose, some as
    // Specials, because nothing numbered them. Kavita groups on Series and
    // orders on Number; a file with neither is filed as a Special.
    const xml = buildComicInfoXml(meta({ seriesName: 'Real Series', seriesIndex: 7 }))
    expect(field(xml, 'Number')).toBe('7')
  })

  it('numbers volume 1 even when the series is named after it', () => {
    // The Special bug. "Seijo no Mita Yume" volume 1 is titled exactly that, so
    // the old `series !== title` test called it a one-shot and left it
    // unnumbered while volume 2 got a number. Having a series name is the test.
    const xml = buildComicInfoXml(
      meta({ title: 'Seijo no Mita Yume', seriesName: 'Seijo no Mita Yume', seriesIndex: 1 })
    )
    expect(field(xml, 'Number')).toBe('1')
  })

  it('treats a whitespace-only series name as no series at all', () => {
    expect(buildComicInfoXml(meta({ seriesName: '   ', seriesIndex: 2 }))).not.toContain('<Number>')
  })

  it('never writes Volume, even for a numbered member', () => {
    // Volume would nest each file in a volume of its own holding a single
    // chapter — it groups, but describes something the data does not mean.
    expect(buildComicInfoXml(meta({ seriesName: 'S', seriesIndex: 2 }))).not.toContain('<Volume>')
  })

  it('never writes Count (Kavita would mark the series Ended/Completed, §4.4)', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<Count>')
  })

  it('never writes Format (the listed values force Special treatment, §4.6)', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<Format>')
  })

  it('mirrors writers into Penciller as well as Writer', () => {
    const xml = buildComicInfoXml(meta({ artists: ['one', 'two'] }))
    expect(field(xml, 'Writer')).toBe('one, two')
    expect(field(xml, 'Penciller')).toBe('one, two')
  })

  it('credits the circle when no artist is named', () => {
    expect(field(buildComicInfoXml(meta({ artists: [], groups: ['A Circle'] })), 'Writer')).toBe(
      'A Circle'
    )
  })

  it('falls back to Unknown rather than an empty Writer', () => {
    expect(field(buildComicInfoXml(meta({ artists: [] })), 'Writer')).toBe('Unknown')
  })

  it('prefers the circle as publisher over a supplied one', () => {
    const xml = buildComicInfoXml(meta({ groups: ['Circle'], publisher: 'Other' }))
    expect(field(xml, 'Publisher')).toBe('Circle')
  })

  it('omits empty optional fields rather than writing empty elements', () => {
    const xml = buildComicInfoXml(meta())
    for (const tag of [
      'Summary',
      'Publisher',
      'Genre',
      'Tags',
      'Characters',
      'Web',
      'Notes',
      'SeriesGroup'
    ]) {
      expect(xml).not.toContain(`<${tag}>`)
    }
  })

  it('always writes PageCount, including zero', () => {
    expect(field(buildComicInfoXml(meta({ pageCount: 143 })), 'PageCount')).toBe('143')
    expect(field(buildComicInfoXml(meta({ pageCount: 0 })), 'PageCount')).toBe('0')
  })

  it('writes Web and Notes only when there is a gallery id', () => {
    const withId = buildComicInfoXml(meta({ galleryId: 123 }))
    expect(field(withId, 'Web')).toBe('https://nhentai.net/g/123')
    expect(field(withId, 'Notes')).toContain('123')
    expect(buildComicInfoXml(meta({ galleryId: null }))).not.toContain('<Web>')
  })

  it('writes a parody as SeriesGroup only when the setting asks', () => {
    expect(
      field(buildComicInfoXml(meta({ parodies: ['P'], parodyAsCollection: true })), 'SeriesGroup')
    ).toBe('P')
    expect(buildComicInfoXml(meta({ parodies: ['P'] }))).not.toContain('<SeriesGroup>')
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
    expect(buildComicInfoXml(meta())).not.toContain('<Year>')
  })

  it('never emits NaN, whatever the adapter was handed', () => {
    // Not '0': JavaScript reads that as the year 2000, and always has. Bogus
    // enough to notice, but it is what the previous emitter did too.
    for (const bad of ['not-a-date', '', 'garbage']) {
      const xml = buildComicInfoXml(
        fileMetadataFromPayload({ title: 'T', creators: [], tags: [], date: bad })
      )
      expect(xml).not.toContain('NaN')
      expect(xml).not.toContain('<Year>')
    }
  })

  it('treats a zero upload timestamp as no date, not as 1970', () => {
    const from = fileMetadataFromGallery({
      id: 1,
      title: { english: 'e', japanese: null, pretty: 'p' },
      tags: [],
      uploadDate: 0,
      numPages: 1
    })
    expect(buildComicInfoXml(from)).not.toContain('<Year>')
  })
})

describe('buildComicInfoXml — language', () => {
  it('maps a human-readable language to an ISO code', () => {
    expect(field(buildComicInfoXml(meta({ language: 'english' })), 'LanguageISO')).toBe('en')
  })

  it('resolves by priority, not by tag order', () => {
    // 'translated' comes first for most galleries and is not a language.
    const xml = buildComicInfoXml(meta({ languageTags: ['translated', 'english'] }))
    expect(field(xml, 'LanguageISO')).toBe('en')
  })

  it('omits LanguageISO when absent', () => {
    expect(buildComicInfoXml(meta())).not.toContain('<LanguageISO>')
  })

  it('omits LanguageISO rather than emitting an unmappable value', () => {
    // Regression: a real conversion once produced
    // <LanguageISO>translated</LanguageISO>. An absent language beats a wrong one.
    for (const bad of ['translated', 'rewrite', 'speechless', 'nonsense']) {
      expect(buildComicInfoXml(meta({ language: bad }))).not.toContain('<LanguageISO>')
    }
  })
})

// ─── XMP ─────────────────────────────────────────────────────────────────────

describe('buildXmpXml', () => {
  it('opens and closes an xpacket, with the byte-order mark intact', () => {
    const xml = buildXmpXml(meta())
    expect(xml.startsWith('<?xpacket begin="﻿"')).toBe(true)
    expect(xml.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true)
  })

  it('never leaves a bare ampersand', () => {
    const xml = buildXmpXml(meta({ title: `T ${AMP} U`, allTags: [`x ${AMP} y`] }))
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|#\d+);)/)
  })

  it('writes dc:language as an rdf:Bag of ISO codes, which is all Kavita reads', () => {
    // A plain <dc:language>en</dc:language> child is silently ignored.
    expect(buildXmpXml(meta({ language: 'english' }))).toContain(
      '<dc:language>\n        <rdf:Bag>\n          <rdf:li>en</rdf:li>'
    )
  })

  it('omits dc:language entirely when the value is not a language', () => {
    expect(buildXmpXml(meta({ language: 'translated' }))).not.toContain('<dc:language>')
  })

  it('writes the calibre series block whenever there is a series name', () => {
    // Gating the whole block on the volume number meant a series without
    // volumes was written nowhere, so Kavita could not group it.
    const xml = buildXmpXml(meta({ seriesName: 'S' }))
    expect(xml).toContain('<rdf:value>S</rdf:value>')
    expect(xml).not.toContain('<calibreSI:series_index>')
  })

  it('writes the series index to two decimal places, as calibre does', () => {
    expect(buildXmpXml(meta({ seriesName: 'S', seriesIndex: 3 }))).toContain(
      '<calibreSI:series_index>3.00</calibreSI:series_index>'
    )
  })

  it('omits the series block when there is no series', () => {
    expect(buildXmpXml(meta())).not.toContain('calibre:series')
  })

  it('puts every tag in dc:subject, not just the tag-type ones', () => {
    const xml = buildXmpXml(meta({ tags: ['a'], allTags: ['a', 'artist name', 'english'] }))
    expect(xml).toContain('<rdf:li>artist name</rdf:li>')
  })

  it('leaves pdfx:isbn empty rather than writing a zero id', () => {
    expect(buildXmpXml(meta({ galleryId: null }))).toContain(
      '<pdfx:isbn xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"></pdfx:isbn>'
    )
  })
})

describe('buildKeywordTokens', () => {
  it('carries everything the scanner needs to rebuild a row from disk', () => {
    const tokens = buildKeywordTokens(
      meta({
        allTags: ['tag one'],
        galleryId: 42,
        seriesName: 'S',
        seriesIndex: 2,
        language: 'English',
        groups: ['Circle']
      })
    )
    expect(tokens).toEqual([
      'tag one',
      'nhentai:42',
      'calibre_series:S',
      'series_index:2',
      'language:English',
      'publisher:Circle'
    ])
  })

  it('keeps the language human-readable, unlike dc:language', () => {
    // The scanner reads this back into the UI; the ISO code lives in the XMP.
    expect(buildKeywordTokens(meta({ languageTags: ['translated', 'english'] }))).toContain(
      'language:English'
    )
  })

  it('omits tokens it has no value for', () => {
    expect(buildKeywordTokens(meta())).toEqual([])
  })
})

describe('buildDocInfo', () => {
  it('agrees with the XMP packet about title and author', () => {
    const info = buildDocInfo(meta({ title: 'T', artists: ['A', 'B'] }))
    expect(info.title).toBe('T')
    expect(info.author).toBe('A, B')
    expect(info.producer).toBe('pikepdf 10.8.0')
  })

  it('does not XML-escape — this goes in a PDF Info dictionary, not markup', () => {
    expect(buildDocInfo(meta({ title: `T ${AMP} U` })).title).toBe(`T ${AMP} U`)
  })
})

// ─── Adapters ────────────────────────────────────────────────────────────────

const gallery: GalleryMetadata = {
  id: 900,
  title: { english: 'English Title', japanese: '日本語', pretty: 'Pretty Title' },
  tags: [
    { type: 'artist', name: 'The Artist' },
    { type: 'group', name: 'The Circle' },
    { type: 'category', name: 'doujinshi' },
    { type: 'tag', name: 'a tag' },
    { type: 'character', name: 'someone' },
    { type: 'parody', name: 'a parody' },
    { type: 'language', name: 'translated' },
    { type: 'language', name: 'english' }
  ],
  uploadDate: 1600000000,
  numPages: 20
}

describe('fileMetadataFromGallery', () => {
  it('sorts tags into the buckets each format needs', () => {
    const m = fileMetadataFromGallery(gallery)
    expect(m.artists).toEqual(['The Artist'])
    expect(m.groups).toEqual(['The Circle'])
    expect(m.genres).toEqual(['doujinshi'])
    expect(m.tags).toEqual(['a tag'])
    expect(m.characters).toEqual(['someone'])
    expect(m.parodies).toEqual(['a parody'])
    expect(m.languageTags).toEqual(['translated', 'english'])
    expect(m.allTags).toHaveLength(8)
  })

  it('keeps every title variant, whether or not a template uses one', () => {
    const m = fileMetadataFromGallery(gallery)
    expect(m.title).toBe('Pretty Title')
    expect(m.titleEnglish).toBe('English Title')
    expect(m.titleJapanese).toBe('日本語')
  })
})

describe('fileMetadataFromLibraryItem', () => {
  const real = JSON.stringify([
    { type: 'artist', name: 'A' },
    { type: 'tag', name: 't' },
    { type: 'language', name: 'japanese' }
  ])

  it('uses the row artist rather than the artist tag', () => {
    // The column is what the user sees and may have corrected by hand.
    const m = fileMetadataFromLibraryItem({ primaryArtist: 'Corrected', rawTagsJson: real })
    expect(m.artists).toEqual(['Corrected'])
  })

  it('gives a scanner stub no release date, whatever its upload_date says', () => {
    // A stub's upload_date is this app's own timestamp. Writing it would tell
    // Kavita that thousands of galleries came out this month.
    const stub = fileMetadataFromLibraryItem({
      customTitle: 'T',
      customTags: 'x, y',
      uploadDate: 1750000000,
      rawTagsJson: JSON.stringify([{ type: 'tag', name: 'x' }])
    })
    expect(stub.releaseDate).toBeNull()
    expect(stub.tags).toEqual(['x', 'y'])
  })

  it('does give a real gallery row its release date', () => {
    const m = fileMetadataFromLibraryItem({ uploadDate: 1600000000, rawTagsJson: real })
    expect(m.releaseDate?.getUTCFullYear()).toBe(2020)
  })

  it('offers the row language as a candidate alongside the tags', () => {
    const m = fileMetadataFromLibraryItem({ rawTagsJson: real, customLanguage: 'English' })
    expect(buildComicInfoXml(m)).toContain('<LanguageISO>en</LanguageISO>')
  })

  it('survives unparseable tag JSON by treating the row as a stub', () => {
    const m = fileMetadataFromLibraryItem({ rawTagsJson: '{oops', customTags: 'x' })
    expect(m.tags).toEqual(['x'])
  })
})

describe('fileMetadataFromPayload', () => {
  it('treats the supplied language as already decided', () => {
    const m = fileMetadataFromPayload({ title: 'T', creators: [], tags: [], language: 'jpn' })
    expect(buildComicInfoXml(m)).toContain('<LanguageISO>ja</LanguageISO>')
  })

  it('puts the same flat tag list in both buckets', () => {
    const m = fileMetadataFromPayload({ title: 'T', creators: ['C'], tags: ['a', 'b'] })
    expect(m.tags).toEqual(['a', 'b'])
    expect(m.allTags).toEqual(['a', 'b'])
  })
})

// ─── The property that started all of this ───────────────────────────────────

describe('every entry point describes the same gallery the same way', () => {
  it('numbers a series member identically whichever path wrote the file', () => {
    // This is the regression the whole refactor exists to prevent: the same
    // question answered in several places, answered differently in one of them.
    const download = fileMetadataFromGallery({ ...gallery, seriesName: 'S', seriesIndex: 4 })
    const convert = fileMetadataFromLibraryItem({
      galleryId: 900,
      customTitle: 'Pretty Title',
      primaryArtist: 'The Artist',
      seriesName: 'S',
      seriesIndex: 4,
      rawTagsJson: JSON.stringify(gallery.tags)
    })
    const edit = fileMetadataFromPayload({
      title: 'Pretty Title',
      creators: ['The Artist'],
      tags: [],
      nhentaiId: 900,
      seriesName: 'S',
      seriesIndex: 4
    })

    for (const m of [download, convert, edit]) {
      const xml = buildComicInfoXml(m)
      expect(field(xml, 'Number')).toBe('4')
      expect(field(xml, 'Series')).toBe('S')
      expect(field(xml, 'Web')).toBe('https://nhentai.net/g/900')
    }
  })
})
