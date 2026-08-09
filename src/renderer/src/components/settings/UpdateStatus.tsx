import { useState, useEffect } from 'react'

type State = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'

type UpdateStatusEvent = Parameters<Parameters<typeof window.api.onUpdateStatus>[0]>[0]

// Tags and attributes we allow through from GitHub's release-note HTML. Anything
// else is unwrapped (children kept) or dropped, and every `on*` handler plus any
// non-http(s)/mailto link is removed — the notes render as rich HTML, not script.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'code', 'pre', 'blockquote', 'hr', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img',
  'sup', 'sub'
])
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan'])
}
const EMPTY_ATTRS = new Set<string>()
const SAFE_HREF = /^(https?:|mailto:)/i

/**
 * Sanitise GitHub's release-note HTML for `dangerouslySetInnerHTML`. Builds a
 * fresh DOM, keeping only allowed tags/attributes, stripping inline handlers and
 * blocking `javascript:`/`data:` URLs, so links stay links without running code.
 */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = document.createElement('div')

  const copy = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(false)
    if (node.nodeType !== Node.ELEMENT_NODE) return null // drop comments, CDATA, etc.
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the element's children but not the element itself.
      const holder = document.createElement('span')
      for (const child of Array.from(el.childNodes)) {
        const c = copy(child)
        if (c) holder.appendChild(c)
      }
      return holder
    }
    const clone = document.createElement(tag)
    const allowedAttrs = ALLOWED_ATTRS[tag] ?? EMPTY_ATTRS
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) continue
      if (!allowedAttrs.has(name)) continue
      const value = attr.value.trim()
      if ((name === 'href' || name === 'src') && !SAFE_HREF.test(value)) continue
      clone.setAttribute(name, value)
    }
    for (const child of Array.from(el.childNodes)) {
      const c = copy(child)
      if (c) clone.appendChild(c)
    }
    return clone
  }

  for (const child of Array.from(doc.body.childNodes)) {
    const c = copy(child)
    if (c) out.appendChild(c)
  }
  return out.innerHTML
}

/**
 * Open a link clicked inside the rendered release notes in the system browser
 * rather than letting Electron's webContents navigate away from the app.
 */
function handleNoteClick(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement | null
  const anchor = target instanceof Element ? target.closest('a') : null
  if (!anchor || !anchor.href) return
  event.preventDefault()
  void window.api.shell.openExternal(anchor.href)
}

/**
 * Update state and the restart prompt.
 *
 * Updates are never downloaded automatically: the app checks on boot and, when
 * one is available, waits in the `available` state until the user explicitly
 * clicks "Download". Once downloaded it waits in `ready` until "Restart now".
 */
export default function UpdateStatus(): React.JSX.Element {
  const [state, setState] = useState<State>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null)

  const apply = (s: UpdateStatusEvent): void => {
    setState(s.state)
    if (s.version) setVersion(s.version)
    if (typeof s.percent === 'number') setPercent(s.percent)
    setMessage(s.message ?? null)
    setReleaseNotes(s.releaseNotes ? sanitizeHtml(s.releaseNotes) : null)
  }

  useEffect(() => {
    let disposed = false
    const off = window.api.onUpdateStatus((s) => {
      if (!disposed) apply(s)
    })
    // The boot check fires long before this pane is ever navigated to, so pull
    // the last known status instead of waiting for an event that already passed.
    void window.api.app.getUpdateStatus().then((r) => {
      if (!disposed && r?.success && r.data) apply(r.data)
    })
    return () => { disposed = true; off() }
  }, [])

  const check = async (): Promise<void> => {
    setState('checking')
    setMessage(null)
    const r = await window.api.app.checkForUpdates()
    // A failed check resolves rather than throwing; the 'error' event usually
    // arrives too, but this covers a rejection that never emits one.
    if (!r?.success) {
      setState('error')
      setMessage(r?.error || 'Update check failed')
    }
  }

  const download = async (): Promise<void> => {
    setState('downloading')
    setMessage(null)
    const r = await window.api.app.downloadUpdate()
    // A rejected download surfaces through the 'error' event; this guards the
    // case where it resolves without ever emitting one.
    if (!r?.success) {
      setState('error')
      setMessage(r?.error || 'Download failed')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={state === 'checking' || state === 'downloading'}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-raised text-fg hover:bg-raised disabled:opacity-50"
        >
          {state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>

        {state === 'current' && (
          <span className="text-xs text-success">
            You are on the latest version
          </span>
        )}
        {state === 'downloading' && (
          <span className="text-xs text-fg-muted tabular-nums">
            Downloading {percent}%
          </span>
        )}
      </div>

      {state === 'available' && (
        <div className="p-3 rounded-lg bg-accent-wash border border-accent space-y-3">
          <div className="text-sm font-medium text-accent">
            Version {version} is available
          </div>
          {releaseNotes ? (
            <div
              className="note max-h-48 overflow-y-auto text-xs text-fg-muted p-2 rounded bg-raised border border-line"
              onClick={handleNoteClick}
              dangerouslySetInnerHTML={{ __html: releaseNotes }}
            />
          ) : (
            <p className="text-xs text-fg-muted">No release notes provided.</p>
          )}
          <button
            onClick={() => void download()}
            className="px-3 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-medium hover:bg-accent-hover"
          >
            Download update
          </button>
        </div>
      )}

      {state === 'ready' && (
        <div className="p-3 rounded-lg bg-accent-wash border border-accent flex items-center justify-between gap-3">
          <span className="text-xs text-accent">
            Version {version} is ready. It will be applied when you restart.
          </span>
          <button
            onClick={() => void window.api.app.installUpdate()}
            className="px-3 py-1.5 shrink-0 rounded-lg bg-accent-fill text-white text-xs font-medium hover:bg-accent-hover"
          >
            Restart now
          </button>
        </div>
      )}

      {state === 'error' && (
        <p className="text-xs text-warning">
          Update check failed: {message}
          {/* Expected until the first GitHub Release is published — the feed
              does not exist yet, so there is nothing to compare against. */}
        </p>
      )}
    </div>
  )
}
