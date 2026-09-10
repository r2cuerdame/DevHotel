import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import { setupDockerMock, webSpec } from './fakeDockerEngine'

vi.mock('../backend/cli', () => ({
  getPinnedDockerRuntime: vi.fn(() => ({ context: 'test-context' })),
  runDocker: vi.fn()
}))

const mockedRunDocker = vi.mocked(runDocker)
const ENGINE_INFO = JSON.stringify({ ID: 'engine-one', ServerVersion: '28.0.0' })

/**
 * #70 asks for at most 20 Docker processes per wake.
 */
const ISSUE_70_WAKE_TARGET = 20
const WAKE_RECREATE_CEILING = 20

function histogram(calls: string[][]): string {
  const counts = new Map<string, number>()
  for (const args of calls) {
    const key = args.slice(0, args[0] === 'network' || args[0] === 'volume' || args[0] === 'image' ? 2 : 1).join(' ')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}×${count}`)
    .join(', ')
}

describe('Room wake Docker budget', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-wake-budget-'))
    mockedRunDocker.mockReset()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('re-creates the anchor and web of a sleeping hotel Room within the wake budget', async () => {
    setupDockerMock(mockedRunDocker)
    const engine = mockedRunDocker.getMockImplementation()!
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'info') return { code: 0, stdout: ENGINE_INFO, stderr: '' }
      return engine(args, opts)
    })
    const roomId = 'wake0001'
    const spec = webSpec(roomId)
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: join(dir, 'legacy-volumes.json'),
      canAdoptLegacyVolume: () => false
    })
    await backend.health()
    await backend.createRoomPod(spec)
    await backend.stopRoomPod(roomId)
    mockedRunDocker.mockClear()

    // The orchestrator's wake, minus boot polling: fresh anchor, fresh web,
    // route credential, and the first liveness probe of verification.
    await expect(backend.recreateAnchor({ roomId, internalPort: spec.internalPort })).resolves.toEqual({ hostPort: 40001 })
    await backend.recreateWeb(spec)
    await backend.relayToken(roomId)
    await expect(backend.webState(roomId)).resolves.toBe('running')

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    console.info(`recreate wake used ${calls.length} docker processes: ${histogram(calls)}`)
    expect(calls.some(([command]) => command === 'info')).toBe(false)
    expect(calls.length, `wake used ${calls.length} docker processes: ${histogram(calls)}`).toBeLessThanOrEqual(
      WAKE_RECREATE_CEILING
    )
  })

  it('starts the retained anchor and web of a sleeping Room within the #70 wake target', async () => {
    setupDockerMock(mockedRunDocker)
    const engine = mockedRunDocker.getMockImplementation()!
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'info') return { code: 0, stdout: ENGINE_INFO, stderr: '' }
      return engine(args, opts)
    })
    const roomId = 'wake0002'
    const spec = webSpec(roomId)
    const backend = new OciCliBackend({ identityFile: join(dir, 'engine.json') })
    await backend.health()
    await backend.createRoomPod(spec)
    await backend.stopRoomPod(roomId)
    mockedRunDocker.mockClear()

    await expect(backend.startRoomPod(roomId)).resolves.toEqual({ hostPort: 40001 })
    await backend.relayToken(roomId)
    await expect(backend.webState(roomId)).resolves.toBe('running')

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    console.info(`warm wake used ${calls.length} docker processes: ${histogram(calls)}`)
    expect(calls.length, `warm wake used ${calls.length} docker processes: ${histogram(calls)}`).toBeLessThanOrEqual(
      ISSUE_70_WAKE_TARGET
    )
  })
})
