/**
 * Finding and loading the metadata templates.
 *
 * The templates are plain text on purpose: they are the exact bytes written
 * into every CBZ and PDF this app touches, and the reader on the other end
 * (Kavita today, possibly something else tomorrow) is not ours to control. A
 * schema change should be an edit to a file, not a patch to three workers.
 *
 * Two copies exist:
 *
 *   - the shipped defaults, next to the application, which are never written to
 *   - a per-user copy under `userData/metadata-templates/`, seeded from the
 *     defaults on first run, which is the one to edit
 *
 * Deleting a file from the user copy restores the shipped default for it, since
 * the search simply falls through. Edits take effect on the next file written —
 * the cache is invalidated by mtime, so there is no need to restart the app.
 *
 * Worker threads inherit `process.env`, so `DOUJIN_TEMPLATE_DIR` is all that is
 * needed to point the six workers at the same directory as the main process.
 */

import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { join, resolve, dirname } from 'path'

/** The directory name used both under userData and alongside the binary. */
const DIR_NAME = 'metadata-templates'

/** Environment variable naming the preferred template directory. */
export const TEMPLATE_DIR_ENV = 'DOUJIN_TEMPLATE_DIR'

export const COMICINFO_TEMPLATE = 'comicinfo.template'
export const PDF_XMP_TEMPLATE = 'pdf-xmp.template'

/**
 * Directories to look in, most specific first.
 *
 * `process.resourcesPath` only exists in a packaged Electron app; the cwd walk
 * covers `npm run dev`, vitest, and the command-line tools, all of which run
 * from somewhere inside the repository.
 */
function searchPath(): string[] {
  const dirs: string[] = []

  const fromEnv = process.env[TEMPLATE_DIR_ENV]
  if (fromEnv) dirs.push(fromEnv)

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) dirs.push(join(resourcesPath, DIR_NAME))

  // Walk up from the working directory so a tool run from a subdirectory still
  // finds the repository copy.
  let cursor = process.cwd()
  for (let i = 0; i < 6; i++) {
    dirs.push(join(cursor, 'resources', DIR_NAME))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  return dirs
}

/** Locate one template file, or null when no candidate directory holds it. */
function findTemplate(name: string): string | null {
  for (const dir of searchPath()) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The shipped defaults, ignoring any user copy.
 *
 * Used to seed the user directory. Skips whatever `DOUJIN_TEMPLATE_DIR` points
 * at, because that is the destination — copying it onto itself would make
 * seeding a no-op that looks like it worked.
 */
function findShippedDir(): string | null {
  const userDir = process.env[TEMPLATE_DIR_ENV]
  for (const dir of searchPath()) {
    if (userDir && resolve(dir) === resolve(userDir)) continue
    if (existsSync(join(dir, COMICINFO_TEMPLATE))) return dir
  }
  return null
}

interface CacheEntry {
  path: string
  mtimeMs: number
  text: string
}

const cache = new Map<string, CacheEntry>()

/**
 * Read a template, re-reading it whenever the file on disk has changed.
 *
 * Throws when the file cannot be found anywhere. That is deliberate: a missing
 * template means every metadata write would produce something wrong, and
 * failing loudly at the first write is far easier to diagnose than a library
 * that quietly fills up with blank ComicInfo files.
 */
export function loadTemplate(name: string): string {
  const cached = cache.get(name)
  if (cached) {
    try {
      if (statSync(cached.path).mtimeMs === cached.mtimeMs) return cached.text
    } catch {
      // The file went away — fall through and resolve again.
    }
  }

  const path = findTemplate(name)
  if (!path) {
    throw new Error(
      `Metadata template "${name}" not found. Looked in:\n  ${searchPath().join('\n  ')}`
    )
  }

  const text = readFileSync(path, 'utf-8')
  cache.set(name, { path, mtimeMs: statSync(path).mtimeMs, text })
  return text
}

/** Forget every cached template. Only needed by tests. */
export function clearTemplateCache(): void {
  cache.clear()
}

/**
 * Make a user-editable copy of the templates and point the app at it.
 *
 * Called once from main at startup, before any worker is spawned, so that the
 * environment variable is inherited by all of them. Missing files are copied;
 * existing ones are never overwritten, because they are what the user edited.
 *
 * Returns the directory in use, or null when the shipped templates could not be
 * located — in which case the search path still finds them wherever they are.
 */
export function installUserTemplates(userDataDir: string): string | null {
  const target = join(userDataDir, DIR_NAME)

  try {
    const shipped = findShippedDir()
    if (!shipped) return null

    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(shipped)) {
      const dest = join(target, entry)
      if (!existsSync(dest)) copyFileSync(join(shipped, entry), dest)
    }

    process.env[TEMPLATE_DIR_ENV] = target
    return target
  } catch {
    // A read-only or unwritable userData directory is not a reason to refuse to
    // write metadata; the shipped templates still resolve.
    return null
  }
}
