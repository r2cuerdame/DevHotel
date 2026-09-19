import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { dockerSpawnCount } from '../backend/dockerBudget'
import { ANCHOR_IMAGE, roomNetworkName, webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import type { WebSpec } from '../backend/types'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeGateway, makeRoom, tempDir, testDb } from './fakes'

/**
 * Real-Docker measurement of the #70 acceptance budget on this host:
 * hotel_status with 20 Rooms (4 awake) and one web Room wake. Opt in with
 * DEVHOTEL_SMOKE=1; it creates and removes its own containers.
 */

const AWAKE_ROOM_IDS = Array.from({ length: 4 }, (_, i) => `bench00${i}`)
const SLEEPING_ROOM_IDS = Array.from({ length: 16 }, (_, i) => `benchs${String(i).padStart(2, '0')}`)
const WAKE_ROOM_ID = 'benchwk1'
const WAKE_SPEC: WebSpec = {
  roomId: WAKE_ROOM_ID,
  internalPort: 3000,
  nodeMajor: '22',
  sourceType: 'empty',
  sourceRef: '',
  workspaceMode: 'empty',
  workspaceVolumeRevision: 0,
  startCommand: `node -e "require('http').createServer((q,s)=>s.end('devhotel-ok')).listen(3000)"`
}

async function cleanup(): Promise<void> {
  await runDocker(['rm', '-f', ...AWAKE_ROOM_IDS.map(webName), webName(WAKE_ROOM_ID), `dh-${WAKE_ROOM_ID}-anchor`])
  await runDocker(['network', 'rm', roomNetworkName(WAKE_ROOM_ID)])
  await runDocker(['volume', 'rm', '-f', `dh-${WAKE_ROOM_ID}-cache`])
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('control-plane Docker budget (real docker)', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  beforeAll(cleanup, 60_000)
  afterAll(cleanup, 60_000)
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function identityDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dh-bench-'))
    dirs.push(dir)
    return dir
  }

  it('answers hotel_status for 20 Rooms with 4 awake within 6 Docker processes and 1.5 s', async () => {
    for (const roomId of AWAKE_ROOM_IDS) {
      const created = await runDocker([
        'run', '-d', '--name', webName(roomId),
        '--label', `devhotel.room=${roomId}`, '--label', 'devhotel.role=web', '--label', 'devhotel.managed=1',
        '--entrypoint', 'sleep', ANCHOR_IMAGE, '600'
      ])
      expect(created.code, created.stderr).toBe(0)
    }
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new OciCliBackend({ identityFile: join(identityDir(), 'engine.json') })
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'bench'
    })
    AWAKE_ROOM_IDS.forEach((id, i) =>
      orch.rooms.create(makeRoom({ id, roomNumber: 500 + i, domain: `${id}.localhost`, status: 'ready' }))
    )
    SLEEPING_ROOM_IDS.forEach((id, i) =>
      orch.rooms.create(makeRoom({ id, roomNumber: 600 + i, domain: `${id}.localhost`, status: 'sleeping', hostPort: null }))
    )

    const warmUp = await orch.hotelStatus()
    const measured = await orch.hotelStatus()
    console.info(
      `hotel_status budget on this host: ${JSON.stringify(measured.budget)} (first call ${JSON.stringify(warmUp.budget)})`
    )

    expect(measured.backend.ok, measured.backend.detail).toBe(true)
    expect(measured.rooms.filter((room) => room.runtimeStatus.state === 'running').map((room) => room.id).sort()).toEqual(
      [...AWAKE_ROOM_IDS].sort()
    )
    expect(measured.rooms.filter((room) => room.runtimeStatus.state === 'stopped')).toHaveLength(16)
    expect(measured.budget.dockerSpawns).toBeLessThanOrEqual(6)
    expect(measured.budget.elapsedMs).toBeLessThan(1500)
  }, 120_000)

  it('wakes one web Room within 20 Docker processes', async () => {
    const dir = identityDir()
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: join(dir, 'legacy-volumes.json'),
      canAdoptLegacyVolume: () => false
    })
    await backend.health()
    await backend.createRoomPod(WAKE_SPEC)
    await backend.stopRoomPod(WAKE_ROOM_ID)

    const before = dockerSpawnCount()
    const startedAt = performance.now()
    const { hostPort } = await backend.recreateAnchor({ roomId: WAKE_ROOM_ID, internalPort: WAKE_SPEC.internalPort })
    await backend.recreateWeb(WAKE_SPEC)
    await backend.relayToken(WAKE_ROOM_ID)
    const webState = await backend.webState(WAKE_ROOM_ID)
    const spawns = dockerSpawnCount() - before
    console.info(`wake budget on this host: ${spawns} docker processes in ${Math.round(performance.now() - startedAt)} ms`)

    expect(hostPort).toBeGreaterThan(0)
    expect(webState).toBe('running')
    // #70 targets at most 20 Docker spawns for wake.
    expect(spawns).toBeLessThanOrEqual(20)
  }, 300_000)
})
