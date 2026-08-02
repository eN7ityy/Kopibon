/**
 * Everything that writes metadata into a file goes through here.
 *
 * The pipeline, in one line:
 *
 *   input shape ──adapter──▶ FileMetadata ──mapper──▶ context ──template──▶ bytes
 *
 * See `resources/metadata-templates/README.md` for the templates themselves and
 * how to change what gets written.
 */

export type {
  FileMetadata,
  MangaDirection,
  TagLike,
  GalleryMetadata,
  LibraryItemMetadata,
  MetadataPayload
} from './file-metadata'

export {
  DEFAULT_FILE_METADATA,
  makeFileMetadata,
  isRealGalleryRow,
  fileMetadataFromGallery,
  fileMetadataFromLibraryItem,
  fileMetadataFromPayload
} from './file-metadata'

export {
  PDF_PRODUCER,
  buildComicInfoXml,
  buildXmpXml,
  buildKeywordTokens,
  buildDocInfo,
  comicInfoContext,
  xmpContext,
  isPartOfSeries,
  seriesTitle,
  seriesNumber,
  resolveWriters,
  resolvePublisher,
  resolveLanguageValue,
  resolveSeriesGroup,
  resolveLocalizedSeries
} from './mappers'

export { renderTemplate } from './template-engine'
export type { TemplateContext, TemplateValue } from './template-engine'

export {
  loadTemplate,
  installUserTemplates,
  clearTemplateCache,
  COMICINFO_TEMPLATE,
  PDF_XMP_TEMPLATE,
  TEMPLATE_DIR_ENV
} from './templates'
