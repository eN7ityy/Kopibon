import { useState, useEffect, useCallback } from 'react'
import type { GalleryDetail as GalleryDetailType, DownloadStatus, CdnConfig } from '../../types/api.types'
import StatusBadge from '../shared/StatusBadge'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import FormatSelector from '../shared/FormatSelector'
import { useAuthStore } from '../../stores/auth.store'
import { useSettingsStore, type OutputFormat } from '../../stores/settings.store'
import GalleryViewer from './GalleryViewer'
import { sortDescriptiveTags, tagClass } from '../shared/tags'
import { useBlocked, blockedChipClass, blockedChipTitle } from '../shared/use-blocked'
import { TileCover, TileFormatBadge, TileMeta } from '../shared/GalleryTile'
import { resolveLibraryFacts, type LibraryFacts } from '../shared/library-facts'
import { AlertCircle, BookOpen, Check, FolderOpen, Heart, ListX, Loader2, Trash2 } from 'lucide-react'

interface GalleryDetailProps {
  galleryId: number
  onClose: () => void
  onDownload: (galleryId: number, format?: OutputFormat) => void
  onAddToQueue?: (galleryId: number) => void
  onTagClick?: (tagType: string, tagName: string) => void
  onGalleryChange?: (galleryId: number) => void
}

