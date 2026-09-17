import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChangeEntry, CheckReport, RoomRecord } from '@devhotel/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { androidAppInstallsRepo } from '../store/androidAppInstallsRepo'
import { ANDROID_DEVICE_EVENT_DETAIL_MAX_CHARS, ANDROID_DEVICE_EVENTS_RETAINED, androidDevicesRepo } from '../store/androidDevicesRepo'
import { CHANGES_RETAINED_PER_ROOM, changesRepo } from '../store/changesRepo'
import { CHECKS_RETAINED_PER_ROOM, checksRepo } from '../store/checksRepo'
import { DB_BUSY_TIMEOUT_MS, openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'

let dir: string
let db: Db
const extraDbs: Db[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-retention-'))
  db = openDb(dir)
})

afterEach(() => {
  for (const extra of extraDbs.splice(0)) extra.close()
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
    workspaceMode: 'hotel',
    stateRevision: 1,
    workspaceVolumeRevision: 0,
    syncStatus: 'synced',
    lastSyncedAt: '2026-08-10T10:00:00.000Z',
    hostSyncEnabled: false,
    workspaceFingerprint: 'abc',
    runtime: { kind: 'node', version: '22.12.0' },
    packageManager: { kind: 'pnpm', version: '9.15.0' },
    startCommand: 'pnpm dev',
    internalPort: 3000,
    domain: 'acme.dev.localhost',
    https: true,
    status: 'ready',
    services: {},
    os: { env: {} },
    hostPort: 52341,
    createdAt: '2026-08-10T10:00:00.000Z',
    lastUsedAt: '2026-08-10T11:00:00.000Z',
    thumbPath: null,
    ...overrides
  }
}

function makeChange(overrides: Partial<Omit<ChangeEntry, 'seq'>> = {}): Omit<ChangeEntry, 'seq'> {
  return {
    id: `chg-${Math.random().toString(36).slice(2)}`,
    roomId: 'room-1',
    kind: 'node-version',
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
    ...overrides
  }
}

function makeReport(i: number): CheckReport {
  return {
    roomId: 'room-1',
    ranAt: new Date(Date.UTC(2026, 7, 10, 12, 0, 0) + i * 1000).toISOString(),
    overall: 'healthy',
    results: [
      { step: 'backend', status: 'healthy', summary: `docker ok ${i}` },
      { step: 'process', status: 'healthy', summary: 'running' },
      { step: 'port', status: 'healthy', summary: 'listening' },
      { step: 'http', status: 'healthy', summary: 'http 200' }
    ]
  }
}

function count(table: string, where = '1=1', ...params: (string | number)[]): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n
}

function bytes(table: string, column: string, where = '1=1', ...params: (string | number)[]): number {
  return (
    db.sqlite
      .prepare(`SELECT COALESCE(SUM(length(CAST(${column} AS BLOB))), 0) AS b FROM ${table} WHERE ${where}`)
      .get(...params) as { b: number }
  ).b
}

describe('openDb contention budget', () => {
  it('proves a nonzero busy_timeout at initialization', () => {
    const row = db.sqlite.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(DB_BUSY_TIMEOUT_MS).toBeGreaterThan(0)
    expect(row.timeout).toBe(DB_BUSY_TIMEOUT_MS)
  })

  it('refuses a zero contention budget rather than opening an unbounded-race database', () => {
    expect(() => openDb(dir, { busyTimeoutMs: 0 })).toThrow(/busy_timeout/)
  })

  it('bounds a contended repository write to the budget, then succeeds once the writer releases', () => {
    const writer = openDb(dir, { busyTimeoutMs: 150 })
    extraDbs.push(writer)
    const rooms = roomsRepo(db)
    const contendedRooms = roomsRepo(writer)
    rooms.create(makeRoom())

    // The first connection holds the write lock across a transaction.
    db.sqlite.exec('BEGIN IMMEDIATE')
    db.sqlite.prepare("UPDATE rooms SET status = 'attention' WHERE id = ?").run('room-1')

    const startedAt = Date.now()
    let failure: unknown = null
    try {
      contendedRooms.update('room-1', { status: 'broken' })
    } catch (error) {
      failure = error
    }
    const waitedMs = Date.now() - startedAt
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/locked|busy/i)
    // Deterministic bound: waits at least the budget, never spins forever.
    expect(waitedMs).toBeGreaterThanOrEqual(100)
    expect(waitedMs).toBeLessThan(5_000)

    db.sqlite.exec('COMMIT')
    contendedRooms.update('room-1', { status: 'broken' })
    expect(rooms.get('room-1')?.status).toBe('broken')
  })
})

