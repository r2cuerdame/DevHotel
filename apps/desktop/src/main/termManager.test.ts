import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
import { TermManager } from './termManager'

function childStub(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
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
    expect(child.kill).toHaveBeenCalled()
  })

  it('does not create a session when backend ownership validation rejects', async () => {
    const spawnInteractiveExec = vi.fn().mockRejectedValue(new Error('container ownership metadata is invalid'))
    const manager = new TermManager({ spawnInteractiveExec } as unknown as RoomOrchestrator)

    await expect(manager.open('room1abc', sender)).rejects.toThrow(/ownership metadata/)
    manager.dispose()
    expect(spawnInteractiveExec).toHaveBeenCalledTimes(1)
  })
})
