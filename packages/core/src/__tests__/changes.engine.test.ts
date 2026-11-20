import { existsSync, readdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeEngine } from '../changes/engine'
import { registerQuickChanges } from '../changes/definitions/index'
import { androidRunChange } from '../changes/definitions/androidRun'
import { ANDROID_SNAPSHOT_CLEAN_SCRIPT, cleanupAndroidBuildArtifacts } from '../changes/definitions/androidBuild'
import { packageInstallCommand } from '../changes/definitions/packageInstall'
import {
  backupServiceToFile,
  pingService,
  restoreServiceFromFile,
  serviceRemoveChange
} from '../changes/definitions/services'
import { SERVICE_DB_USER } from '../backend/naming'
import { NOTHING_TO_NORMALIZE } from '../changes/definitions/lineEndings'
import {
  LINE_ENDING_NORMALIZE_SCRIPT,
  LINE_ENDING_SCAN_SCRIPT,
  SCAN_SENTINEL,
  launcherScanScript
} from '../checks/lineEndings'
import type { ChangeCtx, ChangeDefinition } from '../changes/types'
import { changesRepo, type ChangesRepo } from '../store/changesRepo'
import { roomsRepo, type RoomsRepo } from '../store/roomsRepo'
import { settingsRepo, type SettingsRepo } from '../store/settingsRepo'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'

let engine: ChangeEngine
let backend: FakeBackend
let gateway: FakeGateway
let rooms: RoomsRepo
let changes: ChangesRepo
let settings: SettingsRepo
let port: { port: number; close: () => void }

function ctx(roomId = 'room1abc'): ChangeCtx {
  return {
    roomId,
    backend,
    gateway: gateway.asGateway(),
    rooms,
    changes,
    settings,
    userData: tempDir(),
    log: () => undefined,
    room: () => rooms.get(roomId)!,
    webSpec: (overrides) => {
      const r = rooms.get(roomId)!
      const gen = Number(settings.get(`depsGen:${roomId}:node${r.runtime.version}`) ?? '0')
      return {
        roomId,
        internalPort: r.internalPort,
        nodeMajor: r.runtime.version,
        sourceType: r.sourceType,
        sourceRef: r.sourceRef,
        workspaceMode: r.workspaceMode,
        workspaceVolumeRevision: r.workspaceVolumeRevision,
        startCommand: r.startCommand,
        env: {},
        depsVolumeOverride: gen > 0 ? `dh-${roomId}-deps-node${r.runtime.version}-g${gen}` : undefined,
        ...overrides
      }
    },
    isAwake: () => {
      const s = rooms.get(roomId)!.status
      return s === 'running' || s === 'ready' || s === 'attention'
    },
    syncRoute: async () => {
      const r = rooms.get(roomId)!
      if (r.hostPort != null) {
        await gateway.setRoute({ domain: r.domain, roomId, targetPort: r.hostPort, https: r.https })
      }
    },
    installTrackedAndroidArtifact: async () => {
      throw new Error('tracked Android artifact installer was not configured for this test')
    },
    removeTrackedAndroidInstall: () => undefined,
    removeTrackedAndroidInstalls: () => undefined
  }
}

beforeEach(async () => {
  const db = testDb()
  engine = new ChangeEngine()
  registerQuickChanges(engine)
  backend = new FakeBackend()
  gateway = new FakeGateway()
  rooms = roomsRepo(db)
  changes = changesRepo(db)
  settings = settingsRepo(db)
  port = await listeningPort()
  rooms.create(makeRoom({ hostPort: port.port }))
})

afterEach(() => {
  port.close()
})

describe('node-version change', () => {
  it('installs deps for the new major, recreates web, verifies, and journals', async () => {
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.title).toBe('Node 22 → 24')
    expect(rooms.get('room1abc')!.runtime.version).toBe('24')
    expect(backend.calls.some((c) => c.startsWith('runOneShot'))).toBe(true)
    expect(backend.calls).toContain('recreateWeb:room1abc:node24:default')
    expect(changes.lastUndoable('room1abc')?.id).toBe(entry.id)
  })

  it('keeps a failed-verify change applied (no auto-rollback) and undo restores the old version', async () => {
    backend.webStateValue = 'exited'
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('applied')
    expect(entry.verify?.ok).toBe(false)
    expect(rooms.get('room1abc')!.runtime.version).toBe('24')

    backend.webStateValue = 'running'
    const undoEntry = await engine.undo(ctx(), entry.id, 'user')
    expect(undoEntry.title).toBe('Undo: Node 22 → 24')
    expect(rooms.get('room1abc')!.runtime.version).toBe('22')
    expect(changes.get(entry.id)!.status).toBe('undone')
    expect(backend.calls.filter((c) => c.startsWith('recreateWeb'))).toHaveLength(2)
  })

  it('rolls back when the new major dependency install fails during apply', async () => {
    backend.oneShotResult = { code: 1, stdout: '', stderr: 'EBADENGINE unsupported' }
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('rolled-back')
    expect(rooms.get('room1abc')!.runtime.version).toBe('22')
  })

  it('rejects a no-op version in preflight without journaling', async () => {
    await expect(engine.execute(ctx(), 'node-version', { version: '22' }, 'user')).rejects.toThrow(/already uses/)
    expect(changes.list('room1abc')).toHaveLength(0)
  })
})

describe('Android emulator changes', () => {
  it('android-run refuses to start while the emulator container is not running', async () => {
    rooms.update('room1abc', {
      provider: 'android',
      workspaceMode: 'hotel',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/android.git',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      hostPort: 45000
    })
    backend.emulatorStateValue = 'missing'

    await expect(engine.execute(ctx(), 'android-run', {}, 'user')).rejects.toThrow(/emulator is not running/)
    expect(changes.list('room1abc')).toHaveLength(0)
  })

  it('retries tracked foreground verification while an emulator app is still starting', async () => {
    let foregroundProbes = 0
    backend.execInRoomHandler = () => { throw new Error('verification must not rescan mutable build metadata') }

    const changeCtx = ctx()
    changeCtx.isTrackedAndroidAppForeground = async () => {
      foregroundProbes += 1
      return foregroundProbes >= 3
    }

    vi.useFakeTimers()
    try {
      const verifying = androidRunChange.verify(
        changeCtx,
        {},
        { applicationId: 'com.example.app' },
        { id: 'verify-delayed-emulator-app', createdAt: '2026-08-30T00:00:00.000Z' }
      )
      for (let turn = 0; foregroundProbes === 0 && turn < 20; turn++) await Promise.resolve()
      expect(foregroundProbes).toBe(1)

      await vi.advanceTimersByTimeAsync(4_000)

      await expect(verifying).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Room emulator') })
      expect(foregroundProbes).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emulator-config swaps the emulator container and undo restores the previous device', async () => {
    rooms.update('room1abc', {
      provider: 'android',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      hostPort: 45000,
      android: { device: 'Samsung Galaxy S10', version: '14.0' }
    })

    const entry = await engine.execute(
      ctx(),
      'emulator-config',
      { device: 'Pixel 6', version: '15.0', resolution: 'fast', orientation: 'landscape' },
      'user'
    )
    expect(entry.status).toBe('verified')
    expect(rooms.get('room1abc')!.android).toEqual({
      device: 'Pixel 6',
      version: '15.0',
      resolution: 'fast',
      orientation: 'landscape'
    })
    expect(backend.calls).toContain('removeEmulator:room1abc')
    expect(backend.calls).toContain('createEmulator:room1abc:Pixel 6:15.0')

    await engine.undo(ctx(), entry.id, 'user')
    expect(rooms.get('room1abc')!.android).toEqual({ device: 'Samsung Galaxy S10', version: '14.0' })
    expect(backend.calls).toContain('createEmulator:room1abc:Samsung Galaxy S10:14.0')
  })
})

describe('change crash durability', () => {
  it('persists steps and captured safety data before apply completes', async () => {
    let entered!: () => void
    let release!: () => void
    const enteredApply = new Promise<void>((resolve) => {
      entered = resolve
    })
    const holdApply = new Promise<void>((resolve) => {
      release = resolve
    })
    engine.register({
      kind: 'durable-capture-test',
      plan: () => ({
        title: 'Durable capture',
        component: 'Test',
        before: null,
        after: null,
        undoable: true,
        undoStrategy: 'restore-file',
        autoRollback: false
      }),
      async apply(_changeCtx, _params, steps) {
        steps.push('Safety backup written')
        steps.setCaptured({ backupFile: 'room-backup.sql' })
        entered()
        await holdApply
      },
      async verify() {
        return { ok: true, detail: 'done' }
      }
    } satisfies ChangeDefinition<Record<string, never>>)

    const task = engine.execute(ctx(), 'durable-capture-test', {}, 'user')
    await enteredApply
    const pending = changes.list('room1abc')[0]!
    expect(pending.status).toBe('pending')
    expect(pending.steps).toEqual(['Safety backup written'])
    expect(pending.captured).toEqual({ backupFile: 'room-backup.sql' })

    release()
    await expect(task).resolves.toMatchObject({ status: 'verified' })
  })

  it('persists a bounded failed verification when a generic verifier rejects', async () => {
    engine.register({
      kind: 'verify-throws-test',
      plan: () => ({
        title: 'Throwing verifier',
        component: 'Test',
        before: null,
        after: null,
        undoable: false,
        undoStrategy: 'none',
        autoRollback: false
      }),
      async apply(_changeCtx, _params, steps) {
        steps.push('Applied before verification')
      },
      async verify() {
        throw new Error('token=super-secret C:\\Users\\private\\backend.exe --raw-argument')
      }
    } satisfies ChangeDefinition<Record<string, never>>)

    const entry = await engine.execute(ctx(), 'verify-throws-test', {}, 'user')

    expect(entry).toMatchObject({
      status: 'applied',
      steps: ['Applied before verification'],
      verify: { ok: false, detail: 'Verification could not complete because its probe failed unexpectedly.' }
    })
    expect(JSON.stringify(entry.verify)).not.toMatch(/super-secret|Users|backend\.exe|raw-argument/i)
    expect(changes.get(entry.id)).toMatchObject({ status: 'applied', verify: { ok: false } })
  })

  it('sends a rejected verifier through the normal automatic rollback path', async () => {
    let undone = false
    engine.register({
      kind: 'verify-throws-rollback-test',
      plan: () => ({
        title: 'Rollback throwing verifier',
        component: 'Test',
        before: null,
        after: null,
        undoable: true,
        undoStrategy: 'restore-test-state',
        autoRollback: true
      }),
      async apply() {},
      async verify() {
        throw new Error('private verifier failure')
      },
      async undo() {
        undone = true
      }
    } satisfies ChangeDefinition<Record<string, never>>)

    const entry = await engine.execute(ctx(), 'verify-throws-rollback-test', {}, 'user')

    expect(undone).toBe(true)
    expect(entry).toMatchObject({ status: 'rolled-back', verify: { ok: false } })
  })
})

describe('domain change', () => {
  it('applies, routes, verifies against the gateway table', async () => {
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    expect(entry.status).toBe('verified')
    expect(gateway.routes.has('renamed.localhost')).toBe(true)
    expect(gateway.routes.has('demo-dev.localhost')).toBe(false)
  })

  it('auto-rolls back when routing fails', async () => {
    gateway.failNextSetRoute = true
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    expect(entry.status).toBe('rolled-back')
    expect(rooms.get('room1abc')!.domain).toBe('demo-dev.localhost')
    expect(gateway.routes.has('demo-dev.localhost')).toBe(true)
  })

  it('preflights against a taken domain', async () => {
    rooms.create(makeRoom({ id: 'room2def', domain: 'taken.localhost', roomNumber: 202 }))
    await expect(engine.execute(ctx(), 'domain', { domain: 'taken.localhost' }, 'user')).rejects.toThrow(/already used/)
  })
})

describe('deps clean reinstall', () => {
  it('installs into a fresh generation volume and undo swaps back', async () => {
    const entry = await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    expect(entry.status).toBe('verified')
    expect(settings.get('depsGen:room1abc:node22')).toBe('1')
    expect(backend.calls).toContain('resetVolume:dh-room1abc-deps-node22-g1')
    expect(backend.calls).toContain('runOneShot:dh-room1abc-deps-node22-g1:pnpm install')
    expect(backend.calls).toContain('recreateWeb:room1abc:node22:dh-room1abc-deps-node22-g1')

    await engine.undo(ctx(), entry.id, 'user')
    expect(settings.get('depsGen:room1abc:node22')).toBe('0')
  })

  it('never recycles an undone generation volume', async () => {
    const first = await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    await engine.undo(ctx(), first.id, 'user')
    await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    expect(settings.get('depsGen:room1abc:node22')).toBe('2')
    expect(backend.calls).toContain('resetVolume:dh-room1abc-deps-node22-g2')
  })

  it('refuses to undo a clean reinstall after the room switched node majors', async () => {
    const entry = await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/Node 22/)
  })

  it('plain install is honestly non-undoable', async () => {
    const entry = await engine.execute(ctx(), 'deps-install', { clean: false }, 'agent')
    expect(entry.undoable).toBe(false)
    expect(entry.actor).toBe('agent')
    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/cannot be undone/)
  })
})

