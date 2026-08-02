import { useState } from 'react'

/** Strip protocol prefix from a CDN server hostname (handles https:// and http://). */
function normalizeHost(raw: string): string {
  return raw.replace(/^https?:\/\//, '')
}

export interface ImageRotation {
  /** The full CDN URL, or null when there is no path or every server failed. */
  url: string | null
  /**
   * Advance to the next server. Wire this to the `<img>`'s `onError`. It is a
   * plain arrow function, so it needs no useCallback stability.
   */
  onError: () => void
  /** The current server index. Exposed mainly for debugging/tests. */
  serverIndex: number
  /** True when there are no servers left to try. */
  exhausted: boolean
}

/**
 * Rotate through CDN servers for a single image.
 *
 * Starts at server index 0 and builds `https://{server}/{path}`. Each `onError`
 * call advances to the next server; once the list is exhausted the URL stays
 * null (consumers render their placeholder). When `path` is null no URL is
 * built and no rotation happens.
 *
 * When the image path or the server list changes, the index resets to 0 via the
 * "adjusting state during render" pattern — calling setState in an effect here
 * would trigger a cascading render and trip the react-hooks linter.
 */
export function useImageRotation(path: string | null, servers: string[]): ImageRotation {
  const [serverIndex, setServerIndex] = useState(0)

  // Track the previous inputs and restart from the first server whenever a new
  // image arrives or the server list (re)loads, so a stale index can't point
  // past the end or skip the preferred server.
  const [previousPath, setPreviousPath] = useState(path)
  const [previousServers, setPreviousServers] = useState(servers)
  if (previousPath !== path || previousServers !== servers) {
    setPreviousPath(path)
    setPreviousServers(servers)
    setServerIndex(0)
  }

  if (path === null) {
    return { url: null, onError: () => {}, serverIndex: 0, exhausted: false }
  }

  const exhausted = serverIndex >= servers.length
  const server = servers[serverIndex]
  const url = server && !exhausted ? `https://${normalizeHost(server)}/${path}` : null

  const onError = (): void => {
    setServerIndex((prev) => prev + 1)
  }

  return { url, onError, serverIndex, exhausted }
}
