import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeEngine } from '../changes/engine'
import { registerQuickChanges } from '../changes/definitions/index'
import { androidRunChange } from '../changes/definitions/androidRun'
import { ANDROID_SNAPSHOT_CLEAN_SCRIPT, cleanupAndroidBuildArtifacts } from '../changes/definitions/androidBuild'
import { packageInstallCommand } from '../changes/definitions/packageInstall'
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
