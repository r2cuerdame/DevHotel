import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
})
