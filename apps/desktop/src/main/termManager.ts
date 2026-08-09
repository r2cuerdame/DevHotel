import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC } from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'

interface TermSession {
  id: string
  roomId: string
  child: ChildProcess
}

/**
 * Room terminals via `docker exec -i` (stream mode, no PTY — keeps the app
 * free of native modules). The renderer's xterm does local echo.
 */
export class TermManager {
  private sessions = new Map<string, TermSession>()

  constructor(private readonly orch: RoomOrchestrator) {}

  open(roomId: string, sender: WebContents): { termId: string } {
    const room = this.orch.rooms.get(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    if (room.status === 'sleeping' || room.status === 'preparing') {
      throw new Error('The room must be awake for a terminal session')
    }
    const id = randomUUID()
    const child = spawn('docker', ['exec', '-i', `dh-${roomId}-web`, 'sh', '-li'], { windowsHide: true })
    const forward = (chunk: Buffer): void => {
      if (!sender.isDestroyed()) sender.send(IPC.evTermData, id, chunk.toString('utf8').replaceAll('\n', '\r\n'))
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('close', () => {
      this.sessions.delete(id)
      if (!sender.isDestroyed()) sender.send(IPC.evTermExit, id)
    })
    child.on('error', (err) => {
      if (!sender.isDestroyed()) sender.send(IPC.evTermData, id, `\r\n${err.message}\r\n`)
    })
    this.sessions.set(id, { id, roomId, child })
    return { termId: id }
  }

  input(termId: string, data: string): void {
    const session = this.sessions.get(termId)
    session?.child.stdin?.write(data.replaceAll('\r', '\n'))
  }

  resize(): void {
    // no PTY — nothing to resize
  }

  close(termId: string): void {
    const session = this.sessions.get(termId)
    if (session) {
      session.child.kill()
      this.sessions.delete(termId)
    }
  }

  dispose(): void {
    for (const [, s] of this.sessions) s.child.kill()
    this.sessions.clear()
  }
}
