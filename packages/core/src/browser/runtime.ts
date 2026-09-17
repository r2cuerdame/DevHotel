import type { ClientBrowserKind } from '@devhotel/shared'

/**
 * Backend-neutral contract for the process that actually runs a Client
 * Browser. The Docker-era host runtime and a future DevHotel-owned managed
 * runtime both launch "a Chromium with this profile, reachable over CDP";
 * everything above this seam — ownership, tokens, endpoints, cleanup — is
 * shared and must not care where the process lives.
 */
export interface ClientBrowserLaunchRequest {
  sessionId: string
  /** Directory that must hold this session's entire profile: cookies, storage, cache, tabs. */
  profileDir: string
  headless: boolean
}

export interface LaunchedClientBrowser {
  pid: number | null
  browserKind: ClientBrowserKind
  /** Loopback host and port of the browser's own DevTools listener. */
  devtoolsHost: string
  devtoolsPort: number
  /** Browser-level CDP WebSocket URL (`ws://host:port/devtools/browser/<id>`). */
  cdpWsUrl: string
  /** Best-effort graceful stop; resolves once the process is gone or the grace period elapsed. */
  stop(): Promise<void>
}

/** Fresh observation of a browser this DevHotel did not launch (or launched before a restart). */
export interface ClientBrowserProbe {
  processAlive: boolean
  /** True only when a DevTools listener answered on the recorded port from the recorded profile. */
  cdpReachable: boolean
  cdpWsUrl: string | null
  browserVersion: string | null
}

export interface ClientBrowserRuntime {
  /** Human-readable runtime name for status surfaces. */
  readonly kind: string
  /** Whether a browser can be launched here at all; the reason is agent-facing. */
  availability(): Promise<{ available: boolean; detail: string }>
  launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser>
  /** Observe a session by its durable facts alone; never launches anything. */
  probe(record: { pid: number | null; devtoolsPort: number | null; profileDir: string }): Promise<ClientBrowserProbe>
  /**
   * Stop a browser this runtime cannot hand back as a LaunchedClientBrowser
   * (typically one from an earlier DevHotel process). Returns false when the
   * process could not be proven to be a browser owning `profileDir`, in which
   * case nothing was signalled.
   */
  stopOrphan(record: { pid: number | null; devtoolsPort: number | null; profileDir: string }): Promise<boolean>
}
