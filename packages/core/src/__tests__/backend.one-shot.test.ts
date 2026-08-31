import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker, type RunDockerOpts } from '../backend/cli'
import type { WebSpec } from '../backend/types'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const CONTAINER_ID = 'a'.repeat(64)
const ok = { code: 0, stdout: '', stderr: '' }

function spec(): WebSpec {
  return {
    roomId: ROOM_ID,
    internalPort: 3000,
    nodeMajor: '22',
    sourceType: 'empty',
    sourceRef: '',
    workspaceMode: 'empty',
    workspaceVolumeRevision: 0,
    startCommand: 'pnpm dev',
    noDepsVolume: true,
    noCacheVolume: true
  }
}

function containerInspect(name: string, state: 'created' | 'running' | 'exited'): string {
  return JSON.stringify([{
    Id: CONTAINER_ID,
    Name: `/${name}`,
    Config: {
      Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'job',
        'devhotel.managed': '1'
      }
    },
    State: { Status: state }
  }])
}

interface OneShotHarness {
  readonly name: string
  readonly exists: boolean
  readonly removedIds: string[]
  readonly startOpts: RunDockerOpts | undefined
}

function installHarness(
  start: (opts: RunDockerOpts, state: { exists: boolean; status: 'created' | 'running' | 'exited' }) => Promise<{
    code: number
    stdout: string
    stderr: string
    outputLimitExceeded?: boolean
  }>
): OneShotHarness {
  let name = ''
  const state: { exists: boolean; status: 'created' | 'running' | 'exited' } = {
    exists: false,
    status: 'created'
  }
  const removedIds: string[] = []
  let startOpts: RunDockerOpts | undefined
  mockedRunDocker.mockImplementation(async (args, opts = {}) => {
    if (args[0] === 'image' && args[1] === 'inspect') return ok
    if (args[0] === 'network' && args[1] === 'inspect') {
      return { code: 1, stdout: '', stderr: 'Error: No such network' }
    }
    if (args[0] === 'network' && args[1] === 'create') return ok
    if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1] ?? ''
      state.exists = true
      state.status = 'created'
      return { code: 0, stdout: `${CONTAINER_ID}\n`, stderr: '' }
    }
    if (args[0] === 'inspect') {
      return state.exists
        ? { code: 0, stdout: containerInspect(name, state.status), stderr: '' }
        : { code: 1, stdout: '', stderr: 'Error: No such container' }
    }
    if (args[0] === 'start') {
      startOpts = opts
      state.status = 'running'
      return start(opts, state)
    }
    if (args[0] === 'rm') {
      removedIds.push(args[2] ?? '')
      state.exists = false
      return ok
    }
    return ok
  })
  return {
    get name() { return name },
    get exists() { return state.exists },
    removedIds,
    get startOpts() { return startOpts }
  }
}

describe('OciCliBackend.runOneShot bounded lifecycle', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('creates an inert UUID job, applies finite default caps, and removes its exact ID after success', async () => {
    const harness = installHarness(async (_opts, state) => {
      state.status = 'exited'
      return { code: 0, stdout: 'done\n', stderr: '' }
    })

    await expect(new OciCliBackend().runOneShot(spec(), 'pnpm build')).resolves.toEqual({
      code: 0,
      stdout: 'done\n',
      stderr: ''
    })

    const create = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')
    expect(create?.[0]).not.toContain('--rm')
    expect(harness.name).toMatch(/^dh-room1abc-job-[a-f0-9]{32}$/)
    expect(harness.startOpts).toMatchObject({
      timeoutMs: 600_000,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024
    })
    expect(harness.removedIds).toEqual([CONTAINER_ID])
    expect(harness.exists).toBe(false)
  })

  it('removes only the canonical lifecycle --rm flag and preserves the command text', async () => {
    installHarness(async (_opts, state) => {
      state.status = 'exited'
      return ok
    })

    await new OciCliBackend().runOneShot(spec(), `printf '%s' --rm`)

    const createArgs = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')?.[0]
    expect(createArgs?.[0]).toBe('create')
    expect(createArgs?.[1]).toBe('--name')
    expect(createArgs?.at(-1)).toContain(`printf '"'"'%s'"'"' --rm`)
  })

  it('preserves outputLimitExceeded and finishes exact cleanup before returning overflow', async () => {
    let cleanupFinishedInsideAbort = false
    const lines: string[] = []
    const harness = installHarness(async (opts, state) => {
      opts.onLine?.('bounded output')
      await opts.onAbort?.()
      cleanupFinishedInsideAbort = !state.exists
      return {
        code: -1,
        stdout: 'x'.repeat(32),
        stderr: 'docker output exceeded its configured safety limit',
        outputLimitExceeded: true
      }
    })

    const result = await new OciCliBackend().runOneShot(
      spec(),
      'pnpm build',
      (line) => lines.push(line),
      { timeoutMs: 900_000, maxStdoutBytes: 32, maxStderrBytes: 64 }
    )

    expect(result).toMatchObject({ code: -1, outputLimitExceeded: true })
    expect(result.stdout).toHaveLength(32)
    expect(lines).toEqual(['bounded output'])
    expect(harness.startOpts).toMatchObject({
      timeoutMs: 900_000,
      maxStdoutBytes: 32,
      maxStderrBytes: 64
    })
    expect(cleanupFinishedInsideAbort).toBe(true)
    expect(harness.removedIds).toEqual([CONTAINER_ID])
    expect(harness.exists).toBe(false)
  })

  it('finishes exact cleanup before returning a timeout result', async () => {
    let cleanupFinishedInsideAbort = false
    const harness = installHarness(async (opts, state) => {
      await opts.onAbort?.()
      cleanupFinishedInsideAbort = !state.exists
      return { code: -1, stdout: '', stderr: 'docker start timed out after 25ms' }
    })

    await expect(new OciCliBackend().runOneShot(
      spec(),
      'pnpm build',
      undefined,
      { timeoutMs: 25 }
    )).resolves.toMatchObject({ code: -1 })

    expect(cleanupFinishedInsideAbort).toBe(true)
    expect(harness.removedIds).toEqual([CONTAINER_ID])
    expect(harness.exists).toBe(false)
  })

  it('rejects invalid caps before touching the container runtime', async () => {
    await expect(new OciCliBackend().runOneShot(
      spec(),
      'pnpm build',
      undefined,
      { maxStdoutBytes: -1 }
    )).rejects.toThrow(/maxStdoutBytes must be a non-negative safe integer/)

    expect(mockedRunDocker).not.toHaveBeenCalled()
  })
})
