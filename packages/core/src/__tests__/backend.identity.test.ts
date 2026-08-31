import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { jobName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const roomId = 'room1abc'
const managedJobName = jobName(roomId, '11111111-2222-4333-8444-555555555555')

function managedRow(overrides: { labels?: string; name?: string; state?: string } = {}): string {
  return JSON.stringify({
    Names: overrides.name ?? managedJobName,
    State: overrides.state ?? 'running',
    Labels: overrides.labels ?? `devhotel.managed=1,devhotel.room=${roomId},devhotel.role=job`
  })
}

describe('OciCliBackend engine identity pin', () => {
  let dir: string
  let engineId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-engine-'))
    engineId = 'engine-one'
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'version') {
        return {
          code: 0,
          stdout: JSON.stringify({ Client: { Version: '28.0.0' }, Server: { Version: '28.0.0' } }),
          stderr: ''
        }
      }
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists the first engine identity and refuses destructive work after drift', async () => {
    const identityFile = join(dir, 'runtime', 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })

    await expect(backend.health()).resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({ schema: 1, engineId: 'engine-one' })

    engineId = 'engine-two'
    await expect(backend.deleteRoomPod('r1', { volumes: false })).rejects.toThrow(/engine identity changed/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'ps')).toBe(false)
  })

  it('loads the durable pin in a new backend instance', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    await new OciCliBackend({ identityFile }).health()

    engineId = 'different-engine'
    const restarted = new OciCliBackend({ identityFile })
    await expect(restarted.health()).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/identity changed/) })
  })

  it('blocks create and start mutations after engine drift', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })
    await backend.health()
    engineId = 'engine-two'
    mockedRunDocker.mockClear()

    await expect(backend.startWeb('r1')).rejects.toThrow(/engine identity changed/)
    await expect(
      backend.createRoomPod({
        roomId: 'r1',
        internalPort: 3000,
        nodeMajor: '22',
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        workspaceVolumeRevision: 0,
        startCommand: 'node server.js'
      })
    ).rejects.toThrow(/engine identity changed/)
    expect(mockedRunDocker.mock.calls.every(([args]) => args[0] === 'info')).toBe(true)
  })

  it('pins the engine before listing managed containers and blocks the list after drift', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      }
      if (args[0] === 'ps') {
        return { code: 0, stdout: managedRow(), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(backend.listManagedContainers()).resolves.toEqual([
      { roomId, role: 'job', state: 'running', name: managedJobName }
    ])
    expect(mockedRunDocker.mock.calls.map(([args]) => args[0])).toEqual(['info', 'ps'])

    engineId = 'engine-two'
    mockedRunDocker.mockClear()
    await expect(backend.listManagedContainers()).rejects.toThrow(/engine identity changed/)
    expect(mockedRunDocker.mock.calls.map(([args]) => args[0])).toEqual(['info'])
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing state', JSON.stringify({ Names: managedJobName, Labels: `devhotel.managed=1,devhotel.room=${roomId},devhotel.role=job` })],
    ['missing managed label', managedRow({ labels: `devhotel.room=${roomId},devhotel.role=job` })],
    ['missing Room label', managedRow({ labels: 'devhotel.managed=1,devhotel.role=job' })],
    ['unknown role', managedRow({ labels: `devhotel.managed=1,devhotel.room=${roomId},devhotel.role=unknown` })],
    ['name outside the strict role form', managedRow({ name: `dh-${roomId}-job-not-a-uuid` })]
  ])('fails closed on a malformed managed-container row: %s', async (_label, stdout) => {
    const identityFile = join(dir, 'docker-engine.json')
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      }
      if (args[0] === 'ps') return { code: 0, stdout, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(new OciCliBackend({ identityFile }).listManagedContainers()).rejects.toThrow(
      /invalid JSON|ownership metadata is invalid/
    )
  })

  it('rejects the whole managed list when a malformed row follows a valid row', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      }
      if (args[0] === 'ps') {
        return { code: 0, stdout: `${managedRow()}\n${managedRow({ state: '' })}`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(new OciCliBackend({ identityFile }).listManagedContainers()).rejects.toThrow(
      /ownership metadata is invalid/
    )
  })
})
