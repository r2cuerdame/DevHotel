import type { ChangeEntry, RoomRecord } from '@devhotel/shared'
import type { ExecResult, FencedEmulatorBootResult, IsolationBackend, WebSpec } from '../backend/types'
import type { Gateway } from '../gateway/gateway'
import type { ChangesRepo } from '../store/changesRepo'
import type { RoomsRepo } from '../store/roomsRepo'
import type { SettingsRepo } from '../store/settingsRepo'
import { connectRelay } from '../relayProtocol'
import type { SealedAndroidArtifactRef } from './definitions/androidBuild'

export interface ChangeCtx {
  roomId: string
  backend: IsolationBackend
  gateway: Gateway
  rooms: RoomsRepo
  changes: ChangesRepo
  settings: SettingsRepo
  userData: string
  log: (line: string) => void
  /** current room record, re-read from the store */
  room(): RoomRecord
  /** WebSpec for the room's current record (deps generation applied) */
  webSpec(overrides?: Partial<WebSpec>): WebSpec
  /** true when the room's containers should be up right now */
  isAwake(): boolean
  /** re-route the gateway to the room's current domain/hostPort/https */
  syncRoute(): Promise<void>
  /**
   * Clear the Room's browser profile (cookies, localStorage, IndexedDB, cache).
   * Owned by the desktop app because the profile is an Electron session
   * partition; absent in headless contexts, where there is no profile to clear.
   */
  clearBrowserData?: () => Promise<void>
  /** Present while this Android Room owns a physical-device lease; exec fails closed when the target is unhealthy. */
  physicalAndroidDevice?: {
    nickname: string
    /** Keep the lease alive while a long build prepares the next device action. */
    keepAlive<T>(run: () => Promise<T>): Promise<T>
  }
  /** Execute one bounded target probe through the physical broker or controlled emulator helper. */
  execFencedAndroidTarget?: (args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
  /** Witness managed-emulator boot through one helper/server for the whole deadline. */
  waitForFencedEmulatorBoot?: (opts?: { timeoutMs?: number }) => Promise<FencedEmulatorBootResult>
  /** Resolve one sealed Host artifact capability, stage once, install, prove, and atomically persist its receipt. */
  installTrackedAndroidArtifact: (
    applicationId: string,
    artifact: SealedAndroidArtifactRef,
    changeId: string
  ) => Promise<void>
  /** Revoke a receipt created by a failed or interrupted Android run. */
  removeTrackedAndroidInstall: (applicationId: string, changeId: string) => void
  /** Transactionally revoke every receipt owned by one failed Android run, independent of target lease state. */
  removeTrackedAndroidInstalls: (changeId: string) => void
  /** Launch only through the exact tracked receipt/user/lease session. */
  launchTrackedAndroidApp?: (applicationId: string) => Promise<void>
  /** Verify foreground state through the same exact tracked session. */
  isTrackedAndroidAppForeground?: (applicationId: string) => Promise<boolean>
  /** Recreating a Room emulator invalidates every receipt for its old OS instance. */
  clearAndroidEmulatorInstalls?: () => void
}

export interface ChangePlanned {
  title: string
  component: string
  before: unknown
  after: unknown
  undoable: boolean
  undoStrategy: string
  /** roll back automatically when verify fails; when false the change stays 'applied' with a failed verify and a prominent Undo (goal.md §24 demo) */
  autoRollback: boolean
}

export interface ChangeStep {
  push(step: string): void
  /** replace the entry's captured safety-state from inside apply (e.g. a backup taken mid-apply) */
  setCaptured(blob: unknown): void
  /**
   * Merge facts the change *produced* into the entry's `after` — the device it
   * used, the ids it installed. A caller that has to guess these ends up
   * addressing the emulator by a second name and running everything twice.
   */
  setResult(result: Record<string, unknown>): void
}

export interface ChangeOperation {
  /** Stable ID shared by the Change entry, immutable input snapshot, and artifacts. */
  id: string
  createdAt: string
}

export interface ChangeDefinition<P = unknown> {
  kind: string
  plan(ctx: ChangeCtx, p: P): ChangePlanned
  preflight?(ctx: ChangeCtx, p: P): Promise<void>
  capture?(ctx: ChangeCtx, p: P, operation: ChangeOperation): Promise<unknown>
  apply(ctx: ChangeCtx, p: P, steps: ChangeStep, operation: ChangeOperation): Promise<void>
  verify(ctx: ChangeCtx, p: P, captured: unknown, operation: ChangeOperation): Promise<{ ok: boolean; detail: string }>
  /**
   * Apply failures normally invoke undo. Definitions whose destructive phase
   * starts only after a durable capture can veto rollback until that capture
   * exists, so a failed safety-backup cannot destroy the still-good resource.
   */
  canRollbackApplyFailure?(ctx: ChangeCtx, p: P, captured: unknown): boolean
  undo?(ctx: ChangeCtx, entry: ChangeEntry): Promise<void>
}

/** Poll until the web container reports running and the relay answers, or fail with the last web log hint. */
export async function verifyWebUp(ctx: ChangeCtx, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; detail: string }> {
  const room = ctx.room()
  if (!ctx.isAwake()) return { ok: true, detail: 'applies on next wake (room is asleep)' }
  if (room.provider === 'android') {
    // build rooms have no served port — a running container is a healthy room
    for (let i = 0; i < 5; i++) {
      const state = await ctx.backend.webState(room.id)
      if (state === 'running') return { ok: true, detail: 'build container running' }
      if (state === 'missing') return { ok: false, detail: 'build container missing' }
      await sleep(1000)
    }
    return { ok: false, detail: 'build container exited' }
  }
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const deadline = Date.now() + timeoutMs
  let lastState = 'unknown'
  let consecutiveExited = 0
  while (Date.now() < deadline) {
    const state = await ctx.backend.webState(room.id)
    lastState = state
    if (state === 'running' && room.hostPort) {
      consecutiveExited = 0
      const relayToken = await ctx.backend.relayToken(room.id)
      if (await tcpAnswers(room.hostPort, 1500, relayToken)) {
        return { ok: true, detail: `web process running, port ${room.internalPort} answering` }
      }
    }
    if (state === 'missing') return { ok: false, detail: 'web container missing' }
    // 'exited' is terminal (no restart policy) — confirm once and fail fast
    if (state === 'exited' && ++consecutiveExited >= 2) {
      return { ok: false, detail: 'web process exited' }
    }
    await sleep(1200)
  }
  return {
    ok: false,
    detail: lastState === 'running' ? `nothing listening on internal port ${room.internalPort}` : `web process ${lastState}`
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Data-level probe: the room's socat relay completes a TCP handshake even when
 * nothing listens on the internal port, so a bare connect proves nothing.
 * We send a minimal HTTP request and require at least one response byte —
 * socat closes with zero bytes when its onward connect is refused.
 */
export async function tcpAnswers(port: number, timeoutMs: number, relayToken?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let gotData = false
    const sock = connectRelay(port, relayToken)
    sock.setTimeout(timeoutMs)
    const finish = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => {
      sock.write('HEAD / HTTP/1.0\r\nHost: devhotel-probe\r\n\r\n')
    })
    sock.once('data', () => {
      gotData = true
      finish(true)
    })
    sock.once('close', () => {
      if (!gotData) resolve(false)
    })
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
  })
}
