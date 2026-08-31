import { randomBytes } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  zAgentCloneBody,
  zAndroidDumpUiBody,
  zAndroidForceStopBody,
  zAndroidLaunchAppBody,
  zAbandonAndroidLocaleMatrixRecoveryBody,
  zAndroidLocaleScreenshotMatrixBody,
  zAndroidLogcatBody,
  zAndroidRunCrashScenarioBody,
  zAndroidTapTextBody,
  zAndroidTargetSelector,
  zAndroidWaitForTextBody,
  zAgentRenameBody,
  zApplyChangeBody,
  zAgentCreateRoomInput,
  zAgentAdbBody,
  zArtifactId,
  zArtifactListLimit,
  zArtifactExportBody,
  zRoomArtifact,
  zAttachDeviceBody,
  zCancelRequestBody,
  zCaptureScreenshotArtifactBody,
  zExecBody,
  zHeartbeatBody,
  zLogKind,
  zOperationId,
  zOperationWaitMs,
  zReleaseDeviceBody,
  zRoomId,
  zRunId,
  zRunOutputQuery,
  zRoomOperationsLimit,
  zStartRoomBody,
  zSafeHostResyncBody,
  zUndoChangeBody,
  DeviceLeaseError,
  type ArtifactExportResult,
  type ControlInfo,
  type RoomArtifact
} from '@devhotel/shared'
import {
  DevHotelError,
  isDevHotelError,
  redactStructuredSecrets,
  sanitizeAndroidScreenshotArtifactMetadata,
  WorkspaceDriftError,
  type RoomOrchestrator
} from '@devhotel/core'
import type { GitHubServiceStatus, RoomInspection, RoomRecord } from '@devhotel/shared'

/**
 * Return the durable ID immediately by default. A caller cannot safely assume
 * its own deadline is longer than ours; clients that want an inline terminal
 * result can explicitly opt into a bounded wait.
 */
const DEFAULT_START_WAIT_MS = 0
const ANDROID_AUTOMATION_BODY_LIMIT_BYTES = 64 * 1024
const ARTIFACT_BODY_LIMIT_BYTES = 64 * 1024
const DEFAULT_JSON_BODY_MAX_BYTES = 24 * 1024 * 1024
const ROOM_FILE_JSON_BODY_MAX_BYTES = 23 * 1024 * 1024

interface InputSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false }
}

function parseRequestInput<T>(
  schema: InputSchema<T>,
  input: unknown,
  error: { code: string; message: string; recoveryHint: string }
): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  // Route input is untrusted and Zod's issues can echo caller-controlled
  // values. Convert only this explicit inbound boundary to a stable 400;
  // validation errors thrown later by Core/backend code remain internal 500s.
  throw new DevHotelError(error.code, error.message, {
    recoveryHint: error.recoveryHint,
    httpStatus: 400
  })
}

function parseAndroidBody<T>(schema: InputSchema<T>, input: unknown): T {
  return parseRequestInput(schema, input, {
    code: 'INVALID_ANDROID_REQUEST',
    message: 'Android automation request fields are invalid.',
    recoveryHint: 'Use only the documented bounded Android operation fields and value formats.'
  })
}

function parseArtifactInput<T>(schema: InputSchema<T>, input: unknown): T {
  return parseRequestInput(schema, input, {
    code: 'INVALID_ARTIFACT_REQUEST',
    message: 'Screenshot artifact request fields are invalid.',
    recoveryHint: 'Use only the documented bounded screenshot artifact fields and value formats.'
  })
}

/** Query `waitMs`, clamped by the shared bound; anything unusable waits not at all. */
function parseWaitMs(raw: string | null): number {
  if (raw === null) return 0
  const parsed = zOperationWaitMs.safeParse(Number(raw))
  return parsed.success ? parsed.data : 0
}

/** Hotel Services reachable by agents; populated after app startup wiring. */
export interface HotelServicesRef {
  github: { status(): Promise<GitHubServiceStatus>; install(): Promise<GitHubServiceStatus> } | null
}

/**
 * Loopback control API for the MCP server (and other local agents).
 * Bearer-token authenticated; every mutation is attributed to actor 'agent'.
 */
