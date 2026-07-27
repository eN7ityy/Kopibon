import { PDFDocument, PageSizes, rgb } from 'pdf-lib'
import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'

// ─── Types ───────────────────────────────────────────────────────────────────

export type PdfPageSize = 'dynamic' | 'fit' | 'letter' | 'a4'

export interface PdfOptions {
  pageSize: PdfPageSize
  quality: number // 1-95, used to determine JPEG compression
  blackBackground: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DYNAMIC_WIDTH = 1800

// ─── PDF Generator ────────────────────────────────────────────────────────────

/**
 * Generate a PDF from an array of image paths.
 *
 * @param imagePaths - Ordered array of full paths to image files
 * @param outputPath - Full path where the PDF will be saved
 * @param options - Page size, quality, background settings
 * @returns The output path
 */
export async function generatePdf(
  imagePaths: string[],
  outputPath: string,
  options: PdfOptions
): Promise<string> {
  const pdfDoc = await PDFDocument.create()

  for (const imagePath of imagePaths) {
    const buffer = readFileSync(imagePath)
    const ext = basename(imagePath).split('.').pop()?.toLowerCase()

    let image
    if (ext === 'png') {
      image = await pdfDoc.embedPng(buffer)
    } else {
      // jpg, jpeg, webp handle as JPEG
      image = await pdfDoc.embedJpg(buffer)
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
