import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateRoomInput } from '@devhotel/shared'
import { RoomOrchestrator } from '../orchestrator'
import { canonicalSource, isCompatibleRoom } from '../roomIdentity'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

const input: CreateRoomInput = {
  sourceType: 'empty', sourceRef: '', project: 'demo', nickname: 'new-name', actor: 'agent'
}

describe('canonical Room reuse', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let orch: RoomOrchestrator
  let closePort: () => void
  beforeEach(async () => {
    userData = tempDir()
    db = openDb(userData)
    backend = new FakeBackend()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    orch = new RoomOrchestrator({ userData, db, backend, gateway: new FakeGateway().asGateway(), appVersion: 'test' })
  })
  afterEach(() => {
    closePort()
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  function existing(overrides: Parameters<typeof makeRoom>[0] = {}) {
    const room = makeRoom({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty', syncStatus: 'empty', ...overrides })
    orch.rooms.create(room)
    return room
  }

  it('canonicalizes HTTPS credentials, SSH/scp, suffixes and GitHub casing', () => {
    const expected = 'github.com/owner/repo'
    for (const ref of ['https://token@GitHub.com/Owner/Repo.git/', 'git@github.com:owner/repo.git', 'ssh://git@github.com:22/owner/repo']) {
      expect(canonicalSource('managed-git', ref)).toBe(expected)
    }
    expect(canonicalSource('managed-git', 'https://example.test/Repo.git')).not.toBe(canonicalSource('managed-git', 'https://example.test/repo.git'))
    expect(canonicalSource('managed-git', 'ssh://git@example.test:2222/repo')).not.toBe(canonicalSource('managed-git', 'https://example.test/repo'))
  })

  it('matches an existing repository independently of nickname and URL transport', async () => {
    const room = existing({ sourceType: 'managed-git', sourceRef: 'https://github.com/owner/repo.git', workspaceMode: 'hotel' })
    const result = await orch.acquireRoom({ ...input, sourceType: 'managed-git', sourceRef: 'git@github.com:Owner/Repo.git', project: ' DEMO ' })
    expect(result).toMatchObject({ disposition: 'reused', room: { id: room.id, nickname: 'dev' } })
    expect(backend.calls).toEqual([])
    await expect(orch.createRoom({ ...input, sourceType: 'managed-git', sourceRef: 'ssh://git@github.com/owner/repo' })).rejects.toMatchObject({ code: 'ROOM_REUSE_REQUIRED', evidence: { roomId: room.id } })
  })

  it('creates only once under concurrent acquisition and rejects a concurrent direct create', async () => {
    const requests = [orch.acquireRoom(input), orch.acquireRoom({ ...input, nickname: 'different' }), orch.createRoom(input)] as const
    const [first, second, direct] = await Promise.allSettled(requests)
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('fulfilled')
    if (first.status !== 'fulfilled' || second.status !== 'fulfilled') throw new Error('acquire failed')
    expect(first.value).toMatchObject({ disposition: 'created' })
    expect(second.value).toMatchObject({ disposition: 'reused', room: { id: first.value.room.id } })
    expect(direct).toMatchObject({ status: 'rejected', reason: { code: 'ROOM_REUSE_REQUIRED' } })
    expect(orch.rooms.list()).toHaveLength(1)
  })

  it('wakes a sleeping Room once and preserves modified workspace state and journal evidence', async () => {
    const room = existing({ status: 'sleeping', workspaceMode: 'hotel', syncStatus: 'modified', stateRevision: 7, workspaceVolumeRevision: 3, workspaceFingerprint: 'preserved' })
    const [result, retry] = await Promise.all([orch.acquireRoom(input), orch.acquireRoom(input)])
    expect(result).toMatchObject({ disposition: 'woken', modified: true, room: { id: room.id, stateRevision: 7, workspaceVolumeRevision: 3, workspaceFingerprint: 'preserved' } })
    expect(retry.disposition).toBe('reused')
    expect(backend.calls.filter((call) => call.startsWith('recreateAnchor:'))).toHaveLength(1)
    expect(orch.changes.list(room.id).filter((entry) => entry.kind === 'acquire-room')).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'agent', after: expect.objectContaining({ roomId: room.id, modified: true, reason: expect.stringContaining('existing state preserved') }) })
    ]))
  })

  it('reports a failed wake without creating a replacement', async () => {
    const room = existing({ status: 'sleeping' })
    vi.spyOn(backend, 'recreateAnchor').mockRejectedValue(new Error('wake failed'))
    await expect(orch.acquireRoom(input)).rejects.toMatchObject({ code: 'ROOM_WAKE_FAILED', evidence: { roomId: room.id } })
    expect(orch.rooms.list()).toHaveLength(1)
  })

  it('persists distinct task/issue exceptions and guards retries and omitted identities', async () => {
    const base = existing()
    for (const identity of [{ taskId: 'task-97' }, { issueRef: 'https://github.com/owner/repo/issues/97' }]) {
      const room = await orch.createRoom({ ...input, ...identity })
      expect(room.id).not.toBe(base.id)
      expect(orch.rooms.get(room.id)).toMatchObject(identity)
      await expect(orch.createRoom({ ...input, ...identity, nickname: 'retry' })).rejects.toMatchObject({ code: 'ROOM_REUSE_REQUIRED', evidence: { roomId: room.id } })
      expect((await orch.acquireRoom({ ...input, ...identity })).room.id).toBe(room.id)
    }
    orch.rooms.delete(base.id)
    await expect(orch.createRoom(input)).rejects.toMatchObject({ code: 'ROOM_REUSE_REQUIRED' })
    // Reopening proves identities are durable, not an in-memory exception flag.
    db.close()
    db = openDb(userData)
    expect(roomsRepo(db).findCompatible({ ...input, taskId: 'task-97' })).toMatchObject({ taskId: 'task-97' })
  })

  it('keeps manual creation compatible even when the same Room already exists', async () => {
    existing()
    await orch.createRoom({ ...input, actor: 'user' })
    expect(orch.rooms.list()).toHaveLength(2)
  })

  it.each([
    { provider: 'android' }, { project: 'another' },
    { planOverrides: { runtimeVersion: '24' } }, { planOverrides: { pmKind: 'npm' } },
    { planOverrides: { startCommand: 'npm start' } }, { planOverrides: { internalPort: 4000 } },
    { planOverrides: { https: true } }
  ] as Partial<CreateRoomInput>[])('does not reuse incompatible requirements: %j', (override) => {
    const room = existing()
    expect(isCompatibleRoom(room, { ...input, ...override })).toBe(false)
    expect(isCompatibleRoom(room, { ...input, planOverrides: { runtimeVersion: '22', pmKind: 'pnpm' } })).toBe(true)
  })
})
