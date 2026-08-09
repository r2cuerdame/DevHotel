import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChangeEntry, CheckReport, RoomRecord } from '@devhotel/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changesRepo } from '../store/changesRepo'
import { checksRepo } from '../store/checksRepo'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { settingsRepo } from '../store/settingsRepo'

let dir: string
let db: Db

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'))
  db = openDb(dir)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: 'room-1',
    project: 'acme',
    nickname: 'Acme Site',
    roomNumber: 201,
    provider: 'web',
    sourceType: 'managed-git',
    sourceRef: 'https://github.com/acme/site.git',
    runtime: { kind: 'node', version: '22.12.0' },
    packageManager: { kind: 'pnpm', version: '9.15.0' },
    startCommand: 'pnpm dev',
    internalPort: 3000,
    domain: 'acme.dev.localhost',
    https: true,
    status: 'ready',
    hostPort: 52341,
    createdAt: '2026-08-10T10:00:00.000Z',
    lastUsedAt: '2026-08-10T11:00:00.000Z',
    thumbPath: null,
    ...overrides,
  }
}

function makeChange(overrides: Partial<Omit<ChangeEntry, 'seq'>> = {}): Omit<ChangeEntry, 'seq'> {
  return {
    id: `chg-${Math.random().toString(36).slice(2)}`,
    roomId: 'room-1',
    title: 'Switch node version',
    actor: 'user',
    component: 'runtime',
    before: { version: '20' },
    after: { version: '22' },
    captured: null,
    steps: ['stop web', 'swap volume', 'start web'],
    verify: { ok: true, detail: 'http 200' },
    undoable: true,
    undoStrategy: 'inverse-change',
    status: 'verified',
    rawLogPath: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    undoneAt: null,
    ...overrides,
  }
}

describe('roomsRepo', () => {
  it('round-trips a room preserving nested objects', () => {
    const rooms = roomsRepo(db)
    const room = makeRoom()
    rooms.create(room)
    expect(rooms.get('room-1')).toEqual(room)
  })

  it('round-trips optional fields as null/undefined', () => {
    const rooms = roomsRepo(db)
    const room = makeRoom({
      id: 'room-2',
      domain: 'other.dev.localhost',
      packageManager: { kind: 'npm' },
      https: false,
      hostPort: null,
      thumbPath: null,
    })
    rooms.create(room)
    const got = rooms.get('room-2')
    expect(got).toEqual(room)
    expect(got?.packageManager.version).toBeUndefined()
  })

  it('lists rooms ordered by last_used_at DESC', () => {
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'a', domain: 'a.local', lastUsedAt: '2026-08-10T09:00:00.000Z' }))
    rooms.create(makeRoom({ id: 'b', domain: 'b.local', lastUsedAt: '2026-08-10T12:00:00.000Z' }))
    rooms.create(makeRoom({ id: 'c', domain: 'c.local', lastUsedAt: '2026-08-10T10:00:00.000Z' }))
    expect(rooms.list().map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('updates partial patches including nested objects and booleans', () => {
    const rooms = roomsRepo(db)
    rooms.create(makeRoom())
    rooms.update('room-1', {
      nickname: 'Renamed',
      runtime: { kind: 'node', version: '24.0.0' },
      packageManager: { kind: 'npm' },
      https: false,
      hostPort: null,
      status: 'sleeping',
    })
    const got = rooms.get('room-1')
    expect(got?.nickname).toBe('Renamed')
    expect(got?.runtime).toEqual({ kind: 'node', version: '24.0.0' })
    expect(got?.packageManager).toEqual({ kind: 'npm' })
    expect(got?.https).toBe(false)
    expect(got?.hostPort).toBeNull()
    expect(got?.status).toBe('sleeping')
    expect(got?.startCommand).toBe('pnpm dev')
  })

  it('deletes a room', () => {
    const rooms = roomsRepo(db)
    rooms.create(makeRoom())
    rooms.delete('room-1')
    expect(rooms.get('room-1')).toBeNull()
    expect(rooms.list()).toEqual([])
  })

  it('nextRoomNumber starts at 201 then increments from max', () => {
    const rooms = roomsRepo(db)
    expect(rooms.nextRoomNumber()).toBe(201)
    rooms.create(makeRoom({ id: 'a', domain: 'a.local', roomNumber: 201 }))
    expect(rooms.nextRoomNumber()).toBe(202)
    rooms.create(makeRoom({ id: 'b', domain: 'b.local', roomNumber: 205 }))
    expect(rooms.nextRoomNumber()).toBe(206)
  })
})

