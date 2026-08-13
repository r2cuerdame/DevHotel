import { randomBytes } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  zAgentCloneBody,
  zAgentRenameBody,
  zApplyChangeBody,
  zAgentCreateRoomInput,
  zExecBody,
  zLogKind,
  zRoomId,
  zUndoChangeBody,
  type ControlInfo
} from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'
import type { GitHubServiceStatus, RoomInspection, RoomRecord } from '@devhotel/shared'

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
      const safeRoomId = roomId ? zRoomId.parse(roomId) : undefined
      const op = parts[3]

      if (!roomId && req.method === 'GET') {
        sendJson(res, 200, orch.listRooms().map(roomForAgent))
        return
      }
      if (!roomId && req.method === 'POST') {
        const body = zAgentCreateRoomInput.parse(await readBody(req))
        const room = await orch.createRoom({ ...body, actor: 'agent' })
        sendJson(res, 200, room)
        return
      }
      if (safeRoomId && !op && req.method === 'GET') {
        const inspection = orch.inspectRoom(safeRoomId)
        sendJson(res, 200, { ...inspection, room: roomForAgent(inspection.room), dataDir: '[Hotel data hidden]' } satisfies RoomInspection)
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
      if (safeRoomId && op && req.method === 'POST') {
        switch (op) {
          case 'start':
            await orch.startRoom(safeRoomId, 'agent')
            res.writeHead(204).end()
            return
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
            sendJson(res, 200, roomForAgent(await orch.syncFromHost(safeRoomId, 'agent')))
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
            sendJson(res, 200, await orch.execInRoom(safeRoomId, body.cmd, { timeoutMs: body.timeoutMs }, 'agent'))
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
        const body = (await readBody(req)) as { path?: unknown; contentBase64?: unknown }
        if (typeof body.path !== 'string' || typeof body.contentBase64 !== 'string') {
          sendJson(res, 400, { error: 'expected { path, contentBase64 }' })
          return
        }
        sendJson(res, 200, await orch.pushRoomFile(safeRoomId, body.path, body.contentBase64))
        return
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}
