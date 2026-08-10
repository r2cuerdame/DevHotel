import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker, spawnDockerProcess } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn(), spawnDockerProcess: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const mockedSpawnDocker = vi.mocked(spawnDockerProcess)
const roots: string[] = []

function inspectWeb(overrides: { roomId?: string; managed?: string; id?: string } = {}): string {
  return JSON.stringify([
    {
      Id: overrides.id ?? 'a'.repeat(64),
      Name: '/dh-room1abc-web',
      Config: {
        Labels: {
          'devhotel.room': overrides.roomId ?? 'room1abc',
          'devhotel.role': 'web',
          'devhotel.managed': overrides.managed ?? '1'
        }
      },
      State: { Status: 'running' }
    }
  ])
}

beforeEach(() => {
  mockedRunDocker.mockReset()
  mockedSpawnDocker.mockReset()
  mockedSpawnDocker.mockReturnValue({} as ChildProcessWithoutNullStreams)
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('streaming Room process guards', () => {
  it('blocks interactive exec and log following after pinned engine drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dh-stream-engine-'))
    roots.push(root)
    let engineId = 'engine-one'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'version') {
        return { code: 0, stdout: JSON.stringify({ Client: { Version: '28' }, Server: { Version: '28' } }), stderr: '' }
      }
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
      if (args[0] === 'inspect') return { code: 0, stdout: inspectWeb(), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })
    await backend.health()
    engineId = 'engine-two'

    await expect(backend.spawnInteractiveExec('room1abc', ['sh', '-li'])).rejects.toThrow(/engine identity changed/)
    await expect(backend.followRoomLogs('room1abc')).rejects.toThrow(/engine identity changed/)
    expect(mockedSpawnDocker).not.toHaveBeenCalled()
  })

  it('refuses a same-name web container without exact Room ownership labels', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        return { code: 0, stdout: inspectWeb({ roomId: 'another1' }), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend()

    await expect(backend.spawnInteractiveExec('room1abc', ['sh', '-li'])).rejects.toThrow(/ownership metadata/)
    await expect(backend.followRoomLogs('room1abc')).rejects.toThrow(/ownership metadata/)
    expect(mockedSpawnDocker).not.toHaveBeenCalled()
  })

  it('spawns against the validated immutable container ID, never its reusable name', async () => {
    const id = 'b'.repeat(64)
    mockedRunDocker.mockResolvedValue({ code: 0, stdout: inspectWeb({ id }), stderr: '' })
    const backend = new OciCliBackend()

    await backend.spawnInteractiveExec('room1abc', ['sh', '-li'])
    await backend.followRoomLogs('room1abc', 25)

    expect(mockedSpawnDocker).toHaveBeenNthCalledWith(1, ['exec', '-i', id, 'sh', '-li'])
    expect(mockedSpawnDocker).toHaveBeenNthCalledWith(2, ['logs', '-f', '--tail', '25', id])
  })
})
