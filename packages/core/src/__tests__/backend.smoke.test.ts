import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import type { WebSpec } from '../backend/types'

const ROOM_ID = 'smoketest1'
const SPEC: WebSpec = {
  roomId: ROOM_ID,
  internalPort: 3000,
  nodeMajor: '22',
  sourceType: 'empty',
  sourceRef: '',
  startCommand: `node -e "require('http').createServer((q,s)=>s.end('devhotel-ok')).listen(3000)"`,
}

async function cleanup(): Promise<void> {
  await runDocker(['rm', '-f', `dh-${ROOM_ID}-web`, `dh-${ROOM_ID}-anchor`])
  await runDocker(['volume', 'rm', '-f', `dh-${ROOM_ID}-src`, `dh-${ROOM_ID}-deps-node22`, `dh-${ROOM_ID}-cache`])
}

async function pollForBody(url: string, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const body = await res.text()
      if (body.includes(expected)) return body
      lastError = `unexpected body: ${body.slice(0, 200)}`
    } catch (err) {
      lastError = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${expected} at ${url}: ${lastError}`)
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('oci backend smoke (real docker)', () => {
  const backend = new OciCliBackend()

  beforeAll(async () => {
    await cleanup()
  }, 120_000)

  afterAll(async () => {
    await cleanup()
  }, 120_000)

  it('reports a healthy docker daemon', async () => {
    const health = await backend.health()
    expect(health.ok, health.detail).toBe(true)
  }, 30_000)

  it(
    'creates, serves, stops, and deletes a room pod',
    async () => {
      const { hostPort } = await backend.createRoomPod(SPEC)
      expect(hostPort).toBeGreaterThan(0)

      const body = await pollForBody(`http://127.0.0.1:${hostPort}/`, 'devhotel-ok', 30_000)
      expect(body).toContain('devhotel-ok')

      expect(await backend.webState(ROOM_ID)).toBe('running')
      const listed = await backend.listManagedContainers()
      const roles = listed.filter((c) => c.roomId === ROOM_ID).map((c) => c.role)
      expect(roles).toContain('anchor')
      expect(roles).toContain('web')

      await backend.stopRoomPod(ROOM_ID)
      expect(await backend.webState(ROOM_ID)).toBe('exited')

      const { reclaimedBytes } = await backend.deleteRoomPod(ROOM_ID, { volumes: true })
      expect(reclaimedBytes).toBeGreaterThanOrEqual(0)
      expect(await backend.webState(ROOM_ID)).toBe('missing')
      const remaining = await backend.listManagedContainers()
      expect(remaining.filter((c) => c.roomId === ROOM_ID)).toEqual([])
    },
    600_000,
  )
})
