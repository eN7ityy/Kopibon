import { describe, it, expect } from 'vitest'
import { parseCachedGallery } from './download-manager'

/**
 * Guarding the cached-gallery read in the download pipeline.
 *
 * The reported failure: starting a download returned "Cannot read properties
 * of undefined (reading 'find')". The cause is that the `gallery` table holds
 * two different shapes — full API responses from downloads, and stubs the
 * library scanner writes when it reads an nhentai id out of a filename. The
 * pipeline parsed a stub and then called `gallery.tags.find(...)`.
 *
 * The shapes below are copied from a real library, where 4,357 of 4,409 rows
 * are stubs.
 */

/** A complete row, with the keys a real cached response actually carries. */
const complete = JSON.stringify({
  id: 501888,
  media_id: '1264104', // a string in the real data, not a number
  title: { pretty: 'Smoking Hypnosis', english: 'Smoking Hypnosis' },
  num_pages: 25,
  num_favorites: 900,
  upload_date: 1600000000,
  tags: [{ id: 1, type: 'artist', name: 'dr. stein' }],
  pages: Array.from({ length: 25 }, () => ({ t: 'j', w: 1280, h: 1803 })),
  cover: { t: 'j' },
  thumbnail: { t: 'j' }
})

describe('parseCachedGallery — the scanner stub that broke downloads', () => {
  it('rejects the exact stub shape in the database', () => {
    // Verbatim from the library. No tags, no pages, no media_id, no num_pages.
    expect(parseCachedGallery('{"id":6436,"title":{"pretty":"Breast Play 2"}}')).toBeNull()
    expect(parseCachedGallery('{"id":11172,"title":{"pretty":"The Smell of Incest"}}')).toBeNull()
  })

  it('accepts a complete cached response', () => {
    const gallery = parseCachedGallery(complete)
    expect(gallery).not.toBeNull()
    expect(gallery?.num_pages).toBe(25)
    // The property whose absence caused the crash.
    expect(Array.isArray(gallery?.tags)).toBe(true)
  })

  it('guards every field the pipeline reads without checking', () => {
    // Each of these alone is enough to crash a download further along, so a row
    // missing any one of them has to be treated as a miss rather than patched.
    const withoutTags = { ...JSON.parse(complete), tags: undefined }
    const withoutPages = { ...JSON.parse(complete), pages: [] }
    const withoutMediaId = { ...JSON.parse(complete), media_id: null }
    const zeroPages = { ...JSON.parse(complete), num_pages: 0 }

    expect(parseCachedGallery(JSON.stringify(withoutTags))).toBeNull()
    expect(parseCachedGallery(JSON.stringify(withoutPages))).toBeNull()
    expect(parseCachedGallery(JSON.stringify(withoutMediaId))).toBeNull()
    expect(parseCachedGallery(JSON.stringify(zeroPages))).toBeNull()
  })

  it('keeps a numeric media_id working as well as a string one', () => {
    // Downloads store it as a string; nothing guarantees that forever.
    const numeric = { ...JSON.parse(complete), media_id: 1264104 }
    expect(parseCachedGallery(JSON.stringify(numeric))).not.toBeNull()
  })

  it('treats unusable input as a miss rather than throwing', () => {
    // A cache miss sends the caller to the API. A throw would fail the
    // download, which is the behaviour being fixed.
    expect(parseCachedGallery('not json at all')).toBeNull()
    expect(parseCachedGallery('')).toBeNull()
    expect(parseCachedGallery(null)).toBeNull()
    expect(parseCachedGallery(undefined)).toBeNull()
    expect(parseCachedGallery('null')).toBeNull()
    expect(parseCachedGallery('[]')).toBeNull()
    expect(parseCachedGallery('"a string"')).toBeNull()
  })
})