describe('checks retention', () => {
  it('keeps only the newest per-Room window under a repeated-check soak', () => {
    const checks = checksRepo(db)
    const soak = CHECKS_RETAINED_PER_ROOM * 10
    const maxReportBytes = Buffer.byteLength(JSON.stringify(makeReport(soak)))
    for (let i = 0; i < soak; i++) checks.saveReport(makeReport(i))
    // Another Room's history is not consumed by this Room's window.
    checks.saveReport({ ...makeReport(0), roomId: 'room-2' })

    expect(count('checks', 'room_id = ?', 'room-1')).toBe(CHECKS_RETAINED_PER_ROOM)
    expect(bytes('checks', 'report_json', 'room_id = ?', 'room-1')).toBeLessThanOrEqual(
      CHECKS_RETAINED_PER_ROOM * maxReportBytes
    )
    expect(count('checks', 'room_id = ?', 'room-2')).toBe(1)
    expect(checks.latest('room-1')?.ranAt).toBe(makeReport(soak - 1).ranAt)
  })
})

describe('android device events retention', () => {
  it('keeps the newest global window and caps detail bytes under an event soak', () => {
    const devices = androidDevicesRepo(db)
    const soak = ANDROID_DEVICE_EVENTS_RETAINED + 250
    for (let i = 0; i < soak; i++) {
      devices.recordEvent({
        deviceId: null,
        roomId: 'room-1',
        kind: 'queued',
        detail: `event ${i} ${'x'.repeat(ANDROID_DEVICE_EVENT_DETAIL_MAX_CHARS * 2)}`,
        at: new Date(Date.UTC(2026, 7, 10) + i * 1000).toISOString()
      })
    }

    expect(count('android_device_events')).toBe(ANDROID_DEVICE_EVENTS_RETAINED)
    expect(bytes('android_device_events', 'detail')).toBeLessThanOrEqual(
      ANDROID_DEVICE_EVENTS_RETAINED * ANDROID_DEVICE_EVENT_DETAIL_MAX_CHARS * 4
    )
    const newest = devices.recentEvents(1)[0]!
    expect(newest.detail.startsWith(`event ${soak - 1} `)).toBe(true)
    expect(newest.detail.length).toBeLessThanOrEqual(ANDROID_DEVICE_EVENT_DETAIL_MAX_CHARS)
    const oldest = db.sqlite.prepare('SELECT detail FROM android_device_events ORDER BY at ASC LIMIT 1').get() as { detail: string }
    expect(oldest.detail.startsWith(`event ${soak - ANDROID_DEVICE_EVENTS_RETAINED} `)).toBe(true)
  })
})

describe('changes retention', () => {
  it('bounds the per-Room journal while retaining pending and install-referenced entries', () => {
    roomsRepo(db).create(makeRoom())
    const changes = changesRepo(db)
    const installs = androidAppInstallsRepo(db)
    const pending = changes.append(makeChange({ id: 'chg-pending', status: 'pending', verify: null }))
    const anchored = changes.append(makeChange({ id: 'chg-anchored', kind: 'android-run' }))
    installs.record({
      roomId: 'room-1',
      target: { kind: 'emulator', targetId: 'room-1', deviceId: null },
      applicationId: 'com.acme.app',
      changeId: anchored.id,
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-10T12:00:01.000Z',
      packageIncarnation: 'b'.repeat(64),
      logFence: null,
      installUserId: 0,
      installUserSerial: 0
    })
    const evicted = changes.append(makeChange({ id: 'chg-evicted' }))

    const soak = CHANGES_RETAINED_PER_ROOM + 50
    for (let i = 0; i < soak; i++) changes.append(makeChange({ createdAt: new Date(Date.UTC(2026, 7, 11) + i * 1000).toISOString() }))
    changes.append(makeChange({ roomId: 'room-2', id: 'chg-other-room' }))

    // Window plus the two protected rows, nothing beyond.
    expect(count('changes', 'room_id = ?', 'room-1')).toBe(CHANGES_RETAINED_PER_ROOM + 2)
    expect(changes.get(pending.id)).not.toBeNull()
    expect(changes.get(anchored.id)).not.toBeNull()
    expect(changes.get(evicted.id)).toBeNull()
    expect(changes.get('chg-other-room')).not.toBeNull()
    // Sequence numbers keep advancing past the pruned prefix.
    const newest = changes.list('room-1')[0]!
    expect(newest.seq).toBe(soak + 3)
    const next = changes.append(makeChange())
    expect(next.seq).toBe(soak + 4)
  })
})
