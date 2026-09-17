import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker, type RunDockerOpts } from '../backend/cli'
import { EXEC_OWNED_PROCESS_REAP_SCRIPT, EXEC_OWNER_ENV, OciCliBackend, execOwnedProcessReapArgs } from '../backend/ociCli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn(), spawnDockerProcess: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const WEB_ID = 'c'.repeat(64)

function inspectWeb(status: 'running' | 'exited' | 'paused' = 'running'): string {
  return JSON.stringify([
    {
      Id: WEB_ID,
      Name: '/dh-room1abc-web',
      Config: { Labels: { 'devhotel.room': 'room1abc', 'devhotel.role': 'web', 'devhotel.managed': '1' } },
      State: { Status: status, Running: status === 'running' }
    }
  ])
}

describe('execInRoom owned guest process group', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dh-exec-cancel-'))
    mockedRunDocker.mockReset()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** Drive the exec through an abort, answering the reap with `reap` and later inspects with `after`. */
  function engine(reap: { code: number; stderr?: string }, after: 'running' | 'exited' | 'paused' = 'running') {
    const calls: { args: string[]; opts?: RunDockerOpts }[] = []
    let execSeen = false
    mockedRunDocker.mockImplementation(async (args, opts) => {
      calls.push({ args, ...(opts ? { opts } : {}) })
      if (args[0] === 'version') {
        return { code: 0, stdout: JSON.stringify({ Client: { Version: '28' }, Server: { Version: '28' } }), stderr: '' }
      }
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'inspect') return { code: 0, stdout: inspectWeb(execSeen ? after : 'running'), stderr: '' }
      if (args[0] === 'exec' && args[2] === 'sh' && args[3] === '-c' && args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT) {
        return { code: reap.code, stdout: '', stderr: reap.stderr ?? '' }
      }
      if (args[0] === 'exec') {
        execSeen = true
        // What runDocker does on timeout/abort: the CLI is gone, cleanup runs, then the call settles.
        await opts?.onAbort?.()
        return { code: -1, stdout: '', stderr: '\ndocker exec timed out after 5000ms' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    return calls
  }

  it('tags every command with a private owner token and reaps exactly that token on abort', async () => {
    const calls = engine({ code: 0 })
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })

    const result = await backend.execInRoom('room1abc', ['sleep', '600'], { timeoutMs: 5_000 })

    expect(result.code).toBe(-1)
    const exec = calls.find((call) => call.args[0] === 'exec' && call.args[1] === '-e')
    expect(exec).toBeDefined()
    const tag = exec!.args[2]!
    expect(tag).toMatch(new RegExp(`^${EXEC_OWNER_ENV}=[0-9a-f-]{36}$`))
    expect(exec!.args.slice(3)).toEqual([WEB_ID, 'sleep', '600'])
    const token = tag.slice(EXEC_OWNER_ENV.length + 1)
    const reap = calls.find((call) => call.args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT)
    expect(reap?.args).toEqual(execOwnedProcessReapArgs(WEB_ID, token))
    // The reap is bounded and never inherits the command's own cancellation.
    expect(reap?.opts).toMatchObject({ timeoutMs: 15_000, maxStdoutBytes: 1024 })
    expect(reap?.opts?.signal).toBeUndefined()
    // Reaped exactly once, and a second command gets a different token.
    expect(calls.filter((call) => call.args[4] === EXEC_OWNED_PROCESS_REAP_SCRIPT)).toHaveLength(1)
    await backend.execInRoom('room1abc', ['true'], { timeoutMs: 5_000 })
    const tags = calls.filter((call) => call.args[0] === 'exec' && call.args[1] === '-e').map((call) => call.args[2])
    expect(new Set(tags).size).toBe(2)
  })

  it('fails the aborted command when tagged guest processes survive in a running container', async () => {
    engine({ code: 1, stderr: 'owned=1 groups=1 left=1' })
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })

    await expect(backend.execInRoom('room1abc', ['sleep', '600'], { timeoutMs: 5_000 })).rejects.toThrow(
      /left owned guest processes running: owned=1 groups=1 left=1/
    )
  })

  it('treats a container that already stopped as reaped', async () => {
    engine({ code: 1, stderr: 'container is not running' }, 'exited')
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })

    await expect(backend.execInRoom('room1abc', ['sleep', '600'], { timeoutMs: 5_000 })).resolves.toMatchObject({
      code: -1
    })
  })

  it('does not treat a paused container as reaped: its frozen tree is still there', async () => {
    engine({ code: 1, stderr: 'container is paused' }, 'paused')
    const backend = new OciCliBackend({ identityFile: join(root, 'engine.json') })

    await expect(backend.execInRoom('room1abc', ['sleep', '600'], { timeoutMs: 5_000 })).rejects.toThrow(
      /left owned guest processes running/
    )
  })

  it('reap script only ever signals processes and groups that carry the token', () => {
    // The script is the whole safety argument for "never targets shared
    // processes"; pin the properties a reviewer would otherwise re-derive.
    expect(EXEC_OWNED_PROCESS_REAP_SCRIPT).toContain(`grep -qxF "${EXEC_OWNER_ENV}=$token"`)
    expect(EXEC_OWNED_PROCESS_REAP_SCRIPT).toContain('[ "$pid" = "1" ] && continue')
    // A group is signalled only when its leader is itself tagged.
    expect(EXEC_OWNED_PROCESS_REAP_SCRIPT).toContain('case " $tagged " in *" $pgrp "*) ;; *) continue ;; esac')
    expect(EXEC_OWNED_PROCESS_REAP_SCRIPT).not.toMatch(/pkill|killall|kill -9 -1|kill -KILL -1/)
    expect(EXEC_OWNED_PROCESS_REAP_SCRIPT.trimEnd().endsWith('[ $left -eq 0 ]')).toBe(true)
  })
})
