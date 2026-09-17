import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecResult } from '../backend/types'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

const ROOM = 'room1abc'

function hotelRoom() {
  return makeRoom({ sourceType: 'managed-git', sourceRef: 'https://example.test/demo.git', workspaceMode: 'hotel', syncStatus: 'synced' })
}

/** A guest command that never finishes on its own; only an abort ends it. */
function hangingExec(backend: FakeBackend): { started: Promise<void>; finish: (result: ExecResult) => void } {
  let markStarted: () => void = () => {}
  let finish: (result: ExecResult) => void = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  backend.execInRoomHandler = (_roomId, cmd) => {
    if (cmd.join(' ') !== 'sleep 600') return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
    markStarted()
    return new Promise<ExecResult>((resolve) => {
      finish = resolve
    })
  }
  return { started, finish: (result) => finish(result) }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The rejection is asserted later; keep Node from reporting it as unhandled meanwhile. */
function expectedToReject<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

describe('Room workload slot vs lifecycle lock', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let orch: RoomOrchestrator

  beforeEach(() => {
    db = testDb()
    userData = tempDir()
    backend = new FakeBackend()
    orch = new RoomOrchestrator({ userData, backend, gateway: new FakeGateway().asGateway(), db, appVersion: 'test' })
    orch.rooms.create(hotelRoom())
  })

  afterEach(() => {
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('sleeps the Room while a long command runs instead of queueing behind it, and reaps the command first', async () => {
    const guest = hangingExec(backend)
    const exec = expectedToReject(orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 }))
    await guest.started
    expect(orch.listRuns(ROOM)).toHaveLength(1)

    const sleepStarted = Date.now()
    await orch.sleepRoom(ROOM, 'user')
    expect(Date.now() - sleepStarted).toBeLessThan(2_000)

    await expect(exec).rejects.toMatchObject({ code: 'ROOM_COMMAND_CANCELLED', httpStatus: 409 })
    expect(backend.reapedExecs).toHaveLength(1)
    expect(backend.reapedExecs[0]).toMatchObject({ roomId: ROOM, cmd: ['sleep', '600'] })
    // The owned guest process group is reaped before the runtime is stopped.
    expect(backend.calls.indexOf(`stopRoomPod:${ROOM}`)).toBeGreaterThanOrEqual(0)
    expect(orch.rooms.get(ROOM)?.status).toBe('sleeping')
    expect(orch.listRuns(ROOM).filter((run) => run.status === 'running')).toEqual([])
  })

  it('cancels the command and reaps its guest process group when the caller closes the response', async () => {
    const guest = hangingExec(backend)
    const cancel = new AbortController()
    const exec = expectedToReject(orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000, signal: cancel.signal }))
    await guest.started

    cancel.abort(new Error('response closed'))

    await expect(exec).rejects.toThrow('response closed')
    expect(backend.reapedExecs).toHaveLength(1)
    expect(backend.reapedExecs[0]?.reason).toMatchObject({ message: 'response closed' })
    expect(orch.rooms.get(ROOM)?.status).toBe('ready')
  })

  it('deletes the Room while a command runs, reaping the command before the pod goes', async () => {
    const guest = hangingExec(backend)
    const exec = expectedToReject(orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 }))
    await guest.started

    await orch.deleteRoom(ROOM, 'user')

    await expect(exec).rejects.toMatchObject({ code: 'ROOM_COMMAND_CANCELLED' })
    expect(backend.reapedExecs).toHaveLength(1)
    expect(orch.rooms.get(ROOM)).toBeNull()
  })

  it('does not block lifecycle reads and writes behind the workload slot', async () => {
    const guest = hangingExec(backend)
    const exec = orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 })
    await guest.started

    await orch.renameRoom(ROOM, 'renamed-while-busy')
    expect(orch.rooms.get(ROOM)?.nickname).toBe('renamed-while-busy')

    guest.finish({ code: 0, stdout: '', stderr: '' })
    await expect(exec).resolves.toMatchObject({ code: 0 })
    expect(backend.reapedExecs).toEqual([])
  })

  it('serializes commands among themselves and re-validates a queued command after sleep', async () => {
    const guest = hangingExec(backend)
    const first = expectedToReject(orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 }))
    await guest.started
    const second = expectedToReject(orch.execInRoom(ROOM, ['node', '--version']))
    await settle()
    // Queued, not started: only the hanging command reached the backend.
    expect(backend.execInRoomCalls).toHaveLength(1)

    await orch.sleepRoom(ROOM, 'user')

    await expect(first).rejects.toMatchObject({ code: 'ROOM_COMMAND_CANCELLED' })
    await expect(second).rejects.toMatchObject({ code: 'ROOM_COMMAND_CANCELLED' })
    expect(backend.execInRoomCalls).toHaveLength(1)
  })

  it('counts a running command as activity so the idle sweep never cancels it, then sleeps the Room once it is idle', async () => {
    const guest = hangingExec(backend)
    const exec = orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 })
    await guest.started
    const twoHoursOn = new Date(Date.now() + 2 * 60 * 60 * 1000)

    const busy = await orch.sweepRoomLifecycle(twoHoursOn)
    expect(busy.slept).toEqual([])
    expect(busy.retained).toEqual([{ roomId: ROOM, reason: 'a command is running in the Room' }])
    expect(backend.reapedExecs).toEqual([])
    expect(orch.rooms.get(ROOM)?.status).toBe('ready')

    guest.finish({ code: 0, stdout: '', stderr: '' })
    await expect(exec).resolves.toMatchObject({ code: 0 })
    const idle = await orch.sweepRoomLifecycle(twoHoursOn)
    expect(idle.slept).toEqual([ROOM])
    expect(orch.rooms.get(ROOM)?.status).toBe('sleeping')
  })

  it('cancels a running command before Host resync replaces the workspace under it', async () => {
    const sourceDir = join(tempDir(), 'project')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo' }))
    try {
      orch.rooms.update(ROOM, {
        sourceType: 'linked-folder',
        sourceRef: sourceDir,
        workspaceVolumeRevision: 1,
        hostSyncEnabled: true,
        workspaceFingerprint: 'same-fingerprint'
      })
      backend.workspaceFingerprintValue = 'same-fingerprint'
      const guest = hangingExec(backend)
      const exec = expectedToReject(orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 }))
      await guest.started

      await expect(orch.syncFromHost(ROOM, 'user')).resolves.toMatchObject({ syncStatus: 'synced' })

      await expect(exec).rejects.toMatchObject({ code: 'ROOM_COMMAND_CANCELLED' })
      expect(backend.reapedExecs).toHaveLength(1)
      expect(backend.calls.some((call) => call.startsWith(`recreateWeb:${ROOM}:`))).toBe(true)
    } finally {
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  it('still refuses admission behind an Android recovery fence, and cancellation never touches it', async () => {
    orch.rooms.update(ROOM, { provider: 'android' })
    orch.settings.set(`androidLocaleRestorePending:${ROOM}`, JSON.stringify({ target: 'exact' }))

    await expect(orch.execInRoom(ROOM, ['sleep', '600'])).rejects.toMatchObject({
      code: 'ANDROID_LOCALE_RECOVERY_REQUIRED'
    })
    expect(backend.execInRoomCalls).toEqual([])
    expect(backend.reapedExecs).toEqual([])
    expect(orch.settings.get(`androidLocaleRestorePending:${ROOM}`)).not.toBeNull()
  })

  describe('room_components while the workload slot is busy', () => {
    it('replays a bounded-age live observation instead of probing the busy Room', async () => {
      backend.execHandler = (cmd) => {
        const script = cmd[2] ?? ''
        if (script.includes('node --version')) return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
        if (script.includes('--version')) return { code: 0, stdout: '10.4.1\n', stderr: '' }
        return { code: 1, stdout: '', stderr: '' }
      }
      const live = await orch.components(ROOM)
      expect(live.find((component) => component.id === 'node')).toMatchObject({ version: '22.14.0', source: 'live' })
      const probesBefore = backend.execInRoomCalls.length

      const guest = hangingExec(backend)
      const exec = orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 })
      await guest.started

      const busy = await orch.components(ROOM)
      expect(busy.find((component) => component.id === 'node')).toMatchObject({
        version: '22.14.0',
        source: 'recorded',
        observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      })
      // One call for the hanging command, none for component probes.
      expect(backend.execInRoomCalls.length).toBe(probesBefore + 1)

      guest.finish({ code: 0, stdout: '', stderr: '' })
      await exec
    })

    it('answers from the Room record without probing when no recent observation exists', async () => {
      const guest = hangingExec(backend)
      const exec = orch.execInRoom(ROOM, ['sleep', '600'], { timeoutMs: 600_000 })
      await guest.started

      const busy = await orch.components(ROOM)
      expect(busy.find((component) => component.id === 'node')).toMatchObject({ version: '22', source: 'recorded' })
      expect(busy.every((component) => component.observedAt === undefined)).toBe(true)
      expect(backend.execInRoomCalls).toHaveLength(1)

      guest.finish({ code: 0, stdout: '', stderr: '' })
      await exec
    })
  })
})
