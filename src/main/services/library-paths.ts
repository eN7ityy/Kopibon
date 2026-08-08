/**
 * Resolve and relativize paths between the database and the filesystem.
 *
 * The database stores `file_path` as relative to the library root, so the path
 * is portable across renames and library moves. All internal code works with
 * absolute paths — only the DB boundary calls these helpers.
 *
 *   DB (relative)  ──resolve──▶  code (absolute)  ──relativize──▶  DB (relative)
 */
import { join, relative, isAbsolute, normalize } from 'path'

/**
 * Turn a stored relative path back into an absolute one.
 *
 * Pre-migration rows may still hold absolute paths — the `isAbsolute` guard
 * passes them through unchanged so the migration doesn't have to be atomic
 * with the code deploy.
 */
export function resolveLibraryPath(
  relativePath: string | null | undefined,
  libraryRoot: string
): string {
  if (!relativePath) return ''
  if (isAbsolute(relativePath)) return relativePath // pre-migration row
  return normalize(join(libraryRoot, relativePath))
}

/**
 * Turn an absolute path into one relative to the library root, for storage.
 */
export function relativizeLibraryPath(
  absolutePath: string,
  libraryRoot: string
): string {
  return relative(libraryRoot, absolutePath)
}
