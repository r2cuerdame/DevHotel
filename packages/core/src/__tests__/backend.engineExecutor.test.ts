import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { runDocker, spawnDockerProcess, type OciEngineExecutor, type RunDockerOpts } from '../backend/cli'
import { OciCliBackend, hostDockerCliExecutor } from '../backend/ociCli'
import type { ExecResult } from '../backend/types'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn(), spawnDockerProcess: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const mockedSpawn = vi.mocked(spawnDockerProcess)

/**
 * A stand-in for the DevHotel-managed runtime's engine: it reaches a different
 * endpoint by a different route, and knows nothing about a Host Docker CLI.
 * Everything #107 needs from the seam is that the Room code above cannot tell.
 */
function recordingExecutor(
  endpoint: string,
  reply: (args: string[]) => ExecResult = () => ({ code: 0, stdout: '', stderr: '' })
): OciEngineExecutor & { runs: { args: string[]; opts?: RunDockerOpts }[]; spawns: string[][] } {
  const runs: { args: string[]; opts?: RunDockerOpts }[] = []
  const spawns: string[][] = []
  return {
    endpoint,
    runs,
    spawns,
    run: async (args: string[], opts?: RunDockerOpts) => {
      runs.push({ args, ...(opts === undefined ? {} : { opts }) })
      return reply(args)
    },
    spawn: (args: string[]) => {
      spawns.push(args)
      return { pid: 4242 } as unknown as ChildProcessWithoutNullStreams
    }
  }
}

function engineReply(engineId: string) {
  return (args: string[]): ExecResult => {
    if (args[0] === 'version') {
      return {
        code: 0,
        stdout: JSON.stringify({ Client: { Version: '28.0.0' }, Server: { Version: '28.0.0' } }),
        stderr: ''
      }
    }
    if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: engineId }), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

describe('OciCliBackend engine executor seam', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-engine-executor-'))
    mockedRunDocker.mockReset()
    mockedSpawn.mockReset()
    mockedRunDocker.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sends every engine invocation to the injected executor and never to the Host Docker CLI', async () => {
    const engine = recordingExecutor('managed-linux', engineReply('managed-engine'))
    const backend = new OciCliBackend({ engine, identityFile: join(dir, 'engine.json') })

    await expect(backend.health()).resolves.toMatchObject({ ok: true })
    await backend.listManagedContainers()
    await backend.followRoomLogs('r1', 50).catch(() => undefined)

    expect(engine.runs.map(({ args }) => args[0])).toContain('version')
    expect(engine.runs.map(({ args }) => args[0])).toContain('ps')
    expect(mockedRunDocker).not.toHaveBeenCalled()
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('pins the engine identity under the executor endpoint, not a Docker context', async () => {
    const identityFile = join(dir, 'managed-engine.json')
    const engine = recordingExecutor('managed-linux', engineReply('managed-engine'))

    await expect(new OciCliBackend({ engine, identityFile }).health()).resolves.toMatchObject({ ok: true })

    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({
      schema: 1,
      context: 'managed-linux',
      engineId: 'managed-engine'
    })
  })

  it('refuses Room work when the same durable pin is presented a different endpoint', async () => {
    const identityFile = join(dir, 'moved-engine.json')
    await new OciCliBackend({
      engine: recordingExecutor('managed-linux', engineReply('managed-engine')),
      identityFile
    }).health()

    // Same engine ID, different endpoint: the Room's volumes are not reachable
    // through a route DevHotel never recorded, so this must not be adopted.
    const moved = new OciCliBackend({
      engine: recordingExecutor('host-docker-cli', engineReply('managed-engine')),
      identityFile
    })
    await expect(moved.health()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/identity changed/)
    })
  })

  it('defaults to the Host Docker CLI so nothing changes for the compatibility backend', async () => {
    mockedRunDocker.mockImplementation(async (args) => engineReply('host-engine')(args as string[]))
    const backend = new OciCliBackend({ identityFile: join(dir, 'host-engine.json') })

    await expect(backend.health()).resolves.toMatchObject({ ok: true })

    expect(mockedRunDocker).toHaveBeenCalled()
  })

  it('forwards an optionless invocation as an optionless call to the Host CLI', async () => {
    // The seam has to be invisible to anything observing the invocation, and
    // `runDocker(args, undefined)` is not the same call as `runDocker(args)`.
    await hostDockerCliExecutor.run(['inspect', 'dh-r1-web'])
    expect(mockedRunDocker.mock.calls).toEqual([[['inspect', 'dh-r1-web']]])

    await hostDockerCliExecutor.run(['stop', 'dh-r1-web'], { timeoutMs: 5_000 })
    expect(mockedRunDocker.mock.calls.at(-1)).toEqual([['stop', 'dh-r1-web'], { timeoutMs: 5_000 }])
  })

  it('exposes the pinned Host Docker context as the default executor endpoint', () => {
    expect(hostDockerCliExecutor.endpoint).toBe('default')
  })

  it('clones a repository for planning through the executor, with the credential on stdin', async () => {
    const engine = recordingExecutor('managed-linux', engineReply('managed-engine'))
    const backend = new OciCliBackend({ engine })
    const destination = join(dir, 'plan-tree')

    await expect(
      backend.cloneToHostDirectory('https://example.test/app.git', destination, {
        credential: { username: 'x-access-token', secret: 'super-secret' }
      })
    ).resolves.toMatchObject({ code: 0 })

    const clone = engine.runs.at(-1)!
    expect(clone.args).toContain('run')
    expect(clone.args).toContain(`${destination}:/workspace`)
    expect(clone.args.join(' ')).not.toContain('super-secret')
    expect(clone.opts?.input).toBe('x-access-token\nsuper-secret\n')
  })

  it('refuses a relative clone destination rather than resolving it against an unknown cwd', async () => {
    const backend = new OciCliBackend({ engine: recordingExecutor('managed-linux') })
    await expect(backend.cloneToHostDirectory('https://example.test/app.git', 'plan-tree')).rejects.toThrow(
      /absolute Host path/
    )
  })
})
