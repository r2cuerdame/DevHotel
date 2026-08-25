import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

/** A Room an agent is allowed to run commands in. */
function hotelRoom() {
  return makeRoom({ sourceType: 'managed-git', sourceRef: 'https://example.test/demo.git', workspaceMode: 'hotel', syncStatus: 'synced' })
}

function logLines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
}

describe('bounded Room command output', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let orch: RoomOrchestrator

  beforeEach(() => {
    db = testDb()
    userData = tempDir()
    backend = new FakeBackend()
    orch = new RoomOrchestrator({ userData, backend, gateway: new FakeGateway().asGateway(), db, appVersion: 'test' })
    orch.rooms.create(hotelRoom())
  })

  afterEach(() => {
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('returns small output whole, with no artifact and no truncation notice', async () => {
    backend.execResult = { code: 0, stdout: 'v22.14.0\n', stderr: '' }

    const res = await orch.execInRoom('room1abc', ['node', '--version'])

    expect(res.code).toBe(0)
    expect(res.stdout).toBe('v22.14.0')
    expect(res.output.retained).toBe(false)
    expect(res.output.stdout.truncated).toBe(false)
    expect(res.output.notes).toEqual([])
    expect(orch.listRuns('room1abc')).toEqual([])
  })

  it('bounds a large UIAutomator-sized dump and keeps the whole thing retrievable', async () => {
    // 5000 lines ≈ 60KB of XML-ish output, streamed in realistic chunks.
    backend.execChunks = { stdout: Array.from({ length: 50 }, (_, i) => logLines(100, `node${i}`)) }

    const res = await orch.execInRoom('room1abc', ['sh', '-lc', 'uiautomator dump /dev/tty'], {
      output: { maxBytes: 1024 }
    })

    expect(res.output.stdout.lines).toBe(5000)
    expect(res.output.stdout.returnedBytes).toBeLessThanOrEqual(1024)
    expect(res.output.stdout.truncated).toBe(true)
    expect(res.output.retained).toBe(true)
    expect(res.output.notes.join(' ')).toContain(res.output.runId)

    const listed = orch.listRuns('room1abc')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.runId).toBe(res.output.runId)

    const first = orch.readRunOutput('room1abc', res.output.runId, { mode: 'head', maxBytes: 4096 })
    expect(first.text.startsWith('node0 0\n')).toBe(true)
    const found = orch.readRunOutput('room1abc', res.output.runId, { include: '^node49 99$' })
    expect(found.text).toBe('node49 99')
    expect(found.eof).toBe(true)
  })

  it('filters logcat server-side instead of making the agent pipe through grep', async () => {
    backend.execChunks = {
      stdout: [logLines(2000, 'D/chatty'), 'E/AndroidRuntime: FATAL EXCEPTION: main\n', logLines(2000, 'D/chatty2')]
    }

    const res = await orch.execInRoom('room1abc', ['sh', '-lc', 'adb logcat -d'], {
      output: { include: 'FATAL|E/AndroidRuntime', maxBytes: 4096 }
    })

    expect(res.stdout).toBe('E/AndroidRuntime: FATAL EXCEPTION: main')
    expect(res.output.stdout.filtered).toBe(true)
    expect(res.output.stdout.matchedLines).toBe(1)
    expect(res.output.stdout.lines).toBe(4001)
    // The lines the filter removed are not lost: the raw stream is retained.
    expect(res.output.retained).toBe(true)
    const raw = orch.readRunOutput('room1abc', res.output.runId, { include: '^D/chatty2 1999$' })
    expect(raw.text).toBe('D/chatty2 1999')
  })

  it('bounds and retains stdout and stderr separately for a mixed-stream build', async () => {
    backend.execResult = { code: 1, stdout: '', stderr: '' }
    backend.execChunks = { stdout: [logLines(3000, 'out')], stderr: [logLines(3000, 'err')] }

    const res = await orch.execInRoom('room1abc', ['sh', '-lc', './gradlew assembleDebug'], {
      output: { maxBytes: 512 }
    })

    expect(res.code).toBe(1)
    expect(res.stdout.endsWith('out 2999')).toBe(true)
    expect(res.stderr.endsWith('err 2999')).toBe(true)
    expect(res.output.stdout.retained).toBe(true)
    expect(res.output.stderr.retained).toBe(true)
    expect(res.output.notes).toHaveLength(2)

    const err = orch.readRunOutput('room1abc', res.output.runId, { stream: 'stderr', mode: 'head', maxBytes: 512 })
    expect(err.text.startsWith('err 0\n')).toBe(true)
    expect(err.bytes).toBeGreaterThan(20_000)
  })

  it('bounds output from a backend that buffers instead of streaming', async () => {
    backend.execChunks = null
    backend.execResult = { code: 0, stdout: logLines(4000, 'buffered'), stderr: '' }

    const res = await orch.execInRoom('room1abc', ['sh', '-lc', 'cat big.log'], { output: { maxBytes: 512 } })

    expect(res.output.stdout.lines).toBe(4000)
    expect(res.output.stdout.returnedBytes).toBeLessThanOrEqual(512)
    expect(res.output.retained).toBe(true)
  })

  it('rejects an output selection it cannot honour before running anything', async () => {
    await expect(orch.execInRoom('room1abc', ['echo', 'hi'], { output: { maxBytes: 4 } })).rejects.toThrow(/maxBytes/)
    await expect(orch.execInRoom('room1abc', ['echo', 'hi'], { output: { include: '(' } })).rejects.toThrow(
      /valid regular expression/
    )
  })

  it('deletes retained run output together with the Room', async () => {
    backend.execChunks = { stdout: [logLines(3000, 'out')] }
    const res = await orch.execInRoom('room1abc', ['sh', '-lc', 'build'], { output: { maxBytes: 512 } })
    expect(orch.listRuns('room1abc')).toHaveLength(1)

    await orch.deleteRoom('room1abc', 'agent')

    expect(() => orch.listRuns('room1abc')).toThrow()
    expect(() => new RoomOrchestrator({ userData, backend, gateway: new FakeGateway().asGateway(), db, appVersion: 'test' })).not.toThrow()
    expect(res.output.retained).toBe(true)
  })
})