export async function startControlApi(
  orch: RoomOrchestrator,
  userData: string,
  version: string,
  hotel: HotelServicesRef = { github: null }
): Promise<{ server: Server; info: ControlInfo; stop: () => void }> {
  const token = randomBytes(24).toString('hex')

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof DeviceLeaseError) {
        sendJson(res, 409, { error: err.message, code: err.code })
        return
      }
      if (isDevHotelError(err)) {
        sendJson(res, err.httpStatus, {
          error: err.message,
          code: err.code,
          recoveryHint: err.recoveryHint,
          ...(err.evidence !== null ? { evidence: err.evidence } : {})
        })
        return
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean) // ['v1', 'rooms', ':id', op?]
    if (parts[0] !== 'v1') {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    if (parts[1] === 'ping' && req.method === 'GET') {
      sendJson(res, 200, { version })
      return
    }

    if (parts[1] === 'status' && req.method === 'GET') {
      const status = await orch.hotelStatus()
      sendJson(res, 200, { version, ...status })
      return
    }

    // Long operations are addressable on their own so a caller that timed out,
    // reconnected, or restarted can still finish the story it started.
    if (parts[1] === 'operations' && parts[2] && !parts[3] && req.method === 'GET') {
      const operationId = zOperationId.parse(parts[2])
      const waitMs = parseWaitMs(url.searchParams.get('waitMs'))
      const operation = waitMs > 0 ? await orch.waitForOperation(operationId, waitMs) : orch.getOperation(operationId)
      if (!operation) {
        sendJson(res, 404, { error: 'operation not found' })
        return
      }
      sendJson(res, 200, { operation })
      return
    }

    // The shared Android phones are Hotel-scoped, not Room-scoped: an agent may
    // always see who holds what, so it can explain why it is waiting.
    if (parts[1] === 'devices') {
      if (!parts[2] && req.method === 'GET') {
        sendJson(res, 200, orch.androidDeviceStatus())
        return
      }
      if (parts[2] === 'refresh' && req.method === 'POST') {
        sendJson(res, 200, await orch.refreshAndroidDevices())
        return
      }
      if (parts[2] === 'heartbeat' && req.method === 'POST') {
        const body = zHeartbeatBody.parse(await readBody(req))
        sendJson(res, 200, orch.heartbeatAndroidDevice(body.leaseId, { busy: body.busy }))
        return
      }
      if (parts[2] === 'cancel' && req.method === 'POST') {
        const body = zCancelRequestBody.parse(await readBody(req))
        sendJson(res, 200, orch.cancelAndroidDeviceRequest(body.requestId))
        return
      }
    }

    if (parts[1] === 'hotel' && parts[2] === 'github') {
      if (!hotel.github) {
        sendJson(res, 503, { error: 'Hotel services are still starting' })
        return
      }
      if (!parts[3] && req.method === 'GET') {
        sendJson(res, 200, await hotel.github.status())
        return
      }
      if (parts[3] === 'install' && req.method === 'POST') {
        sendJson(res, 200, await hotel.github.install())
        return
      }
    }

    if (parts[1] === 'rooms') {
      const roomId = parts[2]
      const safeRoomId = roomId
        ? parseRequestInput(zRoomId, roomId, {
            code: 'INVALID_ROOM_ID',
            message: 'The Room ID in the request path is invalid.',
            recoveryHint: 'Use the opaque Room ID returned by DevHotel.'
          })
        : undefined
      const op = parts[3]

      if (!roomId && req.method === 'GET') {
        sendJson(res, 200, (await orch.listRoomsRuntime()).map(roomForAgent))
        return
      }
      if (!roomId && req.method === 'POST') {
        const body = zAgentCreateRoomInput.parse(await readBody(req))
        const room = await orch.createRoom({ ...body, actor: 'agent' })
        sendJson(res, 200, room)
        return
      }
      if (safeRoomId && !op && req.method === 'GET') {
        const inspection = await orch.inspectRoomRuntime(safeRoomId)
        sendJson(res, 200, inspectionForAgent(inspection))
        return
      }
      if (safeRoomId && !op && req.method === 'DELETE') {
        // Deletion is irreversible: rooms holding Host-linked working state
        // (possibly with edits never synced back) stay a human decision.
        const room = orch.rooms.get(safeRoomId)
        if (room && (room.sourceType === 'linked-folder' || room.workspaceMode === 'legacy-host-bind')) {
          sendJson(res, 403, { error: 'Agents cannot delete Host-linked Rooms. Delete it in the DevHotel app.' })
          return
        }
        sendJson(res, 200, await orch.deleteRoom(safeRoomId, 'agent'))
        return
      }
      // High-level Android automation. Every body is strict and small, every
      // package is checked against a target-scoped install receipt in Core.
      if (safeRoomId && op === 'android') {
        const action = parts[4]
        if (action === 'status' && req.method === 'GET') {
          const queryKeys = [...url.searchParams.keys()]
          if (
            queryKeys.some((key) => key !== 'target' && key !== 'deviceId') ||
            url.searchParams.getAll('target').length > 1 ||
            url.searchParams.getAll('deviceId').length > 1
          ) {
            throw new DevHotelError('INVALID_ANDROID_TARGET', 'Android status received an unsupported or repeated target field.', {
              recoveryHint: 'Use only target=auto|emulator|physical and an optional opaque deviceId.',
              httpStatus: 400
            })
          }
          const kind = url.searchParams.get('target') ?? 'auto'
          const deviceId = url.searchParams.get('deviceId') ?? undefined
          const target = parseRequestInput(
            zAndroidTargetSelector,
            { kind, ...(deviceId ? { deviceId } : {}) },
            {
              code: 'INVALID_ANDROID_TARGET',
              message: 'Android status target fields are invalid.',
              recoveryHint: 'Use target=auto|emulator|physical and an optional opaque deviceId.'
            }
          )
          sendJson(res, 200, await orch.androidAutomationStatus(safeRoomId, target))
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req, ANDROID_AUTOMATION_BODY_LIMIT_BYTES)
          switch (action) {
            case 'launch':
              sendJson(res, 200, await orch.androidLaunchApp(safeRoomId, parseAndroidBody(zAndroidLaunchAppBody, body)))
              return
            case 'force-stop':
              sendJson(res, 200, await orch.androidForceStop(safeRoomId, parseAndroidBody(zAndroidForceStopBody, body)))
              return
            case 'wait-for-text':
              sendJson(res, 200, await orch.androidWaitForText(safeRoomId, parseAndroidBody(zAndroidWaitForTextBody, body)))
              return
            case 'tap-text':
              sendJson(res, 200, await orch.androidTapText(safeRoomId, parseAndroidBody(zAndroidTapTextBody, body)))
              return
            case 'dump-ui':
              sendJson(res, 200, await orch.androidDumpUi(safeRoomId, parseAndroidBody(zAndroidDumpUiBody, body)))
              return
            case 'logcat':
              sendJson(res, 200, await orch.androidLogcat(safeRoomId, parseAndroidBody(zAndroidLogcatBody, body)))
              return
            case 'crash-scenario':
              sendJson(res, 200, await orch.androidRunCrashScenario(safeRoomId, parseAndroidBody(zAndroidRunCrashScenarioBody, body)))
              return
            case 'locale-matrix':
              sendJson(res, 200, await orch.androidLocaleScreenshotMatrix(
                safeRoomId,
                parseAndroidBody(zAndroidLocaleScreenshotMatrixBody, body),
                'agent'
              ))
              return
            case 'locale-recovery-abandon':
              sendJson(res, 200, await orch.abandonAndroidLocaleMatrixRecovery(
                safeRoomId,
                parseAndroidBody(zAbandonAndroidLocaleMatrixRecoveryBody, body)
              ))
              return
          }
        }
      }
      // /v1/rooms/:id/device/(attach|release|adb)
      if (safeRoomId && op === 'device' && req.method === 'POST') {
        const action = parts[4]
        if (action === 'attach') {
          // The Room owns the project name on the lease; an agent cannot claim
          // to be a different project when it takes the phone.
          const body = zAttachDeviceBody.parse(await readBody(req))
          sendJson(res, 200, await orch.attachAndroidDevice(safeRoomId, body))
          return
        }
        if (action === 'release') {
          const body = zReleaseDeviceBody.parse(await readBody(req))
          sendJson(res, 200, await orch.releaseAndroidDevice(safeRoomId, body.reason))
          return
        }
        if (action === 'adb') {
          const body = zAgentAdbBody.parse(await readBody(req))
          sendJson(res, 200, await orch.adbOnDevice(safeRoomId, body.args, { timeoutMs: body.timeoutMs }))
          return
        }
      }

      // Durable screenshots are addressed by both Room and artifact ID. Every
      // lookup keeps the Room predicate, so an ID learned in one Room cannot
      // read or export another Room's content.
      if (safeRoomId && op === 'artifacts') {
        const artifactSegment = parts[4]
        if (!artifactSegment && req.method === 'GET') {
          const queryKeys = [...url.searchParams.keys()]
          if (queryKeys.some((key) => key !== 'limit') || url.searchParams.getAll('limit').length > 1) {
            throw new DevHotelError(
              'INVALID_ARTIFACT_REQUEST',
              'Screenshot artifact request fields are invalid.',
              {
                recoveryHint: 'Use only one optional limit field between 1 and 100.',
                httpStatus: 400
              }
            )
          }
          const rawLimit = url.searchParams.get('limit')
          const limit = rawLimit === null
            ? undefined
            : parseArtifactInput(zArtifactListLimit, Number(rawLimit))
          sendArtifactListJson(res, 200, orch.listRoomArtifacts(safeRoomId, limit))
          return
        }
        if (artifactSegment === 'screenshots' && !parts[5] && req.method === 'POST') {
          const body = parseArtifactInput(
            zCaptureScreenshotArtifactBody,
            await readBody(req, ARTIFACT_BODY_LIMIT_BYTES)
          )
          sendArtifactJson(res, 201, await orch.captureAndroidScreenshotArtifact(safeRoomId, body, 'agent'))
          return
        }
        const artifactId = artifactSegment
          ? parseArtifactInput(zArtifactId, artifactSegment)
          : undefined
        if (artifactId && !parts[5] && req.method === 'GET') {
          sendArtifactJson(res, 200, orch.getRoomArtifact(safeRoomId, artifactId))
          return
        }
        if (artifactId && parts[5] === 'content' && !parts[6] && req.method === 'GET') {
          const { artifact, content } = orch.readRoomArtifactContent(safeRoomId, artifactId)
          sendPng(res, artifact.filename, artifact.sha256, content)
          return
        }
        if (artifactId && parts[5] === 'export' && !parts[6] && req.method === 'POST') {
          const body = parseArtifactInput(zArtifactExportBody, await readBody(req, ARTIFACT_BODY_LIMIT_BYTES))
          sendArtifactExportJson(res, 200, await orch.exportRoomArtifact(safeRoomId, artifactId, body, 'agent'))
          return
        }
      }

      if (safeRoomId && op && req.method === 'POST') {
        switch (op) {
          case 'start': {
            // Waking a Room outlives most client timeouts, so the answer is the
            // operation itself. `waitMs` only decides how long this call holds
            // before returning it: a `running` operation is a real answer, and
            // asking again joins the same wake instead of starting another.
            const body = zStartRoomBody.parse(await readBody(req))
            const started = orch.startRoomOperation(safeRoomId, 'agent')
            const waitMs = body.waitMs ?? DEFAULT_START_WAIT_MS
            const operation = waitMs > 0 ? await orch.waitForOperation(started.id, waitMs) : started
            sendJson(res, 200, { operation: operation ?? started })
            return
          }
          case 'sleep':
            await orch.sleepRoom(safeRoomId, 'agent')
            res.writeHead(204).end()
            return
          case 'restart-web':
            sendJson(res, 200, await orch.restartWeb(safeRoomId, 'agent'))
            return
          case 'clone': {
            const body = zAgentCloneBody.parse(await readBody(req))
            const room = await orch.cloneRoom({ sourceRoomId: safeRoomId, ...body, actor: 'agent' })
            sendJson(res, 200, roomForAgent(room))
            return
          }
          case 'rename': {
            const body = zAgentRenameBody.parse(await readBody(req))
            await orch.renameRoom(safeRoomId, body.nickname)
            res.writeHead(204).end()
            return
          }
          case 'sync-from-host': {
            // Runs under the Room's inbound-sync grant and is journaled as the
            // agent that ran it. The path is always the Room's own linked
            // folder — never agent-supplied.
            const room = orch.rooms.get(safeRoomId)
            if (!room) {
              sendJson(res, 404, { error: 'room not found' })
              return
            }
            if (room.sourceType !== 'linked-folder' || !room.hostSyncEnabled) {
              sendJson(res, 409, { error: 'This Room has no linked Host folder to sync from' })
              return
            }
            if (!orch.agentHostSyncAllowed(safeRoomId)) {
              sendJson(res, 403, {
                error: 'Agent Host sync is revoked for this Room. Re-enable it in the Room, or run the sync yourself.'
              })
              return
            }
            try {
              sendJson(res, 200, roomForAgent(await orch.syncFromHost(safeRoomId, 'agent')))
            } catch (error) {
              if (error instanceof WorkspaceDriftError) {
                sendJson(res, 409, error.toResponse())
                return
              }
              throw error
            }
            return
          }
          case 'safe-resync-from-host': {
            const room = orch.rooms.get(safeRoomId)
            if (!room) {
              sendJson(res, 404, { error: 'room not found' })
              return
            }
            if (room.sourceType !== 'linked-folder' || !room.hostSyncEnabled) {
              sendJson(res, 409, { error: 'This Room has no linked Host folder to sync from' })
              return
            }
            if (!orch.agentHostSyncAllowed(safeRoomId)) {
              sendJson(res, 403, {
                error: 'Agent Host sync is revoked for this Room. Re-enable it in the Room, or run the sync yourself.'
              })
              return
            }
            const body = zSafeHostResyncBody.parse(await readBody(req))
            try {
              const outcome = await orch.safeResyncFromHost(
                safeRoomId,
                'agent',
                body.confirmationToken
              )
              sendJson(res, outcome.status === 'confirmation-required' ? 409 : 200, outcome)
            } catch (error) {
              if (error instanceof WorkspaceDriftError) {
                sendJson(res, 409, error.toResponse())
                return
              }
              throw error
            }
            return
          }
          case 'sync-baseline': {
            // Records a new comparison point only; no Host file is read and no
            // Room file changes, so this needs no human approval. The sync it
            // unblocks still does.
            sendJson(res, 200, roomForAgent(await orch.resetSyncBaseline(safeRoomId, 'agent')))
            return
          }
          case 'exec': {
            const body = zExecBody.parse(await readBody(req))
            sendJson(
              res,
              200,
              await orch.execInRoom(safeRoomId, body.cmd, { timeoutMs: body.timeoutMs, output: body.output }, 'agent')
            )
            return
          }
          case 'checks':
            sendJson(res, 200, await orch.runChecks(safeRoomId))
            return
          case 'changes': {
            const body = zApplyChangeBody.parse(await readBody(req))
            sendJson(res, 200, await orch.applyChange(safeRoomId, body.change, 'agent'))
            return
          }
          case 'undo': {
            const body = zUndoChangeBody.parse(await readBody(req))
            sendJson(res, 200, await orch.undoChange(safeRoomId, body.changeId, 'agent'))
            return
          }
        }
      }
      if (safeRoomId && op === 'file' && req.method === 'GET') {
        const path = url.searchParams.get('path') ?? ''
        sendJson(res, 200, await orch.pullRoomFile(safeRoomId, path))
        return
      }
      if (safeRoomId && op === 'file' && req.method === 'PUT') {
        const body = (await readBody(req, ROOM_FILE_JSON_BODY_MAX_BYTES)) as { path?: unknown; contentBase64?: unknown }
        if (typeof body.path !== 'string' || typeof body.contentBase64 !== 'string') {
          sendJson(res, 400, { error: 'expected { path, contentBase64 }' })
          return
        }
        sendJson(res, 200, await orch.pushRoomFile(safeRoomId, body.path, body.contentBase64))
        return
      }
      if (safeRoomId && op === 'runs' && req.method === 'GET') {
        // /v1/rooms/:id/runs and /v1/rooms/:id/runs/:runId/output — reading a
        // run never takes the Room lock, so a long command stays readable while
        // it is still producing output.
        if (!parts[4]) {
          sendJson(res, 200, { runs: orch.listRuns(safeRoomId) })
          return
        }
        if (parts[5] === 'output') {
          const runId = zRunId.parse(parts[4])
          const query = zRunOutputQuery.parse(Object.fromEntries(url.searchParams))
          sendJson(res, 200, orch.readRunOutput(safeRoomId, runId, query))
          return
        }
      }
      if (safeRoomId && req.method === 'GET') {
        switch (op) {
          case 'diagnostic':
            sendJson(res, 200, { text: await orch.getDiagnostic(safeRoomId) })
            return
          case 'changes':
            sendJson(res, 200, orch.listChanges(safeRoomId))
            return
          case 'components':
            sendJson(res, 200, await orch.components(safeRoomId))
            return
          case 'logs': {
            const kind = zLogKind.parse(url.searchParams.get('kind') ?? 'web')
            sendJson(res, 200, { lines: orch.logs.tail(safeRoomId, kind) })
            return
          }
          case 'operations': {
            const raw = url.searchParams.get('limit')
            const limit = raw === null ? undefined : zRoomOperationsLimit.parse(Number(raw))
            sendJson(res, 200, { operations: orch.listOperations(safeRoomId, limit) })
            return
          }
          case 'screenshot': {
            const mode = url.searchParams.get('mode') === 'screen' ? 'screen' : 'auto'
            sendJson(res, 200, await orch.androidScreenshot(safeRoomId, mode))
            return
          }
        }
      }
    }
    sendJson(res, 404, { error: 'not found' })
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const info: ControlInfo = { port, token, pid: process.pid, version }
  const controlFile = join(userData, 'control.json')
  writeFileSync(controlFile, JSON.stringify(info, null, 2), 'utf8')

  return {
    server,
    info,
    stop: () => {
      try {
        rmSync(controlFile, { force: true })
      } catch {
        // best effort
      }
      server.close()
    }
  }
}