interface RelatedGallery {
  id: number
  title: string
  thumbnailUrl: string | null
  pages: number
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

export default function GalleryDetailPanel({
  galleryId,
  onClose,
  onDownload,
  onTagClick,
  onGalleryChange
}: GalleryDetailProps): React.JSX.Element {
  const { matcher: blockedMatch } = useBlocked()
  const auth = useAuthStore()
  const settingsOutputFormat = useSettingsStore((s) => s.outputFormat)
  const [downloadFormat, setDownloadFormat] = useState<OutputFormat>(settingsOutputFormat)
  const [detail, setDetail] = useState<GalleryDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>('not_downloaded')
  const [imgError, setImgError] = useState(false)
  const [showRedownloadConfirm, setShowRedownloadConfirm] = useState(false)
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [relatedGalleries, setRelatedGalleries] = useState<RelatedGallery[]>([])
  const [relatedFacts, setRelatedFacts] = useState<Record<number, LibraryFacts>>({})
  const [isFavorited, setIsFavorited] = useState(false)
  const [favLoading, setFavLoading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<'none' | 'remove' | 'deleteFile'>('none')
  const [deleting, setDeleting] = useState(false)
  const [libraryItemId, setLibraryItemId] = useState<number | null>(null)
  const [showViewer, setShowViewer] = useState(false)
  const [cdnConfig, setCdnConfig] = useState<CdnConfig | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const libResult = await window.api.library.getByGalleryId(galleryId)
      if (libResult.success && libResult.data) {
        const item = libResult.data
        setLibraryItemId(item.id)
        // isCustom=2 means placeholder (downloading), 0 means on disk
        setDownloadStatus(item.isCustom === 2 ? 'downloading' : 'in_library')
      } else {
        setDownloadStatus('not_downloaded')
        setLibraryItemId(null)
      }
    } catch {
      // Status check is best-effort
    }
  }, [galleryId])

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await window.api.getGallery(galleryId)
      if (result.success && result.data) {
        setDetail(result.data)
        await fetchStatus()
      } else {
        setError(result.error || 'Gallery not found')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gallery')
    } finally {
      setLoading(false)
    }
  }, [galleryId, fetchStatus])

  useEffect(() => {
    fetchDetail()
    // Poll status every 2s for real-time updates
    const interval = setInterval(fetchStatus, 2000)
    return () => clearInterval(interval)
  }, [fetchDetail, fetchStatus])

  // Check favorite status when detail loads
  useEffect(() => {
    if (!detail || !auth.loggedIn) return
    let cancelled = false
    window.api.checkFavorite(galleryId).then((result) => {
      if (cancelled) return
      if (result.success) {
        setIsFavorited(result.data)
      }
    }).catch(() => { /* silently ignore */ })
    return () => { cancelled = true }
  }, [detail, galleryId, auth.loggedIn])

  // Fetch CDN config for gallery viewer
  useEffect(() => {
    window.api.getCdnConfig().then((result) => {
      if (result.success && result.data) {
        setCdnConfig(result.data)
      }
    }).catch(() => { /* silently ignore */ })
  }, [])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      // Don't close panel if viewer is open (viewer handles its own Escape)
      if (showViewer) return
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose, showViewer])

  // F6: Fetch related galleries
  useEffect(() => {
    if (!detail || loading) return

    let cancelled = false
    window.api.getRelatedGalleries(galleryId).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        // The row scrolls now, so it is no longer limited to what fits.
        const related = result.data.result.slice(0, 12).map((item) => ({
          id: item.id,
          title: item.english_title || item.japanese_title || `Gallery #${item.id}`,
          thumbnailUrl: item.thumbnail
            ? `https://t.nhentai.net/${item.thumbnail}`
            : null,
          pages: item.num_pages || 0
        }))
        setRelatedGalleries(related)

        // Same lookup the grids use, so these cards can show the in-library
        // tick, format, artist and language exactly like the main ones.
        resolveLibraryFacts(related.map((r) => r.id))
          .then((facts) => {
            if (!cancelled) setRelatedFacts(facts)
          })
          .catch(() => {
            /* the cards fall back to title and page count */
          })
      }
    }).catch(() => { /* silently ignore */ })

    return () => { cancelled = true }
  }, [detail, loading, galleryId])

  // Cover URL: path from cover object, prefixed with standard thumbnail CDN
  const coverUrl = detail?.cover?.path
    ? `https://t.nhentai.net/${detail.cover.path}`
    : null

  const isInLibrary = downloadStatus === 'in_library'
  const isDownloading = downloadStatus === 'downloading' || downloadStatus === 'queued' || downloadStatus === 'converting'

  const handleTagClick = (tagType: string, tagName: string): void => {
    if (onTagClick) {
      onTagClick(tagType, tagName)
    } else {
      window.api.shell.openExternal(
        `https://nhentai.net/tag/${encodeURIComponent(tagName.replace(/\s+/g, '-').toLowerCase())}/`
      )
    }
  }

  const handleDelete = async (mode: 'remove' | 'deleteFile'): Promise<void> => {
    if (!libraryItemId) return
    setDeleting(true)
    try {
      if (mode === 'deleteFile') {
        await window.api.library.deleteFile(libraryItemId)
      } else {
        await window.api.library.delete(libraryItemId)
      }
      setDownloadStatus('not_downloaded')
      setLibraryItemId(null)
      setDeleteConfirm('none')
    } catch { /* silently ignore */ }
    finally { setDeleting(false) }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 transition-opacity" onClick={onClose} />

      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-surface shadow-2xl z-50 overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-raised text-fg-muted hover:text-fg transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {loading && <LoadingSkeleton variant="detail" />}

        {error && !loading && (
          <div className="p-6 text-center">
            <AlertCircle size={40} strokeWidth={1.5} className="mx-auto mb-4 text-fg-faint" aria-hidden="true" />
            <p className="text-lg font-medium text-danger">{error}</p>
            <button
              onClick={fetchDetail}
              className="mt-4 px-4 py-2 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {detail && !loading && !error && (
          <div className="p-6">
            {/* Cover image — clickable to open gallery viewer */}
            <button
              onClick={() => setShowViewer(true)}
              className="aspect-[3/4] max-w-sm mx-auto mb-6 bg-raised rounded-lg overflow-hidden block w-full relative group cursor-pointer"
              title="Read gallery"
            >
              {coverUrl && !imgError ? (
                <>
                  <img
                    src={coverUrl}
                    alt={detail.title.pretty}
                    draggable={false}
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                    <span className="inline-flex items-center gap-1.5 text-white text-lg font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                      <BookOpen size={16} aria-hidden="true" /> Read
                    </span>
                  </div>
                </>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-fg-faint">
                  <BookOpen size={40} strokeWidth={1.5} aria-hidden="true" />
                </div>
              )}
            </button>

            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <StatusBadge status={downloadStatus} size="md" />
                {auth.loggedIn && (
                  <button
                    onClick={async () => {
                      setFavLoading(true)
                      try {
                        if (isFavorited) {
                          await window.api.removeFavorite(galleryId)
                          setIsFavorited(false)
                        } else {
                          await window.api.addFavorite(galleryId)
                          setIsFavorited(true)
                        }
                      } catch { /* silently fail */ }
                      setFavLoading(false)
                    }}
                    disabled={favLoading}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm transition-colors disabled:opacity-50 ${
                      isFavorited
                        ? 'bg-accent-wash text-accent hover:bg-accent-wash'
                        : 'bg-raised text-fg-faint hover:bg-raised'
                    }`}
                    title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {favLoading ? (
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Heart size={14} fill={isFavorited ? 'currentColor' : 'none'} aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
              <span className="text-sm text-fg-muted">{detail.num_pages} pages</span>
            </div>

            <h2 className="text-xl font-bold text-fg mb-2">
              {detail.title.pretty}
            </h2>
            {detail.title.english && detail.title.english !== detail.title.pretty && (
              <p className="text-sm text-fg-muted mb-1">{detail.title.english}</p>
            )}
            {detail.title.japanese && (
              <p className="text-sm text-fg-faint mb-3">{detail.title.japanese}</p>
            )}

            {/* Artists & Groups */}
            <div className="flex flex-wrap gap-2 mb-3">
              {detail.tags
                .filter((t) => t.type === 'artist')
                .map((tag) => {
                  const blocked = blockedMatch('artist', tag.name)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => handleTagClick('artist', tag.name)}
                      title={blockedChipTitle(blocked)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${tagClass('artist')} ${blockedChipClass(blocked)}`}
                    >
                      {tag.name}
                    </button>
                  )
                })}
              {detail.tags
                .filter((t) => t.type === 'group')
                .map((tag) => {
                  const blocked = blockedMatch('group', tag.name)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => handleTagClick('group', tag.name)}
                      title={blockedChipTitle(blocked)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${tagClass('group')} ${blockedChipClass(blocked)}`}
                    >
                      {tag.name}
                    </button>
                  )
                })}
            </div>

            {/* All tags */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {/* Grouped by type: Genre, Languages, Parodies, Characters, then tags. */}
              {sortDescriptiveTags(detail.tags).map((tag) => {
                const blocked = blockedMatch(tag.type, tag.name)
                return (
                  <button
                    key={tag.id}
                    onClick={() => handleTagClick(tag.type, tag.name)}
                    title={blockedChipTitle(blocked)}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${tagClass(tag.type)} ${blockedChipClass(blocked)}`}
                  >
                    {tag.name}
                  </button>
                )
              })}
            </div>

            {/*
              Related galleries.

              Previously 64×80px thumbnails with a bare caption, which was too
              small to recognise a cover by and read as an afterthought under the
              tags. Now proper cards at the same 3/4 ratio as the grids, wide
              enough to actually see, scrolling horizontally inside their own
              container so the row can never widen the panel.
            */}
            {relatedGalleries.length > 0 && (
              <div className="mb-6">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold text-fg">Related</h3>
                  <span className="text-label text-fg-faint">
                    {relatedGalleries.length} galleries
                  </span>
                </div>

                <div className="-mx-1 overflow-x-auto px-1 pb-2">
                  <div className="flex gap-3 w-max">
                    {relatedGalleries.map((rg) => {
                      const facts = relatedFacts[rg.id]
                      return (
                        <button
                          key={rg.id}
                          onClick={() => {
                            if (onGalleryChange) {
                              onGalleryChange(rg.id)
                            } else {
                              window.api.shell.openExternal(`https://nhentai.net/g/${rg.id}`)
                            }
                          }}
                          title={rg.title}
                          className="group w-36 shrink-0 overflow-hidden rounded-lg border border-line bg-surface text-left transition-all duration-200 hover:border-accent hover:shadow-lg"
                        >
                          {/*
                            The same parts as the main grids, so a related card
                            carries the same information in the same places: page
                            count bottom right, format and in-library tick top
                            right, artist and language under the title.
                          */}
                          <TileCover
                            src={rg.thumbnailUrl}
                            alt={rg.title}
                            stat={rg.pages > 0 ? `${rg.pages}p` : null}
                            badge={
                              <TileFormatBadge
                                format={facts?.format}
                                owned={facts?.status === 'in_library'}
                                busy={facts?.status === 'downloading'}
                              />
                            }
                          />
                          <TileMeta
                            title={rg.title}
                            artist={facts?.artist}
                            language={facts?.language}
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Meta info */}
            <div className="space-y-1.5 text-sm text-fg-muted mb-6">
              <div className="flex justify-between">
                <span>ID</span>
                <span className="font-medium text-fg font-mono">#{detail.id}</span>
              </div>
              <div className="flex justify-between">
                <span>Pages</span>
                <span className="font-medium text-fg">{detail.num_pages}</span>
              </div>
              <div className="flex justify-between">
                <span>Uploaded</span>
                <span className="font-medium text-fg">{formatDate(detail.upload_date)}</span>
              </div>
              <div className="flex justify-between">
                <span>Favorites</span>
                <span className="font-medium text-fg">
                  {detail.num_favorites.toLocaleString()}
                </span>
              </div>
              {detail.scanlator && (
                <div className="flex justify-between">
                  <span>Scanlator</span>
                  <span className="font-medium text-fg">{detail.scanlator}</span>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="space-y-3">
              {isInLibrary && !showRedownloadConfirm ? (
                <>
                  <div className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-lg bg-success-wash text-success font-medium">
                    <Check size={16} aria-hidden="true" />
                    Already in Library
                  </div>
                  <button
                    onClick={async () => {
                      // Fetch library path for the warning
                      try {
                        const r = await window.api.library.getByGalleryId(galleryId)
                        if (r.success && r.data) setLibraryPath(r.data.filePath)
                      } catch { /* */ }
                      setShowRedownloadConfirm(true)
                    }}
                    className="w-full px-4 py-2.5 rounded-lg border border-warning bg-warning-wash text-warning font-medium hover:bg-warning-wash transition-colors"
                  >
                    Re-download
                  </button>

                  {/* Delete actions */}
                  {deleteConfirm === 'remove' ? (
                    <div className="space-y-2">
                      <p className="text-xs text-warning">This will only remove the database entry. The file on disk will be kept.</p>
                      <div className="flex gap-2">
                        <button onClick={() => handleDelete('remove')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-warning-fill text-white text-sm font-medium hover:bg-warning-fill disabled:opacity-50">{deleting ? 'Removing...' : 'Confirm Remove'}</button>
                        <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-raised text-sm font-medium">Cancel</button>
                      </div>
                    </div>
                  ) : deleteConfirm === 'deleteFile' ? (
                    <div className="space-y-2">
                      <p className="text-xs text-danger">This will delete the database entry AND the file from disk. This cannot be undone.</p>
                      <div className="flex gap-2">
                        <button onClick={() => handleDelete('deleteFile')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-danger-fill text-white text-sm font-medium hover:bg-danger-fill disabled:opacity-50">{deleting ? 'Deleting...' : 'Confirm Delete'}</button>
                        <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-raised text-sm font-medium">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={() => setDeleteConfirm('remove')} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-warning-wash text-warning text-sm font-medium hover:bg-warning-wash"><ListX size={14} aria-hidden="true" /> Remove from Library</button>
                      <button onClick={() => setDeleteConfirm('deleteFile')} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-danger-wash text-danger text-sm font-medium hover:bg-danger-wash"><Trash2 size={14} aria-hidden="true" /> Delete File</button>
                    </div>
                  )}
                </>
              ) : showRedownloadConfirm ? (
                <div className="p-4 rounded-lg border border-warning bg-warning-wash space-y-3">
                  <p className="text-sm text-warning">
                    This gallery already exists in your library.
                    {libraryPath && (
                      <span className="mt-1 flex items-center gap-1.5 text-xs opacity-75">
                        <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
                        <span className="truncate">{libraryPath}</span>
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-warning">
                    Re-downloading will remove the existing file and re-download it.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        // Remove from library first, then download
                        try {
                          const r = await window.api.library.getByGalleryId(galleryId)
                          if (r.success && r.data) {
                            await window.api.library.deleteFile(r.data.id)
                          }
                        } catch { /* */ }
                        setShowRedownloadConfirm(false)
                        setDownloadStatus('not_downloaded')
                        onDownload(galleryId, downloadFormat)
                      }}
                      className="flex-1 px-3 py-2 rounded-lg bg-warning-fill text-white text-sm font-medium hover:bg-warning-fill transition-colors"
                    >
                      Yes, Re-download
                    </button>
                    <button
                      onClick={() => setShowRedownloadConfirm(false)}
                      className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-fg text-sm font-medium hover:bg-raised transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : isDownloading ? (
                <div className="px-4 py-3 rounded-lg bg-info-wash text-info text-center font-medium">
                  ⏳ Already Downloading...
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <FormatSelector
                      value={downloadFormat}
                      onChange={setDownloadFormat}
                      className="flex-1"
                    />
                    <button
                      onClick={() => onDownload(galleryId, downloadFormat)}
                      className="flex-1 px-4 py-3 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover transition-colors"
                    >
                      Download
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => window.api.shell.openExternal(`https://nhentai.net/g/${galleryId}`)}
                className="w-full px-4 py-2 rounded-lg text-sm text-fg-muted hover:text-fg transition-colors"
              >
                Open in Browser ↗
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Gallery Viewer */}
      {showViewer && detail && cdnConfig && (
        <GalleryViewer
          galleryId={detail.id}
          pages={detail.pages}
          cdnServers={cdnConfig.image_servers}
          thumbServers={cdnConfig.thumb_servers}
          title={detail.title.pretty}
          onClose={() => setShowViewer(false)}
        />
      )}
    </>
  )
}
