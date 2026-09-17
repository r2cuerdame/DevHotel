import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

/**
 * Issue #72 acceptance against a real engine: a `run_in_room` executing
 * `sleep 600` with a 5-second timeout leaves no matching guest process in
 * `docker top` within 5 seconds, and a caller-side abort does the same.
 * The Room's own PID 1 (the "start command") is never touched.
 */
const ROOM_ID = 'execreapsmoke'
const WEB = webName(ROOM_ID)

async function guestProcesses(): Promise<string[]> {
  const top = await runDocker(['top', WEB, '-o', 'pid,args'])
  if (top.code !== 0) throw new Error(`docker top failed: ${top.stderr}`)
  return top.stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean)
}

async function cleanup(): Promise<void> {
  await runDocker(['rm', '-f', WEB])
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('exec owned process group reap (real docker)', () => {
  const backend = new OciCliBackend()

  beforeAll(async () => {
    await cleanup()
    const created = await runDocker([
      'run', '-d', '--name', WEB,
      '--label', `devhotel.room=${ROOM_ID}`, '--label', 'devhotel.role=web', '--label', 'devhotel.managed=1',
      'node:22-bookworm', 'sleep', '3600'
    ])
    if (created.code !== 0) throw new Error(`could not start the test web container: ${created.stderr}`)
  }, 180_000)

  afterAll(async () => {
    await cleanup()
  }, 60_000)

  it('reaps the whole guest process group of a timed-out command within 5 seconds', async () => {
    const started = Date.now()
    // A shell with two children: the group, not just the entry process, must go.
    const result = await backend.execInRoom(ROOM_ID, ['sh', '-c', 'sleep 600 & sleep 600; wait'], { timeoutMs: 5_000 })
    const settledAfterMs = Date.now() - started

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/timed out after 5000ms/)
    expect(settledAfterMs).toBeLessThan(10_000)
    const remaining = await guestProcesses()
    expect(remaining.filter((line) => line.includes('sleep 600'))).toEqual([])
    // The shared process the Room runs on is untouched.
    expect(remaining.some((line) => line.includes('sleep 3600'))).toBe(true)
  }, 60_000)

  it('reaps the guest process group when the caller aborts before the timeout', async () => {
    const cancel = new AbortController()
    const pending = backend.execInRoom(ROOM_ID, ['sleep', '600'], { timeoutMs: 600_000, signal: cancel.signal })
    // Let the exec reach the guest before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect((await guestProcesses()).filter((line) => line.includes('sleep 600'))).toHaveLength(1)

    const aborted = Date.now()
    cancel.abort(new Error('response closed'))
    await expect(pending).rejects.toThrow('response closed')
    expect(Date.now() - aborted).toBeLessThan(5_000)

    const remaining = await guestProcesses()
    expect(remaining.filter((line) => line.includes('sleep 600'))).toEqual([])
    expect(remaining.some((line) => line.includes('sleep 3600'))).toBe(true)
  }, 60_000)
})
