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
