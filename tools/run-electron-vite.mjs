#!/usr/bin/env node
/**
 * Cross-platform launcher for electron-vite.
 *
 * The npm scripts used to be `ELECTRON_RUN_AS_NODE= electron-vite dev`, which is
 * bash-only syntax — on Windows cmd/PowerShell it fails outright, so `npm run
 * dev` did not work there at all.
 *
 * The prefix exists to *unset* ELECTRON_RUN_AS_NODE. When that variable is
 * inherited (some editors and terminal integrations set it), the electron binary
 * runs as plain Node and never opens a window. There is no portable shell syntax
 * for unsetting a variable inline, so this does it in JS instead of pulling in a
 * dependency such as cross-env.
 *
 * Usage: node tools/run-electron-vite.mjs <dev|preview|build> [...args]
 */
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// `npx`-free resolution: electron-vite's bin is in node_modules/.bin, which npm
// already puts on PATH for scripts, so the bare name resolves. `shell: true` is
// needed on Windows for the .cmd shim.
const child = spawn('electron-vite', process.argv.slice(2), {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

child.on('exit', (code, signal) => {
  // Propagate the real outcome so CI and `npm run` report failures correctly.
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
child.on('error', (err) => {
  console.error('[run-electron-vite] failed to start electron-vite:', err.message)
  process.exit(1)
})
