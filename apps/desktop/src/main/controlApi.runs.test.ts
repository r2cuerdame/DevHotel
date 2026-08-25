import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []
const RUN_ID = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function withApi(
  orch: Partial<RoomOrchestrator>,
  fn: (base: string, headers: Record<string, string>) => Promise<void>
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-runs-'))
  roots.push(userData)
  const control = await startControlApi(orch as RoomOrchestrator, userData, 'test')
  try {
    await fn(`http://127.0.0.1:${control.info.port}`, { authorization: `Bearer ${control.info.token}` })
  } finally {
    control.stop()
  }
}

describe('agent control API bounded command output', () => {
  it('forwards the caller output selection to the orchestrator', async () => {
    const execInRoom = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', output: { runId: RUN_ID } }))
    await withApi({ execInRoom } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/rooms/room1abc/exec`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          cmd: ['sh', '-lc', 'adb logcat -d'],
          timeoutMs: 30_000,
          output: { maxBytes: 4096, mode: 'head', include: 'FATAL', ignoreCase: true }
        })
      })
      expect(res.status).toBe(200)
      expect(execInRoom).toHaveBeenCalledWith(
        'room1abc',
        ['sh', '-lc', 'adb logcat -d'],
        { timeoutMs: 30_000, output: { maxBytes: 4096, mode: 'head', include: 'FATAL', ignoreCase: true } },
        'agent'
      )
    })
  })

  it('rejects an output selection the contract does not define', async () => {
    const execInRoom = vi.fn()
    await withApi({ execInRoom } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/rooms/room1abc/exec`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: ['echo'], output: { maxBytes: 4096, shellPipe: 'grep FATAL' } })
      })
      expect(res.status).toBe(500)
      expect(execInRoom).not.toHaveBeenCalled()
    })
  })

  it('lists the Room runs', async () => {
    const listRuns = vi.fn(() => [{ runId: RUN_ID, status: 'running' }])
    await withApi({ listRuns } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/rooms/room1abc/runs`, { headers })
      expect(await res.json()).toEqual({ runs: [{ runId: RUN_ID, status: 'running' }] })
      expect(listRuns).toHaveBeenCalledWith('room1abc')
    })
  })

  it('reads retained output with a typed query, not raw strings', async () => {
    const readRunOutput = vi.fn(() => ({ runId: RUN_ID, text: 'FATAL', eof: true }))
    await withApi({ readRunOutput } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(
        `${base}/v1/rooms/room1abc/runs/${RUN_ID}/output?stream=stderr&offsetBytes=4096&maxBytes=512&mode=head&include=FATAL&ignoreCase=true`,
        { headers }
      )
      expect(res.status).toBe(200)
      expect(readRunOutput).toHaveBeenCalledWith('room1abc', RUN_ID, {
        stream: 'stderr',
        offsetBytes: 4096,
        maxBytes: 512,
        mode: 'head',
        include: 'FATAL',
        ignoreCase: true
      })
    })
  })

  it('refuses a run id that is not a run id', async () => {
    const readRunOutput = vi.fn()
    await withApi({ readRunOutput } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/rooms/room1abc/runs/..%2F..%2Fsecrets/output`, { headers })
      expect(res.status).toBe(500)
      expect(readRunOutput).not.toHaveBeenCalled()
    })
  })
})