describe('sleeping rooms', () => {
  it('records changes without touching the backend and defers verification', async () => {
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })
    const entry = await engine.execute(ctx(), 'start-command', { command: 'pnpm start' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toMatch(/next wake/)
    expect(backend.calls.filter((c) => c.startsWith('recreateWeb'))).toHaveLength(0)
    expect(rooms.get('room1abc')!.startCommand).toBe('pnpm start')
  })
})

describe('services', () => {
  it('rejects service versions outside the supported catalog before changing Room state', async () => {
    await expect(
      engine.execute(ctx(), 'service-add', { service: 'postgres', version: 'latest' }, 'user')
    ).rejects.toThrow(/Unsupported PostgreSQL version/)
    expect(rooms.get('room1abc')!.services.postgres).toBeUndefined()
    expect(changes.list('room1abc')).toHaveLength(0)
  })

  it('adds postgres, verifies it answers, and undo removes it with its volume', async () => {
    const entry = await engine.execute(ctx(), 'service-add', { service: 'postgres' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.title).toBe('PostgreSQL 17 added')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(backend.calls).toContain('createService:postgres:17')

    await engine.undo(ctx(), entry.id, 'user')
    expect(rooms.get('room1abc')!.services.postgres).toBeUndefined()
    expect(backend.calls).toContain('removeService:postgres:with-volume')
  })

  it('remove captures a safety backup and undo restores service plus data', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    expect(entry.status).toBe('verified')
    const captured = entry.captured as { backupFile: string | null; version: string }
    expect(captured.version).toBe('8')
    expect(captured.backupFile).toMatch(/redis-.*\.rdb$/)

    await engine.undo(ctx(), entry.id, 'user')
    expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '8' })
    expect(backend.calls).toContain('copyToService:redis:/data/dump.rdb')
  })

  it('remove refuses a sleeping room before any backup or volume deletion', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })
    backend.calls.length = 0

    await expect(engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')).rejects.toThrow(
      /Start the room and its Redis app before removing it/
    )
    expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '8' })
    expect(backend.calls.some((call) => call.startsWith('removeService:redis'))).toBe(false)
    expect(changes.list('room1abc').filter((c) => c.kind === 'service-remove')).toHaveLength(0)
  })

  it('remove refuses a stopped service container before any volume deletion', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'postgres' }, 'user')
    backend.serviceStates.set('postgres', 'exited')
    backend.calls.length = 0

    await expect(engine.execute(ctx(), 'service-remove', { service: 'postgres' }, 'user')).rejects.toThrow(
      /Start the room and its PostgreSQL app before removing it/
    )
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(backend.serviceStates.get('postgres')).toBe('exited')
    expect(backend.calls.some((call) => call.startsWith('removeService:postgres'))).toBe(false)
    expect(changes.list('room1abc').filter((c) => c.kind === 'service-remove')).toHaveLength(0)
  })

  it('remove refuses a missing service container instead of deleting its volume', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'missing')

    await expect(engine.execute(ctx(), 'service-remove', { service: 'postgres' }, 'user')).rejects.toThrow(
      /Start the room and its PostgreSQL app before removing it/
    )
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(backend.calls.some((call) => call.startsWith('removeService:postgres'))).toBe(false)
  })

  it('remove aborts with the service intact when the safety backup fails', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    backend.execInService = async (_roomId, svc, cmd) => {
      backend.calls.push(`execInService:${svc}:${cmd[0]}`)
      return { code: 1, stdout: '', stderr: 'MISCONF disk full' }
    }
    backend.calls.length = 0

    await expect(engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')).rejects.toThrow(
      /redis SAVE failed.*disk full/
    )
    expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '8' })
    expect(backend.serviceStates.get('redis')).toBe('running')
    expect(backend.calls.some((call) => call.startsWith('removeService:redis'))).toBe(false)
    expect(changes.list('room1abc').filter((c) => c.kind === 'service-remove')).toHaveLength(0)
  })

  describe('Redis SAVE reply', () => {
    function scriptRedis(replies: { save: string[]; bgsave?: string[] }) {
      const original = backend.execInService.bind(backend)
      const saves = [...replies.save]
      const bgsave = [...(replies.bgsave ?? [])]
      backend.execInService = async (roomId, svc, cmd) => {
        if (svc === 'redis' && cmd[0] === 'redis-cli' && cmd[1] === 'save') {
          backend.calls.push('redis:save')
          return { code: 0, stdout: `${saves.shift() ?? 'OK'}\n`, stderr: '' }
        }
        if (svc === 'redis' && cmd[0] === 'redis-cli' && cmd[1] === 'info') {
          backend.calls.push('redis:info')
          return { code: 0, stdout: `# Persistence\r\nrdb_bgsave_in_progress:${bgsave.shift() ?? '0'}\r\n`, stderr: '' }
        }
        return original(roomId, svc, cmd)
      }
    }

    function backupFiles(): string[] {
      const dir = joinPath(ctxUserData, 'rooms', 'room1abc', 'backups')
      return existsSync(dir) ? readdirSync(dir) : []
    }

    let ctxUserData: string
    function redisCtx(): ChangeCtx {
      return { ...ctx(), userData: ctxUserData }
    }

    beforeEach(() => {
      ctxUserData = tempDir()
      rooms.update('room1abc', { services: { redis: { version: '8' } } })
      backend.serviceStates.set('redis', 'running')
      backend.calls.length = 0
    })

    it('waits out a background save and copies the file only after a fresh SAVE answers OK', async () => {
      scriptRedis({ save: ['ERR Background save already in progress', 'OK'], bgsave: ['1', '0'] })

      const file = await backupServiceToFile(redisCtx(), 'redis')

      expect(file).toMatch(/redis-.*\.rdb$/)
      const redisCalls = backend.calls.filter((c) => c.startsWith('redis:') || c.startsWith('copyFromService:redis'))
      expect(redisCalls).toEqual([
        'redis:save',
        'redis:info',
        'redis:info',
        'redis:save',
        'copyFromService:redis:/data/dump.rdb'
      ])
      expect(backupFiles()).toHaveLength(1)
    })

    it('fails with the Redis reason and leaves no backup when SAVE is refused with exit code 0', async () => {
      scriptRedis({ save: ['MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk'] })

      await expect(backupServiceToFile(redisCtx(), 'redis')).rejects.toThrow(/redis SAVE failed: MISCONF .*not able to persist/)
      expect(backend.calls.some((c) => c.startsWith('copyFromService:redis'))).toBe(false)
      expect(backupFiles()).toEqual([])
    })

    it('room reset stops before deleting Redis data when SAVE is refused', async () => {
      scriptRedis({ save: ['MISCONF disk error'] })
      rooms.update('room1abc', { sourceType: 'managed-git', sourceRef: 'https://example.test/repo.git', workspaceMode: 'hotel' })

      await expect(
        engine.execute(
          redisCtx(),
          'room-reset',
          { reinstallDependencies: false, clearCaches: false, services: 'empty', clearBrowserData: false },
          'user'
        )
      ).rejects.toThrow(/redis SAVE failed: MISCONF disk error/)
      expect(backend.calls.some((c) => c.startsWith('removeService:redis'))).toBe(false)
      expect(backend.serviceStates.get('redis')).toBe('running')
      expect(backupFiles()).toEqual([])
    })

    it('version switch stops before deleting Redis data when SAVE is refused', async () => {
      scriptRedis({ save: ['ERR something went wrong'] })

      const outcome = await engine
        .execute(redisCtx(), 'service-version', { service: 'redis', version: '7' }, 'user')
        .then((entry) => entry.verify?.detail ?? entry.status, (err: Error) => err.message)

      expect(outcome).toMatch(/redis SAVE failed: ERR something went wrong/)
      expect(backend.calls.some((c) => c.startsWith('removeService:redis'))).toBe(false)
      expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '8' })
      expect(backupFiles()).toEqual([])
    })
  })

  it('remove verify names the preserved safety backup', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    const captured = entry.captured as { backupFile: string }
    const { basename } = await import('node:path')
    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toContain(basename(captured.backupFile))
  })

  it('remove only rolls back an apply failure when a safety backup was captured', () => {
    const guard = serviceRemoveChange.canRollbackApplyFailure!
    expect(guard(ctx(), { service: 'redis' }, null)).toBe(false)
    expect(guard(ctx(), { service: 'redis' }, { version: '8', backupFile: null })).toBe(false)
    expect(guard(ctx(), { service: 'redis' }, { version: '8', backupFile: '/backups/redis-x.rdb' })).toBe(true)
  })

  it('remove undo refuses to recreate an empty service when the safety backup is missing', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    const captured = entry.captured as { backupFile: string; version: string }
    const { rmSync } = await import('node:fs')
    rmSync(captured.backupFile)
    backend.calls.length = 0

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/safety backup.*missing/i)
    expect(rooms.get('room1abc')!.services.redis).toBeUndefined()
    expect(backend.calls.some((call) => call.startsWith('createService:redis'))).toBe(false)
    expect(changes.get(entry.id)!.status).toBe('verified')
  })

  it('remove undo refuses a change whose record lost its safety backup', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    changes.setStatus(entry.id, 'verified', { captured: { version: '8', backupFile: null } })
    backend.calls.length = 0

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/safety backup.*missing/i)
    expect(rooms.get('room1abc')!.services.redis).toBeUndefined()
    expect(backend.calls.some((call) => call.startsWith('createService:redis'))).toBe(false)
  })

  it('remove undo refuses a sleeping room instead of deferring an empty service to next wake', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })
    backend.calls.length = 0

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/Wake the room first/)
    expect(rooms.get('room1abc')!.services.redis).toBeUndefined()
    expect(backend.calls).toHaveLength(0)
  })

  it('db-backup produces a non-empty dump file', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'postgres' }, 'user')
    const c = ctx()
    const entry = await engine.execute(c, 'db-backup', { service: 'postgres' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toMatch(/postgres-.*\.sql/)
  })

  it('does not touch the intact service or volume when a version-change backup fails before capture', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
    backend.execInServiceToFile = async (_roomId, svc, cmd) => {
      backend.calls.push(`execInServiceToFile:${svc}:${cmd[0]}`)
      return { code: 1, stdout: '', stderr: 'disk full before a backup existed' }
    }

    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toMatch(/pg_dump failed.*disk full/)
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(backend.serviceStates.get('postgres')).toBe('running')
    expect(backend.calls.some((call) => call.startsWith('removeService:postgres'))).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('createService:postgres'))).toBe(false)
  })

  it('rejects unsupported service upgrades before backup or recreation', async () => {
    rooms.update('room1abc', { services: { redis: { version: '7' } } })
    backend.serviceStates.set('redis', 'running')
    await expect(
      engine.execute(ctx(), 'service-version', { service: 'redis', version: 'latest' }, 'user')
    ).rejects.toThrow(/Unsupported Redis version/)
    expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '7' })
    expect(backend.calls.some((call) => call.startsWith('removeService:redis'))).toBe(false)
  })

  it('still restores the captured backup when a version change fails after destructive work begins', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
    const createService = backend.createService.bind(backend)
    backend.createService = async (roomId, svc, version) => {
      if (version === '17') {
        backend.calls.push(`createService:${svc}:${version}`)
        throw new Error('new image failed to start')
      }
      await createService(roomId, svc, version)
    }

    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('rolled-back')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(backend.calls).toContain('createService:postgres:16')
    expect(backend.calls).toContain('execInServiceFromFile:postgres:psql')
    expect(entry.captured).toMatchObject({ prevVersion: '16', backupFile: expect.stringMatching(/postgres-.*\.sql$/) })
  })
})

