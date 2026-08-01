import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import { useConversionStore } from '../../stores/conversion.store'
import { useAuthStore } from '../../stores/auth.store'
import type { OutputFormat, PageSizeOption } from '../../stores/settings.store'
import OriginalsCleanup from './OriginalsCleanup'
import ProgressBar from '../shared/ProgressBar'
import ToolchainStatus from './ToolchainStatus'
import UpdateStatus from './UpdateStatus'
import LogsPage from './LogsPage'
import SearchSettings from './SearchSettings'
import {
  Check,
  Trash2,
  X,
  FolderTree,
  Globe,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import Notice from '../shared/Notice'
import Button from '../shared/Button'

/**
 * Settings panes.
 *
 * `savable` marks the panes that hold values the Save button writes. Tools,
 * Logs, Advanced and Danger Zone act immediately or act on their own controls,
 * so showing Save there would offer a button that does nothing.
 */
type PaneKey = 'library' | 'nhentai' | 'advanced' | 'danger'

const SETTINGS_PANES: Array<{
  key: PaneKey
  label: string
  Icon: LucideIcon
  savable?: boolean
}> = [
  { key: 'library', label: 'Library', Icon: FolderTree, savable: true },
  // Account and search defaults are both nhentai-side settings, and each was a
  // pane holding very little on its own.
  { key: 'nhentai', label: 'nhentai', Icon: Globe },
  // Tools, logs and updates are all things you go looking for rather than
  // configure, so they share a pane.
  { key: 'advanced', label: 'Advanced', Icon: SlidersHorizontal },
  { key: 'danger', label: 'Danger Zone', Icon: TriangleAlert }
]

type ValidationState =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid'; username: string }
  | { status: 'invalid'; error: string }

export default function SettingsPage(): React.JSX.Element {
  const settings = useSettingsStore()
  const auth = useAuthStore()

  const [pane, setPane] = useState<PaneKey>('library')
  const [keyInput, setKeyInput] = useState('')
  const [validation, setValidation] = useState<ValidationState>({ status: 'idle' })

  // Reset state
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetSuccess, setResetSuccess] = useState(false)

  // Save feedback
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const handleSaveSettings = async (): Promise<void> => {
    setSaveState('saving')
    await settings.saveToDb()
    // Re-read from the DB so the form reflects what was actually persisted
    await settings.loadFromDb()
    setSaveState('saved')
    setTimeout(() => setSaveState('idle'), 2000)
  }

  // Check auth status on mount
  useEffect(() => {
    if (auth.loggedIn && auth.username) {
      setValidation({ status: 'valid', username: auth.username })
    }
  }, [auth.loggedIn, auth.username])

  const handleValidateAndSave = async (): Promise<void> => {
    if (!keyInput.trim()) return
    setValidation({ status: 'validating' })

    const result = await window.api.auth.validateKey(keyInput.trim())
    if (result.success) {
      setValidation({ status: 'valid', username: result.data.username })
      auth.setAuth(true, result.data.username)
    } else {
      setValidation({ status: 'invalid', error: result.error || 'Invalid API key' })
    }
  }

  const handleClearKey = async (): Promise<void> => {
    await window.api.auth.clearKey()
    setKeyInput('')
    setValidation({ status: 'idle' })
    auth.clearAuth()
  }

  const handleResetLibrary = async (): Promise<void> => {
    if (resetConfirm !== 'DELETE ALL') return
    setResetting(true)
    setResetError(null)
    try {
      const result = await window.api.library.reset()
      if (result.success) {
        setResetSuccess(true)
        setResetConfirm('')
        setTimeout(() => setResetSuccess(false), 3000)
      } else {
        setResetError(result.error || 'Reset failed')
      }
    } catch (err) {
      setResetError(String(err))
    } finally {
      setResetting(false)
    }
  }

  const activePane = SETTINGS_PANES.find((p) => p.key === pane)

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Configure application preferences</p>
      </div>

      <div className="flex flex-1 min-h-0 gap-5">
        {/*
          Sub-navigation. Eight groups in one scroll was the problem: sections
          were only distinguishable because their headings were oversized, and
          reaching Logs meant scrolling past everything including the
          irreversible reset.
        */}
        <nav
          className="w-44 shrink-0 space-y-0.5 border-r border-line pr-3"
          aria-label="Settings sections"
        >
          {SETTINGS_PANES.map((item) => {
            const isActive = item.key === pane
            return (
              <button
                key={item.key}
                onClick={() => setPane(item.key)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent-wash text-accent'
                    : item.key === 'danger'
                      ? 'text-danger/80 hover:bg-raised hover:text-danger'
                      : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`}
              >
                {isActive && (
                  <span
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent"
                    aria-hidden="true"
                  />
                )}
                <item.Icon size={16} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        {/*
          Horizontal padding inside the scroll area, not just on the right.

          Full-width inputs sit flush against the container edge, and the focus
          ring is a 2px outline at a 2px offset, so it draws 4px outside the input
          where `overflow-y-auto` would clip it. `px-1.5` is 6px — just enough to
          clear the ring, where the 8px it had before pushed the fields further
          from the nav than they needed to be.
        */}
        <div className="flex-1 min-w-0 overflow-y-auto px-1.5">
          <div className="max-w-2xl space-y-6 pb-6">
            {/* Library */}
            {pane === 'library' && (
              <section>
                <h2 className="text-section font-semibold text-fg mb-3">Library</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">Library Path</label>
                    <input
                      type="text"
                      value={settings.libraryPath}
                      onChange={(e) => settings.setLibraryPath(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                    <p className="mt-1 text-xs text-fg-faint">
                      Directory where doujinshi PDFs are stored
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* Nhentai Account */}
            {pane === 'nhentai' && (
              <section>
                <h2 className="text-section font-semibold text-fg mb-3">Nhentai Account</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">API Key</label>

                    {validation.status !== 'valid' ? (
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={keyInput}
                          onChange={(e) => {
                            setKeyInput(e.target.value)
                            if (validation.status !== 'idle') setValidation({ status: 'idle' })
                          }}
                          placeholder="Enter your nhentai API key"
                          className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                        <button
                          onClick={handleValidateAndSave}
                          disabled={validation.status === 'validating' || !keyInput.trim()}
                          className="px-4 py-2 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {validation.status === 'validating' ? 'Validating...' : 'Validate & Save'}
                        </button>
                      </div>
                    ) : (
                      <div className="px-4 py-3 rounded-lg bg-success-wash border border-success flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Check size={18} className="text-success" aria-hidden="true" />
                          <div>
                            <p className="text-sm font-medium text-success">API Key Configured</p>
                            <p className="text-xs text-success">
                              Connected as {validation.username}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={handleClearKey}
                          className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger-wash text-danger hover:bg-danger-wash transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    )}

                    {/* Validation error */}
                    {validation.status === 'invalid' && (
                      <p className="mt-2 text-sm text-danger flex items-center gap-1">
                        <X size={14} aria-hidden="true" />
                        <span>{validation.error}</span>
                      </p>
                    )}

                    <p className="mt-1 text-xs text-fg-faint">
                      Login is optional. Provides access to favorites and higher rate limits.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* Downloads */}
            {pane === 'library' && (
              <section>
                <h2 className="text-section font-semibold text-fg mb-3">Downloads</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      Concurrency: {settings.downloadConcurrency}
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      value={settings.downloadConcurrency}
                      onChange={(e) => settings.setDownloadConcurrency(Number(e.target.value))}
                      className="w-full accent-accent"
                    />
                    <p className="mt-1 text-xs text-fg-faint">
                      Number of simultaneous downloads (1-8)
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">Output Format</label>
                    <select
                      value={settings.outputFormat}
                      onChange={(e) => settings.setOutputFormat(e.target.value as OutputFormat)}
                      className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="pdf">PDF</option>
                      <option value="cbz">CBZ</option>
                    </select>
                    <p className="mt-1 text-xs text-fg-faint">
                      Default for new downloads. Each download can override it.
                    </p>
                  </div>

                  <div className="border-t border-line pt-3">
                    <h3 className="text-sm font-semibold text-fg mb-3">PDF → CBZ Conversion</h3>

                    <div className="flex items-start gap-3 mb-3">
                      <input
                        type="checkbox"
                        checked={settings.cbzKeepOriginal}
                        onChange={(e) => settings.setCbzKeepOriginal(e.target.checked)}
                        className="mt-0.5 w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
                      />
                      <div>
                        <label className="text-sm text-fg">
                          Keep original PDFs after converting
                        </label>
                        <p className="mt-0.5 text-xs text-fg-faint">
                          Archives them under <code className="text-label">_originals/</code>{' '}
                          instead of deleting. Roughly doubles disk use. This is only the default —
                          each conversion asks.
                        </p>
                      </div>
                    </div>

                    <OriginalsCleanup />
                  </div>

                  <div className="flex items-center gap-3 mb-3">
                    <input
                      type="checkbox"
                      checked={settings.showNotifications}
                      onChange={(e) => settings.setShowNotifications(e.target.checked)}
                      className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
                    />
                    <label className="text-sm text-fg">Show download notifications</label>
                  </div>

                  <div className="border-t border-line pt-3">
                    <h3 className="text-sm font-semibold text-fg mb-3">PDF Compression</h3>

                    <div className="flex items-center gap-3 mb-3">
                      <input
                        type="checkbox"
                        checked={settings.compressPdf}
                        onChange={(e) => settings.setCompressPdf(e.target.checked)}
                        className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
                      />
                      <label className="text-sm text-fg">Enable Image Compression (JPEG)</label>
                    </div>

                    <div className="mb-3">
                      <label className="block text-sm font-medium text-fg mb-1">
                        Quality: {settings.compressionQuality}
                      </label>
                      <input
                        type="range"
                        min="1"
                        max="95"
                        value={settings.compressionQuality}
                        onChange={(e) => settings.setCompressionQuality(Number(e.target.value))}
                        disabled={!settings.compressPdf}
                        className="w-full accent-accent disabled:opacity-40"
                      />
                      <p className="mt-1 text-xs text-fg-faint">
                        Higher quality = larger file size (1-95)
                      </p>
                    </div>

                    <div className="mb-3">
                      <label className="block text-sm font-medium text-fg mb-1">Page Size</label>
                      <select
                        value={settings.pageSize}
                        onChange={(e) => settings.setPageSize(e.target.value as PageSizeOption)}
                        className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="Dynamic">Dynamic (1800px width, auto height)</option>
                        <option value="Fit to Image">Fit to Image (original dimensions)</option>
                        <option value="Letter">Letter</option>
                        <option value="A4">A4</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={settings.blackBackground}
                        onChange={(e) => settings.setBlackBackground(e.target.checked)}
                        className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
                      />
                      <label className="text-sm text-fg">Black Background (for Letter/A4)</label>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {pane === 'nhentai' && <SearchSettings />}

            {/* Interface */}
            {/* Required tools — not bundled, and the app degrades quietly without
            them, so this is deliberately its own section rather than a footnote */}
            {pane === 'advanced' && (
              <section>
                <h2 className="text-section font-semibold text-fg mb-3">Required Tools</h2>
                <ToolchainStatus />
              </section>
            )}


            {/* Advanced */}
            {pane === 'advanced' && (
              <section>
                <h2 className="text-section font-semibold text-fg mb-3">Advanced</h2>
                <div className="space-y-3">
                  <UpdateStatus />
                  <MetadataConverter />
                  <AppVersion />
                </div>
              </section>
            )}

            {/* The log reads as a footer to this pane, so it sits last. */}
            {pane === 'advanced' && <LogsPage />}

            {/*
          Destructive settings, last and visually separated.

          This sat in the middle of the page, between the output settings and
          Required Tools, marked only by red heading text — so scrolling past it
          to reach Logs meant scrolling through it. Irreversible actions belong at
          the end, behind a boundary you have to cross deliberately.
        */}
            {pane === 'danger' && (
              <section aria-labelledby="danger-zone">
                <div>
                  <h2 id="danger-zone" className="text-section font-semibold text-danger mb-1">
                    Danger Zone
                  </h2>
                  <p className="text-sm text-fg-muted mb-3">These actions cannot be undone.</p>

                  <div className="p-4 rounded-lg border border-danger bg-danger-wash space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold text-fg">Reset library</h3>
                      <p className="text-sm text-fg-muted mt-0.5">
                        Removes every item from the database. Files on disk are{' '}
                        <strong className="text-fg">not</strong> deleted, so a rescan will find them
                        again.
                      </p>
                    </div>

                    <div>
                      <label
                        htmlFor="reset-confirm"
                        className="block text-label mb-1 text-fg-muted"
                      >
                        Type <code className="font-mono text-fg">DELETE ALL</code> to confirm
                      </label>
                      <input
                        id="reset-confirm"
                        type="text"
                        value={resetConfirm}
                        onChange={(e) => setResetConfirm(e.target.value)}
                        placeholder="DELETE ALL"
                        className="w-full max-w-xs px-3 py-2 rounded-lg border border-danger bg-surface text-sm text-fg focus:ring-2 focus:ring-danger"
                      />
                    </div>

                    {resetError && <Notice tone="error">{resetError}</Notice>}
                    {resetSuccess && <Notice tone="success">Library reset.</Notice>}

                    <Button
                      role="danger"
                      icon={<Trash2 size={16} />}
                      onClick={handleResetLibrary}
                      disabled={resetConfirm !== 'DELETE ALL' || resetting}
                    >
                      {resetting ? 'Resetting…' : 'Reset library'}
                    </Button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {/*
        Save stays outside the scroll area and outside the pane switch. It was at
        the very bottom of a long page, so on the panes that have saveable
        settings you had to scroll to reach it. Panes that save nothing —
        Tools, Logs, Advanced, Danger Zone — hide it rather than showing a
        control that would do nothing.
      */}
      {activePane?.savable && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line pt-4">
          <Button role="primary" onClick={handleSaveSettings} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          {saveState === 'saved' && (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check size={14} aria-hidden="true" /> Saved
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function AppVersion(): React.JSX.Element {
  const [version, setVersion] = useState<string>('...')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then((r) => {
        if (r.success && r.data) setVersion(r.data)
      })
      .catch(() => setVersion('unknown'))
  }, [])

  return <p className="text-xs text-fg-faint">Doujin Downloader v{version}</p>
}

function MetadataConverter(): React.JSX.Element {
  const store = useConversionStore()
  const [showConfirm, setShowConfirm] = useState(false)
  const [runners, setRunners] = useState(3)
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [store.logLines])

  // Listen for progress from main process when running
  useEffect(() => {
    if (!store.running) return undefined
    const cleanup = window.api.onConvertProgress((p) => {
      store.updateProgress({
        current: p.current,
        total: p.total,
        converted: p.converted,
        failed: p.failed,
        logLines: (p as any).logLines
      })
    })
    return () => {
      cleanup()
    }
  }, [store.running])

  const handleStart = async () => {
    setShowConfirm(false)
    store.reset()
    store.setRunning(true)
    let summary = 'Metadata conversion finished'
    try {
      const r = await window.api.library.convertAllMetadata(runners)
      if (r.success && r.data) {
        const d = r.data as any
        if (d.cancelled) {
          store.addLogLine(`CANCELLED: ${d.converted} converted, ${d.total} total`)
          summary = `Metadata conversion cancelled: ${d.converted} of ${d.total} converted`
        } else {
          store.addLogLine(
            `COMPLETE: ${d.converted} converted, ${d.failed} failed, ${d.total} total`
          )
          summary =
            `Metadata conversion complete: ${d.converted} converted` +
            (d.failed > 0 ? `, ${d.failed} failed` : '')
        }
      } else {
        store.addLogLine(`ERROR: ${r.error || 'Unknown'}`)
        summary = `Metadata conversion failed: ${r.error || 'unknown error'}`
      }
    } catch (e) {
      store.addLogLine(`ERROR: ${String(e)}`)
      summary = `Metadata conversion failed: ${String(e)}`
    }
    // finish() replaces setRunning(false): it also carries the outcome, so the
    // job reports its result the same way sync and CBZ conversion do instead of
    // ending silently outside the log pane.
    store.finish(summary)
  }

  const handleCancel = async () => {
    await window.api.library.cancelConversion()
    store.addLogLine('Cancelling after current items finish...')
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => setShowConfirm(true)}
        disabled={store.running}
        className="px-4 py-2 rounded-lg border border-warning bg-warning-wash text-warning text-sm font-medium hover:bg-warning-wash disabled:opacity-50 transition-colors"
      >
        {store.running ? 'Converting...' : 'Convert Library Metadata'}
      </button>
      <p className="text-xs text-fg-faint">
        Re-applies correct XMP metadata to all files and fixes filenames.
      </p>
      {!store.running && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-fg-muted">Runners:</label>
          <input
            type="number"
            min={1}
            max={20}
            value={runners}
            onChange={(e) => setRunners(Math.max(1, Math.min(20, parseInt(e.target.value) || 3)))}
            className="w-16 px-2 py-1 text-xs rounded border border-line bg-surface"
          />
        </div>
      )}

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-surface rounded-xl p-6 max-w-md mx-4 shadow-2xl">
            <h3 className="text-section font-semibold text-fg mb-2">Convert Library Metadata?</h3>
            <p className="text-sm text-fg-muted mb-4">
              This will rewrite XMP metadata on ALL files in your library using pikepdf. This may
              take several minutes for large libraries. Downloads and other operations will not be
              affected.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleStart}
                className="flex-1 px-4 py-2 rounded-lg bg-warning-fill text-white text-sm font-medium hover:bg-warning-fill"
              >
                Start Conversion
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-line bg-surface text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Progress — the same component and rules as every other job */}
      {(store.running || store.lastMessage) && (
        <ProgressBar
          id="metadata"
          label={store.running ? 'Rewriting file metadata' : store.lastMessage!}
          current={store.current}
          total={store.total}
          detail={
            [
              store.converted > 0 ? `${store.converted} ok` : null,
              store.failed > 0 ? `${store.failed} failed` : null
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
          etaSeconds={store.etaSeconds}
          tone="write"
          done={!store.running}
          onCancel={store.running ? handleCancel : undefined}
        />
      )}

      {/* Scrollable log */}
      {store.logLines.length > 0 && (
        <div
          ref={logRef}
          className="max-h-40 overflow-y-auto rounded-lg bg-app text-fg text-xs font-mono p-2 space-y-0.5"
        >
          {store.logLines.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('ERROR') || line.startsWith('FAIL')
                  ? 'text-danger'
                  : line.startsWith('COMPLETE')
                    ? 'text-warning'
                    : ''
              }
            >
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Cancel now lives on the progress bar itself, like every other job */}
    </div>
  )
}