describe('changesRepo', () => {
  it('append assigns seq 1 then 2 per room and round-trips', () => {
    const changes = changesRepo(db)
    const first = changes.append(makeChange({ id: 'c1' }))
    const second = changes.append(makeChange({ id: 'c2' }))
    const otherRoom = changes.append(makeChange({ id: 'c3', roomId: 'room-9' }))
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(otherRoom.seq).toBe(1)
    expect(changes.get('c1')).toEqual(first)
  })

  it('lists newest-first', () => {
    const changes = changesRepo(db)
    changes.append(makeChange({ id: 'c1' }))
    changes.append(makeChange({ id: 'c2' }))
    expect(changes.list('room-1').map((c) => c.id)).toEqual(['c2', 'c1'])
  })

  it('lastUndoable skips undone, non-verified, and non-undoable entries', () => {
    const changes = changesRepo(db)
    changes.append(makeChange({ id: 'c1' }))
    changes.append(makeChange({ id: 'c2', undoable: false }))
    changes.append(makeChange({ id: 'c3' }))
    changes.append(makeChange({ id: 'c4', status: 'pending', verify: null }))
    changes.setStatus('c3', 'undone', { undoneAt: '2026-08-10T13:00:00.000Z' })
    expect(changes.lastUndoable('room-1')?.id).toBe('c1')
    const undone = changes.get('c3')
    expect(undone?.status).toBe('undone')
    expect(undone?.undoneAt).toBe('2026-08-10T13:00:00.000Z')
  })

  it('setStatus patches verify/captured/steps/rawLogPath', () => {
    const changes = changesRepo(db)
    changes.append(makeChange({ id: 'c1', status: 'applied', verify: null }))
    changes.setStatus('c1', 'verified', {
      verify: { ok: true, detail: 'all good' },
      captured: { snapshot: 'vol-1' },
      steps: ['a', 'b'],
      rawLogPath: '/logs/c1.log',
    })
    const got = changes.get('c1')
    expect(got?.status).toBe('verified')
    expect(got?.verify).toEqual({ ok: true, detail: 'all good' })
    expect(got?.captured).toEqual({ snapshot: 'vol-1' })
    expect(got?.steps).toEqual(['a', 'b'])
    expect(got?.rawLogPath).toBe('/logs/c1.log')
  })

  it('returns null when a room has no undoable change', () => {
    const changes = changesRepo(db)
    expect(changes.lastUndoable('room-1')).toBeNull()
  })
})

describe('settingsRepo', () => {
  it('gets null for missing keys, sets and overwrites values', () => {
    const settings = settingsRepo(db)
    expect(settings.get('theme')).toBeNull()
    settings.set('theme', 'dark')
    expect(settings.get('theme')).toBe('dark')
    settings.set('theme', 'light')
    expect(settings.get('theme')).toBe('light')
  })
})

describe('checksRepo', () => {
  function makeReport(ranAt: string, roomId = 'room-1'): CheckReport {
    return {
      roomId,
      ranAt,
      overall: 'healthy',
      results: [{ step: 'http', status: 'healthy', summary: 'HTTP 200' }],
    }
  }

  it('saves reports and returns the latest per room', () => {
    const checks = checksRepo(db)
    expect(checks.latest('room-1')).toBeNull()
    checks.saveReport(makeReport('2026-08-10T10:00:00.000Z'))
    checks.saveReport(makeReport('2026-08-10T12:00:00.000Z'))
    checks.saveReport(makeReport('2026-08-10T11:00:00.000Z', 'room-2'))
    expect(checks.latest('room-1')).toEqual(makeReport('2026-08-10T12:00:00.000Z'))
    expect(checks.latest('room-2')).toEqual(makeReport('2026-08-10T11:00:00.000Z', 'room-2'))
  })
})

describe('openDb', () => {
  it('is idempotent across reopen and keeps data', () => {
    const rooms = roomsRepo(db)
    rooms.create(makeRoom())
    db.close()
    db = openDb(dir)
    expect(roomsRepo(db).get('room-1')?.id).toBe('room-1')
  })
})
