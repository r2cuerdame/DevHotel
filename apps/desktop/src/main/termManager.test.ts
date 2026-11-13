import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorEvent, RoomOrchestrator } from '@devhotel/core'
import type { RoomStatus } from '@devhotel/shared'
import { TermManager } from './termManager'

function childStub(): ChildProcessWithoutNullStreams & { rawKill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { rawKill: ReturnType<typeof vi.fn> }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const rawKill = vi.fn(() => true)
  child.rawKill = rawKill
  child.kill = rawKill
  return child
}

function createSenderStub(): {
  sender: WebContents
  emitter: EventEmitter
  destroy: () => void
  send: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter()
  let destroyed = false
  const send = vi.fn()
  const sender = Object.assign(emitter, {
    isDestroyed: () => destroyed,
    send
  }) as unknown as WebContents
  return {
    sender,
    emitter,
    send,
    destroy: () => {
      destroyed = true
      emitter.emit('destroyed')
    }
  }
}

function createOrchHarness(initialRooms: Record<string, RoomStatus> = { room1abc: 'ready' }) {
  const statuses = new Map<string, RoomStatus>(Object.entries(initialRooms))
  const listeners = new Set<(event: OrchestratorEvent) => void>()
  const spawnInteractiveExec = vi.fn()
  const orch = {
    onEvent: (cb: (event: OrchestratorEvent) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    rooms: {
      get: (id: string) => {
        const status = statuses.get(id)
        return status ? { id, provider: 'web', status } : null
      }
    },
    spawnInteractiveExec
  } as unknown as RoomOrchestrator

  return {
    orch,
    statuses,
    listeners,
    spawnInteractiveExec,
    emit: (event: OrchestratorEvent) => {
      for (const listener of [...listeners]) listener(event)
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sender = { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents

describe('TermManager Room boundary', () => {
  it('obtains the stream only through the orchestrator validated exec path', async () => {
    const child = childStub()
    const spawnInteractiveExec = vi.fn().mockResolvedValue(child)
    const manager = new TermManager({ spawnInteractiveExec } as unknown as RoomOrchestrator)

    await expect(manager.open('room1abc', sender)).resolves.toMatchObject({ termId: expect.any(String) })
    expect(spawnInteractiveExec).toHaveBeenCalledWith('room1abc', ['sh', '-li'])
    manager.dispose()
    expect(child.rawKill).toHaveBeenCalled()
  })

  it('does not create a session when backend ownership validation rejects', async () => {
    const spawnInteractiveExec = vi.fn().mockRejectedValue(new Error('container ownership metadata is invalid'))
    const manager = new TermManager({ spawnInteractiveExec } as unknown as RoomOrchestrator)

    await expect(manager.open('room1abc', sender)).rejects.toThrow(/ownership metadata/)
    manager.dispose()
    expect(spawnInteractiveExec).toHaveBeenCalledTimes(1)
  })

  it('kills a late-connecting console immediately when the Room sleeps, is deleted, or the app disposes during open', async () => {
    // 1. Room sleeps while open() is awaiting spawnInteractiveExec
    {
      const harness = createOrchHarness({ room1abc: 'ready' })
      const gate = deferred<ChildProcessWithoutNullStreams>()
      harness.spawnInteractiveExec.mockReturnValueOnce(gate.promise)
      const client = createSenderStub()
      const manager = new TermManager(harness.orch)

      const opening = manager.open('room1abc', client.sender)
      harness.statuses.set('room1abc', 'sleeping')
      harness.emit({ roomId: 'room1abc', kind: 'status' })

      const lateChild = childStub()
      gate.resolve(lateChild)

      await expect(opening).rejects.toThrow()
      expect(lateChild.rawKill).toHaveBeenCalledTimes(1)
      expect(client.emitter.listenerCount('destroyed')).toBe(0)
      manager.dispose()
    }

    // 2. Room is deleted while open() is awaiting spawnInteractiveExec
    {
      const harness = createOrchHarness({ room1abc: 'ready' })
      const gate = deferred<ChildProcessWithoutNullStreams>()
      harness.spawnInteractiveExec.mockReturnValueOnce(gate.promise)
      const client = createSenderStub()
      const manager = new TermManager(harness.orch)

      const opening = manager.open('room1abc', client.sender)
      harness.statuses.delete('room1abc')
      harness.emit({ roomId: 'room1abc', kind: 'deleted' })

      const lateChild = childStub()
      gate.resolve(lateChild)

      await expect(opening).rejects.toThrow()
      expect(lateChild.rawKill).toHaveBeenCalledTimes(1)
      expect(client.emitter.listenerCount('render-process-gone')).toBe(0)
      manager.dispose()
    }

    // 3. App shuts down (dispose) while open() is awaiting spawnInteractiveExec
    {
      const harness = createOrchHarness({ room1abc: 'ready' })
      const gate = deferred<ChildProcessWithoutNullStreams>()
      harness.spawnInteractiveExec.mockReturnValueOnce(gate.promise)
      const client = createSenderStub()
      const manager = new TermManager(harness.orch)

      const opening = manager.open('room1abc', client.sender)
      manager.dispose()

      const lateChild = childStub()
      gate.resolve(lateChild)

      await expect(opening).rejects.toThrow()
      expect(lateChild.rawKill).toHaveBeenCalledTimes(1)
      expect(harness.listeners.size).toBe(0)
    }
  })

  it('closes active consoles when a Room sleeps, enters broken state, or is deleted without disturbing other Rooms', async () => {
    const harness = createOrchHarness({ room1abc: 'ready', room2def: 'running' })
    const child1 = childStub()
    const child1AfterWake = childStub()
    const child2 = childStub()
    harness.spawnInteractiveExec
      .mockResolvedValueOnce(child1)
      .mockResolvedValueOnce(child2)
      .mockResolvedValueOnce(child1AfterWake)
    const client = createSenderStub()
    const manager = new TermManager(harness.orch)

    await manager.open('room1abc', client.sender)
    await manager.open('room2def', client.sender)

    harness.statuses.set('room1abc', 'sleeping')
    harness.emit({ roomId: 'room1abc', kind: 'status' })
    expect(child1.rawKill).toHaveBeenCalledTimes(1)
    expect(child2.rawKill).not.toHaveBeenCalled()

    harness.statuses.set('room1abc', 'ready')
    await manager.open('room1abc', client.sender)
    harness.statuses.set('room1abc', 'broken')
    // Health checks update status to 'broken' and emit 'check'.
    harness.emit({ roomId: 'room1abc', kind: 'check' })
    expect(child1AfterWake.rawKill).toHaveBeenCalledTimes(1)
    expect(child2.rawKill).not.toHaveBeenCalled()

    harness.statuses.delete('room2def')
    harness.emit({ roomId: 'room2def', kind: 'deleted' })
    expect(child2.rawKill).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('closes only the affected WebContents consoles on crash, destroy, or page reload and removes sender listeners', async () => {
    const harness = createOrchHarness({ room1abc: 'ready', room2def: 'ready' })
    const childA1 = childStub()
    const childA2 = childStub()
    const childB = childStub()
    const childReload = childStub()
    harness.spawnInteractiveExec
      .mockResolvedValueOnce(childA1)
      .mockResolvedValueOnce(childA2)
      .mockResolvedValueOnce(childB)
      .mockResolvedValueOnce(childReload)

    const senderA = createSenderStub()
    const senderB = createSenderStub()
    const manager = new TermManager(harness.orch)

    await manager.open('room1abc', senderA.sender)
    await manager.open('room2def', senderA.sender)
    const { termId: termB } = await manager.open('room2def', senderB.sender)

    senderA.emitter.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(childA1.rawKill).toHaveBeenCalledTimes(1)
    expect(childA2.rawKill).toHaveBeenCalledTimes(1)
    expect(childB.rawKill).not.toHaveBeenCalled()
    expect(senderA.emitter.listenerCount('destroyed')).toBe(0)
    expect(senderA.emitter.listenerCount('render-process-gone')).toBe(0)

    await manager.open('room1abc', senderA.sender)
    // In-page navigation (same document) must not drop an active console.
    senderA.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(childReload.rawKill).not.toHaveBeenCalled()
    // Full reload / main-frame document navigation reclaims the console immediately.
    senderA.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(childReload.rawKill).toHaveBeenCalledTimes(1)
    expect(senderA.emitter.listenerCount('did-start-navigation')).toBe(0)

    manager.close(termB)
    expect(childB.rawKill).toHaveBeenCalledTimes(1)
    expect(senderB.emitter.listenerCount('destroyed')).toBe(0)
    expect(senderB.emitter.listenerCount('render-process-gone')).toBe(0)
    manager.dispose()
  })

  it('guards console input when stdin is already ended, destroyed, or throws on write', async () => {
    const child = childStub()
    const spawnInteractiveExec = vi.fn().mockResolvedValue(child)
    const manager = new TermManager({ spawnInteractiveExec } as unknown as RoomOrchestrator)

    const { termId } = await manager.open('room1abc', sender)
    child.stdin.end()
    expect(() => manager.input(termId, 'ls\r')).not.toThrow()

    child.stdin.destroy()
    expect(() => manager.input(termId, 'pwd\r')).not.toThrow()

    const throwingChild = childStub()
    throwingChild.stdin.write = (() => {
      throw new Error('EPIPE')
    }) as typeof throwingChild.stdin.write
    spawnInteractiveExec.mockResolvedValueOnce(throwingChild)
    const { termId: throwingTerm } = await manager.open('room1abc', sender)
    expect(() => manager.input(throwingTerm, 'whoami\r')).not.toThrow()

    manager.dispose()
  })
})
