import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCreateRoomInput, ControlInfo, QuickChange } from '@devhotel/shared'

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
  startRoom(roomId: string) {
    return this.req<void>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/start`)
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
}

export async function connect(): Promise<ControlClient> {
  const info = await loadControlInfo()
  const client = new ControlClient(info)
  await client.ping()
  return client
}
