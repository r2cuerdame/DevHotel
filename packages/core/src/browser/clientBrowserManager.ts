import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { customAlphabet } from 'nanoid'
import type {
  ClientBrowserAllocation,
  ClientBrowserEndpoint,
  ClientBrowserInspection,
  ClientBrowserNavigationResult,
  ClientBrowserProfileMode,
  ClientBrowserReconcileReport,
  ClientBrowserReleaseResult,
  ClientBrowserScreenshotResult,
  ClientBrowserSessionInfo,
  ClientBrowserSessionRecord
} from '@devhotel/shared'
import { DevHotelError } from '../errors'
import type { ClientBrowserRepo } from '../store/clientBrowserRepo'
import type { SettingsRepo } from '../store/settingsRepo'
import { SimpleCdpClient } from './cdpClient'
import { ClientBrowserEndpointServer } from './endpointServer'
import type { ClientBrowserRuntime, LaunchedClientBrowser } from './runtime'

const newSessionSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16)
const newTokenSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32)

export const CLIENT_BROWSERS_DIR = 'client-browsers'
const PERSISTENT_PROFILES_DIR = 'persistent'
const ENDPOINT_PORT_SETTING = 'clientBrowser.endpointPort'
const DEFAULT_NAVIGATE_TIMEOUT_MS = 15_000

export function hashClientBrowserToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

interface LiveSession {
  launched: LaunchedClientBrowser
  cdp: SimpleCdpClient | null
}

export interface ClientBrowserRoomView {
  id: string
  project: string
  nickname: string
  status: string
}

export interface ClientBrowserManagerOptions {
  userData: string
  repo: ClientBrowserRepo
  settings: SettingsRepo
  runtime: ClientBrowserRuntime
  /** Identity of this DevHotel process; sessions from any other generation are orphans. */
  generation: string
  rooms: { get(roomId: string): ClientBrowserRoomView | null }
  log?: (message: string) => void
}

/**
 * Owns every Client Browser session: who may use it, where it lives, how it
 * is reached and when it goes away. The runtime underneath launches and
 * stops processes; the endpoint server in front tunnels agents to them.
 * Neither knows about tokens or Rooms — that is this class, and only this
 * class, so the rules are the same whichever runtime is plugged in.
 */
export class ClientBrowserManager {
  private readonly userData: string
  private readonly repo: ClientBrowserRepo
  private readonly settings: SettingsRepo
  private readonly runtime: ClientBrowserRuntime
  private readonly generation: string
  private readonly rooms: ClientBrowserManagerOptions['rooms']
  private readonly log: (message: string) => void
  private readonly endpoint: ClientBrowserEndpointServer
  private readonly live = new Map<string, LiveSession>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private started = false

  constructor(options: ClientBrowserManagerOptions) {
    this.userData = options.userData
    this.repo = options.repo
    this.settings = options.settings
    this.runtime = options.runtime
    this.generation = options.generation
    this.rooms = options.rooms
    this.log = options.log ?? (() => {})
    this.endpoint = new ClientBrowserEndpointServer({
      resolve: (sessionId, token) => this.resolveUpstream(sessionId, token),
      preferredPort: Number.parseInt(this.settings.get(ENDPOINT_PORT_SETTING) ?? '', 10) || null
    })
  }

  get root(): string {
    return join(this.userData, CLIENT_BROWSERS_DIR)
  }

  get runtimeKind(): string {
    return this.runtime.kind
  }

  /** Binds the endpoint. Idempotent; allocation before this refuses rather than guessing a port. */
  async start(): Promise<void> {
    if (this.started) return
    const port = await this.endpoint.start()
    this.settings.set(ENDPOINT_PORT_SETTING, String(port))
    this.started = true
  }

  availability(): Promise<{ available: boolean; detail: string }> {
    return this.runtime.availability()
  }

  // ---------------------------------------------------------------- ownership

