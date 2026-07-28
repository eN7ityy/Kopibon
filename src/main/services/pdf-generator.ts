import { PDFDocument, PageSizes, rgb } from 'pdf-lib'
import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import sharp from 'sharp'

// ─── Types ───────────────────────────────────────────────────────────────────

export type PdfPageSize = 'dynamic' | 'fit' | 'letter' | 'a4'

export interface PdfOptions {
  pageSize: PdfPageSize
  quality: number // 1-95, used to determine JPEG compression
  blackBackground: boolean
}

export type PdfProgressCallback = (current: number, total: number) => void

// ─── Constants ───────────────────────────────────────────────────────────────

const DYNAMIC_WIDTH = 1800
const YIELD_INTERVAL = 5 // Yield to event loop every N images

// ─── PDF Generator ────────────────────────────────────────────────────────────

/**
 * Generate a PDF from an array of image paths.
 *
 * @param imagePaths - Ordered array of full paths to image files
 * @param outputPath - Full path where the PDF will be saved
 * @param options - Page size, quality, background settings
 * @param onProgress - Optional callback for progress (current, total)
 * @returns The output path
 */
export async function generatePdf(
  imagePaths: string[],
  outputPath: string,
  options: PdfOptions,
  onProgress?: PdfProgressCallback
): Promise<string> {
  const pdfDoc = await PDFDocument.create()
  const total = imagePaths.length

  for (let i = 0; i < imagePaths.length; i++) {
    const imagePath = imagePaths[i]
    const buffer = readFileSync(imagePath)

    // Yield to event loop periodically to prevent UI freeze
    if (i > 0 && i % YIELD_INTERVAL === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    // Report progress
    onProgress?.(i + 1, total)

    // If compression enabled (quality < 100), convert to JPEG via sharp first.
    // This applies to ALL image formats — PNG, WebP, and JPEG itself (re-compress).
    let jpegBuffer: Buffer | null = null
    if (options.quality < 100) {
      try {
        jpegBuffer = await sharp(buffer)
          .jpeg({ quality: options.quality, mozjpeg: true })
          .toBuffer()
      } catch (err) {
        console.warn(`Failed to compress image: ${basename(imagePath)} — ${String(err)}`)
      }
    }

    let image
    if (jpegBuffer) {
      image = await pdfDoc.embedJpg(jpegBuffer)
    } else {
      // No compression — use original format (legacy behavior)
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      const isWebP = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50

      if (isPng) {
        image = await pdfDoc.embedPng(buffer)
      } else if (isJpeg) {
        image = await pdfDoc.embedJpg(buffer)
      } else if (isWebP) {
        try {
          const pngBuffer = await sharp(buffer).png().toBuffer()
          image = await pdfDoc.embedPng(pngBuffer)
        } catch (err) {
          console.warn(`Failed to convert WebP to PNG: ${basename(imagePath)} — ${String(err)}`)
          continue
        }
      } else {
        try {
          image = await pdfDoc.embedJpg(buffer)
        } catch {
          try {
            image = await pdfDoc.embedPng(buffer)
          } catch {
            try {
              const pngBuffer = await sharp(buffer).png().toBuffer()
              image = await pdfDoc.embedPng(pngBuffer)
            } catch (err) {
              console.warn(`Skipping unsupported image format: ${basename(imagePath)} — ${String(err)}`)
              continue
            }
          }
        }
      }
    }

    // Determine page dimensions
    let pageWidth: number
    let pageHeight: number

    const imgAspect = image.width / image.height

    switch (options.pageSize) {
      case 'dynamic':
        pageWidth = DYNAMIC_WIDTH
        pageHeight = Math.round(DYNAMIC_WIDTH / imgAspect)
        break
      case 'a4':
        pageWidth = PageSizes.A4[0]
        pageHeight = PageSizes.A4[1]
        break
      case 'letter':
        pageWidth = PageSizes.Letter[0]
        pageHeight = PageSizes.Letter[1]
        break
      case 'fit':
      default: {
        // Fit to image dimensions, keeping aspect ratio
        pageWidth = image.width
        pageHeight = image.height
        break
      }
    }

    const page = pdfDoc.addPage([pageWidth, pageHeight])

    // Calculate scaling to fit the image within the page while preserving aspect ratio
    const pageAspect = pageWidth / pageHeight
    let drawWidth: number
    let drawHeight: number

    if (imgAspect > pageAspect) {
      // Image wider than page — fit to width
      drawWidth = pageWidth
      drawHeight = pageWidth / imgAspect
    } else {
      // Image taller than page — fit to height
      drawHeight = pageHeight
      drawWidth = pageHeight * imgAspect
    }

    // Center image on page
    const x = (pageWidth - drawWidth) / 2
    const y = (pageHeight - drawHeight) / 2

    // If black background is requested, draw a black rectangle first
    if (options.blackBackground) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
        color: rgb(0, 0, 0)
      })
    }

    page.drawImage(image, {
      x,
      y,
      width: drawWidth,
      height: drawHeight
    })
  }

  const pdfBytes = await pdfDoc.save()
  writeFileSync(outputPath, pdfBytes)

  return outputPath
}
