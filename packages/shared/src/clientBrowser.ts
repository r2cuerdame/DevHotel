import { z } from 'zod'

/**
 * Client Browser capability: an isolated, DevHotel-owned Chromium session an
 * agent borrows for web automation. It is deliberately separate from the Web
 * Server Room capability — a Room hosts the application under test; a Client
 * Browser is the thing that visits it. Every session has its own profile,
 * cookies, storage, tabs and process, and is reachable only through a
 * DevHotel endpoint that embeds a per-session secret.
 */

export type ClientBrowserStatus = 'starting' | 'ready' | 'stopped' | 'failed'
export type ClientBrowserProfileMode = 'ephemeral' | 'persistent'
export type ClientBrowserKind = 'chrome' | 'edge' | 'chromium' | 'custom'

/** Durable record. The token itself is never stored; only its SHA-256 digest is. */
export interface ClientBrowserSessionRecord {
  id: string
  roomId: string
  tokenHash: string
  status: ClientBrowserStatus
  pid: number | null
  /** Loopback port the browser's own DevTools listener bound; never published to agents. */
  devtoolsPort: number | null
  browserKind: ClientBrowserKind | null
  headless: boolean
  profileMode: ClientBrowserProfileMode
  profilePath: string
  /** DevHotel process generation that launched it; a session from another generation is orphaned. */
  runtimeGeneration: string
  createdAt: string
  lastActiveAt: string
}

/** What any caller may see about a session: identity and ownership, never the secret. */
export interface ClientBrowserSessionInfo {
  id: string
  roomId: string
  status: ClientBrowserStatus
  pid: number | null
  browserKind: ClientBrowserKind | null
  headless: boolean
  profileMode: ClientBrowserProfileMode
  createdAt: string
  lastActiveAt: string
}

/** Stable automation targets. Both embed the session secret; treat them like the token. */
export interface ClientBrowserEndpoint {
  /** `http://127.0.0.1:<port>/cdp/<sessionId>/<token>` — pass to Playwright `chromium.connectOverCDP`. */
  http: string
  /** `ws://127.0.0.1:<port>/cdp/<sessionId>/<token>` — the browser-level CDP WebSocket. */
  ws: string
}

export interface ClientBrowserAllocation {
  session: ClientBrowserSessionInfo
  /** Returned exactly once here (and again on attach with the same token). Required by every later call. */
  token: string
  endpoint: ClientBrowserEndpoint
}

export interface ClientBrowserTargetInfo {
  targetId: string
  type: string
  url: string
  title: string
}

export interface ClientBrowserInspection {
  session: ClientBrowserSessionInfo
  owner: { roomId: string; project: string | null; nickname: string | null }
  liveness: {
    processAlive: boolean
    cdpReachable: boolean
    browserVersion: string | null
  }
  connection: {
    endpoint: ClientBrowserEndpoint | null
    /** Automation clients currently tunnelled through the DevHotel endpoint. */
    activeClients: number
  }
  targets: ClientBrowserTargetInfo[]
}

export interface ClientBrowserNavigationResult {
  sessionId: string
  url: string
  finalUrl: string
  title: string
  loaded: boolean
}

export interface ClientBrowserScreenshotResult {
  sessionId: string
  mimeType: 'image/png' | 'image/jpeg'
  /** Opaque encoded bytes; the key name keeps it out of text redaction. */
  contentBase64: string
  sizeBytes: number
}

export interface ClientBrowserReleaseResult {
  sessionId: string
  roomId: string
  released: boolean
  processStopped: boolean
  profileRemoved: boolean
}

/** What startup found and did about browsers left behind by an earlier DevHotel process. */
export interface ClientBrowserReconcileReport {
  orphanedSessions: number
  stoppedProcesses: number
  removedProfiles: number
  /** Sessions whose process could not be proven ours; left alone and named here. */
  unverified: string[]
}

export const zClientBrowserSessionId = z.string().regex(/^cbr_[a-z0-9]{16}$/, 'valid Client Browser session ID')
export const zClientBrowserToken = z.string().regex(/^cbt_[a-z0-9]{32}$/, 'valid Client Browser token')
export const zClientBrowserProfileMode = z.enum(['ephemeral', 'persistent'])

export const zAllocateClientBrowserBody = z
  .object({
    profileMode: zClientBrowserProfileMode.optional(),
    headless: z.boolean().optional()
  })
  .strict()
export type AllocateClientBrowserBody = z.infer<typeof zAllocateClientBrowserBody>

export const zClientBrowserAuthBody = z.object({ token: zClientBrowserToken }).strict()

export const zNavigateClientBrowserBody = z
  .object({
    token: zClientBrowserToken,
    url: z.string().trim().min(1).max(4096),
    timeoutMs: z.number().int().min(100).max(120_000).optional()
  })
  .strict()
export type NavigateClientBrowserBody = z.infer<typeof zNavigateClientBrowserBody>

export const zScreenshotClientBrowserBody = z
  .object({
    token: zClientBrowserToken,
    format: z.enum(['png', 'jpeg']).optional(),
    fullPage: z.boolean().optional()
  })
  .strict()
export type ScreenshotClientBrowserBody = z.infer<typeof zScreenshotClientBrowserBody>
