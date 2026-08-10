import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC } from '@devhotel/shared'
import { type RoomOrchestrator } from '@devhotel/core'

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

  async open(roomId: string, sender: WebContents): Promise<{ termId: string }> {
    const id = randomUUID()
    const child = await this.orch.spawnInteractiveExec(roomId, ['sh', '-li'])
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