  private resolveUpstream(sessionId: string, token: string): { sessionId: string; devtoolsHost: string; devtoolsPort: number; browserPath: string } | null {
    const record = this.repo.get(sessionId)
    if (!record || !tokenMatches(record, token)) return null
    const session = this.live.get(sessionId)
    if (!session) return null
    const path = new URL(session.launched.cdpWsUrl).pathname
    return {
      sessionId,
      devtoolsHost: session.launched.devtoolsHost,
      devtoolsPort: session.launched.devtoolsPort,
      browserPath: path
    }
  }

  /** The only way from (id, token) to a session. Every agent-facing operation starts here. */
  private authorize(sessionId: string, token: string): ClientBrowserSessionRecord {
    const record = this.repo.get(sessionId)
    if (!record) {
      throw new DevHotelError('CLIENT_BROWSER_NOT_FOUND', `Client Browser session ${sessionId} does not exist.`, {
        httpStatus: 404,
        recoveryHint: 'Allocate a browser for your Room with allocate_client_browser; released sessions cannot be reattached.'
      })
    }
    if (!tokenMatches(record, token)) {
      throw new DevHotelError('CLIENT_BROWSER_FORBIDDEN', `The token presented does not own Client Browser session ${sessionId}.`, {
        httpStatus: 403,
        recoveryHint: 'Use the token returned by the allocation that created this session. Another agent’s session cannot be attached without its token.'
      })
    }
    return record
  }