function roomForAgent(room: RoomRecord): RoomRecord {
  return room.sourceType === 'linked-folder' ? { ...room, sourceRef: '[Host folder hidden]' } : room
}

function inspectionForAgent(inspection: RoomInspection): RoomInspection {
  const device = inspection.device
  return {
    ...inspection,
    room: roomForAgent(inspection.room),
    dataDir: '[Hotel data hidden]',
    device: device
      ? {
          deviceId: device.deviceId,
          project: device.project,
          purpose: device.purpose,
          state: device.state,
          acquiredAt: device.acquiredAt
        }
      : null
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // One last structured boundary protects every general Control API response
  // and, transitively, every MCP tool.
  writeJson(res, status, redactStructuredSecrets(body))
}

function artifactForJson(value: RoomArtifact): RoomArtifact {
  const artifact = zRoomArtifact.parse(value)
  return zRoomArtifact.parse({
    ...artifact,
    metadata: sanitizeAndroidScreenshotArtifactMetadata(artifact.metadata)
  })
}

function sendArtifactJson(res: ServerResponse, status: number, artifact: RoomArtifact): void {
  writeJson(res, status, artifactForJson(artifact))
}

function sendArtifactListJson(res: ServerResponse, status: number, artifacts: RoomArtifact[]): void {
  writeJson(res, status, { artifacts: artifacts.map(artifactForJson) })
}

function sendArtifactExportJson(res: ServerResponse, status: number, result: ArtifactExportResult): void {
  // Core derives these fields from a strict artifact receipt and the validated
  // repo-relative request path. Prose redaction would corrupt the committed
  // destination and its Markdown after a successful export.
  writeJson(res, status, result)
}

function sendPng(res: ServerResponse, filename: string, sha256: string, content: Buffer): void {
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': content.byteLength,
    'content-disposition': `inline; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-devhotel-sha256': sha256
  })
  res.end(content)
}

async function readBody(req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new DevHotelError('REQUEST_BODY_TOO_LARGE', 'Request body exceeds the allowed size.', {
      recoveryHint: 'Send only the documented JSON fields within the endpoint limit.',
      httpStatus: 413
    })
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      throw new DevHotelError('REQUEST_BODY_TOO_LARGE', 'Request body exceeds the allowed size.', {
        recoveryHint: 'Send only the documented JSON fields within the endpoint limit.',
        httpStatus: 413
      })
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new DevHotelError('INVALID_JSON_BODY', 'Request body is not valid JSON.', {
      recoveryHint: 'Send one valid JSON value using UTF-8 encoding.',
      httpStatus: 400
    })
  }
}
