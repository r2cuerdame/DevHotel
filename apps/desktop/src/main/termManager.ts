import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC, type RoomStatus } from '@devhotel/shared'
import { type RoomOrchestrator } from '@devhotel/core'

const AWAKE_ROOM_STATUSES = new Set<RoomStatus>(['running', 'ready', 'attention'])

interface TermSession {
  id: string
  roomId: string
  sender: WebContents
  child: ChildProcess
  closed: boolean
  suppressExitEvent: boolean
  exitNotified: boolean
}

interface PendingTermOpen {
  id: string
  roomId: string
  sender: WebContents
  cancelReason: string | null
}

interface SenderSubscription {
  detach: () => void
}

function removeSenderListener(
  sender: WebContents,
  event: string,
  listener: (...args: never[]) => void
): void {
  const target = sender as unknown as {
    off?: (ev: string, fn: (...args: never[]) => void) => void
    removeListener?: (ev: string, fn: (...args: never[]) => void) => void
  }
  if (typeof target.off === 'function') target.off(event, listener)
  else if (typeof target.removeListener === 'function') target.removeListener(event, listener)
}

/**
 * Room terminals via `docker exec -i` (stream mode, no PTY — keeps the app
 * free of native modules). The renderer's xterm does local echo.
 */
export class TermManager {
  private sessions = new Map<string, TermSession>()
  private pendingOpens = new Map<string, PendingTermOpen>()
  private senderSubscriptions = new Map<WebContents, SenderSubscription>()
  private offOrchEvent: (() => void) | null = null
  private disposed = false

  constructor(private readonly orch: RoomOrchestrator) {
    if (typeof this.orch.onEvent === 'function') {
      this.offOrchEvent = this.orch.onEvent((e) => {
        if (e.kind === 'deleted') {
          this.closeForRoom(e.roomId, 'The room was deleted')
          return
        }
        if (!this.isRoomAwake(e.roomId)) {
          this.closeForRoom(e.roomId, 'The room must be awake for a terminal session')
        }
      })
    }
  }

  private isRoomAwake(roomId: string): boolean {
    const rooms = (this.orch as { rooms?: RoomOrchestrator['rooms'] }).rooms
    if (!rooms) return true
    const room = rooms.get(roomId)
    return room !== null && room !== undefined && AWAKE_ROOM_STATUSES.has(room.status)
  }

  private watchSender(sender: WebContents): void {
    if (this.senderSubscriptions.has(sender)) return
    const target = sender as unknown as {
      on?: (ev: string, fn: (...args: never[]) => void) => void
    }
    if (typeof target.on !== 'function') return

    const onDestroyed = (): void => {
      this.closeForSender(sender, 'Renderer window was destroyed')
    }
    const onProcessGone = (): void => {
      this.closeForSender(sender, 'Renderer process exited')
    }
    const onStartNavigation = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
      if (details === undefined || (details.isMainFrame !== false && !details.isSameDocument)) {
        this.closeForSender(sender, 'Renderer navigated away')
      }
    }
    const onDidNavigate = (): void => {
      this.closeForSender(sender, 'Renderer navigated away')
    }

    target.on('destroyed', onDestroyed)
    target.on('render-process-gone', onProcessGone)
    target.on('did-start-navigation', onStartNavigation as (...args: never[]) => void)
    target.on('did-navigate', onDidNavigate)