  /** Serializes work per session so a release cannot interleave with a navigate on the same browser. */
  private withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(() => undefined, () => undefined)
    this.locks.set(sessionId, settled)
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId)
    })
    return next
  }

  // ---------------------------------------------------------------- lifecycle

  async allocate(
    roomId: string,
    options: { profileMode?: ClientBrowserProfileMode; headless?: boolean } = {}
  ): Promise<ClientBrowserAllocation> {
    if (!this.started) {
      throw new DevHotelError('CLIENT_BROWSER_UNAVAILABLE', 'The Client Browser endpoint is not running.', {
        httpStatus: 503,
        recoveryHint: 'DevHotel is still starting; retry shortly.'
      })
    }
    const room = this.rooms.get(roomId)
    if (!room) {
      throw new DevHotelError('ROOM_NOT_FOUND', `Room ${roomId} does not exist.`, { httpStatus: 404 })
    }
    if (room.status === 'sleeping' || room.status === 'broken' || room.status === 'deleting') {
      throw new DevHotelError(
        'CLIENT_BROWSER_ROOM_NOT_AWAKE',
        `Room ${roomId} is ${room.status}; a Client Browser belongs to an awake Room.`,
        { recoveryHint: 'Start the Room first (start_room or acquire_room), then allocate the browser.' }
      )
    }
    const availability = await this.runtime.availability()
    if (!availability.available) {
      throw new DevHotelError('CLIENT_BROWSER_NOT_FOUND', availability.detail, {
        httpStatus: 503,
        recoveryHint: 'Install Google Chrome, Chromium or Microsoft Edge on the Host, or set DEVHOTEL_BROWSER_PATH.'
      })
    }

    const profileMode = options.profileMode ?? 'ephemeral'
    const headless = options.headless ?? true
    const id = `cbr_${newSessionSuffix()}`
    const token = `cbt_${newTokenSuffix()}`
    const profilePath =
      profileMode === 'persistent'
        ? join(this.root, PERSISTENT_PROFILES_DIR, roomId)
        : join(this.root, id)
    if (profileMode === 'persistent') {
      const holder = this.repo.listByRoom(roomId).find((other) => other.profilePath === profilePath && other.status !== 'stopped')
      if (holder) {
        throw new DevHotelError(
          'CLIENT_BROWSER_PROFILE_BUSY',
          `Room ${roomId} already has a persistent-profile browser (${holder.id}) open.`,
          { recoveryHint: 'Release that session first, or allocate an ephemeral one.' }
        )
      }
    }
    const now = new Date().toISOString()
    const record: ClientBrowserSessionRecord = {
      id,
      roomId,
      tokenHash: hashClientBrowserToken(token),
      status: 'starting',
      pid: null,
      devtoolsPort: null,
      browserKind: null,
      headless,
      profileMode,
      profilePath,
      runtimeGeneration: this.generation,
      createdAt: now,
      lastActiveAt: now
    }
    mkdirSync(profilePath, { recursive: true })
    this.repo.create(record)
    this.log(`client browser ${id}: launching for Room ${roomId} (${profileMode}, ${headless ? 'headless' : 'headed'})`)

    let launched: LaunchedClientBrowser
    try {
      launched = await this.runtime.launch({ sessionId: id, profileDir: profilePath, headless })
    } catch (error) {
      this.repo.delete(id)
      if (profileMode === 'ephemeral') rmSync(profilePath, { recursive: true, force: true })
      throw error
    }
    const readyAt = new Date().toISOString()
    this.repo.markLaunched(id, { pid: launched.pid, devtoolsPort: launched.devtoolsPort, browserKind: launched.browserKind }, readyAt)
    this.live.set(id, { launched, cdp: null })
    const session = this.repo.get(id)!
    this.log(`client browser ${id}: ready (pid ${launched.pid ?? 'unknown'}, ${launched.browserKind})`)
    return { session: toInfo(session), token, endpoint: this.endpointFor(id, token) }
  }

  attach(sessionId: string, token: string): ClientBrowserAllocation {
    const record = this.authorize(sessionId, token)
    if (!this.live.has(sessionId)) {
      throw new DevHotelError(
        'CLIENT_BROWSER_NOT_LIVE',
        `Client Browser session ${sessionId} has no running browser in this DevHotel process.`,
        { recoveryHint: 'Release it and allocate a new session.' }
      )
    }
    return { session: toInfo(record), token, endpoint: this.endpointFor(sessionId, token) }
  }

  private endpointFor(sessionId: string, token: string): ClientBrowserEndpoint {
    const endpoint = this.endpoint.endpointFor(sessionId, token)
    if (!endpoint) {
      throw new DevHotelError('CLIENT_BROWSER_UNAVAILABLE', 'The Client Browser endpoint is not running.', { httpStatus: 503 })
    }
    return endpoint
  }

  async inspect(sessionId: string, token: string): Promise<ClientBrowserInspection> {
    const record = this.authorize(sessionId, token)
    return await this.withLock(sessionId, async () => {
      const live = this.live.get(sessionId) ?? null
      const probe = await this.runtime.probe({ pid: record.pid, devtoolsPort: record.devtoolsPort, profileDir: record.profilePath })
      let targets: ClientBrowserInspection['targets'] = []
      if (live && probe.cdpReachable) {
        try {
          const cdp = await this.cdpFor(sessionId, live)
          targets = (await cdp.getTargets())
            .filter((target) => target.type === 'page')
            .map((target) => ({ targetId: target.targetId, type: target.type, url: target.url, title: target.title }))
        } catch {
          targets = []
        }
      }
      const room = this.rooms.get(record.roomId)
      return {
        session: toInfo(record),
        owner: { roomId: record.roomId, project: room?.project ?? null, nickname: room?.nickname ?? null },
        liveness: { processAlive: probe.processAlive, cdpReachable: probe.cdpReachable, browserVersion: probe.browserVersion },
        connection: {
          endpoint: live ? this.endpointFor(sessionId, token) : null,
          activeClients: this.endpoint.activeClients(sessionId)
        },
        targets
      }
    })
  }

  listForRoom(roomId: string): ClientBrowserSessionInfo[] {
    return this.repo.listByRoom(roomId).map(toInfo)
  }

  listAll(): ClientBrowserSessionInfo[] {
    return this.repo.listAll().map(toInfo)
  }

  async navigate(sessionId: string, token: string, url: string, timeoutMs = DEFAULT_NAVIGATE_TIMEOUT_MS): Promise<ClientBrowserNavigationResult> {
    this.authorize(sessionId, token)
    assertNavigableUrl(url)
    return await this.withLock(sessionId, async () => {
      const cdp = await this.cdpFor(sessionId, this.mustLive(sessionId))
      const result = await cdp.navigate(url, timeoutMs)
      this.repo.touch(sessionId, new Date().toISOString())
      return { sessionId, url, finalUrl: result.finalUrl, title: result.title, loaded: result.loaded }
    })
  }

  async screenshot(sessionId: string, token: string, options: { format?: 'png' | 'jpeg'; fullPage?: boolean } = {}): Promise<ClientBrowserScreenshotResult> {
    this.authorize(sessionId, token)
    return await this.withLock(sessionId, async () => {
      const cdp = await this.cdpFor(sessionId, this.mustLive(sessionId))
      const shot = await cdp.captureScreenshot(options.format ?? 'png', options.fullPage ?? false)
      this.repo.touch(sessionId, new Date().toISOString())
      return { sessionId, mimeType: shot.mimeType, contentBase64: shot.data, sizeBytes: Buffer.byteLength(shot.data, 'base64') }
    })
  }

  /** Runs a JavaScript expression in the session's page; used by tests to observe isolation from the outside. */
  async evaluate<T = unknown>(sessionId: string, token: string, expression: string): Promise<T> {
    this.authorize(sessionId, token)
    return await this.withLock(sessionId, async () => {
      const cdp = await this.cdpFor(sessionId, this.mustLive(sessionId))
      return await cdp.evaluate<T>(expression)
    })
  }

  async release(sessionId: string, token: string): Promise<ClientBrowserReleaseResult> {
    const record = this.authorize(sessionId, token)
    return await this.withLock(sessionId, () => this.releaseLocked(record, 'released by its owner'))
  }

  /** Every session of a Room, whoever holds the tokens. Room delete and sleep call this. */
  async releaseRoom(roomId: string, reason: string): Promise<ClientBrowserReleaseResult[]> {
    const results: ClientBrowserReleaseResult[] = []
    for (const record of this.repo.listByRoom(roomId)) {
      results.push(await this.withLock(record.id, () => this.releaseLocked(record, reason)))
    }
    return results
  }

  private async releaseLocked(record: ClientBrowserSessionRecord, reason: string): Promise<ClientBrowserReleaseResult> {
    const sessionId = record.id
    this.log(`client browser ${sessionId}: releasing (${reason})`)
    this.endpoint.disconnect(sessionId)
    const live = this.live.get(sessionId)
    this.live.delete(sessionId)
    live?.cdp?.close()
    let processStopped = false
    if (live) {
      await live.launched.stop()
      processStopped = true
    } else {
      processStopped = await this.runtime.stopOrphan({ pid: record.pid, devtoolsPort: record.devtoolsPort, profileDir: record.profilePath })
    }
    let profileRemoved = false
    if (record.profileMode === 'ephemeral' && processStopped) {
      profileRemoved = removeProfile(record.profilePath)
    }
    if (processStopped) {
      this.repo.delete(sessionId)
    } else {
      // Something we could not prove ours is still running: keep the row so
      // the next reconcile sees it, but it no longer answers to the token.
      this.repo.updateStatus(sessionId, 'failed', new Date().toISOString())
    }
    return { sessionId, roomId: record.roomId, released: true, processStopped, profileRemoved }
  }

  // ---------------------------------------------------------------- startup / shutdown

  /**
   * Called once at startup, before any allocation. Every session on record
   * belongs to a DevHotel process that is gone: its agents' tunnels died with
   * that process, so the browser is unreachable through the contract and is
   * stopped. Profiles under the root with no row are leftovers of a crash
   * mid-allocation and go the same way. Nothing here touches a process it
   * cannot prove is a browser owning one of our profiles.
   */
  async reconcile(): Promise<ClientBrowserReconcileReport> {
    const report: ClientBrowserReconcileReport = { orphanedSessions: 0, stoppedProcesses: 0, removedProfiles: 0, unverified: [] }
    for (const record of this.repo.listAll()) {
      if (this.live.has(record.id)) continue
      report.orphanedSessions += 1
      const stopped = await this.runtime.stopOrphan({ pid: record.pid, devtoolsPort: record.devtoolsPort, profileDir: record.profilePath })
      if (!stopped) {
        report.unverified.push(record.id)
        this.repo.updateStatus(record.id, 'failed', new Date().toISOString())
        this.log(`client browser ${record.id}: orphan process ${record.pid ?? 'unknown'} could not be proven ours; left running`)
        continue
      }
      report.stoppedProcesses += 1
      if (record.profileMode === 'ephemeral' && removeProfile(record.profilePath)) report.removedProfiles += 1
      this.repo.delete(record.id)
    }
    // Directories with no row: an allocation that crashed between mkdir and
    // insert, or a row lost with its database. Only session-shaped names are
    // ours to remove; the persistent folder holds Room-owned profiles.
    const root = this.root
    if (existsSync(root)) {
      const known = new Set(this.repo.listAll().map((record) => resolve(record.profilePath)))
      for (const name of readdirSync(root)) {
        if (name === PERSISTENT_PROFILES_DIR || !/^cbr_[a-z0-9]{16}$/.test(name)) continue
        const dir = join(root, name)
        if (known.has(resolve(dir))) continue
        const stopped = await this.runtime.stopOrphan({ pid: null, devtoolsPort: null, profileDir: dir })
        if (!stopped) {
          report.unverified.push(name)
          continue
        }
        if (removeProfile(dir)) report.removedProfiles += 1
      }
    }
    if (report.orphanedSessions > 0 || report.removedProfiles > 0 || report.unverified.length > 0) {
      this.log(
        `client browsers reconciled: ${report.orphanedSessions} orphaned session(s), ${report.stoppedProcesses} stopped, ${report.removedProfiles} profile(s) removed` +
          (report.unverified.length > 0 ? `, unverified: ${report.unverified.join(', ')}` : '')
      )
    }
    return report
  }

  /** Stops every live browser and the endpoint. Rows that could not be cleaned are left for the next reconcile. */
  async shutdown(): Promise<void> {
    for (const record of this.repo.listAll()) {
      if (!this.live.has(record.id)) continue
      try {
        await this.withLock(record.id, () => this.releaseLocked(record, 'DevHotel is shutting down'))
      } catch (error) {
        this.log(`client browser ${record.id}: shutdown release failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.endpoint.stop()
    this.started = false
  }

  // ---------------------------------------------------------------- helpers

  private mustLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId)
    if (!live) {
      throw new DevHotelError(
        'CLIENT_BROWSER_NOT_LIVE',
        `Client Browser session ${sessionId} has no running browser in this DevHotel process.`,
        { recoveryHint: 'Release it and allocate a new session.' }
      )
    }
    return live
  }

  private async cdpFor(sessionId: string, live: LiveSession): Promise<SimpleCdpClient> {
    if (live.cdp && live.cdp.isOpen) return live.cdp
    live.cdp?.close()
    live.cdp = await SimpleCdpClient.connect(live.launched.cdpWsUrl)
    if (this.live.get(sessionId) !== live) {
      live.cdp.close()
      throw new DevHotelError('CLIENT_BROWSER_NOT_LIVE', `Client Browser session ${sessionId} was released.`)
    }
    return live.cdp
  }
}

function tokenMatches(record: ClientBrowserSessionRecord, token: string): boolean {
  const presented = Buffer.from(hashClientBrowserToken(token), 'hex')
  const stored = Buffer.from(record.tokenHash, 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}

function toInfo(record: ClientBrowserSessionRecord): ClientBrowserSessionInfo {
  return {
    id: record.id,
    roomId: record.roomId,
    status: record.status,
    pid: record.pid,
    browserKind: record.browserKind,
    headless: record.headless,
    profileMode: record.profileMode,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt
  }
}

function removeProfile(profilePath: string): boolean {
  try {
    rmSync(profilePath, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    return !existsSync(profilePath)
  } catch {
    return false
  }
}

/** Agents drive pages, not the Host: file:, chrome:, devtools: and friends are not navigable. */
function assertNavigableUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DevHotelError('CLIENT_BROWSER_URL_REFUSED', `"${url}" is not an absolute URL.`, {
      httpStatus: 400,
      recoveryHint: 'Navigate to an http:// or https:// URL, or about:blank.'
    })
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || url === 'about:blank') return
  throw new DevHotelError('CLIENT_BROWSER_URL_REFUSED', `Client Browsers navigate only to http, https or about:blank; ${parsed.protocol} is refused.`, {
    httpStatus: 400,
    recoveryHint: 'Serve local files through a Room or a local server and navigate to that URL.'
  })
}
