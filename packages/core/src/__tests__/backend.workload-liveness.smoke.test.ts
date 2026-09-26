import { afterEach, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { webName, wrapStartCommand } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

/**
 * Issue #160 acceptance against a real engine: a Room web container whose
 * app died while a keeper still holds PID 1's tree open is `degraded`, even
 * though Docker reports it `running` and `docker top` has no STAT column.
 */
const ROOM_ID = 'livenesssmoke'
const WEB = webName(ROOM_ID)
const SERVER = 'node -e "require(\\"http\\").createServer(()=>{}).listen(3000)"'
const DYING = 'node -e "setTimeout(()=>process.exit(1),300)"'

async function cleanup(): Promise<void> {
  await runDocker(['rm', '-f', WEB])
}

async function startWeb(startCommand: string): Promise<void> {
  await cleanup()
  const created = await runDocker([
    'run', '-d', '--init', '--name', WEB,
    '--label', `devhotel.room=${ROOM_ID}`, '--label', 'devhotel.role=web', '--label', 'devhotel.managed=1',
    'node:22-bookworm', 'sh', '-lc', wrapStartCommand(startCommand)
  ])
  if (created.code !== 0) throw new Error(`could not start the test web container: ${created.stderr}`)
  // Long enough for the dying app to exit and the listing to settle.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const status = await runDocker(['inspect', '--format', '{{.State.Status}}', WEB])
  expect(status.stdout.trim()).toBe('running')
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('web workload liveness (real docker)', () => {
  const backend = new OciCliBackend()

  afterEach(async () => {
    await cleanup()
  }, 60_000)

  it('reports a live server as running', async () => {
    await startWeb(SERVER)
    expect(await backend.webState(ROOM_ID)).toBe('running')
  }, 180_000)

  it('reports a dead app under a live `exec sleep infinity` keeper as degraded', async () => {
    await startWeb(`${DYING} & exec sleep infinity`)
    expect(await backend.webState(ROOM_ID)).toBe('degraded')
  }, 180_000)

  it('reports a dead app beside a live `tail -f /dev/null` keeper as degraded', async () => {
    await startWeb(`${DYING} & tail -f /dev/null`)
    expect(await backend.webState(ROOM_ID)).toBe('degraded')
  }, 180_000)

  it('does not let a docker exec process stand in for the dead app', async () => {
    await startWeb(`${DYING} & exec sleep infinity`)
    const exec = await runDocker(['exec', '-d', WEB, 'sleep', '600'])
    expect(exec.code).toBe(0)
    const top = await runDocker(['top', WEB])
    expect(top.stdout).toContain('sleep 600')
    expect(await backend.webState(ROOM_ID)).toBe('degraded')
  }, 180_000)
})
