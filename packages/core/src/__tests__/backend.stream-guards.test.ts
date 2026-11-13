import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker, spawnDockerProcess } from '../backend/cli'
import {
  EXEC_OWNED_PROCESS_REAP_SCRIPT,
  EXEC_OWNER_ENV,
  OciCliBackend,
  execOwnedProcessReapArgs
} from '../backend/ociCli'

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
    // Drift is observed by the next health read; streaming then refuses to
    // start until a fresh identity read proves the pinned engine again.
    await expect(backend.health()).resolves.toMatchObject({ ok: false })

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

    expect(mockedSpawnDocker).toHaveBeenNthCalledWith(1, [
      'exec',
      '-i',
      '-e',
      expect.stringMatching(/^DEVHOTEL_EXEC_TOKEN=[0-9a-f-]{36}$/),
      id,
      'sh',
      '-li'
    ])
    expect(mockedSpawnDocker).toHaveBeenNthCalledWith(2, ['logs', '-f', '--tail', '25', id])
  })

  it('reaps only the closed console session tagged guest process group while keeping sibling consoles and Room services intact', async () => {
    const id = 'd'.repeat(64)
    const runCalls: string[][] = []
    mockedRunDocker.mockImplementation(async (args) => {
      runCalls.push(args)
      if (args[0] === 'inspect') return { code: 0, stdout: inspectWeb({ id }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    const makeInteractiveChild = () => {
      const rawKill = vi.fn(() => true)
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        rawKill,
        kill: rawKill
      }) as unknown as ChildProcessWithoutNullStreams & { rawKill: ReturnType<typeof vi.fn> }
    }

    const childA = makeInteractiveChild()
    const childB = makeInteractiveChild()
    mockedSpawnDocker.mockReturnValueOnce(childA).mockReturnValueOnce(childB)

    const backend = new OciCliBackend()
    const sessionA = await backend.spawnInteractiveExec('room1abc', ['sh', '-li'])
    const sessionB = await backend.spawnInteractiveExec('room1abc', ['sh', '-li'])

    const argsA = mockedSpawnDocker.mock.calls[0]?.[0] ?? []
    const argsB = mockedSpawnDocker.mock.calls[1]?.[0] ?? []
    const tagA = argsA[3] ?? ''
    const tagB = argsB[3] ?? ''
    expect(tagA).toMatch(new RegExp(`^${EXEC_OWNER_ENV}=[0-9a-f-]{36}$`))
    expect(tagB).toMatch(new RegExp(`^${EXEC_OWNER_ENV}=[0-9a-f-]{36}$`))
    const tokenA = tagA.slice(EXEC_OWNER_ENV.length + 1)
    const tokenB = tagB.slice(EXEC_OWNER_ENV.length + 1)
    expect(tokenA).not.toBe(tokenB)

    sessionA.kill()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(childA.stdin.writableEnded).toBe(true)
    expect(childA.rawKill).toHaveBeenCalledTimes(1)
    expect(childB.rawKill).not.toHaveBeenCalled()

    const reaps = runCalls.filter((args) => args[0] === 'exec' && args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT)
    expect(reaps).toEqual([execOwnedProcessReapArgs(id, tokenA)])
    expect(runCalls.some((args) => args[0] === 'stop' || args[0] === 'rm' || args[0] === 'kill')).toBe(false)

    // Repeated kill on the closed session does not trigger a second reap.
    sessionA.kill()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runCalls.filter((args) => args[0] === 'exec' && args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT)).toHaveLength(1)

    // Sibling console remains independent and reaps its own token only when closed.
    sessionB.kill()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runCalls.filter((args) => args[0] === 'exec' && args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT)).toEqual([
      execOwnedProcessReapArgs(id, tokenA),
      execOwnedProcessReapArgs(id, tokenB)
    ])
  })

  it('swallows reap failures after container teardown without leaking an unhandled rejection', async () => {
    const id = 'e'.repeat(64)
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: inspectWeb({ id }), stderr: '' }
      if (args[0] === 'exec' && args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT) {
        return { code: 1, stdout: '', stderr: 'container stopped during teardown' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true)
    }) as unknown as ChildProcessWithoutNullStreams
    mockedSpawnDocker.mockReturnValueOnce(child)

    const backend = new OciCliBackend()
    const session = await backend.spawnInteractiveExec('room1abc', ['sh', '-li'])
    expect(() => session.kill()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 25))
  })

  it('forwards hard output caps and cancellation to production Room exec', async () => {
    const id = 'c'.repeat(64)
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: inspectWeb({ id }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend()
    const controller = new AbortController()
    const onStdout = vi.fn()
    const onStderr = vi.fn()

    await backend.execInRoom('room1abc', ['sh', '-lc', 'bounded'], {
      timeoutMs: 30_000,
      signal: controller.signal,
      maxStdoutBytes: 1234,
      maxStderrBytes: 5678,
      onStdout,
      onStderr
    })

    expect(mockedRunDocker).toHaveBeenCalledWith(
      ['exec', '-e', expect.stringMatching(/^DEVHOTEL_EXEC_TOKEN=[0-9a-f-]{36}$/), id, 'sh', '-lc', 'bounded'],
      {
        timeoutMs: 30_000,
        signal: controller.signal,
        maxStdoutBytes: 1234,
        maxStderrBytes: 5678,
        onStdout,
        onStderr,
        onAbort: expect.any(Function)
      }
    )
  })
})
