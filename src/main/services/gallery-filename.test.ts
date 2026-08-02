import { describe, it, expect } from 'vitest'
import { applyGalleryIdToFilename } from './gallery-filename'

/**
 * The filename marker is read back by the scanner and matched by the ComicInfo
 * rewrite tool, so attaching an id by hand has to change the name too. These
 * cases come from names actually on disk, which use both placements.
 */

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('applyGalleryIdToFilename — attaching', () => {
  it('appends the marker to a name that has none', () => {
    expect(applyGalleryIdToFilename('Some Doujin.cbz', 651024)).toBe(
      'Some Doujin [nhentai-651024].cbz'
    )
  })

  it('replaces an existing marker rather than adding a second', () => {
    expect(applyGalleryIdToFilename('Some Doujin [nhentai-111].cbz', 222)).toBe(
      'Some Doujin [nhentai-222].cbz'
    )
  })

  it('handles the leading-marker form that also exists on disk', () => {
    // e.g. "[nhentai-00000] Alma ga Arekore ... Hon. 1.cbz"
    expect(applyGalleryIdToFilename('[nhentai-00000] Alma Hon. 1.cbz', 305059)).toBe(
      'Alma Hon. 1 [nhentai-305059].cbz'
    )
  })

  it('keeps the extension, whatever it is', () => {
    expect(applyGalleryIdToFilename('Book.pdf', 5)).toBe('Book [nhentai-5].pdf')
  })

  it('copes with a name that has no extension', () => {
    expect(applyGalleryIdToFilename('Book', 5)).toBe('Book [nhentai-5]')
  })

  it('does not treat a dotted title as an extension boundary it should move', () => {
    expect(applyGalleryIdToFilename('Vol. 1. Something.cbz', 7)).toBe(
      'Vol. 1. Something [nhentai-7].cbz'
    )
  })
})

describe('applyGalleryIdToFilename — detaching', () => {
  it('removes the marker', () => {
    expect(applyGalleryIdToFilename('Some Doujin [nhentai-651024].cbz', null)).toBe(
      'Some Doujin.cbz'
    )
  })

  it('removes a leading marker and the space it leaves', () => {
    expect(applyGalleryIdToFilename('[nhentai-00000] Alma Hon. 1.cbz', null)).toBe(
      'Alma Hon. 1.cbz'
    )
  })

  it('leaves a name that never had one alone', () => {
    expect(applyGalleryIdToFilename('Some Doujin.cbz', null)).toBe('Some Doujin.cbz')
  })

  it('never produces an empty name', () => {
    // Detaching from a file called only by its marker would otherwise leave
    // nothing but the extension.
    expect(applyGalleryIdToFilename('[nhentai-123].cbz', null)).toBe('Untitled.cbz')
  })
})

describe('applyGalleryIdToFilename — the 255-byte limit', () => {
  // Japanese is three bytes a character, so a name that looks short is not.
  const long = '母'.repeat(90) // 270 bytes on its own

  it('keeps the result inside the limit', () => {
    const out = applyGalleryIdToFilename(`${long}.cbz`, 625548)
    expect(bytes(out)).toBeLessThanOrEqual(255)
  })

  it('trims the title, never the marker', () => {
    // The marker is the part the scanner and the rewrite tool read, so it has
    // to survive intact even when the title cannot.
    const out = applyGalleryIdToFilename(`${long}.cbz`, 625548)
    expect(out.endsWith(' [nhentai-625548].cbz')).toBe(true)
  })

  it('does not split a multi-byte character while trimming', () => {
    expect(applyGalleryIdToFilename(`${long}.cbz`, 625548)).not.toContain('�')
  })

  it('leaves a name that already fits untouched', () => {
    const out = applyGalleryIdToFilename('Short.cbz', 1)
    expect(out).toBe('Short [nhentai-1].cbz')
  })
})