describe('PostgreSQL version direction', () => {
  function touchedPostgres(): boolean {
    return backend.calls.some((call) =>
      call.startsWith('removeService:postgres') ||
      call.startsWith('createService:postgres') ||
      call.startsWith('execInServiceToFile:postgres') ||
      call.startsWith('execInServiceFromFile:postgres') ||
      call === 'execInService:postgres:psql'
    )
  }

  async function roomBackup(changeCtx: ChangeCtx, header: string): Promise<string> {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(changeCtx.userData, 'rooms', 'room1abc', 'backups')
    mkdirSync(dir, { recursive: true })
    const backupId = 'postgres-2026-11-01T10-00-00-0a1b2c3d.sql'
    writeFileSync(join(dir, backupId), `${header}SET statement_timeout = 0;\nCREATE TABLE t();\n`)
    return backupId
  }

  function dumpHeader(major: string): string {
    return [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '',
      `-- Dumped from database version ${major} (Debian ${major}-1.pgdg120+1)`,
      `-- Dumped by pg_dump version ${major} (Debian ${major}-1.pgdg120+1)`,
      '',
      ''
    ].join('\n')
  }

  beforeEach(() => {
    backend.serviceStates.set('postgres', 'running')
  })

  it('refuses switching PostgreSQL to an older major before backing up or deleting its data', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '17' } } })

    await expect(
      engine.execute(ctx(), 'service-version', { service: 'postgres', version: '16' }, 'user')
    ).rejects.toThrow(/PostgreSQL 17 cannot be switched down to 16/)

    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(backend.serviceStates.get('postgres')).toBe('running')
    expect(touchedPostgres()).toBe(false)
    expect(changes.list('room1abc').filter((c) => c.kind === 'service-version')).toHaveLength(0)
  })

  it('still upgrades PostgreSQL 16 to 17', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })

    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('verified')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(backend.calls).toContain('createService:postgres:17')
    expect(backend.calls).toContain('execInServiceFromFile:postgres:psql')
  })

  it('keeps Redis version switches in both directions', async () => {
    rooms.update('room1abc', { services: { redis: { version: '8' } } })
    backend.serviceStates.set('redis', 'running')

    const entry = await engine.execute(ctx(), 'service-version', { service: 'redis', version: '7' }, 'user')

    expect(entry.status).toBe('verified')
    expect(rooms.get('room1abc')!.services.redis).toEqual({ version: '7' })
  })

  it('refuses restoring a backup dumped by a newer PostgreSQL before the safety backup or drop', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    const changeCtx = ctx()
    const backupId = await roomBackup(changeCtx, dumpHeader('17.2'))

    await expect(
      engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId }, 'user')
    ).rejects.toThrow(/made on PostgreSQL 17 and cannot be restored into PostgreSQL 16/)

    expect(touchedPostgres()).toBe(false)
    expect(changes.list('room1abc').filter((c) => c.kind === 'db-restore')).toHaveLength(0)
  })

  it.each([
    ['the same major', dumpHeader('16.4')],
    ['an older major', dumpHeader('15.8')],
    ['no version header', '-- hand written dump\n']
  ])('restores a backup with %s', async (_label, header) => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    const changeCtx = ctx()
    const backupId = await roomBackup(changeCtx, header)

    const entry = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId }, 'user')

    expect(entry.status).toBe('verified')
    expect(backend.calls).toContain('execInServiceToFile:postgres:pg_dump')
    expect(backend.calls).toContain('execInServiceFromFile:postgres:psql')
  })
})

describe('PostgreSQL readiness after a fresh create', () => {
  const BOOTSTRAP_MS = 1_000
  const interrupted = { code: 2, stdout: '', stderr: 'FATAL: terminating connection due to administrator command' }

  function simulateInitServerOnCreate() {
    const events: string[] = []
    let bootstrapUntil = 0
    const bootstrapping = () => Date.now() < bootstrapUntil
    const create = backend.createService.bind(backend)
    backend.createService = async (roomId, svc, version) => {
      await create(roomId, svc, version)
      if (svc === 'postgres') bootstrapUntil = Date.now() + BOOTSTRAP_MS
    }
    const exec = backend.execInService.bind(backend)
    backend.execInService = async (roomId, svc, cmd) => {
      if (svc === 'postgres' && cmd[0] === 'pg_isready') {
        backend.calls.push(`execInService:${svc}:${cmd[0]}`)
        const overTcp = cmd.includes('-h')
        if (bootstrapping() && overTcp) {
          events.push('probe:no-response')
          return { code: 2, stdout: '127.0.0.1:5432 - no response', stderr: '' }
        }
        events.push(bootstrapping() ? 'probe:init-server' : 'probe:real-server')
        return { code: 0, stdout: 'accepting connections', stderr: '' }
      }
      if (svc === 'postgres' && cmd[0] === 'psql') {
        events.push(bootstrapping() ? 'psql:interrupted' : 'psql')
        if (bootstrapping()) {
          backend.calls.push(`execInService:${svc}:${cmd[0]}`)
          return interrupted
        }
      }
      return exec(roomId, svc, cmd)
    }
    const execFromFile = backend.execInServiceFromFile.bind(backend)
    backend.execInServiceFromFile = async (roomId, svc, cmd) => {
      events.push(bootstrapping() ? 'restore:interrupted' : 'restore')
      if (bootstrapping()) {
        backend.calls.push(`execInServiceFromFile:${svc}:${cmd[0]}`)
        return interrupted
      }
      return execFromFile(roomId, svc, cmd)
    }
    return { events }
  }

  function recordProbes(): string[][] {
    const probes: string[][] = []
    const exec = backend.execInService.bind(backend)
    backend.execInService = async (roomId, svc, cmd) => {
      if (cmd[0] === 'pg_isready' || cmd[0] === 'redis-cli') probes.push([svc, ...cmd])
      return exec(roomId, svc, cmd)
    }
    return probes
  }

  beforeEach(() => {
    backend.serviceStates.set('postgres', 'running')
  })

  it('probes PostgreSQL over TCP so the socket-only init server does not count as ready', async () => {
    const probes = recordProbes()

    await expect(pingService(ctx(), 'postgres')).resolves.toEqual({
      ok: true,
      detail: 'PostgreSQL answering on its in-room port'
    })
    expect(probes).toEqual([['postgres', 'pg_isready', '-h', '127.0.0.1', '-U', SERVICE_DB_USER]])
  })

  it('keeps the Redis probe and its result unchanged', async () => {
    backend.serviceStates.set('redis', 'running')
    const probes = recordProbes()

    await expect(pingService(ctx(), 'redis')).resolves.toEqual({
      ok: true,
      detail: 'Redis answering on its in-room port'
    })
    expect(probes).toEqual([['redis', 'redis-cli', 'ping']])
  })

  it('upgrades PostgreSQL 16 to 17 only after the init server hands over to the real server', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    const { events } = simulateInitServerOnCreate()

    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('verified')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(events[0]).toBe('probe:no-response')
    expect(events).not.toContain('probe:init-server')
    expect(events.filter((e) => e.endsWith(':interrupted'))).toEqual([])
    expect(events.indexOf('probe:real-server')).toBeLessThan(events.indexOf('psql'))
    expect(events).toContain('restore')
  })

  it('shows the socket-only probe passing during the init server and the restore then being cut off', async () => {
    const { events } = simulateInitServerOnCreate()
    const changeCtx = ctx()
    await backend.createService('room1abc', 'postgres', '17')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(changeCtx.userData, { recursive: true })
    const backupFile = join(changeCtx.userData, 'postgres-before-fix.sql')
    writeFileSync(backupFile, 'CREATE TABLE t();\n')

    const socketProbe = await backend.execInService('room1abc', 'postgres', ['pg_isready', '-U', SERVICE_DB_USER])
    expect(socketProbe.code).toBe(0)
    await expect(restoreServiceFromFile(changeCtx, 'postgres', backupFile)).rejects.toThrow(
      /database reset failed.*terminating connection/
    )
    expect(events).toEqual(['probe:init-server', 'psql:interrupted'])
  })
})

