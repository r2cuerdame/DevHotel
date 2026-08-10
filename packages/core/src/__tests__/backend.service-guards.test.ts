import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const roots: string[] = []
const SERVICE_ID = 'd'.repeat(64)

function inspectRedis(overrides: { roomId?: string; role?: string; managed?: string; id?: string } = {}): string {
  return JSON.stringify([
    {
      Id: overrides.id ?? SERVICE_ID,
      Name: '/dh-room1abc-svc-redis',
      Config: {
        Labels: {
          'devhotel.room': overrides.roomId ?? 'room1abc',
          'devhotel.role': overrides.role ?? 'svc-redis',
          'devhotel.managed': overrides.managed ?? '1'
        }
      },
      State: { Status: 'running' }
    }
  ])
}

beforeEach(() => {
  mockedRunDocker.mockReset()
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('service process ownership guards', () => {
  it('rejects every service state/exec/stream/copy path after pinned engine drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dh-service-engine-'))
    roots.push(root)
    let engineId = 'engine-one'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'version') {
        return { code: 0, stdout: JSON.stringify({ Client: { Version: '28' }, Server: { Version: '28' } }), stderr: '' }
      }
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      if (args[0] === 'inspect') return { code: 0, stdout: inspectRedis(), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })
    await backend.health()
    engineId = 'engine-two'
    mockedRunDocker.mockClear()

    const guarded = [
      () => backend.serviceState('room1abc', 'redis'),
      () => backend.execInService('room1abc', 'redis', ['redis-cli', 'ping']),
      () => backend.execInServiceToFile('room1abc', 'redis', ['redis-cli', 'save'], 'dump.out'),
      () => backend.execInServiceFromFile('room1abc', 'redis', ['redis-cli'], 'dump.in'),
      () => backend.copyFromService('room1abc', 'redis', '/data/dump.rdb', 'dump.rdb'),
      () => backend.copyToService('room1abc', 'redis', 'dump.rdb', '/data/dump.rdb')
    ]
    for (const operation of guarded) await expect(operation()).rejects.toThrow(/engine identity changed/)
    expect(mockedRunDocker.mock.calls.every(([args]) => args[0] === 'info')).toBe(true)
  })

  it('rejects a same-name service container without exact Room ownership labels before any mutation', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        return { code: 0, stdout: inspectRedis({ roomId: 'another1' }), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend()

    const guarded = [
      () => backend.serviceState('room1abc', 'redis'),
      () => backend.execInService('room1abc', 'redis', ['redis-cli', 'ping']),
      () => backend.execInServiceToFile('room1abc', 'redis', ['redis-cli', 'save'], 'dump.out'),
      () => backend.execInServiceFromFile('room1abc', 'redis', ['redis-cli'], 'dump.in'),
      () => backend.copyFromService('room1abc', 'redis', '/data/dump.rdb', 'dump.rdb'),
      () => backend.copyToService('room1abc', 'redis', 'dump.rdb', '/data/dump.rdb')
    ]
    for (const operation of guarded) await expect(operation()).rejects.toThrow(/ownership metadata/)
    expect(mockedRunDocker.mock.calls.every(([args]) => args[0] === 'inspect')).toBe(true)
  })

  it('uses the validated immutable service ID for buffered, streamed, and copy operations', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: inspectRedis(), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend()

    await expect(backend.serviceState('room1abc', 'redis')).resolves.toBe('running')
    await backend.execInService('room1abc', 'redis', ['redis-cli', 'ping'])
    await backend.execInService('room1abc', 'redis', ['redis-cli'], { input: 'PING\n' })
    await backend.execInServiceToFile('room1abc', 'redis', ['redis-cli', 'save'], 'dump.out')
    await backend.execInServiceFromFile('room1abc', 'redis', ['redis-cli'], 'dump.in')
    await backend.copyFromService('room1abc', 'redis', '/data/dump.rdb', 'dump.rdb')
    await backend.copyToService('room1abc', 'redis', 'dump.rdb', '/data/dump.rdb')

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    expect(calls).toContainEqual(['exec', SERVICE_ID, 'redis-cli', 'ping'])
    expect(calls).toContainEqual(['exec', '-i', SERVICE_ID, 'redis-cli'])
    expect(calls).toContainEqual(['exec', SERVICE_ID, 'redis-cli', 'save'])
    expect(calls).toContainEqual(['cp', `${SERVICE_ID}:/data/dump.rdb`, 'dump.rdb'])
    expect(calls).toContainEqual(['cp', 'dump.rdb', `${SERVICE_ID}:/data/dump.rdb`])
  })
})
