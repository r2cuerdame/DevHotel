import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCreateRoomInput, ControlInfo, OperationRecord, QuickChange } from '@devhotel/shared'

export function defaultControlFile(): string {
  if (process.env.DEVHOTEL_CONTROL_FILE) return process.env.DEVHOTEL_CONTROL_FILE
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevHotel', 'control.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'DevHotel', 'control.json')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'DevHotel', 'control.json')
}

export class DevHotelNotRunningError extends Error {
  constructor(detail: string) {
    super(
      `DevHotel does not appear to be running (${detail}). ` +
        'Start the DevHotel desktop app, then try again.'
    )
    this.name = 'DevHotelNotRunningError'
  }
}

export async function loadControlInfo(file = defaultControlFile()): Promise<ControlInfo> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new DevHotelNotRunningError(`no control file at ${file}`)
  }
  try {
    const info = JSON.parse(raw) as ControlInfo
    if (!info.port || !info.token) throw new Error('missing port/token')
    return info
  } catch {
    throw new DevHotelNotRunningError(`unreadable control file at ${file}`)
  }
}

export class ControlClient {
  constructor(private readonly info: ControlInfo) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `http://127.0.0.1:${this.info.port}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.info.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      throw new DevHotelNotRunningError(`cannot reach control API on port ${this.info.port}: ${String(err)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`DevHotel control API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  ping() {
    return this.req<{ version: string }>('GET', '/v1/ping')
  }
  listRooms() {
    return this.req<unknown[]>('GET', '/v1/rooms')
  }
  createRoom(input: AgentCreateRoomInput) {
    return this.req<unknown>('POST', '/v1/rooms', input)
  }
  inspectRoom(roomId: string) {
    return this.req<unknown>('GET', `/v1/rooms/${encodeURIComponent(roomId)}`)
  }
  /** Answers with the wake's operation record, running or finished. */
  startRoom(roomId: string, waitMs?: number) {
    return this.req<{ operation: OperationRecord }>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/start`,
      waitMs === undefined ? {} : { waitMs }
    )
  }
  getOperation(operationId: string, waitMs?: number) {
    const query = waitMs === undefined ? '' : `?waitMs=${waitMs}`
    return this.req<{ operation: OperationRecord }>('GET', `/v1/operations/${encodeURIComponent(operationId)}${query}`)
  }
  listRoomOperations(roomId: string, limit?: number) {
    const query = limit === undefined ? '' : `?limit=${limit}`
    return this.req<{ operations: OperationRecord[] }>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/operations${query}`
    )
  }
  sleepRoom(roomId: string) {
    return this.req<void>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/sleep`)
  }
  execInRoom(roomId: string, cmd: string[], timeoutMs?: number) {
    return this.req<{ code: number; stdout: string; stderr: string }>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/exec`,
      { cmd, timeoutMs }
    )
  }
  deleteRoom(roomId: string) {
    return this.req<{ reclaimedBytes: number }>('DELETE', `/v1/rooms/${encodeURIComponent(roomId)}`)
  }
  restartWeb(roomId: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/restart-web`)
  }
  cloneRoom(roomId: string, body: { nickname: string; copyDependencies: boolean; services: 'copy' | 'empty' | 'exclude' }) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/clone`, body)
  }
  renameRoom(roomId: string, nickname: string) {
    return this.req<void>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/rename`, { nickname })
  }
  listChanges(roomId: string) {
    return this.req<unknown[]>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/changes`)
  }
  components(roomId: string) {
    return this.req<unknown[]>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/components`)
  }
  logs(roomId: string, kind: 'web' | 'orchestrator') {
    return this.req<{ lines: string[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/logs?kind=${kind}`)
  }
  runChecks(roomId: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/checks`)
  }
  applyChange(roomId: string, change: QuickChange) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/changes`, { change })
  }
  undoChange(roomId: string, changeId: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/undo`, { changeId })
  }
  diagnostic(roomId: string) {
    return this.req<{ text: string }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/diagnostic`)
  }
  syncFromHost(roomId: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/sync-from-host`)
  }
  resetSyncBaseline(roomId: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/sync-baseline`)
  }
  hotelStatus() {
    return this.req<unknown>('GET', '/v1/status')
  }
  screenshot(roomId: string, mode: 'auto' | 'screen' = 'auto') {
    return this.req<{ png: string; source: 'adb' | 'screen' }>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/screenshot?mode=${mode}`
    )
  }
  pullFile(roomId: string, path: string) {
    return this.req<{ path: string; size: number; contentBase64: string }>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/file?path=${encodeURIComponent(path)}`
    )
  }
  pushFile(roomId: string, path: string, contentBase64: string) {
    return this.req<{ path: string; size: number }>('PUT', `/v1/rooms/${encodeURIComponent(roomId)}/file`, {
      path,
      contentBase64
    })
  }
  hotelGithubStatus() {
    return this.req<unknown>('GET', '/v1/hotel/github')
  }
  hotelGithubInstall() {
    return this.req<unknown>('POST', '/v1/hotel/github/install')
  }
}

export async function connect(): Promise<ControlClient> {
  const info = await loadControlInfo()
  const client = new ControlClient(info)
  await client.ping()
  return client
}

function isStaleConnection(err: unknown): boolean {
  // DevHotel restarts change the control port and token: the old socket
  // refuses (NotRunning) or a lucky port reuse answers 401.
  if (err instanceof DevHotelNotRunningError) return true
  return err instanceof Error && /control API 401/.test(err.message)
}

/** Real ControlClient methods; anything else must not be forwarded (see below). */
const CLIENT_METHODS = new Set(
  Object.getOwnPropertyNames(ControlClient.prototype).filter((name) => name !== 'constructor')
)

/**
 * A ControlClient that survives DevHotel app restarts: on a stale-connection
 * failure it re-reads control.json (fresh port/token) and retries once, so a
 * long-lived MCP session never needs a manual reconnect.
 *
 * Only real methods are forwarded. A proxy that answers *every* property with a
 * function is thenable, so `return client` from an async function makes the
 * runtime invoke `client.then(...)` — which ControlClient does not have, and the
 * resulting unhandled rejection killed the stdio server on its first tool call.
 */
export function resilientClient(connector: () => Promise<ControlClient> = connect): ControlClient {
  let inner: ControlClient | null = null
  return new Proxy({} as ControlClient, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string' || !CLIENT_METHODS.has(prop)) return undefined
      return async (...args: unknown[]) => {
        inner ??= await connector()
        const call = async (client: ControlClient): Promise<unknown> =>
          (client[prop as keyof ControlClient] as (...a: unknown[]) => Promise<unknown>)(...args)
        try {
          return await call(inner)
        } catch (err) {
          if (!isStaleConnection(err)) throw err
          inner = null
          inner = await connector()
          return await call(inner)
        }
      }
    },
    has(_target, prop) {
      return typeof prop === 'string' && CLIENT_METHODS.has(prop)
    }
  })
}