describe('undo verification follows the reverted target', () => {
  function androidEmulatorRoom(): void {
    rooms.update('room1abc', {
      provider: 'android',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      hostPort: 45000,
      android: { device: 'Samsung Galaxy S10', version: '14.0' }
    })
  }

  it('records an emulator-config undo as failed when the restored emulator is unhealthy', async () => {
    androidEmulatorRoom()
    const entry = await engine.execute(ctx(), 'emulator-config', { device: 'Pixel 6', version: '15.0' }, 'user')
    expect(entry.status).toBe('verified')
    backend.createEmulator = async () => {
      backend.emulatorStateValue = 'degraded'
    }

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toMatchObject({ kind: 'undo', status: 'applied', verify: { ok: false, detail: 'emulator container degraded' } })
    expect(changes.get(entry.id)!.status).toBe('undone')
  })

  it('verifies an emulator-config undo by the emulator rather than the build container', async () => {
    androidEmulatorRoom()
    const entry = await engine.execute(ctx(), 'emulator-config', { device: 'Pixel 6', version: '15.0' }, 'user')
    backend.webStateValue = 'exited'

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true, detail: expect.stringContaining('emulator container running') } })
  })

  it('fails a domain undo whose restored route is missing from the gateway', async () => {
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    const undoCtx = ctx()
    undoCtx.syncRoute = async () => undefined

    const undone = await engine.undo(undoCtx, entry.id, 'user')

    expect(rooms.get('room1abc')!.domain).toBe('demo-dev.localhost')
    expect(undone).toMatchObject({
      status: 'applied',
      verify: { ok: false, detail: 'demo-dev.localhost missing from the gateway routing table' }
    })
  })

  it('verifies a domain undo from the gateway without waiting on a stopped web process', async () => {
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    backend.webStateValue = 'exited'

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true, detail: 'demo-dev.localhost routed by the local gateway' } })
    expect(gateway.routes.has('renamed.localhost')).toBe(false)
  })

  it('fails an https undo while the gateway still routes the room via TLS', async () => {
    const entry = await engine.execute(ctx(), 'https', { enabled: true }, 'user')
    expect(gateway.routes.get('demo-dev.localhost')?.https).toBe(true)
    const undoCtx = ctx()
    undoCtx.syncRoute = async () => undefined

    const undone = await engine.undo(undoCtx, entry.id, 'user')

    expect(rooms.get('room1abc')!.https).toBe(false)
    expect(undone).toMatchObject({ status: 'applied', verify: { ok: false, detail: 'gateway still routes the room via TLS' } })
  })

  it('verifies an https undo against the plain route it restored', async () => {
    const entry = await engine.execute(ctx(), 'https', { enabled: true }, 'user')

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(gateway.routes.get('demo-dev.localhost')?.https).toBe(false)
    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true, detail: 'http://demo-dev.localhost routed without TLS' } })
  })

  it('fails a service-add undo whose container survived removal', async () => {
    const entry = await engine.execute(ctx(), 'service-add', { service: 'postgres' }, 'user')
    backend.removeService = async (_roomId, svc, opts) => {
      backend.calls.push(`removeService:${svc}:${opts.volume ? 'with-volume' : 'keep-volume'}`)
    }

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(rooms.get('room1abc')!.services.postgres).toBeUndefined()
    expect(undone).toMatchObject({ status: 'applied', verify: { ok: false, detail: 'PostgreSQL container still exists' } })
  })

  it('verifies a service-add undo by the removed service, not the web process', async () => {
    const entry = await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    backend.webStateValue = 'exited'

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true, detail: 'Redis removed with its data volume' } })
  })

  it('fails a service-remove undo whose restored service does not come back', async () => {
    await engine.execute(ctx(), 'service-add', { service: 'redis' }, 'user')
    const entry = await engine.execute(ctx(), 'service-remove', { service: 'redis' }, 'user')
    backend.startService = async (_roomId, svc) => {
      backend.calls.push(`startService:${svc}`)
      backend.serviceStates.set(svc, 'missing')
    }

    const undone = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toMatchObject({ status: 'applied', verify: { ok: false, detail: 'Redis container missing' } })
  })

  it('verifies service-version and db-restore undos with the service probe', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
    const changeCtx = ctx()
    const version = await engine.execute(changeCtx, 'service-version', { service: 'postgres', version: '17' }, 'user')
    backend.webStateValue = 'exited'

    const versionUndo = await engine.undo(changeCtx, version.id, 'user')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(versionUndo).toMatchObject({ status: 'verified', verify: { ok: true, detail: expect.stringContaining('PostgreSQL answering') } })

    const restore = await restorePostgresFromBackup(changeCtx)
    const restoreUndo = await engine.undo(changeCtx, restore.id, 'user')
    expect(restoreUndo).toMatchObject({ status: 'verified', verify: { ok: true, detail: expect.stringContaining('PostgreSQL answering') } })
  })

  it('completes the undo record without leaking a rejected verifier error', async () => {
    let undone = false
    engine.register({
      kind: 'verify-undo-throws-test',
      plan: () => ({
        title: 'Throwing undo verifier',
        component: 'Test',
        before: { value: 1 },
        after: { value: 2 },
        undoable: true,
        undoStrategy: 'restore-test-state',
        autoRollback: false
      }),
      async apply() {},
      async verify() {
        return { ok: true, detail: 'applied' }
      },
      async undo() {
        undone = true
      },
      async verifyUndo() {
        throw new Error('token=super-secret C:\\Users\\private\\backend.exe --raw-argument')
      }
    } satisfies ChangeDefinition<Record<string, never>>)
    const entry = await engine.execute(ctx(), 'verify-undo-throws-test', {}, 'user')

    const undoEntry = await engine.undo(ctx(), entry.id, 'user')

    expect(undone).toBe(true)
    expect(undoEntry).toMatchObject({
      kind: 'undo',
      title: 'Undo: Throwing undo verifier',
      status: 'applied',
      verify: { ok: false, detail: 'Verification could not complete because its probe failed unexpectedly.' }
    })
    expect(JSON.stringify(changes.list('room1abc'))).not.toMatch(/super-secret|Users|backend\.exe|raw-argument/i)
    expect(changes.get(entry.id)).toMatchObject({ status: 'undone', undoneAt: expect.any(String) })
    expect(changes.list('room1abc').filter((c) => c.kind === 'undo')).toHaveLength(1)
  })
})

async function restorePostgresFromBackup(changeCtx: ChangeCtx) {
  await engine.execute(changeCtx, 'db-backup', { service: 'postgres' }, 'user')
  const { readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const backupId = readdirSync(join(changeCtx.userData, 'rooms', 'room1abc', 'backups'))
    .filter((name) => name.startsWith('postgres-') && name.endsWith('.sql'))
    .sort()
    .at(-1)!
  const entry = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId }, 'user')
  expect(entry.status).toBe('verified')
  return entry
}

const DROP_DEVHOTEL = 'DROP DATABASE IF EXISTS devhotel WITH (FORCE);'
const CREATE_DEVHOTEL = 'CREATE DATABASE devhotel;'
const RESTORE_FROM_FILE = 'restore-from-file'

function appConnectedToPostgres(): string[] {
  const trace: string[] = []
  const exec = backend.execInService.bind(backend)
  backend.execInService = async (roomId, svc, cmd) => {
    const sql = cmd[cmd.length - 2] === '-c' ? cmd[cmd.length - 1]! : ''
    if (svc === 'postgres' && sql) trace.push(sql)
    if (svc === 'postgres' && sql.startsWith('DROP DATABASE') && !sql.includes('WITH (FORCE)')) {
      backend.calls.push(`execInService:${svc}:${cmd[0]}`)
      return {
        code: 1,
        stdout: '',
        stderr: 'ERROR:  database "devhotel" is being accessed by other users\nDETAIL:  There is 1 other session using the database.'
      }
    }
    return exec(roomId, svc, cmd)
  }
  const restore = backend.execInServiceFromFile.bind(backend)
  backend.execInServiceFromFile = async (roomId, svc, cmd) => {
    if (svc === 'postgres') trace.push(RESTORE_FROM_FILE)
    return restore(roomId, svc, cmd)
  }
  return trace
}

function resetSequences(trace: string[]): string[][] {
  const sequences: string[][] = []
  for (const [index, step] of trace.entries()) {
    if (step.startsWith('DROP DATABASE')) sequences.push(trace.slice(index, index + 3))
  }
  return sequences
}

