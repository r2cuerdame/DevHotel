import { randomBytes } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  zApplyChangeBody,
  zAgentCreateRoomInput,
  zExecBody,
  zRoomId,
  zUndoChangeBody,
  type ControlInfo
} from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'
import type { RoomInspection, RoomRecord } from '@devhotel/shared'

/**
 * Loopback control API for the MCP server (and other local agents).
 * Bearer-token authenticated; every mutation is attributed to actor 'agent'.
 */
export async function startControlApi(
  orch: RoomOrchestrator,
  userData: string,
  version: string
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
      if (safeRoomId && op === 'diagnostic' && req.method === 'GET') {
        sendJson(res, 200, { text: await orch.getDiagnostic(safeRoomId) })
        return
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
