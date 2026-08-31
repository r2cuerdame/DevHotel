import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  SCREENSHOT_ARTIFACT_MAX_BYTES,
  type AgentCreateRoomInput,
  type AbandonAndroidLocaleMatrixRecoveryInput,
  type AbandonAndroidLocaleMatrixRecoveryResult,
  type AndroidAutomationStatus,
  type AndroidAcceptanceReportResult,
  type AndroidAcceptanceReportSummary,
  type AndroidCrashScenarioResult,
  type AndroidDumpUiInput,
  type AndroidForceStopInput,
  type AndroidForceStopResult,
  type AndroidLaunchAppInput,
  type AndroidLaunchResult,
  type AndroidLogcatInput,
  type AndroidLogcatResult,
  type AndroidLocaleScreenshotMatrixInput,
  type AndroidLocaleScreenshotMatrixResult,
  type AndroidRunCrashScenarioInput,
  type AndroidTapTextInput,
  type AndroidTapTextResult,
  type AndroidTargetSelector,
  type AndroidUiDumpResult,
  type AndroidWaitForTextInput,
  type AndroidWaitForTextResult,
  type ArtifactExportBody,
  type ArtifactExportResult,
  type CaptureScreenshotArtifactBody,
  type CreateAndroidAcceptanceReportInput,
  type ControlInfo,
  type OperationRecord,
  type QuickChange,
  type RoomArtifact
} from '@devhotel/shared'

/** Bounded-output selection understood by the control API's exec and run reads. */
export interface OutputSelection {
  maxBytes?: number
  maxLines?: number
  mode?: 'head' | 'tail'
  include?: string
  exclude?: string
  ignoreCase?: boolean
}

export interface RunOutputQuery extends OutputSelection {
  stream?: 'stdout' | 'stderr'
  offsetBytes?: number
  encoding?: 'utf8' | 'base64'
}

export interface StreamReport {
  bytes: number
  lines: number
  returnedBytes: number
  returnedLines: number
  matchedLines?: number
  truncated: boolean
  filtered: boolean
  retained: boolean
}