describe('service data restore while the room app holds a database connection', () => {
  beforeEach(() => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
  })

  it('restores a backup and undoes that restore by force-dropping the connected database', async () => {
    const trace = appConnectedToPostgres()
    const changeCtx = ctx()

    const restore = await restorePostgresFromBackup(changeCtx)
    const undone = await engine.undo(changeCtx, restore.id, 'user')

    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true } })
    expect(changes.get(restore.id)!.status).toBe('undone')
    expect(resetSequences(trace)).toEqual([
      [DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE],
      [DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE]
    ])
  })

  it('switches the PostgreSQL version and back while the app stays connected', async () => {
    const trace = appConnectedToPostgres()
    const changeCtx = ctx()

    const version = await engine.execute(changeCtx, 'service-version', { service: 'postgres', version: '17' }, 'user')
    expect(version.status).toBe('verified')
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })

    const undone = await engine.undo(changeCtx, version.id, 'user')
    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true } })
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(resetSequences(trace)).toHaveLength(2)
  })

  it('rolls a failed version switch back to the previous version and its data while the app is connected', async () => {
    const trace = appConnectedToPostgres()
    const restore = backend.execInServiceFromFile.bind(backend)
    let restores = 0
    backend.execInServiceFromFile = async (roomId, svc, cmd) => {
      restores += 1
      if (restores === 1) {
        backend.calls.push(`execInServiceFromFile:${svc}:${cmd[0]}`)
        trace.push(RESTORE_FROM_FILE)
        return { code: 3, stdout: '', stderr: 'ERROR:  type "legacy_money" does not exist' }
      }
      return restore(roomId, svc, cmd)
    }

    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('rolled-back')
    expect(entry.verify?.detail).toMatch(/psql restore failed.*legacy_money/)
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(backend.calls.indexOf('createService:postgres:17')).toBeLessThan(backend.calls.indexOf('createService:postgres:16'))
    expect(restores).toBe(2)
    expect(resetSequences(trace)).toEqual([
      [DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE],
      [DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE]
    ])
  })

  it('brings a removed PostgreSQL back from its safety backup while the app is connected', async () => {
    const trace = appConnectedToPostgres()
    const changeCtx = ctx()
    const removed = await engine.execute(changeCtx, 'service-remove', { service: 'postgres' }, 'user')
    expect(removed.status).toBe('verified')

    const undone = await engine.undo(changeCtx, removed.id, 'user')

    expect(undone).toMatchObject({ status: 'verified', verify: { ok: true } })
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
    expect(resetSequences(trace)).toEqual([[DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE]])
  })

  it('stops before recreating or loading data when the database still cannot be dropped', async () => {
    const trace: string[] = []
    backend.execInService = async (_roomId, svc, cmd) => {
      backend.calls.push(`execInService:${svc}:${cmd[0]}`)
      trace.push(cmd[cmd.length - 1]!)
      return { code: 1, stdout: '', stderr: 'ERROR:  must be owner of database devhotel' }
    }
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const file = join(tempDir(), 'postgres-dump.sql')
    writeFileSync(file, 'CREATE TABLE t();')

    await expect(restoreServiceFromFile(ctx(), 'postgres', file)).rejects.toThrow(/database reset failed: .*must be owner/)
    expect(trace).toEqual([DROP_DEVHOTEL])
    expect(backend.calls.some((call) => call.startsWith('execInServiceFromFile:'))).toBe(false)
  })
})

describe('service data replacement pauses the room app', () => {
  async function postgresBackupId(changeCtx: ChangeCtx): Promise<string> {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(changeCtx.userData, 'rooms', 'room1abc', 'backups')
    mkdirSync(dir, { recursive: true })
    const backupId = 'postgres-2026-11-01T10-00-00-0a1b2c3d.sql'
    writeFileSync(join(dir, backupId), 'CREATE TABLE t();\n')
    return backupId
  }

  function pauseCalls(): string[] {
    return backend.calls.filter((call) => call === 'pauseWeb:room1abc' || call === 'unpauseWeb:room1abc')
  }

  beforeEach(() => {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
  })

  it('pauses the app after the safety backup and before the drop, and resumes it after the restore', async () => {
    const trace = appConnectedToPostgres()
    const changeCtx = ctx()
    const backupId = await postgresBackupId(changeCtx)

    const entry = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId }, 'user')

    expect(entry.status).toBe('verified')
    expect(trace).toEqual([DROP_DEVHOTEL, CREATE_DEVHOTEL, RESTORE_FROM_FILE])
    const calls = backend.calls
    const pause = calls.indexOf('pauseWeb:room1abc')
    const firstSqlAfterPause = calls.indexOf('execInService:postgres:psql', pause)
    expect(calls.indexOf('execInServiceToFile:postgres:pg_dump')).toBeLessThan(pause)
    expect(pause).toBeGreaterThanOrEqual(0)
    expect(calls.slice(0, pause)).not.toContain('execInService:postgres:psql')
    expect(firstSqlAfterPause).toBeGreaterThan(pause)
    expect(calls.indexOf('execInServiceFromFile:postgres:psql')).toBeGreaterThan(firstSqlAfterPause)
    expect(calls.indexOf('unpauseWeb:room1abc')).toBeGreaterThan(calls.indexOf('execInServiceFromFile:postgres:psql'))
    expect(pauseCalls()).toEqual(['pauseWeb:room1abc', 'unpauseWeb:room1abc'])
    expect(backend.webPausedValue).toBe(false)
  })

  it('pauses the app before removing the old PostgreSQL and resumes it after loading the data into the new one', async () => {
    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(entry.status).toBe('verified')
    const calls = backend.calls
    const pause = calls.indexOf('pauseWeb:room1abc')
    expect(pause).toBeGreaterThan(calls.indexOf('execInServiceToFile:postgres:pg_dump'))
    expect(pause).toBeLessThan(calls.indexOf('removeService:postgres:with-volume'))
    expect(calls.indexOf('unpauseWeb:room1abc')).toBeGreaterThan(calls.lastIndexOf('execInServiceFromFile:postgres:psql'))
    expect(pauseCalls()).toEqual(['pauseWeb:room1abc', 'unpauseWeb:room1abc'])
  })

  it('pauses the app for the undo of a restore, a version switch and a removal', async () => {
    const changeCtx = ctx()
    const version = await engine.execute(changeCtx, 'service-version', { service: 'postgres', version: '17' }, 'user')
    backend.calls.length = 0
    await engine.undo(changeCtx, version.id, 'user')
    expect(backend.calls.indexOf('pauseWeb:room1abc')).toBeLessThan(backend.calls.indexOf('removeService:postgres:with-volume'))
    expect(backend.calls.indexOf('unpauseWeb:room1abc')).toBeGreaterThan(backend.calls.indexOf('execInServiceFromFile:postgres:psql'))

    const restore = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId: await postgresBackupId(changeCtx) }, 'user')
    backend.calls.length = 0
    await engine.undo(changeCtx, restore.id, 'user')
    expect(pauseCalls()).toEqual(['pauseWeb:room1abc', 'unpauseWeb:room1abc'])
    expect(backend.calls.indexOf('pauseWeb:room1abc')).toBeLessThan(backend.calls.indexOf('execInService:postgres:psql'))

    const removed = await engine.execute(changeCtx, 'service-remove', { service: 'postgres' }, 'user')
    backend.calls.length = 0
    await engine.undo(changeCtx, removed.id, 'user')
    expect(backend.calls.indexOf('pauseWeb:room1abc')).toBeLessThan(backend.calls.indexOf('removeService:postgres:keep-volume'))
    expect(backend.calls.indexOf('unpauseWeb:room1abc')).toBeGreaterThan(backend.calls.indexOf('execInServiceFromFile:postgres:psql'))
    expect(backend.webPausedValue).toBe(false)
  })

  it('resumes the app when the restore fails and again around the automatic rollback', async () => {
    const restore = backend.execInServiceFromFile.bind(backend)
    let restores = 0
    backend.execInServiceFromFile = async (roomId, svc, cmd) => {
      restores += 1
      if (restores === 1) {
        backend.calls.push(`execInServiceFromFile:${svc}:${cmd[0]}`)
        return { code: 3, stdout: '', stderr: 'ERROR:  relation "users" already exists' }
      }
      return restore(roomId, svc, cmd)
    }
    const changeCtx = ctx()

    const entry = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId: await postgresBackupId(changeCtx) }, 'user')

    expect(entry.status).toBe('rolled-back')
    expect(restores).toBe(2)
    expect(pauseCalls()).toEqual(['pauseWeb:room1abc', 'unpauseWeb:room1abc', 'pauseWeb:room1abc', 'unpauseWeb:room1abc'])
    expect(backend.webPausedValue).toBe(false)
  })

  it('recreates the app when it cannot be resumed and keeps the restore result', async () => {
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('container is not paused')
    }
    const changeCtx = ctx()

    const entry = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId: await postgresBackupId(changeCtx) }, 'user')

    expect(entry.status).toBe('verified')
    const recreate = backend.calls.findIndex((call) => call.startsWith('recreateWeb:room1abc:'))
    expect(recreate).toBeGreaterThan(backend.calls.indexOf('unpauseWeb:room1abc'))
    expect(backend.webPausedValue).toBe(false)
  })

  it('reports the restore, resume and recreate errors together when the app cannot come back', async () => {
    const { withWebPaused } = await import('../changes/definitions/services')
    backend.unpauseWeb = async () => {
      throw new Error('container is not paused')
    }
    backend.recreateWeb = async () => {
      throw new Error('image missing')
    }

    const error = await withWebPaused(ctx(), async () => {
      throw new Error('psql restore failed')
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'psql restore failed',
      'container is not paused',
      'image missing'
    ])
  })

  it('stops before dropping or removing anything when the app cannot be paused', async () => {
    const trace = appConnectedToPostgres()
    backend.pauseWeb = async (roomId) => {
      backend.calls.push(`pauseWeb:${roomId}`)
      throw new Error('cgroup freezer unavailable')
    }
    const changeCtx = ctx()

    const restore = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId: await postgresBackupId(changeCtx) }, 'user')
    expect(restore.status).toBe('failed')
    expect(restore.verify?.detail).toMatch(/Could not pause the Room app.*cgroup freezer unavailable/)
    expect(trace).toEqual([])

    const version = await engine.execute(changeCtx, 'service-version', { service: 'postgres', version: '17' }, 'user')
    expect(version.status).toBe('failed')
    expect(backend.calls.some((call) => call.startsWith('removeService:postgres'))).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('execInServiceFromFile:'))).toBe(false)
    expect(backend.calls).not.toContain('unpauseWeb:room1abc')
    expect(trace).toEqual([])
    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '16' })
  })

  it.each([
    ['stopped', () => { backend.webStateValue = 'exited' }],
    ['already paused', () => { backend.webPausedValue = true }]
  ])('leaves a %s app as it was', async (_label, arrange) => {
    arrange()
    const pausedBefore = backend.webPausedValue
    const changeCtx = ctx()

    const restore = await engine.execute(changeCtx, 'db-restore', { service: 'postgres', backupId: await postgresBackupId(changeCtx) }, 'user')
    const version = await engine.execute(changeCtx, 'service-version', { service: 'postgres', version: '17' }, 'user')

    expect(restore.status).toBe('verified')
    expect(version.status).toBe('verified')
    expect(pauseCalls()).toEqual([])
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
    expect(backend.webPausedValue).toBe(pausedBefore)
  })

  it('pauses the app around a Redis restore', async () => {
    rooms.update('room1abc', { services: { redis: { version: '8' } } })
    backend.serviceStates.set('redis', 'running')

    const entry = await engine.execute(ctx(), 'service-version', { service: 'redis', version: '7' }, 'user')

    expect(entry.status).toBe('verified')
    expect(backend.calls.indexOf('pauseWeb:room1abc')).toBeLessThan(backend.calls.indexOf('removeService:redis:with-volume'))
    expect(backend.calls.indexOf('unpauseWeb:room1abc')).toBeGreaterThan(backend.calls.lastIndexOf('copyToService:redis:/data/dump.rdb'))
    expect(pauseCalls()).toEqual(['pauseWeb:room1abc', 'unpauseWeb:room1abc'])
  })
})

