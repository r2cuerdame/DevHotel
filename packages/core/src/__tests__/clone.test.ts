import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { srcVolume, svcVolume } from '../backend/naming'
import { depsVolumeForGen } from '../changes/definitions/deps'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, makeRoom as makeBaseRoom, tempDir, testDb } from './fakes'

function makeRoom(overrides: Parameters<typeof makeBaseRoom>[0] = {}) {
  return makeBaseRoom({ workspaceMode: 'hotel', syncStatus: 'synced', hostSyncEnabled: false, ...overrides })
}

describe('RoomOrchestrator.cloneRoom', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let gateway: FakeGateway
  let orch: RoomOrchestrator
  let closePort: (() => void) | null

  beforeEach(async () => {
    db = testDb()
    userData = tempDir()
    backend = new FakeBackend()
    gateway = new FakeGateway()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test'
    })
  })

  afterEach(() => {
    closePort?.()
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('copies a managed workspace, active dependencies, environment and service data into a fresh identity', async () => {
    const source = makeRoom({
      id: 'source01',
      project: 'loopoffice',
      nickname: 'dev',
      roomNumber: 201,
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/loopoffice.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      domain: 'loopoffice-dev.localhost',
      hostPort: backend.hostPort,
      services: { postgres: { version: '17' }, redis: { version: '8' } },
      os: { env: { FEATURE_FLAG: 'on' }, cpus: 2, memoryMB: 2048, timezone: 'Asia/Seoul' },
      thumbPath: 'C:\\old-thumb.png'
    })
    orch.rooms.create(source)
    orch.settings.set('depsGen:source01:node22', '2')
    backend.serviceStates.set('postgres', 'running')
    backend.serviceStates.set('redis', 'running')

    const cloned = await orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'stage',
      copyDependencies: true,
      services: 'copy',
      actor: 'user'
    })

    expect(cloned.id).not.toBe(source.id)
    expect(cloned.roomNumber).toBe(202)
    expect(cloned.nickname).toBe('stage')
    expect(cloned.domain).toBe('loopoffice-stage.localhost')
    expect(cloned.status).toBe('ready')
    expect(cloned.hostPort).toBe(backend.hostPort)
    expect(cloned.thumbPath).toBeNull()
    expect(cloned.runtime).toEqual(source.runtime)
    expect(cloned.packageManager).toEqual(source.packageManager)
    expect(cloned.os).toEqual(source.os)
    expect(cloned.services).toEqual(source.services)
    expect(cloned.os).not.toBe(source.os)
    expect(cloned.os.env).not.toBe(source.os.env)
    expect(backend.calls).toContain(`copyVolume:${srcVolume(source.id)}:${srcVolume(cloned.id)}`)
    expect(backend.calls).toContain(
      `copyVolume:${depsVolumeForGen(source.id, '22', 2)}:${depsVolumeForGen(cloned.id, '22', 0)}`
    )
    expect(backend.calls).toContain(`createRoomPod:source-ready:${cloned.id}`)
    expect(backend.calls).toContain(`createRoomPod:web-stopped:${cloned.id}`)
    expect(backend.calls).toContain(`pauseWeb:${source.id}`)
    expect(backend.calls).toContain(`unpauseWeb:${source.id}`)
    expect(backend.calls).toContain('execInServiceToFile:postgres:pg_dump')
    expect(backend.calls).toContain('execInServiceFromFile:postgres:psql')
    expect(backend.calls).toContain('copyFromService:redis:/data/dump.rdb')
    expect(backend.calls).toContain('copyToService:redis:/data/dump.rdb')
    const pausedAt = backend.calls.indexOf(`pauseWeb:${source.id}`)
    const postgresDumpAt = backend.calls.indexOf('execInServiceToFile:postgres:pg_dump')
    const redisBackupAt = backend.calls.indexOf('copyFromService:redis:/data/dump.rdb')
    const resumedAt = backend.calls.indexOf(`unpauseWeb:${source.id}`)
    const targetCreatedAt = backend.calls.indexOf(`createRoomPod:${cloned.id}`)
    const postgresRestoreAt = backend.calls.indexOf('execInServiceFromFile:postgres:psql')
    const redisRestoreAt = backend.calls.indexOf('copyToService:redis:/data/dump.rdb')
    const targetWebStartedAt = backend.calls.indexOf(`startWeb:${cloned.id}`)
    expect(pausedAt).toBeLessThan(postgresDumpAt)
    expect(postgresDumpAt).toBeLessThan(redisBackupAt)
    expect(redisBackupAt).toBeLessThan(resumedAt)
    expect(resumedAt).toBeLessThan(targetCreatedAt)
    expect(targetCreatedAt).toBeLessThan(postgresRestoreAt)
    expect(postgresRestoreAt).toBeLessThan(redisRestoreAt)
    expect(redisRestoreAt).toBeLessThan(targetWebStartedAt)
    expect(backend.calls.filter((call) => call === `startWeb:${cloned.id}`)).toHaveLength(1)
    expect(backend.calls).not.toContain(`restartWeb:${cloned.id}`)
    expect(backend.calls.some((call) => call.startsWith(`recreateWeb:${cloned.id}:`))).toBe(false)
    expect(orch.changes.list(source.id)).toEqual([])
    expect(orch.changes.list(cloned.id).map((change) => change.kind)).toEqual(['clone-room'])
    expect(orch.checks.latest(cloned.id)).toBeNull()
    expect(orch.inspectRoom(cloned.id).backups).toEqual([])
    const sourceBackups = orch.inspectRoom(source.id).backups
    expect(sourceBackups.map((backup) => backup.service).sort()).toEqual(['postgres', 'redis'])
    expect(sourceBackups.every((backup) => backup.id.length > 0 && !('file' in backup))).toBe(true)
    expect(orch.rooms.get(source.id)?.status).toBe('ready')
  })

  it('refuses to clone a legacy Host bind that would accidentally share the same files', async () => {
    const source = makeRoom({
      id: 'source02',
      project: 'site',
      nickname: 'dev',
      domain: 'site-dev.localhost',
      hostPort: backend.hostPort,
      workspaceMode: 'legacy-host-bind',
      syncStatus: 'legacy',
      hostSyncEnabled: true,
      services: { postgres: { version: '17' } }
    })
    orch.rooms.create(source)

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'node24-test',
        copyDependencies: false,
        services: 'exclude',
        actor: 'agent'
      })
    ).rejects.toThrow(/Move.*into the Hotel/)
    expect(orch.listRooms()).toHaveLength(1)
  })

  it('copies stopped service volumes without waking a sleeping source and rolls back a failed clone', async () => {
    const source = makeRoom({
      id: 'source03',
      project: 'api',
      nickname: 'dev',
      domain: 'api-dev.localhost',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      status: 'sleeping',
      hostPort: null,
      services: { postgres: { version: '17' } }
    })
    orch.rooms.create(source)

    const cloned = await orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'stage',
      copyDependencies: false,
      services: 'copy',
      actor: 'user'
    })
    expect(backend.calls).toContain(`copyVolume:${svcVolume(source.id, 'postgres')}:${svcVolume(cloned.id, 'postgres')}`)
    expect(
      backend.calls.some(
        (call) =>
          call === `stopRoomPod:${source.id}` ||
          call === `startRoomPod:${source.id}` ||
          call === `pauseWeb:${source.id}` ||
          call === `unpauseWeb:${source.id}`
      )
    ).toBe(false)
    expect(orch.rooms.get(source.id)?.status).toBe('sleeping')

    const originalCopy = backend.copyVolume.bind(backend)
    backend.serviceStates.set('postgres', 'exited')
    backend.copyVolume = async (fromRoomId, from, toRoomId, to) => {
      if (from === svcVolume(source.id, 'postgres')) throw new Error('disk full')
      return originalCopy(fromRoomId, from, toRoomId, to)
    }
    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'broken-copy',
        copyDependencies: false,
        services: 'copy',
        actor: 'user'
      })
    ).rejects.toThrow('disk full')
    expect(orch.listRooms().map((room) => room.nickname).sort()).toEqual(['dev', 'stage'])
    expect(backend.calls.some((call) => call.startsWith('deleteRoomPod:'))).toBe(true)
  })

  it('requires a unique nickname within the project', async () => {
    const source = makeRoom({ id: 'source04', project: 'demo', nickname: 'dev', domain: 'demo-dev.localhost' })
    orch.rooms.create(source)
    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: ' DEV ',
        copyDependencies: false,
        services: 'exclude',
        actor: 'user'
      })
    ).rejects.toThrow(/already has a room/i)
    expect(orch.listRooms()).toHaveLength(1)
  })

  it('allocates a unique local domain when another project already owns the suggestion', async () => {
    const source = makeRoom({ id: 'source06', project: 'demo', nickname: 'dev', domain: 'demo-dev.localhost' })
    orch.rooms.create(source)
    orch.rooms.create(
      makeRoom({ id: 'other006', project: 'other', nickname: 'stage', roomNumber: 202, domain: 'demo-stage.localhost' })
    )

    const cloned = await orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'stage',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })
    expect(cloned.domain).toBe('demo-stage-2.localhost')
  })

  it('always resumes an awake source when a managed-volume copy fails', async () => {
    const source = makeRoom({
      id: 'source05',
      project: 'managed',
      nickname: 'dev',
      domain: 'managed-dev.localhost',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/managed.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    backend.copyVolume = async () => {
      throw new Error('copy interrupted')
    }

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'test',
        copyDependencies: false,
        services: 'exclude',
        actor: 'user'
      })
    ).rejects.toThrow('copy interrupted')
    expect(backend.calls).toContain(`pauseWeb:${source.id}`)
    expect(backend.calls).toContain(`unpauseWeb:${source.id}`)
    expect(orch.rooms.get(source.id)?.status).toBe('ready')
    expect(orch.listRooms()).toHaveLength(1)
  })

  it('retains a broken target ownership record when rollback cleanup cannot be verified', async () => {
    const source = makeRoom({
      id: 'source07',
      project: 'managed',
      nickname: 'dev',
      domain: 'managed-cleanup.localhost',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/managed.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    backend.copyVolume = async () => {
      throw new Error('copy interrupted')
    }
    backend.deleteRoomPod = async () => {
      throw new Error('volume still mounted')
    }

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'needs-cleanup',
        copyDependencies: false,
        services: 'exclude',
        actor: 'user'
      })
    ).rejects.toThrow(/Automatic cleanup.*failed/i)

    const retained = orch.listRooms().find((room) => room.nickname === 'needs-cleanup')
    expect(retained?.status).toBe('broken')
    expect(orch.changes.list(retained!.id).map((change) => change.kind)).toContain('clone-room-cleanup-required')
  })

  it('refuses raw service-volume copying if a sleeping source service is actually running', async () => {
    const source = makeRoom({
      id: 'source08',
      project: 'api',
      nickname: 'dev',
      domain: 'api-sleeping.localhost',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      status: 'sleeping',
      services: { postgres: { version: '17' } }
    })
    orch.rooms.create(source)
    backend.serviceStates.set('postgres', 'running')

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'unsafe-copy',
        copyDependencies: false,
        services: 'copy',
        actor: 'user'
      })
    ).rejects.toThrow(/sleeping source still has a running service/)
    expect(backend.calls.some((call) => call.startsWith('copyVolume:'))).toBe(false)
  })

  it('removes a partial streamed Postgres dump and resumes the source when disk output fails', async () => {
    const source = makeRoom({
      id: 'source09',
      project: 'api',
      nickname: 'dev',
      domain: 'api-stream.localhost',
      services: { postgres: { version: '17' } },
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    backend.serviceStates.set('postgres', 'running')
    backend.execInServiceToFile = async (_roomId, svc, cmd, hostPath) => {
      backend.calls.push(`execInServiceToFile:${svc}:${cmd[0]}`)
      writeFileSync(hostPath, 'partial dump')
      return { code: 1, stdout: '', stderr: 'disk write failed' }
    }

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'failed-stream',
        copyDependencies: false,
        services: 'copy',
        actor: 'user'
      })
    ).rejects.toThrow(/pg_dump failed.*disk write failed/)

    const backupDir = join(userData, 'rooms', source.id, 'backups')
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([])
    expect(backend.calls.indexOf(`pauseWeb:${source.id}`)).toBeLessThan(
      backend.calls.indexOf(`unpauseWeb:${source.id}`)
    )
  })

  it('rejects awake Postgres whole-instance state that a managed-database dump cannot represent', async () => {
    const source = makeRoom({
      id: 'source12',
      project: 'api',
      nickname: 'dev',
      domain: 'api-extra-db.localhost',
      services: { postgres: { version: '17' } },
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    backend.serviceStates.set('postgres', 'running')
    const originalExec = backend.execInService.bind(backend)
    backend.execInService = async (roomId, svc, cmd) => {
      if (svc === 'postgres' && cmd.some((part) => part.startsWith('SELECT datname FROM pg_database'))) {
        return { code: 0, stdout: 'customer_archive\n', stderr: '' }
      }
      return originalExec(roomId, svc, cmd)
    }

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'unsupported-db',
        copyDependencies: false,
        services: 'copy',
        actor: 'user'
      })
    ).rejects.toThrow(/unmanaged databases.*customer_archive/)
    expect(backend.calls).not.toContain('execInServiceToFile:postgres:pg_dump')
  })

  it('treats any streamed Postgres SQL error as a failed clone and rolls the target back', async () => {
    const source = makeRoom({
      id: 'source13',
      project: 'api',
      nickname: 'dev',
      domain: 'api-restore.localhost',
      services: { postgres: { version: '17' } },
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    backend.serviceStates.set('postgres', 'running')
    let restoreCommand: string[] = []
    backend.execInServiceFromFile = async (_roomId, svc, cmd) => {
      backend.calls.push(`execInServiceFromFile:${svc}:${cmd[0]}`)
      restoreCommand = cmd
      return { code: 3, stdout: '', stderr: 'ERROR: relation restore failed' }
    }

    await expect(
      orch.cloneRoom({
        sourceRoomId: source.id,
        nickname: 'bad-restore',
        copyDependencies: false,
        services: 'copy',
        actor: 'user'
      })
    ).rejects.toThrow(/psql restore failed.*relation restore failed/)

    expect(restoreCommand).toContain('ON_ERROR_STOP=1')
    expect(restoreCommand).toContain('--single-transaction')
    expect(backend.calls.some((call) => call.startsWith('deleteRoomPod:'))).toBe(true)
    expect(backend.calls.some((call) => call.startsWith('startWeb:'))).toBe(false)
    expect(orch.listRooms().map((room) => room.nickname)).toEqual(['dev'])
  })

  it('does not publish a start operation for a clone target that may still roll back', async () => {
    const source = makeRoom({
      id: 'source14',
      project: 'api',
      nickname: 'dev',
      domain: 'api-dev.localhost',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    let copyEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      copyEntered = resolve
    })
    let failCopy!: () => void
    const copyFailure = new Promise<void>((resolve) => {
      failCopy = resolve
    })
    backend.copyVolume = async () => {
      copyEntered()
      await copyFailure
      throw new Error('copy failed after target publication')
    }

    const cloning = orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'rollback',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })
    await entered
    const target = orch.listRooms().find((room) => room.id !== source.id)!

    expect(() => orch.startRoomOperation(target.id, 'agent')).toThrow(/still being created/)
    expect(orch.listOperations(target.id)).toEqual([])

    failCopy()
    await expect(cloning).rejects.toThrow(/copy failed after target publication/)
    expect(orch.rooms.get(target.id)).toBeNull()
    expect(orch.listOperations(target.id)).toEqual([])
  })
})
