import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { emulatorName, webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeGateway, makeRoom, tempDir, testDb } from './fakes'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const ENGINE_INFO = JSON.stringify({ ID: 'engine-one', ServerVersion: '28.0.0', ClientInfo: { Version: '28.0.0' } })

function psRow(name: string, roomId: string, role: string, state: string, labels?: string): string {
  return JSON.stringify({
    Names: name,
    State: state,
    Labels: labels ?? `devhotel.managed=1,devhotel.role=${role},devhotel.room=${roomId}`
  })
}

const commands = (): string[] => mockedRunDocker.mock.calls.map(([args]) => args[0] ?? '')

describe('OciCliBackend Room runtime inventory', () => {
  let dir: string
  let rows: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-inventory-'))
    rows = []
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: ENGINE_INFO, stderr: '' }
      if (args[0] === 'ps') return { code: 0, stdout: rows.join('\n'), stderr: '' }
      return { code: 1, stdout: '', stderr: 'Error response from daemon: No such container' }
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('answers every listed Room from one docker ps over owned containers', async () => {
    rows = [
      psRow(webName('room0001'), 'room0001', 'web', 'running'),
      psRow(webName('room0002'), 'room0002', 'web', 'exited'),
      psRow(emulatorName('room0002'), 'room0002', 'svc-emulator', 'running'),
      psRow('dh-room0002-anchor', 'room0002', 'anchor', 'running'),
      psRow(webName('room0009'), 'room0009', 'web', 'running')
    ]
    const backend = new OciCliBackend({ identityFile: join(dir, 'engine.json') })
    await backend.health()
    mockedRunDocker.mockClear()

    const observed = await backend.observeRoomRuntimes(['room0001', 'room0002', 'room0003'])

    expect(commands()).toEqual(['ps'])
    expect(mockedRunDocker.mock.calls[0]?.[0]).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=devhotel.managed=1',
      '--format',
      '{{json .}}'
    ])
    expect([...observed.entries()]).toEqual([
      ['room0001', { main: 'running', emulator: 'missing' }],
      ['room0002', { main: 'exited', emulator: 'running' }],
      ['room0003', { main: 'missing', emulator: 'missing' }]
    ])
  })

  it('scopes a single-Room inventory to that Room label', async () => {
    rows = [psRow(webName('room0001'), 'room0001', 'web', 'running')]
    const backend = new OciCliBackend()

    await expect(backend.observeRoomRuntimes(['room0001'])).resolves.toEqual(
      new Map([['room0001', { main: 'running', emulator: 'missing' }]])
    )
    expect(mockedRunDocker.mock.calls[0]?.[0]).toContain('label=devhotel.room=room0001')
  })

  it('reports unknown, never running, for a same-name container without exact ownership metadata', async () => {
    rows = [
      psRow(webName('room0001'), 'room0001', 'web', 'running', 'devhotel.managed=1,devhotel.role=web,devhotel.room=another1'),
      psRow(emulatorName('room0001'), 'room0001', 'svc-emulator', 'running', 'devhotel.role=svc-emulator,devhotel.room=room0001'),
      psRow(webName('room0002'), 'room0002', 'web', '')
    ]
    const backend = new OciCliBackend()

    const observed = await backend.observeRoomRuntimes(['room0001', 'room0002'])

    expect(observed.get('room0001')).toEqual({ main: 'unknown', emulator: 'unknown' })
    expect(observed.get('room0002')).toEqual({ main: 'unknown', emulator: 'missing' })
  })

  it('fails closed on an inventory that is not JSON', async () => {
    rows = ['{']
    await expect(new OciCliBackend().observeRoomRuntimes(['room0001'])).rejects.toThrow(/invalid JSON/)
  })

  it('does nothing for an empty Room list', async () => {
    const backend = new OciCliBackend({ identityFile: join(dir, 'engine.json') })

    await expect(backend.observeRoomRuntimes([])).resolves.toEqual(new Map())
    expect(commands()).toEqual([])
  })
})

describe('hotel_status Docker budget with 20 Rooms and 4 awake', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('costs one health read plus one inventory, never a process per Room', async () => {
    const awake = Array.from({ length: 4 }, (_, i) =>
      makeRoom({ id: `awake00${i}`, roomNumber: 300 + i, domain: `awake00${i}.localhost`, status: 'ready' })
    )
    const asleep = Array.from({ length: 16 }, (_, i) => {
      const id = `sleep0${String(i).padStart(2, '0')}`
      return makeRoom({ id, roomNumber: 400 + i, domain: `${id}.localhost`, status: 'sleeping', hostPort: null })
    })
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: ENGINE_INFO, stderr: '' }
      if (args[0] === 'ps') {
        return {
          code: 0,
          stdout: awake.map((room, i) => psRow(webName(room.id), room.id, 'web', i === 3 ? 'exited' : 'running')).join('\n'),
          stderr: ''
        }
      }
      throw new Error(`unexpected docker command during status: ${args.join(' ')}`)
    })
    const userData = tempDir()
    dirs.push(userData)
    const identityDir = mkdtempSync(join(tmpdir(), 'dh-budget-'))
    dirs.push(identityDir)
    const db = testDb()
    dbs.push(db)
    const backend = new OciCliBackend({ identityFile: join(identityDir, 'engine.json') })
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
    for (const room of [...awake, ...asleep]) orch.rooms.create(room)

    const first = await orch.hotelStatus()
    mockedRunDocker.mockClear()
    const second = await orch.hotelStatus()

    expect(first.backend.ok).toBe(true)
    expect(commands()).toEqual(['info', 'ps'])
    expect(second.rooms.filter((room) => room.runtimeStatus.state === 'running')).toHaveLength(3)
    expect(second.rooms.find((room) => room.id === 'awake003')).toMatchObject({
      status: 'broken',
      runtimeStatus: { state: 'dead', main: 'exited' }
    })
    expect(second.rooms.filter((room) => room.runtimeStatus.state === 'stopped')).toHaveLength(16)
    expect(second.budget.dockerSpawns).toBeLessThanOrEqual(6)
    expect(second.budget.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