describe('Redis restore keeps the service running when the copy fails', () => {
  async function rdbFile(): Promise<string> {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const file = join(tempDir(), 'redis-dump.rdb')
    writeFileSync(file, 'fake-rdb')
    return file
  }

  beforeEach(() => {
    rooms.update('room1abc', { services: { redis: { version: '8' } } })
    backend.serviceStates.set('redis', 'running')
    backend.copyToService = async (_roomId, svc, _hostPath, containerPath) => {
      backend.calls.push(`copyToService:${svc}:${containerPath}`)
      throw new Error('no space left on device')
    }
  })

  it('starts Redis again and reports the copy error', async () => {
    await expect(restoreServiceFromFile(ctx(), 'redis', await rdbFile())).rejects.toThrow('no space left on device')

    expect(backend.calls).toEqual(['stopService:redis', 'copyToService:redis:/data/dump.rdb', 'startService:redis'])
    expect(backend.serviceStates.get('redis')).toBe('running')
  })

  it('keeps the copy error when Redis also fails to start again', async () => {
    const logged: string[] = []
    backend.startService = async (_roomId, svc) => {
      backend.calls.push(`startService:${svc}`)
      throw new Error('container exited immediately')
    }

    await expect(
      restoreServiceFromFile({ ...ctx(), log: (line) => logged.push(line) }, 'redis', await rdbFile())
    ).rejects.toThrow('no space left on device')

    expect(backend.calls).toContain('startService:redis')
    expect(logged.join('\n')).toMatch(/container exited immediately/)
  })
})

describe('service data undo refuses before touching data', () => {
  async function upgradedPostgres() {
    rooms.update('room1abc', { services: { postgres: { version: '16' } } })
    backend.serviceStates.set('postgres', 'running')
    const entry = await engine.execute(ctx(), 'service-version', { service: 'postgres', version: '17' }, 'user')
    expect(entry.status).toBe('verified')
    backend.calls.length = 0
    return entry
  }

  function touchedServiceData(): boolean {
    return backend.calls.some((call) =>
      call.startsWith('removeService:') ||
      call.startsWith('createService:') ||
      call.startsWith('execInServiceFromFile:') ||
      call === 'execInService:postgres:psql'
    )
  }

  it('refuses a service-version undo in a sleeping room without lowering the recorded version', async () => {
    const entry = await upgradedPostgres()
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/Wake the room first/)

    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(touchedServiceData()).toBe(false)
    expect(changes.get(entry.id)!.status).toBe('verified')
    expect(changes.list('room1abc').filter((c) => c.kind === 'undo')).toHaveLength(0)
  })

  it('refuses a service-version undo whose safety backup is gone instead of emptying the volume', async () => {
    const entry = await upgradedPostgres()
    const { rmSync } = await import('node:fs')
    rmSync((entry.captured as { backupFile: string }).backupFile)

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/safety backup is missing/)

    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(touchedServiceData()).toBe(false)
    expect(changes.get(entry.id)!.status).toBe('verified')
  })

  it('refuses a service-version undo whose record lost its safety backup', async () => {
    const entry = await upgradedPostgres()
    changes.setStatus(entry.id, 'verified', { captured: { prevVersion: '16' } })

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/safety backup is missing/)

    expect(rooms.get('room1abc')!.services.postgres).toEqual({ version: '17' })
    expect(touchedServiceData()).toBe(false)
  })

  it('refuses a db-restore undo in a sleeping room before restoring anything', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '17' } } })
    backend.serviceStates.set('postgres', 'running')
    const entry = await restorePostgresFromBackup(ctx())
    backend.calls.length = 0
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })

    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/Wake the room first/)

    expect(touchedServiceData()).toBe(false)
    expect(changes.get(entry.id)!.status).toBe('verified')
  })

  it('refuses a db-restore undo whose safety backup is gone without exposing its path', async () => {
    rooms.update('room1abc', { services: { postgres: { version: '17' } } })
    backend.serviceStates.set('postgres', 'running')
    const entry = await restorePostgresFromBackup(ctx())
    const backupFile = (entry.captured as { backupFile: string }).backupFile
    const { rmSync } = await import('node:fs')
    rmSync(backupFile)
    backend.calls.length = 0

    const refused = await engine.undo(ctx(), entry.id, 'user').catch((error: unknown) => error as Error)

    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/safety backup is missing/)
    expect((refused as Error).message).not.toContain(backupFile)
    expect(touchedServiceData()).toBe(false)
    expect(changes.get(entry.id)!.status).toBe('verified')
  })
})

describe('engine safety', () => {
  it('rejects unknown change kinds', async () => {
    await expect(engine.execute(ctx(), 'format-host-disk', {}, 'agent')).rejects.toThrow(/Unknown change kind/)
  })

  it('refuses to undo an undone change twice', async () => {
    const entry = await engine.execute(ctx(), 'start-command', { command: 'pnpm start' }, 'user')
    await engine.undo(ctx(), entry.id, 'user')
    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/already undone/)
  })
})

