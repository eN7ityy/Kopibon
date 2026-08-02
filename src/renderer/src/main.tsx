import './assets/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// ─── Renderer-side logger helper ────────────────────────────────────────────

type LogBridge = {
  log?: {
    write?: (level: string, scope: string, msg: string, fields?: Record<string, unknown>) => unknown
  }
}

function rendererLog(
  level: string,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>
): void {
  try {
    ;(window as unknown as { api?: LogBridge }).api?.log?.write?.(level, scope, msg, fields)
  } catch {
    /* logger unavailable */
  }
  // Also keep console in dev so devtools still shows output
  if (level === 'error') console.error(`[${scope}]`, msg, fields)
  else if (level === 'warn') console.warn(`[${scope}]`, msg, fields)
}

// ─── Global error capture (§1.6) ───────────────────────────────────────────

window.addEventListener('error', (event) => {
  const errorId = `E-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  rendererLog('error', 'renderer:window', event.error?.message || event.message, {
    err: event.error
      ? {
          name: event.error.name || 'Error',
          message: event.error.message,
          stack: event.error.stack
        }
      : undefined,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    errorId
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const errorId = `E-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const reason = event.reason
  rendererLog('error', 'renderer:unhandledrejection', 'Unhandled promise rejection', {
    err: reason instanceof Error
      ? { name: reason.name, message: reason.message, stack: reason.stack }
      : { name: 'Error', message: String(reason) },
    errorId
  })
})

// ─── Native drag suppression ────────────────────────────────────────────────

/**
 * Refuse every native drag, application-wide.
 *
 * Links and images are draggable by default. Starting one hands Chromium a
 * native drag, and in this app that reliably hangs the window: catch a sidebar
 * tab, move the pointer a little, and the drag ghost appears with the tab's
 * label and its localhost URL — then nothing responds and the app has to be
 * killed. Cover images used to do the same, which is why a handful of cards
 * already prevent it individually.
 *
 * Registered here rather than on components so it cannot be missed. The CSS
 * rule in styles.css stops most drags from starting at all; this is the
 * authoritative half, because a drag can begin through paths that
 * `-webkit-user-drag` does not cover.
 *
 * Capture phase, so it runs before anything downstream and does not depend on
 * the event reaching the document by bubbling. Nothing legitimate is lost: the
 * app has no drag-and-drop, and dropping files *in* uses different events.
 */
window.addEventListener('dragstart', (event) => event.preventDefault(), { capture: true })

// `drop` and `dragover` on the document would otherwise let a file dragged in
// from the desktop navigate the window away from the app, replacing the UI with
// whatever was dropped.
window.addEventListener('dragover', (event) => event.preventDefault(), { capture: true })
window.addEventListener('drop', (event) => event.preventDefault(), { capture: true })

// ─── Mount React ────────────────────────────────────────────────────────────

rendererLog('info', 'renderer', 'main.tsx loaded, mounting React...')

try {
  const rootEl = document.getElementById('root')
  if (!rootEl) {
    rendererLog('error', 'renderer', '#root element not found!')
  } else {
    rendererLog('info', 'renderer', '#root found, rendering App...')
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  }
} catch (err) {
  rendererLog('error', 'renderer', 'Failed to mount React', {
    err: err instanceof Error ? err : new Error(String(err))
  })
  document.body.innerHTML = `<div style="color:red;padding:20px;">Failed to start: ${String(err)}</div>`
}