    this.senderSubscriptions.set(sender, {
      detach: () => {
        removeSenderListener(sender, 'destroyed', onDestroyed)
        removeSenderListener(sender, 'render-process-gone', onProcessGone)
        removeSenderListener(sender, 'did-start-navigation', onStartNavigation as (...args: never[]) => void)
        removeSenderListener(sender, 'did-navigate', onDidNavigate)
      }
    })
  }

  private releaseSenderIfIdle(sender: WebContents): void {
    for (const session of this.sessions.values()) {
      if (session.sender === sender) return
    }
    for (const pending of this.pendingOpens.values()) {
      if (pending.sender === sender) return
    }
    const sub = this.senderSubscriptions.get(sender)
    if (sub) {
      this.senderSubscriptions.delete(sender)
      sub.detach()
    }
  }

  private terminateChild(child: ChildProcess): void {
    if (typeof child.on === 'function') {
      child.on('error', () => {})
    }
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', () => {})
    }
    try {
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end()
      }
    } catch {
      // Ignore stdin teardown races when the stream already closed.
    }
    try {
      child.kill()
    } catch {
      // Ignore kill races when the process already exited.
    }
  }

  private closeSession(session: TermSession, suppressExitEvent: boolean): void {
    session.closed = true
    if (suppressExitEvent) session.suppressExitEvent = true
    this.sessions.delete(session.id)
    this.terminateChild(session.child)
    this.releaseSenderIfIdle(session.sender)
  }

  private closeForRoom(roomId: string, reason: string): void {
    for (const pending of this.pendingOpens.values()) {
      if (pending.roomId === roomId && pending.cancelReason === null) {
        pending.cancelReason = reason
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.roomId === roomId) {
        this.closeSession(session, false)
      }
    }
  }

  private closeForSender(sender: WebContents, reason: string): void {
    for (const pending of this.pendingOpens.values()) {
      if (pending.sender === sender && pending.cancelReason === null) {
        pending.cancelReason = reason
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.sender === sender) {
        this.closeSession(session, true)
      }
    }
    this.releaseSenderIfIdle(sender)
  }

  async open(roomId: string, sender: WebContents): Promise<{ termId: string }> {
    if (this.disposed) throw new Error('Terminal manager is disposed')
    if (sender.isDestroyed()) throw new Error('Renderer window is closed')
    if (!this.isRoomAwake(roomId)) throw new Error('The room must be awake for a terminal session')

    const id = randomUUID()
    const pending: PendingTermOpen = { id, roomId, sender, cancelReason: null }
    this.pendingOpens.set(id, pending)
    this.watchSender(sender)

    let child: ChildProcess
    try {
      child = await this.orch.spawnInteractiveExec(roomId, ['sh', '-li'])
    } catch (err) {
      this.pendingOpens.delete(id)
      this.releaseSenderIfIdle(sender)
      throw err
    }

    this.pendingOpens.delete(id)
    const cancelReason =
      pending.cancelReason ??
      (this.disposed
        ? 'Terminal manager is disposed'
        : sender.isDestroyed()
          ? 'Renderer window is closed'
          : !this.isRoomAwake(roomId)
            ? 'The room must be awake for a terminal session'
            : null)

    if (cancelReason !== null) {
      this.terminateChild(child)
      this.releaseSenderIfIdle(sender)
      throw new Error(cancelReason)
    }

    const session: TermSession = {
      id,
      roomId,
      sender,
      child,
      closed: false,
      suppressExitEvent: false,
      exitNotified: false
    }
    child.stdin?.on('error', () => {})
    const forward = (chunk: Buffer): void => {
      if (!session.closed && !this.disposed && !sender.isDestroyed()) {
        sender.send(IPC.evTermData, id, chunk.toString('utf8').replaceAll('\n', '\r\n'))
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('close', () => {
      session.closed = true
      this.sessions.delete(id)
      this.releaseSenderIfIdle(sender)
      if (!session.suppressExitEvent && !session.exitNotified && !this.disposed && !sender.isDestroyed()) {
        session.exitNotified = true
        sender.send(IPC.evTermExit, id)
      }
    })
    child.on('error', (err) => {
      if (!session.closed && !this.disposed && !sender.isDestroyed()) {
        sender.send(IPC.evTermData, id, `\r\n${err.message}\r\n`)
      }
    })
    this.sessions.set(id, session)
    return { termId: id }
  }

  input(termId: string, data: string): void {
    if (this.disposed) return
    const session = this.sessions.get(termId)
    if (!session || session.closed) return
    if (
      session.child.killed ||
      typeof session.child.exitCode === 'number' ||
      typeof session.child.signalCode === 'string'
    ) {
      return
    }
    const stdin = session.child.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) return
    try {
      stdin.write(data.replaceAll('\r', '\n'))
    } catch {
      // Ignore synchronous write races against a closing stdin pipe.
    }
  }

  resize(): void {
    // no PTY — nothing to resize
  }

  close(termId: string): void {
    const session = this.sessions.get(termId)
    if (session) {
      this.closeSession(session, true)
    }
  }

  dispose(): void {
    this.disposed = true
    this.offOrchEvent?.()
    this.offOrchEvent = null
    for (const pending of this.pendingOpens.values()) {
      pending.cancelReason ??= 'Terminal manager is disposed'
    }
    for (const session of [...this.sessions.values()]) {
      this.closeSession(session, true)
    }
    this.sessions.clear()
    for (const [, sub] of this.senderSubscriptions) {
      sub.detach()
    }
    this.senderSubscriptions.clear()
  }
}
