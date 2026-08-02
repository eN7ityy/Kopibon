/**
 * Entry point for the command-line tools.
 *
 * `tools/rewrite-comicinfo.mjs` bundles this with esbuild so it drives the
 * application's own writer rather than a second implementation that could
 * drift from it. Nothing in the app imports this file.
 */

export { applyMetadata } from './apply-metadata'
export {
  fileMetadataFromLibraryItem,
  fileMetadataFromGallery,
  fileMetadataFromPayload
} from './metadata/file-metadata'
