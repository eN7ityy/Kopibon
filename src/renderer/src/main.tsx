import './assets/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

console.log('[renderer] main.tsx loaded, mounting React...')

try {
  const rootEl = document.getElementById('root')
  if (!rootEl) {
    console.error('[renderer] #root element not found!')
  } else {
    console.log('[renderer] #root found, rendering App...')
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  }
} catch (err) {
  console.error('[renderer] Failed to mount React:', err)
  document.body.innerHTML = `<div style="color:red;padding:20px;">Failed to start: ${String(err)}</div>`
}
