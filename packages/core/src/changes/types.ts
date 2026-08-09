import type { ChangeEntry, RoomRecord } from '@devhotel/shared'
import type { IsolationBackend, WebSpec } from '../backend/types'
import type { Gateway } from '../gateway/gateway'
import type { ChangesRepo } from '../store/changesRepo'
import type { RoomsRepo } from '../store/roomsRepo'
import type { SettingsRepo } from '../store/settingsRepo'

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
}

export interface ChangeDefinition<P = unknown> {
  kind: string
  plan(ctx: ChangeCtx, p: P): ChangePlanned
  preflight?(ctx: ChangeCtx, p: P): Promise<void>
  capture?(ctx: ChangeCtx, p: P): Promise<unknown>
  apply(ctx: ChangeCtx, p: P, steps: ChangeStep): Promise<void>
  verify(ctx: ChangeCtx, p: P): Promise<{ ok: boolean; detail: string }>
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
      if (await tcpAnswers(room.hostPort, 1500)) {
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
export async function tcpAnswers(port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    let gotData = false
    const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs })
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