describe('Android immutable build', () => {
  beforeEach(() => {
    rooms.update('room1abc', {
      provider: 'android',
      workspaceMode: 'hotel',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/android.git',
      stateRevision: 17,
      workspaceVolumeRevision: 3,
      syncStatus: 'modified',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: './gradlew assembleDebug --no-daemon',
      hostPort: null
    })
    backend.workspaceFingerprintValue = 'b'.repeat(64)
  })

  it('builds only a frozen Room revision, exports provenance, and cleans the snapshot', async () => {
    const before = rooms.get('room1abc')!
    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')

    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toContain(`artifacts/${entry.id}/`)
    const snapshot = `dh-room1abc-src-build-${entry.id.replaceAll('-', '')}`
    const pauseAt = backend.calls.indexOf('pauseWeb:room1abc')
    const copyAt = backend.calls.indexOf(`copyVolume:dh-room1abc-src-r3:${snapshot}`)
    const cleanupAt = backend.calls.findIndex((call) =>
      call === `runOneShot:${snapshot}:${ANDROID_SNAPSHOT_CLEAN_SCRIPT}`
    )
    const fingerprintAt = backend.calls.indexOf(`fingerprintBuildInput:${snapshot}`)
    const unpauseAt = backend.calls.indexOf('unpauseWeb:room1abc')
    const buildAt = backend.calls.findIndex((call) =>
      call === `runOneShot:${snapshot}:./gradlew assembleDebug --no-daemon`
    )
    const exportAt = backend.calls.findIndex((call) => call.startsWith(`exportAndroidArtifacts:${snapshot}:`))
    const snapshotCleanupAt = backend.calls.indexOf(`removeWorkspaceSnapshot:${entry.id}`)
    expect([pauseAt, copyAt, unpauseAt, cleanupAt, fingerprintAt, buildAt, exportAt, snapshotCleanupAt]).toEqual(
      [...[pauseAt, copyAt, unpauseAt, cleanupAt, fingerprintAt, buildAt, exportAt, snapshotCleanupAt]].sort((a, b) => a - b)
    )
    expect(pauseAt).toBeGreaterThanOrEqual(0)
    expect(backend.lastWebSpec?.workspaceVolumeOverride).toBe(snapshot)
    expect(backend.lastWebSpec).toMatchObject({ noCacheVolume: true, extraVolumes: [] })

    const provenance = entry.captured as {
      jobId: string
      changeId: string
      roomId: string
      executionLifecycle: string
      cleanExecution: boolean
      input: { stateRevision: number; workspaceVolumeRevision: number; buildInputSha256: string; environmentRevision: string }
      artifacts: { sha256: string }[]
      provenanceSha256: string
    }
    expect(provenance).toMatchObject({
      jobId: entry.id,
      changeId: entry.id,
      roomId: 'room1abc',
      executionLifecycle: 'isolated-snapshot',
      cleanExecution: true,
      input: { stateRevision: 17, workspaceVolumeRevision: 3, buildInputSha256: 'b'.repeat(64) }
    })
    expect(provenance.input.environmentRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(provenance.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(provenance.provenanceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(rooms.get('room1abc')).toMatchObject({
      stateRevision: before.stateRevision,
      workspaceVolumeRevision: before.workspaceVolumeRevision,
      syncStatus: before.syncStatus
    })
  })

  it('unpauses the live Room and removes its snapshot when the isolated build fails', async () => {
    backend.oneShotHandler = (_spec, cmd) => cmd === ANDROID_SNAPSHOT_CLEAN_SCRIPT
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'Gradle failed' }
    const entry = await engine.execute(ctx(), 'android-build', {}, 'agent')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('Gradle failed')
    expect(backend.calls).toContain('unpauseWeb:room1abc')
    expect(backend.calls).toContain(`removeWorkspaceSnapshot:${entry.id}`)
    expect(backend.calls.some((call) => call.startsWith('exportAndroidArtifacts:'))).toBe(false)
    expect(rooms.get('room1abc')).toMatchObject({ stateRevision: 17, workspaceVolumeRevision: 3 })
  })

  it('recreates the live Android runtime if unpause fails and still cleans the build snapshot', async () => {
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('engine refused unpause')
    }
    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('engine refused unpause')
    expect(backend.calls).toContain('recreateWeb:room1abc:node17:default')
    expect(backend.calls.filter((call) => call === 'recreateWeb:room1abc:node17:default')).toHaveLength(1)
    expect(backend.lastWebSpec?.workspaceVolumeOverride).toBeUndefined()
    expect(backend.calls).toContain(`removeWorkspaceSnapshot:${entry.id}`)
    expect(backend.calls.some((call) => call.startsWith('runOneShot:'))).toBe(false)
  })

  it('conservatively resumes the Room when pause succeeds but its response is lost', async () => {
    backend.pauseWeb = async (roomId) => {
      backend.calls.push(`pauseWeb:${roomId}`)
      backend.webPausedValue = true
      throw new Error('pause response was lost')
    }

    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('pause response was lost')
    expect(backend.calls).toContain('unpauseWeb:room1abc')
    expect(backend.webPausedValue).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('copyVolume:'))).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('runOneShot:'))).toBe(false)
  })

  it('fails verification when an exported APK does not match its recorded hash', async () => {
    const changeCtx = ctx()
    backend.exportAndroidArtifacts = async (_roomId, workspaceVolume, artifactsRoot, operationId) => {
      backend.calls.push(`exportAndroidArtifacts:${workspaceVolume}`)
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname, join } = await import('node:path')
      const relativePath = 'app/build/outputs/apk/debug/app-debug.apk'
      const path = join(artifactsRoot, operationId, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'tampered')
      return [{ relativePath, size: 8, sha256: 'c'.repeat(64) }]
    }
    const entry = await engine.execute(changeCtx, 'android-build', {}, 'user')

    expect(entry.status).toBe('applied')
    expect(entry.verify).toEqual({ ok: false, detail: expect.stringMatching(/checksum does not match/) })
    expect(JSON.stringify(entry)).not.toContain(changeCtx.userData)
    expect(backend.calls).toContain(`removeWorkspaceSnapshot:${entry.id}`)
  })

  it('does not publish Host artifact paths when snapshot export fails', async () => {
    const changeCtx = ctx()
    backend.exportAndroidArtifacts = async (_roomId, _workspaceVolume, artifactsRoot, operationId) => {
      throw new Error(`EACCES opening ${artifactsRoot}/${operationId}/private.apk`)
    }

    const entry = await engine.execute(changeCtx, 'android-build', {}, 'user')

    expect(entry).toMatchObject({
      status: 'failed',
      verify: { detail: expect.stringContaining('Android build artifact export failed') }
    })
    expect(JSON.stringify(entry)).not.toContain(changeCtx.userData)
  })

  it.each(['missing', 'corrupt', 'tampered'] as const)(
    'fails closed and removes artifacts when the on-disk provenance manifest is %s',
    async (mode) => {
      const changeCtx = ctx()
      backend.removeWorkspaceSnapshot = async (_roomId, operationId) => {
        backend.calls.push(`removeWorkspaceSnapshot:${operationId}`)
        const { createHash } = await import('node:crypto')
        const { readFileSync, rmSync, writeFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const manifest = join(changeCtx.userData, 'rooms', 'room1abc', 'artifacts', operationId, 'provenance.json')
        if (mode === 'missing') rmSync(manifest)
        else if (mode === 'corrupt') writeFileSync(manifest, '{broken-json', 'utf8')
        else {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
          parsed.command = 'tampered command'
          const { provenanceSha256: _old, ...unsigned } = parsed
          parsed.provenanceSha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
          writeFileSync(manifest, JSON.stringify(parsed), 'utf8')
        }
      }

      const entry = await engine.execute(changeCtx, 'android-build', {}, 'user')

      expect(entry.status).toBe('applied')
      expect(entry.verify?.detail).toMatch(/manifest/)
      expect(entry.verify?.detail).not.toContain(changeCtx.userData)
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      expect(existsSync(join(changeCtx.userData, 'rooms', 'room1abc', 'artifacts', entry.id))).toBe(false)
    }
  )

  it('rejects Android builds without a Room-owned workspace before pausing', async () => {
    rooms.update('room1abc', { workspaceMode: 'legacy-host-bind' })
    await expect(engine.execute(ctx(), 'android-build', {}, 'user')).rejects.toThrow(/Room-owned Hotel workspace/)
    expect(backend.calls).not.toContain('pauseWeb:room1abc')
  })

  it('refuses corrupted cleanup identities without escaping the private artifact root', async () => {
    const changeCtx = ctx()
    const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const operationId = '11111111-2222-4333-8444-555555555555'
    const operationEscape = join(changeCtx.userData, 'rooms', 'room1abc', 'outside', 'sentinel')
    const roomEscape = join(changeCtx.userData, 'escape', 'artifacts', operationId, 'sentinel')
    mkdirSync(join(operationEscape, '..'), { recursive: true })
    mkdirSync(join(roomEscape, '..'), { recursive: true })
    writeFileSync(operationEscape, 'keep')
    writeFileSync(roomEscape, 'keep')

    const errors = [
      cleanupAndroidBuildArtifacts(changeCtx.userData, 'room1abc', '../outside'),
      cleanupAndroidBuildArtifacts(changeCtx.userData, '../escape', operationId)
    ]

    expect(errors).toEqual([
      'private Android build artifact cleanup failed',
      'private Android build artifact cleanup failed'
    ])
    expect(errors.join(' ')).not.toContain(changeCtx.userData)
    expect(existsSync(operationEscape)).toBe(true)
    expect(existsSync(roomEscape)).toBe(true)
  })
})

describe('package install change', () => {
  it('runs the selected Room package manager inside a Hotel workspace', async () => {
    rooms.update('room1abc', {
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/demo.git',
      workspaceMode: 'hotel'
    })
    const entry = await engine.execute(
      ctx(),
      'package-install',
      { name: '@vitejs/plugin-react', version: '5.0.1', dev: true },
      'user'
    )
    expect(entry.status).toBe('verified')
    expect(entry.undoable).toBe(true)
    expect(backend.calls).toContain('runOneShot:dh-room1abc-deps-node22-g1:pnpm add --save-exact --save-dev @vitejs/plugin-react@5.0.1')
    expect(backend.calls).toContain('recreateWeb:room1abc:node22:dh-room1abc-deps-node22-g1')
    expect(rooms.get('room1abc')).toMatchObject({ workspaceVolumeRevision: 1, stateRevision: 1, syncStatus: 'modified' })
  })

  it('refuses linked Host folders before executing any install command', async () => {
    await expect(
      engine.execute(ctx(), 'package-install', { name: 'zod', version: '4.0.0', dev: false }, 'user')
    ).rejects.toThrow(/protect Host files/)
    expect(backend.calls.some((call) => call.startsWith('runOneShot'))).toBe(false)
    expect(changes.list('room1abc')).toHaveLength(0)
  })

  it('allows an imported Local Folder after it becomes Hotel-owned working state', async () => {
    rooms.update('room1abc', {
      sourceType: 'linked-folder',
      sourceRef: 'D:\\Projects\\demo',
      workspaceMode: 'hotel'
    })
    const entry = await engine.execute(
      ctx(),
      'package-install',
      { name: 'zod', version: '4.0.0', dev: false },
      'user'
    )
    expect(entry.status).toBe('verified')
    expect(backend.calls).toContain('runOneShot:dh-room1abc-deps-node22-g1:pnpm add --save-exact zod@4.0.0')
  })

  it('explains that Empty Rooms do not have a persistent project state yet', async () => {
    rooms.update('room1abc', { sourceType: 'empty', sourceRef: '', workspaceMode: 'empty' })
    await expect(
      engine.execute(ctx(), 'package-install', { name: 'zod', version: '4.0.0', dev: false }, 'user')
    ).rejects.toThrow(/no persistent project working state/)
    expect(backend.calls.some((call) => call.startsWith('runOneShot'))).toBe(false)
  })

  it('pins exact versions for npm and pnpm installs', () => {
    expect(packageInstallCommand('npm', { name: 'zod', version: '4.0.0', dev: false })).toBe(
      'npm install --save-exact --save zod@4.0.0'
    )
    expect(packageInstallCommand('pnpm', { name: 'zod', version: '4.0.0', dev: true })).toBe(
      'pnpm add --save-exact --save-dev zod@4.0.0'
    )
  })
})

