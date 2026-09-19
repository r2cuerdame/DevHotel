import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { anchorName, emulatorName, webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import { getProvider } from '../providers'
import { makeRoom } from './fakes'
import { until } from './timing'

/**
 * Issue #77 acceptance against a real engine: SIGKILL a *disposable* managed
 * emulator and prove the classification the wake path relies on.
 *
 * - Before the kill the emulator is `running`.
 * - After `docker kill --signal=KILL` on the emulator container alone, the
 *   backend classifies it `exited` (it is still there, it is still ours, it is
 *   not running) while the Room's web runtime is still `running`. That pair is
 *   what the orchestrator reports as a degraded runtime and what makes the
 *   next wake recreate the emulator instead of reusing it.
 * - The restart is the ordinary wake sequence (`removeEmulator` then
 *   `createEmulator`), after which the emulator is `running` again.
 *
 * Only the throwaway Room below is touched. The smoke never opens a hotel
 * database, so no #61 recovery fence exists here to weaken; the managed
 * inventory outside this Room is snapshotted before and compared after to
 * prove nothing else was killed, removed or created.
 *
 * Gated twice: DEVHOTEL_SMOKE for a real engine, DEVHOTEL_ANDROID_SMOKE
 * because the emulator image is >10GB and needs KVM to do anything useful.
 */
const ROOM_ID = 'emukill01'
const ROOM = makeRoom({
  id: ROOM_ID,
  provider: 'android',
  sourceType: 'empty',
  sourceRef: '',
  workspaceMode: 'empty',
  syncStatus: 'empty',
  runtime: { kind: 'jdk', version: '17' },
  packageManager: { kind: 'gradle' },
  startCommand: '',
  internalPort: 6080,
  domain: 'emukill-dev.localhost',
  android: { device: 'Pixel 6', version: '14.0' }
})
const SPEC = getProvider('android').buildSpec(ROOM)

interface InventoryRow {
  roomId: string
  role: string
  name: string
}

/** Every managed container that is not ours, as identity only: states of live Rooms may change on their own. */
async function othersInventory(backend: OciCliBackend): Promise<InventoryRow[]> {
  return (await backend.listManagedContainers())
    .filter((container) => container.roomId !== ROOM_ID)
    .map(({ roomId, role, name }) => ({ roomId, role, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

async function cleanup(backend: OciCliBackend): Promise<void> {
  await backend.deleteRoomPod(ROOM_ID, { volumes: true }).catch(() => undefined)
  // Belt and braces: nothing that names this Room may outlive the smoke.
  const containers = await runDocker(['ps', '-aq', '--filter', `label=devhotel.room=${ROOM_ID}`])
  const ids = containers.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (ids.length > 0) await runDocker(['rm', '-f', ...ids])
  const networks = await runDocker(['network', 'ls', '-q', '--filter', `name=dh-${ROOM_ID}-`])
  const networkIds = networks.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (networkIds.length > 0) await runDocker(['network', 'rm', ...networkIds])
  const volumes = await runDocker(['volume', 'ls', '-q', '--filter', `name=dh-${ROOM_ID}-`])
  const volumeNames = volumes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (volumeNames.length > 0) await runDocker(['volume', 'rm', '-f', ...volumeNames])
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE || !process.env.DEVHOTEL_ANDROID_SMOKE)(
  'managed emulator SIGKILL → restart classification (real docker)',
  () => {
    const backend = new OciCliBackend()
    let othersBefore: InventoryRow[] = []

    beforeAll(async () => {
      await cleanup(backend)
      othersBefore = await othersInventory(backend)
      const { hostPort } = await backend.createRoomPod(SPEC)
      expect(hostPort).toBeGreaterThan(0)
      await backend.createEmulator(ROOM_ID, ROOM.android, ROOM.os)
    }, 600_000)

    afterAll(async () => {
      await cleanup(backend)
    }, 300_000)

    it('classifies a SIGKILLed emulator as exited beside a running web runtime, and the wake sequence brings it back running', async () => {
      expect(await backend.emulatorState(ROOM_ID)).toBe('running')
      expect(await backend.webState(ROOM_ID)).toBe('running')

      // The kill goes to this one container and nothing else.
      const killed = await runDocker(['kill', '--signal=KILL', emulatorName(ROOM_ID)])
      expect(killed.code, killed.stderr).toBe(0)

      await until(async () => (await backend.emulatorState(ROOM_ID)) === 'exited', {
        timeoutMs: 30_000,
        intervalMs: 250,
        what: 'the killed emulator to be classified as exited'
      })
      // Exited, not missing: the container is retained and still ours.
      const retained = await runDocker(['inspect', '--format', '{{.State.Status}}', emulatorName(ROOM_ID)])
      expect(retained.code).toBe(0)
      expect(retained.stdout.trim()).toBe('exited')
      // Killing the emulator never took the Room's web runtime or anchor with it.
      expect(await backend.webState(ROOM_ID)).toBe('running')
      const anchor = await runDocker(['inspect', '--format', '{{.State.Status}}', anchorName(ROOM_ID)])
      expect(anchor.stdout.trim()).toBe('running')
      const web = await runDocker(['inspect', '--format', '{{.State.Status}}', webName(ROOM_ID)])
      expect(web.stdout.trim()).toBe('running')

      // What the ordinary wake does with an emulator that is not running.
      await backend.removeEmulator(ROOM_ID)
      expect(await backend.emulatorState(ROOM_ID)).toBe('missing')
      await backend.createEmulator(ROOM_ID, ROOM.android, ROOM.os)
      expect(await backend.emulatorState(ROOM_ID)).toBe('running')
      expect(await backend.webState(ROOM_ID)).toBe('running')

      // Nothing outside this disposable Room changed identity.
      expect(await othersInventory(backend)).toEqual(othersBefore)
    }, 600_000)
  }
)