export interface RoomExecResponse {
  code: number
  stdout: string
  stderr: string
  output: {
    runId: string
    retained: boolean
    stdout: StreamReport
    stderr: StreamReport
    notes: string[]
  }
}

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

  private async reqBytes(path: string): Promise<{ bytes: Buffer; sha256: string }> {
    const url = `http://127.0.0.1:${this.info.port}${path}`
    let res: Response
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.info.token}` } })
    } catch (err) {
      throw new DevHotelNotRunningError(`cannot reach control API on port ${this.info.port}: ${String(err)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`DevHotel control API ${res.status}: ${text || res.statusText}`)
    }
    if (res.headers.get('content-type')?.split(';', 1)[0] !== 'image/png') {
      throw new Error('DevHotel control API returned a non-PNG artifact')
    }
    const declaredHeader = res.headers.get('content-length')
    const declared = declaredHeader === null ? null : Number(declaredHeader)
    if (
      declared !== null &&
      (!Number.isSafeInteger(declared) || declared < 1 || declared > SCREENSHOT_ARTIFACT_MAX_BYTES)
    ) {
      throw new Error('DevHotel control API artifact has an invalid length or exceeds the 16MB response limit')
    }
    if (!res.body) throw new Error('DevHotel control API returned an empty artifact response')
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > SCREENSHOT_ARTIFACT_MAX_BYTES) {
        await reader.cancel()
        throw new Error('DevHotel control API artifact exceeds the 16MB response limit')
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length)
    if (declared !== null && declared !== bytes.byteLength) {
      throw new Error('DevHotel control API artifact content length does not match')
    }
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (bytes.byteLength < pngSignature.byteLength || !bytes.subarray(0, pngSignature.byteLength).equals(pngSignature)) {
      throw new Error('DevHotel control API artifact bytes are not a PNG')
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const expected = res.headers.get('x-devhotel-sha256')
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== sha256) {
      throw new Error('DevHotel control API artifact checksum does not match')
    }
    return { bytes, sha256 }
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
  execInRoom(roomId: string, cmd: string[], timeoutMs?: number, output?: OutputSelection) {
    return this.req<RoomExecResponse>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/exec`, {
      cmd,
      timeoutMs,
      ...(output && Object.keys(output).length > 0 ? { output } : {})
    })
  }
  listRuns(roomId: string) {
    return this.req<{ runs: unknown[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/runs`)
  }
  readRunOutput(roomId: string, runId: string, query: RunOutputQuery = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const suffix = params.toString()
    return this.req<unknown>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}/output${suffix ? `?${suffix}` : ''}`
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
  safeResyncFromHost(roomId: string, confirmationToken?: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/safe-resync-from-host`, {
      ...(confirmationToken === undefined ? {} : { confirmationToken })
    })
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
  androidAutomationStatus(roomId: string, target: AndroidTargetSelector = { kind: 'auto' }) {
    const query = new URLSearchParams({ target: target.kind })
    if (target.kind === 'physical' && target.deviceId) query.set('deviceId', target.deviceId)
    return this.req<AndroidAutomationStatus>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/status?${query.toString()}`
    )
  }
  androidLaunchApp(roomId: string, input: AndroidLaunchAppInput) {
    return this.req<AndroidLaunchResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/launch`, input)
  }
  androidForceStop(roomId: string, input: AndroidForceStopInput) {
    return this.req<AndroidForceStopResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/force-stop`, input)
  }
  androidWaitForText(roomId: string, input: AndroidWaitForTextInput) {
    return this.req<AndroidWaitForTextResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/wait-for-text`, input)
  }
  androidTapText(roomId: string, input: AndroidTapTextInput) {
    return this.req<AndroidTapTextResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/tap-text`, input)
  }
  androidDumpUi(roomId: string, input: AndroidDumpUiInput) {
    return this.req<AndroidUiDumpResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/dump-ui`, input)
  }
  androidLogcat(roomId: string, input: AndroidLogcatInput) {
    return this.req<AndroidLogcatResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/android/logcat`, input)
  }
  androidRunCrashScenario(roomId: string, input: AndroidRunCrashScenarioInput) {
    return this.req<AndroidCrashScenarioResult>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/crash-scenario`,
      input
    )
  }
  androidLocaleScreenshotMatrix(roomId: string, input: AndroidLocaleScreenshotMatrixInput) {
    return this.req<AndroidLocaleScreenshotMatrixResult>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/locale-matrix`,
      input
    )
  }
  abandonAndroidLocaleMatrixRecovery(roomId: string, input: AbandonAndroidLocaleMatrixRecoveryInput) {
    return this.req<AbandonAndroidLocaleMatrixRecoveryResult>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/locale-recovery-abandon`,
      input
    )
  }
  createAndroidAcceptanceReport(roomId: string, input: CreateAndroidAcceptanceReportInput) {
    return this.req<AndroidAcceptanceReportResult>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/acceptance-reports`,
      input
    )
  }
  listAndroidAcceptanceReports(roomId: string, limit?: number) {
    const suffix = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`
    return this.req<{ reports: AndroidAcceptanceReportSummary[] }>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/acceptance-reports${suffix}`
    )
  }
  getAndroidAcceptanceReport(roomId: string, reportId: string) {
    return this.req<AndroidAcceptanceReportResult>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/android/acceptance-reports/${encodeURIComponent(reportId)}`
    )
  }
  captureScreenshotArtifact(roomId: string, body: CaptureScreenshotArtifactBody) {
    return this.req<RoomArtifact>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/artifacts/screenshots`, body)
  }
  listRoomArtifacts(roomId: string, limit?: number) {
    const query = limit === undefined ? '' : `?limit=${limit}`
    return this.req<{ artifacts: RoomArtifact[] }>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/artifacts${query}`
    )
  }
  getRoomArtifact(roomId: string, artifactId: string) {
    return this.req<RoomArtifact>(
      'GET',
      `/v1/rooms/${encodeURIComponent(roomId)}/artifacts/${encodeURIComponent(artifactId)}`
    )
  }
  async readRoomArtifactContent(roomId: string, artifactId: string) {
    const { bytes, sha256 } = await this.reqBytes(
      `/v1/rooms/${encodeURIComponent(roomId)}/artifacts/${encodeURIComponent(artifactId)}/content`
    )
    return { data: bytes.toString('base64'), mimeType: 'image/png' as const, sizeBytes: bytes.byteLength, sha256 }
  }
  exportRoomArtifact(roomId: string, artifactId: string, body: ArtifactExportBody) {
    return this.req<ArtifactExportResult>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/artifacts/${encodeURIComponent(artifactId)}/export`,
      body
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
  androidDevices() {
    return this.req<unknown>('GET', '/v1/devices')
  }
  refreshAndroidDevices() {
    return this.req<unknown>('POST', '/v1/devices/refresh')
  }
  attachAndroidDevice(roomId: string, body: Record<string, unknown>) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/device/attach`, body)
  }
  releaseAndroidDevice(roomId: string, reason?: string) {
    return this.req<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/device/release`, reason ? { reason } : {})
  }
  adbOnDevice(roomId: string, args: string[], timeoutMs?: number) {
    return this.req<{ code: number; stdout: string; stderr: string }>(
      'POST',
      `/v1/rooms/${encodeURIComponent(roomId)}/device/adb`,
      { args, timeoutMs }
    )
  }
  heartbeatAndroidDevice(leaseId: string, busy?: boolean) {
    return this.req<unknown>('POST', '/v1/devices/heartbeat', { leaseId, busy })
  }
  cancelAndroidDeviceRequest(requestId: string) {
    return this.req<unknown>('POST', '/v1/devices/cancel', { requestId })
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
