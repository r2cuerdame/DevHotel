import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OciCliBackend,
  WEB_STOP_TIMEOUT_SECONDS,
  buildRoomNetworkCreateArgs,
  buildWebCreateArgs,
  roomNetworkName,
  runDocker,
  webName,
  type WebSpec
} from '../src/index'

/**
 * Live acceptance evidence for issue #69 against the local engine: a
 * TERM-aware stock web fixture is created exactly as a Room web container is,
 * then put to sleep through the real `stopRoomPod` ten times. Every cycle must
 * finish well inside the engine's KILL timeout and the fixture must exit
 * because it received TERM (0 from its handler, or 143), never 137.
 */
// Opt-in like the other scripts here: `DEVHOTEL_GRACEFUL_STOP_PROBE=1 pnpm run
// probe:graceful-stop`. It needs a live engine, so the plain test run never
// starts a container.
const ENABLED = process.env['DEVHOTEL_GRACEFUL_STOP_PROBE'] === '1'
const ROOM_ID = `p69${Date.now().toString(36).slice(-5)}`
const CYCLES = 10
const CYCLE_BUDGET_MS = 3_000
const FIXTURE =
  'node -e "process.on(\'SIGTERM\', () => { console.log(\'got TERM\'); setTimeout(() => process.exit(0), 200) }); ' +
  'setInterval(() => {}, 1000); console.log(\'up\')"'

const spec: WebSpec = {
  roomId: ROOM_ID,
  internalPort: 5173,
  nodeMajor: '22',
  sourceType: 'empty',
  sourceRef: '',
  workspaceMode: 'empty',
  workspaceVolumeRevision: 0,
  startCommand: FIXTURE,
  standalone: true,
  noCacheVolume: true
}

async function mustRun(args: string[], what: string): Promise<string> {
  const result = await runDocker(args)
  if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${result.stderr || result.stdout}`)
  return result.stdout
}

async function waitForLog(name: string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await runDocker(['logs', name])
    if (`${result.stdout}${result.stderr}`.includes(needle)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${name} never logged ${JSON.stringify(needle)}`)
}

describe.skipIf(!ENABLED)('graceful Room stop (real engine)', () => {
  beforeAll(async () => {
    await mustRun(buildRoomNetworkCreateArgs(ROOM_ID), 'create probe network')
    await mustRun(buildWebCreateArgs(spec), 'create probe web container')
  })

  afterAll(async () => {
    await runDocker(['rm', '-f', webName(ROOM_ID)])
    await runDocker(['network', 'rm', roomNetworkName(ROOM_ID)])
  })

  it('puts a TERM-aware web fixture to sleep gracefully ten times in a row', async () => {
    const backend = new OciCliBackend()
    const name = webName(ROOM_ID)
    const cycles: Array<{ cycle: number; elapsedMs: number; exitCode: number; sawTerm: boolean }> = []
    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      await mustRun(['start', name], `start probe web (cycle ${cycle})`)
      await waitForLog(name, 'up', 15_000)
      const startedAt = Date.now()
      await backend.stopRoomPod(ROOM_ID)
      const elapsedMs = Date.now() - startedAt
      const inspect = JSON.parse(await mustRun(['inspect', name], 'inspect probe web')) as Array<{
        State: { Status: string; ExitCode: number }
      }>
      const state = inspect[0]!.State
      const logs = await runDocker(['logs', name])
      const sawTerm = `${logs.stdout}${logs.stderr}`.includes('got TERM')
      cycles.push({ cycle, elapsedMs, exitCode: state.ExitCode, sawTerm })
      process.stdout.write(
        `GRACEFUL_STOP_PROBE cycle=${cycle} status=${state.Status} exit=${state.ExitCode} elapsedMs=${elapsedMs} sawTerm=${sawTerm}\n`
      )
      expect(state.Status).toBe('exited')
      expect([0, 143]).toContain(state.ExitCode)
      expect(state.ExitCode).not.toBe(137)
      expect(sawTerm).toBe(true)
      expect(elapsedMs).toBeLessThan(CYCLE_BUDGET_MS)
      expect(elapsedMs).toBeLessThan(WEB_STOP_TIMEOUT_SECONDS * 1000)
    }
    process.stdout.write(`GRACEFUL_STOP_PROBE ${JSON.stringify({ roomId: ROOM_ID, cycles })}\n`)
  }, 120_000)
})
