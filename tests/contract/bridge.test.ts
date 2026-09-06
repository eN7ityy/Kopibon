/**
 * BR-01 — bridge contract suite (`npm run contract:bridge`).
 *
 * Generated from `docs/rust-port/02-ipc-surface.md` §2/§3: every
 * request/response channel the renderer invokes must have exactly one
 * registered Tauri handler, and every event the renderer subscribes to must
 * be emitted by the shell with a working unlisten.
 *
 * Static by design: it runs in CI without the Tauri binary (no WebView, no
 * side effects). Behavioural parity lives in the core differential suites;
 * this suite guards the wiring — a handler that exists but is not
 * registered, a renamed channel, a dropped event — which is how a 144/144
 * surface silently rots.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const BRIDGE = join(ROOT, 'src', 'renderer', 'src', 'bridge.ts')
const SRC_TAURI = join(ROOT, 'src-tauri', 'src')
const MAIN_RS = join(SRC_TAURI, 'main.rs')
const DOC = join(ROOT, 'docs', 'rust-port', '02-ipc-surface.md')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** All `call('ns:ch', …)` sites — the invoke surface. */
function bridgeInvokes(): string[] {
  const src = read(BRIDGE)
  return [...src.matchAll(/\bcall\('([^']+)'/g)].map((m) => m[1])
}

/** All `on('ns:ev', …)` sites — the event subscriptions. */
function bridgeEvents(): string[] {
  const src = read(BRIDGE)
  return [...src.matchAll(/\bon\('([^']+)'/g)].map((m) => m[1])
}

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) rustFiles(full, out)
    else if (entry.name.endsWith('.rs')) out.push(full)
  }
  return out
}

/** `rename = "ns:ch"` → rust fn name, across every command module.
 *
 * Two shapes: hand-written `#[tauri::command(rename = "…")]` attributes and
 * the per-module shorthands (`api_command!`, `lib_read!`, `lib_mut!`,
 * `lib_job!`, …), whose first argument is the generated fn name and whose
 * second is the channel. */
function shellRenames(): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of rustFiles(SRC_TAURI)) {
    const src = read(file)
    const attr = /#\[tauri::command\(rename = "([^"]+)"\)\]\s*\n?\s*pub\(crate\) fn (\w+)/g
    for (const m of src.matchAll(attr)) map.set(m[1], m[2])
    const shorthand = /\b(?:\w*_command|lib_\w+)!\(\s*(\w+),\s*"([^"]+)"/g
    for (const m of src.matchAll(shorthand)) map.set(m[2], m[1])
  }
  return map
}

/** `emit` targets in the shell: the channel may be the first argument
 * (`app.emit("ns:ev", …)`) or a later one (`emit(&app, "ns:ev", …)`), so the
 * match allows one nested argument before the string. Doc comments never
 * contain an `emit(` call and cannot fake a hit. */
function shellEmits(): Set<string> {
  const set = new Set<string>()
  const re = /emit\(\s*(?:[^()]*,\s*)?"([a-z]+:[a-zA-Z]+)"/g
  for (const file of rustFiles(SRC_TAURI)) {
    const src = read(file)
    for (const m of src.matchAll(re)) set.add(m[1])
  }
  return set
}

/** Rust fns listed in the `generate_handler![…]` block. */
function registeredFns(): Set<string> {
  const src = read(MAIN_RS)
  const block = src.slice(src.indexOf('generate_handler!'))
  return new Set([...block.matchAll(/commands::\w+::(\w+)/g)].map((m) => m[1]))
}

/** Backticked `ns:ch` occurrences inside one doc section. */
function docChannels(section: string): Set<string> {
  return new Set([...section.matchAll(/`([a-zA-Z]+:[a-zA-Z]+)`/g)].map((m) => m[1]))
}

const INVOKES = [...new Set(bridgeInvokes())].sort()
const EVENTS = [...new Set(bridgeEvents())].sort()

describe('BR-01 bridge contract (144/144)', () => {
  it('invoke surface has the documented size (130)', () => {
    expect(INVOKES).toHaveLength(130)
  })

  it('event surface has the documented size (14)', () => {
    expect(EVENTS).toHaveLength(14)
  })

  it('every invoked channel has exactly one shell handler', () => {
    const renames = shellRenames()
    const missing = INVOKES.filter((ch) => !renames.has(ch))
    expect(missing).toEqual([])
    // No handler may claim a channel the renderer never invokes
    // (dead surface rots silently) — except `auth:getRateLimits`, a dead
    // endpoint 1.x registered and the bridge never calls; the shell keeps
    // it so the surface stays 144/144.
    const invokeSet = new Set(INVOKES)
    const orphaned = [...renames.keys()].filter((ch) => !invokeSet.has(ch))
    expect(orphaned).toEqual(['auth:getRateLimits'])
  })

  it('every handler is registered in generate_handler!', () => {
    const renames = shellRenames()
    const registered = registeredFns()
    const unregistered = [...renames.entries()]
      .filter(([, fn]) => !registered.has(fn))
      .map(([ch]) => ch)
    expect(unregistered).toEqual([])
  })

  it('every subscribed event is emitted by the shell', () => {
    const emits = shellEmits()
    const silent = EVENTS.filter((ev) => !emits.has(ev))
    expect(silent).toEqual([])
  })

  it('every subscription returns a working unlisten', () => {
    // Static: each `on(` binding must resolve through the sync-unsubscribe
    // wrapper (bridge.ts `on`), which settles Tauri's async `listen` into a
    // plain `() => void` with a cancelled flag for the pre-resolve window.
    const src = read(BRIDGE)
    expect(src).toMatch(/function on<T>\(channel: string/)
    expect(src).toMatch(/cancelled = true/)
    for (const ev of EVENTS) {
      expect(src).toContain(`on('${ev}'`)
    }
  })

  it('02-ipc-surface §2 documents every invoked channel', () => {
    const doc = read(DOC)
    const section2 = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'))
    const documented = docChannels(section2)
    const undocumented = INVOKES.filter((ch) => !documented.has(ch))
    expect(undocumented).toEqual([])
  })

  it('02-ipc-surface §3 documents every event', () => {
    const doc = read(DOC)
    const section3 = doc.slice(doc.indexOf('## 3.'))
    const documented = docChannels(section3)
    const undocumented = EVENTS.filter((ev) => !documented.has(ev))
    expect(undocumented).toEqual([])
  })
})