describe('normalize-line-endings change', () => {
  const CRLF_SCAN = `${SCAN_SENTINEL}\0./gradlew\0./scripts/build.sh\0`
  const CLEAN_SCAN = `${SCAN_SENTINEL}\0`

  /** A Room whose Windows-imported workspace still has CRLF launchers. */
  function crlfRoom(): void {
    rooms.update('room1abc', { sourceType: 'linked-folder', sourceRef: 'D:\\Projects\\demo', workspaceMode: 'hotel' })
    backend.execResult = { code: 0, stdout: CRLF_SCAN, stderr: '' }
    backend.oneShotHandler = (_spec, cmd) => ({
      code: 0,
      // the normalizer reports what it rewrote; a later scan finds nothing left
      stdout: cmd === LINE_ENDING_NORMALIZE_SCRIPT ? CRLF_SCAN : CLEAN_SCAN,
      stderr: ''
    })
  }

  it('normalizes on a copy and publishes it as a new workspace generation', async () => {
    crlfRoom()
    const entry = await engine.execute(ctx(), 'normalize-line-endings', {}, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toBe('2 scripts now use LF line endings')
    expect(backend.calls).toContain('copyVolume:dh-room1abc-src:dh-room1abc-src-r1')
    expect(rooms.get('room1abc')).toMatchObject({ workspaceVolumeRevision: 1, stateRevision: 1, syncStatus: 'modified' })
    expect(entry.steps.join(' ')).toContain('./gradlew')
  })

  it('lists the normalized scripts and stays undoable', async () => {
    crlfRoom()
    const entry = await engine.execute(ctx(), 'normalize-line-endings', {}, 'user')
    expect(entry.undoable).toBe(true)
    expect(entry.undoStrategy).toBe('workspace-generation-swap')
    expect(changes.lastUndoable('room1abc')?.id).toBe(entry.id)
  })

  it('undo republishes the untouched generation and drops the normalized copy', async () => {
    crlfRoom()
    const entry = await engine.execute(ctx(), 'normalize-line-endings', {}, 'user')
    await engine.undo(ctx(), entry.id, 'user')
    expect(rooms.get('room1abc')).toMatchObject({ workspaceVolumeRevision: 0 })
    expect(backend.calls).toContain('removeWorkspaceVolume:r1')
  })

  it('never writes to a Room still bound to its Host folder', async () => {
    // makeRoom() is a legacy Host bind; Host files are not ours to rewrite.
    backend.execResult = { code: 0, stdout: CRLF_SCAN, stderr: '' }
    await expect(engine.execute(ctx(), 'normalize-line-endings', {}, 'user')).rejects.toThrow(/protect Host files/)
    expect(backend.calls.some((call) => call.startsWith('copyVolume'))).toBe(false)
    expect(changes.list('room1abc')).toHaveLength(0)
  })

  it('says so plainly instead of copying a workspace for nothing', async () => {
    rooms.update('room1abc', { workspaceMode: 'hotel' })
    backend.execResult = { code: 0, stdout: CLEAN_SCAN, stderr: '' }
    await expect(engine.execute(ctx(), 'normalize-line-endings', {}, 'user')).rejects.toThrow(NOTHING_TO_NORMALIZE)
    expect(backend.calls.some((call) => call.startsWith('copyVolume'))).toBe(false)
  })

  it('fails verification when CRLF survived the rewrite', async () => {
    rooms.update('room1abc', { workspaceMode: 'hotel' })
    backend.execResult = { code: 0, stdout: CRLF_SCAN, stderr: '' }
    // the re-scan still reports a CRLF script: the change must not claim success
    backend.oneShotHandler = () => ({ code: 0, stdout: CRLF_SCAN, stderr: '' })
    const entry = await engine.execute(ctx(), 'normalize-line-endings', {}, 'user')
    expect(entry.status).toBe('applied')
    expect(entry.verify).toMatchObject({ ok: false })
    expect(entry.verify?.detail).toContain('still CRLF after normalization')
  })
})

describe('android build line-ending preflight', () => {
  function androidRoom(): void {
    rooms.update('room1abc', {
      provider: 'android',
      sourceType: 'linked-folder',
      sourceRef: 'D:\\Projects\\app',
      workspaceMode: 'hotel',
      startCommand: 'sh ./gradlew assembleDebug --no-daemon'
    })
    // the build's provenance manifest records real digests
    backend.workspaceFingerprintValue = 'a'.repeat(64)
  }

  it('refuses a build with a CRLF gradlew and names the real cause', async () => {
    androidRoom()
    backend.execResult = { code: 0, stdout: `${SCAN_SENTINEL}\0./gradlew\0`, stderr: '' }
    await expect(engine.execute(ctx(), 'android-build', {}, 'user')).rejects.toThrow(
      /not a Gradle or build failure/
    )
    // refused before anything ran: no snapshot, no build container
    expect(backend.calls.some((call) => call.startsWith('copyVolume'))).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('runOneShot'))).toBe(false)
  })

  it('builds normally once the launcher uses LF', async () => {
    androidRoom()
    backend.execResult = { code: 0, stdout: `${SCAN_SENTINEL}\0`, stderr: '' }
    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')
    expect(entry.status).toBe('verified')
  })

  it('does not block a build because an unrelated script has CRLF', async () => {
    androidRoom()
    // the launcher scan only ever reports ./gradlew or ./mvnw; a CRLF helper
    // elsewhere is a check-tab warning, not a reason to refuse a build
    backend.execResult = { code: 0, stdout: `${SCAN_SENTINEL}\0`, stderr: '' }
    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')
    expect(entry.status).toBe('verified')
  })

  it('re-attributes a failed build when the build input still holds CRLF scripts', async () => {
    androidRoom()
    backend.execResult = { code: 0, stdout: `${SCAN_SENTINEL}\0`, stderr: '' }
    backend.oneShotHandler = (_spec, cmd) =>
      cmd === ANDROID_SNAPSHOT_CLEAN_SCRIPT
        ? { code: 0, stdout: '', stderr: '' }
        : cmd === LINE_ENDING_SCAN_SCRIPT
        ? { code: 0, stdout: `${SCAN_SENTINEL}\0./scripts/sign.sh\0`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'Execution failed for task :app:signDebug' }
    const entry = await engine.execute(ctx(), 'android-build', {}, 'user')
    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('Execution failed for task')
    expect(entry.verify?.detail).toContain('./scripts/sign.sh')
    expect(entry.verify?.detail).toContain('not a Gradle or build failure')
  })
})

describe('android Build & Run line-ending preflight', () => {
  function androidRunRoom(): void {
    rooms.update('room1abc', {
      provider: 'android',
      sourceType: 'linked-folder',
      sourceRef: 'D:\\Projects\\app',
      workspaceMode: 'hotel',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'sh ./gradlew assembleDebug --no-daemon'
    })
    backend.emulatorStateValue = 'running'
  }

  it('refuses Build & Run before invoking a CRLF gradlew', async () => {
    androidRunRoom()
    const expectedProbe = launcherScanScript('sh ./gradlew assembleDebug --no-daemon')
    backend.execHandler = (cmd) => ({
      code: 0,
      stdout: cmd[2] === expectedProbe ? `${SCAN_SENTINEL}\0./gradlew\0` : '',
      stderr: ''
    })

    await expect(engine.execute(ctx(), 'android-run', {}, 'user')).rejects.toThrow(
      /not a Gradle or build failure/
    )
    expect(changes.list('room1abc')).toHaveLength(0)
  })

  it('re-attributes a failed Build & Run when a CRLF helper caused it', async () => {
    androidRunRoom()
    const expectedProbe = launcherScanScript('sh ./gradlew assembleDebug --no-daemon')
    backend.execHandler = (cmd) => {
      const script = cmd[2] ?? ''
      if (script === expectedProbe) {
        return { code: 0, stdout: `${SCAN_SENTINEL}\0`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    backend.oneShotHandler = (_spec, cmd) => cmd === ANDROID_SNAPSHOT_CLEAN_SCRIPT
      ? { code: 0, stdout: '', stderr: '' }
      : cmd === LINE_ENDING_SCAN_SCRIPT
        ? { code: 0, stdout: `${SCAN_SENTINEL}\0./scripts/sign.sh\0`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'Execution failed for task :app:signDebug' }

    const entry = await engine.execute(ctx(), 'android-run', {}, 'user')
    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('Execution failed for task')
    expect(entry.verify?.detail).toContain('./scripts/sign.sh')
    expect(entry.verify?.detail).toContain('not a Gradle or build failure')
  })

  it('attempts every receipt revocation when a later tracked install fails', async () => {
    androidRunRoom()
    backend.workspaceFingerprintValue = 'a'.repeat(64)
    backend.exportAndroidArtifacts = async (_roomId, _workspaceVolume, artifactsRoot, operationId) => {
      const { createHash } = await import('node:crypto')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname, join } = await import('node:path')
      return ['one', 'two'].map((name) => {
        const relativePath = `${name}/build/outputs/apk/debug/${name}.apk`
        const path = join(artifactsRoot, operationId, relativePath)
        const bytes = Buffer.from(`sealed-${name}`)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
        writeFileSync(
          join(dirname(path), 'output-metadata.json'),
          JSON.stringify({ applicationId: `com.example.${name}`, elements: [{ outputFile: `${name}.apk` }] })
        )
        return {
          relativePath,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      })
    }
    const installed: string[] = []
    const removalAttempts: string[] = []
    const bulkRemovals: string[] = []
    const changeCtx = ctx()
    changeCtx.waitForFencedEmulatorBoot = async () => ({
      booted: true,
      adbState: 'device',
      bootProperty: '1',
      lastAdbCode: 0,
      helperCode: 0
    })
    changeCtx.installTrackedAndroidArtifact = async (applicationId) => {
      installed.push(applicationId)
      if (applicationId === 'com.example.two') {
        throw new Error(`private stage cleanup failed after committing ${applicationId}`)
      }
    }
    changeCtx.removeTrackedAndroidInstall = (applicationId) => {
      removalAttempts.push(applicationId)
      if (applicationId === 'com.example.one') throw new Error('first receipt remover failed')
    }
    changeCtx.removeTrackedAndroidInstalls = (changeId) => {
      bulkRemovals.push(changeId)
    }

    const entry = await engine.execute(changeCtx, 'android-run', {}, 'user')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toContain('private stage cleanup failed')
    expect(installed).toEqual(['com.example.one', 'com.example.two'])
    expect(removalAttempts).toEqual(['com.example.one', 'com.example.two'])
    expect(bulkRemovals).toEqual([entry.id])
  })

  it('directs legacy Host-bound Build & Run failures to a Host-side line-ending fix', async () => {
    androidRunRoom()
    rooms.update('room1abc', { workspaceMode: 'legacy-host-bind' })
    const expectedProbe = launcherScanScript('sh ./gradlew assembleDebug --no-daemon')
    backend.execHandler = (cmd) => ({
      code: 0,
      stdout: cmd[2] === expectedProbe ? `${SCAN_SENTINEL}\0./gradlew\0` : '',
      stderr: ''
    })

    await expect(engine.execute(ctx(), 'android-run', {}, 'user')).rejects.toThrow(/Room-owned Hotel workspace/)
    expect(backend.calls.some((call) => call.startsWith('pauseWeb:'))).toBe(false)
  })
})

describe('normalize-line-endings verification', () => {
  it('does not call a clean scan a success while the Room is down', async () => {
    rooms.update('room1abc', { workspaceMode: 'hotel' })
    backend.execResult = { code: 0, stdout: `${SCAN_SENTINEL}\0./gradlew\0`, stderr: '' }
    backend.oneShotHandler = (_spec, cmd) => ({
      code: 0,
      stdout: cmd === LINE_ENDING_NORMALIZE_SCRIPT ? `${SCAN_SENTINEL}\0./gradlew\0` : `${SCAN_SENTINEL}\0`,
      stderr: ''
    })
    backend.webStateValue = 'exited'
    const entry = await engine.execute(ctx(), 'normalize-line-endings', {}, 'user')
    expect(entry.verify).toMatchObject({ ok: false })
    expect(entry.verify?.detail).toContain('web process exited')
  })
})

describe('a change that reports what it produced', () => {
  it('merges its result into the entry so the next call need not guess', async () => {
    const engine = new ChangeEngine()
    engine.register({
      kind: 'reports-result',
      plan: () => ({
        title: 'Reports a result',
        component: 'Test',
        before: null,
        after: { requested: 'app' },
        undoable: false,
        undoStrategy: 'none',
        autoRollback: false
      }),
      async apply(_ctx, _p, steps) {
        steps.setResult({ adbSerial: 'emulator-5554', installedApplicationIds: ['com.a', 'com.b'] })
      },
      async verify() {
        return { ok: true, detail: 'ok' }
      }
    })

    const entry = await engine.execute(ctx(), 'reports-result', {}, 'agent')

    // The planned `after` survives; the produced facts join it.
    expect(entry.after).toEqual({
      requested: 'app',
      adbSerial: 'emulator-5554',
      installedApplicationIds: ['com.a', 'com.b']
    })
  })
})
