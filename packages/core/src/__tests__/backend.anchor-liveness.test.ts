import { rmSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { anchorName, androidRuntimeAnchorName, webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import { RoomOrchestrator } from '../orchestrator'
import { FakeGateway, makeRoom, tempDir, testDb } from './fakes'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const ENGINE_INFO = JSON.stringify({ ID: 'engine-one', ServerVersion: '28.0.0', ClientInfo: { Version: '28.0.0' } })
const LIVE_TOP = 'UID PID PPID C STIME TTY TIME CMD\nroot 1 0 0 00:00 ? 00:00:00 node index.js\n'

function psRow(name: string, roomId: string, role: string, state: string): string {
  return JSON.stringify({
    Names: name,
    State: state,
    Labels: `devhotel.managed=1,devhotel.role=${role},devhotel.room=${roomId}`
  })
}

/**
 * The web container joins its Room anchor's network namespace
 * (`container:dh-<id>-anchor`). When the anchor stops, `docker ps` and
 * `docker top` still show a live web container, but the app is unreachable
 * (the gateway answers 502). Liveness must follow the anchor too.
 */
describe('Room runtime liveness follows the network anchor', () => {
  let rows: string[]
  let execs: string[][]

  beforeEach(() => {
    rows = []
    execs = []
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: ENGINE_INFO, stderr: '' }
      if (args[0] === 'ps') return { code: 0, stdout: rows.join('\n'), stderr: '' }
      if (args[0] === 'top') return { code: 0, stdout: LIVE_TOP, stderr: '' }
      if (args[0] === 'exec') {
        execs.push(args)
        return { code: 0, stdout: 'ok\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'Error response from daemon: No such container' }
    })
  })

  function withOrchestrator<T>(backend: OciCliBackend, run: (orch: RoomOrchestrator) => Promise<T>): Promise<T> {
    const userData = tempDir()
    const db = testDb()
    const orch = new RoomOrchestrator({ userData, backend, gateway: new FakeGateway().asGateway(), db, appVersion: 'test' })
    return run(orch).finally(() => {
      db.close()
      rmSync(userData, { recursive: true, force: true })
    })
  }

  it('web running, anchor exited: status is not ready and run_in_room is refused', async () => {
    rows = [
      psRow(webName('room0001'), 'room0001', 'web', 'running'),
      psRow(anchorName('room0001'), 'room0001', 'anchor', 'exited')
    ]
    const backend = new OciCliBackend()

    const observed = await backend.observeRoomRuntimes(['room0001'])
    expect(observed.get('room0001')?.main).toBe('degraded')
    await expect(backend.webState('room0001')).resolves.toBe('degraded')

    await withOrchestrator(backend, async (orch) => {
      orch.rooms.create(
        makeRoom({ id: 'room0001', status: 'ready', workspaceMode: 'hotel', syncStatus: 'synced', workspaceFingerprint: 'baseline' })
      )
      for (let read = 0; read < 3; read++) {
        const hotel = await orch.hotelStatus()
        expect(hotel.rooms[0]?.status).not.toBe('ready')
        expect(hotel.rooms[0]?.runtimeStatus).toMatchObject({ state: 'degraded', main: 'degraded' })
        expect(hotel.rooms[0]?.runtimeStatus.detail).toContain('network anchor')
        expect(hotel.rooms[0]?.runtimeStatus.recoveryHint).toBe('Start or restart the Room, then retry.')
      }
      await expect(orch.execInRoom('room0001', ['echo', 'hi'], undefined, 'agent')).rejects.toMatchObject({
        code: 'ROOM_RUNTIME_NOT_RUNNING',
        recoveryHint: 'Start or restart the Room, then retry.'
      })
    })
    expect(execs).toEqual([])
    // Read-only: nothing was started, restarted or repaired.
    const verbs = mockedRunDocker.mock.calls.map(([args]) => args[0])
    expect(verbs).not.toContain('start')
    expect(verbs).not.toContain('restart')
  })

  it('an Android web slot follows its runtime anchor, not the emulator anchor', async () => {
    rows = [
      psRow(webName('room0002'), 'room0002', 'web', 'running'),
      psRow(anchorName('room0002'), 'room0002', 'anchor', 'running'),
      psRow(androidRuntimeAnchorName('room0002'), 'room0002', 'android-runtime-anchor', 'exited')
    ]
    const backend = new OciCliBackend()

    expect((await backend.observeRoomRuntimes(['room0002'])).get('room0002')?.main).toBe('degraded')
    await expect(backend.webState('room0002')).resolves.toBe('degraded')
  })

  it('web and anchor running stays running', async () => {
    rows = [
      psRow(webName('room0003'), 'room0003', 'web', 'running'),
      psRow(anchorName('room0003'), 'room0003', 'anchor', 'running')
    ]
    const backend = new OciCliBackend()

    expect((await backend.observeRoomRuntimes(['room0003'])).get('room0003')?.main).toBe('running')
    await expect(backend.webState('room0003')).resolves.toBe('running')
    await withOrchestrator(backend, async (orch) => {
      orch.rooms.create(makeRoom({ id: 'room0003', status: 'ready' }))
      const hotel = await orch.hotelStatus()
      expect(hotel.rooms[0]).toMatchObject({ status: 'ready', runtimeStatus: { state: 'running', main: 'running' } })
    })
  })

  it('a standalone Room without an anchor is judged by its web container alone', async () => {
    rows = [psRow(webName('room0004'), 'room0004', 'web', 'running')]
    const backend = new OciCliBackend()

    expect((await backend.observeRoomRuntimes(['room0004'])).get('room0004')?.main).toBe('running')
    await expect(backend.webState('room0004')).resolves.toBe('running')
  })
})

