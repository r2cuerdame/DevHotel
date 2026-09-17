import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepStaleStaging, type StagingSweepReport } from '../lifecycle/stagingSweep'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

describe('startup stale staging sweep', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(userData = tempDir()) {
    if (!roots.includes(userData)) roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({ userData, db, backend, gateway: gateway.asGateway(), appVersion: 'test' })
    orch.rooms.create(
      makeRoom({
        status: 'ready',
        sourceType: 'managed-git',
        sourceRef: 'https://example.invalid/demo.git',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        hostSyncEnabled: false
      })
    )
    return { userData, backend, gateway, orch }
  }

  function leftover(userData: string, name: string, file = 'file.bin'): string {
    const dir = join(userData, 'tmp', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), 'left behind by a process that died before its finally')
    return dir
  }

  it('sweeps every crash-leftover family at startup and reports the result', async () => {
    const { userData, backend, orch } = setup()
    const stale = [
      leftover(userData, 'pull-a1b2c3d4'),
      leftover(userData, 'push-a1b2c3d4'),
      leftover(userData, 'device-adb-Ab12cd', '000.apk'),
      leftover(userData, 'android-sealed-install-Ab12cd', 'installed.apk')
    ]

    const result = await orch.init()

    for (const dir of stale) expect(existsSync(dir), dir).toBe(false)
    expect(orch.startupStatus()).toMatchObject({
      state: 'ready',
      stagingSweep: { rootOk: true, removed: 4, retained: 0, failed: 0 }
    })
    // Unrelated Room reconciliation still ran after the sweep.
    expect(result.reconciled).not.toBeNull()
    expect(backend.calls).toContain('stopRoomPod:room1abc')
  })

  it('retains a stage that is live in this process and reclaims it only after that process is gone', async () => {
    const { userData, backend, orch } = setup()
    let release!: () => void
    const entered = new Promise<void>((resolveEntered) => {
      backend.copyFromRoomHook = () => {
        resolveEntered()
        return new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    const pulling = orch.pullRoomFile('room1abc', '/workspace/README.md')
    await entered
    const liveDirs = readdirSync(join(userData, 'tmp')).filter((name) => name.startsWith('pull-'))
    expect(liveDirs).toHaveLength(1)
    const liveDir = join(userData, 'tmp', liveDirs[0]!)

    // A repeated startup in the same process must not pull the rug out.
    await orch.init()
    expect(existsSync(liveDir)).toBe(true)
    expect(orch.startupStatus().stagingSweep).toEqual({ rootOk: true, removed: 0, retained: 1, failed: 0 })

    // The process "dies" here: the pull never finishes, so its finally never runs.
    const restarted = setup(userData)
    await restarted.orch.init()
    expect(existsSync(liveDir)).toBe(false)
    expect(restarted.orch.startupStatus().stagingSweep).toEqual({ rootOk: true, removed: 1, retained: 0, failed: 0 })

    // The abandoned pull's stage is gone; letting it run to its finally only
    // fails the dead operation, it never resurrects the directory.
    release()
    await expect(pulling).rejects.toThrow()
    expect(existsSync(liveDir)).toBe(false)
  })

  it('cleans up its own stage on the normal path so nothing is left for the sweep', async () => {
    const { userData, orch } = setup()
    await orch.pullRoomFile('room1abc', '/workspace/README.md')
    await orch.pushRoomFile('room1abc', '/workspace/pushed.txt', Buffer.from('pushed').toString('base64'))
    expect(readdirSync(join(userData, 'tmp'))).toEqual([])

    await orch.init()
    expect(orch.startupStatus().stagingSweep).toEqual({ rootOk: true, removed: 0, retained: 0, failed: 0 })
  })

  it('is idempotent across repeated startups and never traverses a junction', async () => {
    const { userData, orch } = setup()
    const outside = tempDir()
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'keep')
    mkdirSync(join(userData, 'tmp'), { recursive: true })
    symlinkSync(outside, join(userData, 'tmp', 'pull-junction'), 'junction')
    leftover(userData, 'push-a1b2c3d4')

    await orch.init()
    expect(orch.startupStatus().stagingSweep).toEqual({ rootOk: true, removed: 1, retained: 1, failed: 0 })
    await orch.init()
    expect(orch.startupStatus().stagingSweep).toEqual({ rootOk: true, removed: 0, retained: 1, failed: 0 })

    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(join(userData, 'tmp'))).toEqual(['pull-junction'])
  })

  it('reports a stage it cannot remove without blocking Room reconciliation', async () => {
    const { userData, backend, orch } = setup()
    const stuck = leftover(userData, 'pull-stuckkk1')
    const file = join(stuck, 'file.bin')
    leftover(userData, 'pull-removab1')
    // libuv clears the read-only attribute before unlinking on Windows and
    // Node opens files with delete sharing, so a genuinely stuck handle cannot
    // be staged portably; drive the same orchestrator path through the seam.
    const orchAny = orch as unknown as {
      liveStaging: Set<string>
      sweepStaleStagingDirectories: () => StagingSweepReport
    }
    orchAny.sweepStaleStagingDirectories = () =>
      sweepStaleStaging(userData, {
        live: orchAny.liveStaging,
        unlink: (path) => {
          if (path === file) throw new Error('EBUSY: resource busy or locked')
          unlinkSync(path)
        }
      })

    const result = await orch.init()

    expect(result.backendOk).toBe(true)
    expect(result.reconciled).not.toBeNull()
    expect(backend.calls).toContain('stopRoomPod:room1abc')
    expect(orch.startupStatus()).toMatchObject({
      state: 'ready',
      stagingSweep: { rootOk: true, removed: 1, retained: 0, failed: 1 }
    })
    expect(existsSync(file)).toBe(true)
  })

  it('reports an unsafe temporary root and still reconciles Rooms', async () => {
    const { userData, backend, orch } = setup()
    const outside = tempDir()
    roots.push(outside)
    mkdirSync(join(outside, 'pull-a1b2c3d4'))
    writeFileSync(join(outside, 'pull-a1b2c3d4', 'file.bin'), 'keep')
    symlinkSync(outside, join(userData, 'tmp'), 'junction')

    const result = await orch.init()

    expect(result.reconciled).not.toBeNull()
    expect(backend.calls).toContain('stopRoomPod:room1abc')
    expect(orch.startupStatus().stagingSweep).toEqual({ rootOk: false, removed: 0, retained: 0, failed: 0 })
    expect(readFileSync(join(outside, 'pull-a1b2c3d4', 'file.bin'), 'utf8')).toBe('keep')
  })
})
