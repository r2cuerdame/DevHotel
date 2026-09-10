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
const DAEMON_DOWN =
  'error during connect: Head "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/_ping": ' +
  'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'

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
  /** While true, every non-identity command fails the way a stopped daemon fails. */
  let daemonDown: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-engine-'))
    engineId = 'engine-one'
    daemonDown = false
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return {
          code: 0,
          stdout: JSON.stringify({ ID: engineId, ServerVersion: '28.0.0', ClientInfo: { Version: '28.0.0' } }),
          stderr: ''
        }
      }
      if (daemonDown) return { code: 1, stdout: '', stderr: DAEMON_DOWN }
      if (args[0] === 'ps') return { code: 0, stdout: managedRow(), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const commands = (): string[] => mockedRunDocker.mock.calls.map(([args]) => args[0] ?? '')

  it('persists the first engine identity and refuses destructive work once drift is observed', async () => {
    const identityFile = join(dir, 'runtime', 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })

    await expect(backend.health()).resolves.toMatchObject({ ok: true, detail: 'client 28.0.0, server 28.0.0' })
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({ schema: 1, engineId: 'engine-one' })

    engineId = 'engine-two'
    await expect(backend.health()).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/identity changed/) })
    await expect(backend.deleteRoomPod('r1', { volumes: false })).rejects.toThrow(/engine identity changed/)
    expect(commands()).not.toContain('ps')
  })

  it('loads the durable pin in a new backend instance', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    await new OciCliBackend({ identityFile }).health()

    engineId = 'different-engine'
    const restarted = new OciCliBackend({ identityFile })
    await expect(restarted.health()).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/identity changed/) })
  })

  it('health reads the engine identity in the same docker info it uses for liveness', async () => {
    const backend = new OciCliBackend({ identityFile: join(dir, 'docker-engine.json') })

    await backend.health()
    await backend.health()

    expect(commands()).toEqual(['info', 'info'])
  })

  it('reports an unreachable daemon without touching the pin', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })
    await backend.health()
    mockedRunDocker.mockImplementation(async () => ({ code: 1, stdout: '', stderr: DAEMON_DOWN }))

    await expect(backend.health()).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/error during connect/) })
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({ engineId: 'engine-one' })
  })

  it('caches the verified engine identity per process instead of re-reading it per Room operation', async () => {
    const backend = new OciCliBackend({ identityFile: join(dir, 'docker-engine.json') })
    await backend.health()
    mockedRunDocker.mockClear()

    await backend.listManagedContainers()
    await backend.listManagedContainers()
    await backend.webState('r1')

    expect(commands()).toEqual(['ps', 'ps', 'inspect'])
  })

  it('coalesces concurrent first-use identity reads into one docker info', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    await new OciCliBackend({ identityFile }).health()
    mockedRunDocker.mockClear()

    const restarted = new OciCliBackend({ identityFile })
    await Promise.all([
      restarted.listManagedContainers(),
      restarted.listManagedContainers(),
      restarted.listManagedContainers()
    ])

    expect(commands().filter((command) => command === 'info')).toHaveLength(1)
    expect(commands().filter((command) => command === 'ps')).toHaveLength(3)
  })

  it('revalidates fail-closed after a transport error and blocks mutations on drift', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })
    await backend.health()

    // The daemon goes away mid-session: one read fails the way a stopped
    // engine fails, and the engine comes back with a different identity.
    daemonDown = true
    await expect(backend.webState('r1')).resolves.toBe('missing')
    daemonDown = false
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
    expect(commands().every((command) => command === 'info')).toBe(true)
  })

  it('stays fail-closed while the identity re-read itself keeps failing', async () => {
    const backend = new OciCliBackend({ identityFile: join(dir, 'docker-engine.json') })
    await backend.health()
    daemonDown = true
    await backend.webState('r1')
    mockedRunDocker.mockImplementation(async () => ({ code: 1, stdout: '', stderr: DAEMON_DOWN }))
    mockedRunDocker.mockClear()

    await expect(backend.listManagedContainers()).rejects.toThrow(/read Docker engine identity/)
    await expect(backend.listManagedContainers()).rejects.toThrow(/read Docker engine identity/)
    expect(commands()).toEqual(['info', 'info'])
  })

  it('resumes the cached path once a revalidation succeeds after a transport error', async () => {
    const backend = new OciCliBackend({ identityFile: join(dir, 'docker-engine.json') })
    await backend.health()
    daemonDown = true
    await backend.webState('r1')
    daemonDown = false
    mockedRunDocker.mockClear()

    await backend.listManagedContainers()
    await backend.listManagedContainers()

    expect(commands()).toEqual(['info', 'ps', 'ps'])
  })

  it('pins the engine before listing managed containers and blocks the list after observed drift', async () => {
    const identityFile = join(dir, 'docker-engine.json')
    const backend = new OciCliBackend({ identityFile })

    await expect(backend.listManagedContainers()).resolves.toEqual([
      { roomId, role: 'job', state: 'running', name: managedJobName }
    ])
    expect(commands()).toEqual(['info', 'ps'])

    engineId = 'engine-two'
    daemonDown = true
    await backend.webState('r1')
    daemonDown = false
    mockedRunDocker.mockClear()
    await expect(backend.listManagedContainers()).rejects.toThrow(/engine identity changed/)
    expect(commands()).toEqual(['info'])
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
