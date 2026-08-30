import { randomUUID } from 'node:crypto'
import type {
  AndroidDevice,
  DeviceConstraints,
  DeviceEvent,
  DeviceEventKind,
  DeviceLease,
  DeviceQueueEntry,
  LeasePurpose
} from '@devhotel/shared'
import type { Db } from './db'

interface DeviceRow {
  id: string
  serial: string
  nickname: string
  model: string | null
  android_version: string | null
  api_level: number | null
  connection: string
  health: string
  first_seen_at: string
  last_seen_at: string
}

interface LeaseRow {
  id: string
  device_id: string
  room_id: string
  project: string
  issue_ref: string | null
  run_id: string | null
  worker_id: string
  purpose: string
  state: string
  acquired_at: string
  heartbeat_at: string
  activity_at: string
  ttl_ms: number
  max_duration_ms: number
  released_at: string | null
  release_reason: string | null
}

interface QueueRow {
  id: string
  device_id: string | null
  room_id: string
  project: string
  purpose: string
  worker_id: string
  issue_ref: string | null
  run_id: string | null
  constraints_json: string
  priority: number
  state: string
  requested_at: string
  resolved_at: string | null
  ttl_ms: number
  max_duration_ms: number
}

interface EventRow {
  id: string
  device_id: string | null
  room_id: string | null
  kind: string
  detail: string
  at: string
}

const toDevice = (row: DeviceRow): AndroidDevice => ({
  id: row.id,
  serial: row.serial,
  nickname: row.nickname,
  model: row.model,
  androidVersion: row.android_version,
  apiLevel: row.api_level,
  connection: row.connection as AndroidDevice['connection'],
  health: row.health as AndroidDevice['health'],
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at
})

const toLease = (row: LeaseRow): DeviceLease => ({
  id: row.id,
  deviceId: row.device_id,
  roomId: row.room_id,
  project: row.project,
  issueRef: row.issue_ref,
  runId: row.run_id,
  workerId: row.worker_id,
  purpose: row.purpose as LeasePurpose,
  state: row.state as DeviceLease['state'],
  acquiredAt: row.acquired_at,
  heartbeatAt: row.heartbeat_at,
  activityAt: row.activity_at,
  ttlMs: row.ttl_ms,
  maxDurationMs: row.max_duration_ms,
  releasedAt: row.released_at,
  releaseReason: row.release_reason
})

const toQueueEntry = (row: QueueRow): DeviceQueueEntry => ({
  id: row.id,
  deviceId: row.device_id,
  roomId: row.room_id,
  project: row.project,
  purpose: row.purpose as LeasePurpose,
  workerId: row.worker_id,
  issueRef: row.issue_ref,
  runId: row.run_id,
  constraints: JSON.parse(row.constraints_json) as DeviceConstraints,
  priority: row.priority,
  state: row.state as DeviceQueueEntry['state'],
  requestedAt: row.requested_at,
  resolvedAt: row.resolved_at,
  ttlMs: row.ttl_ms,
  maxDurationMs: row.max_duration_ms
})

const toEvent = (row: EventRow): DeviceEvent => ({
  id: row.id,
  deviceId: row.device_id,
  roomId: row.room_id,
  kind: row.kind as DeviceEventKind,
  detail: row.detail,
  at: row.at
})

export interface DeviceUpsert {
  id: string
  serial: string
  nickname: string
  model: string | null
  androidVersion: string | null
  apiLevel: number | null
  connection: AndroidDevice['connection']
  health: AndroidDevice['health']
  seenAt: string
}

export interface LeaseInsert {
  deviceId: string
  roomId: string
  project: string
  issueRef: string | null
  runId: string | null
  workerId: string
  purpose: LeasePurpose
  at: string
  ttlMs: number
  maxDurationMs: number
}

export interface QueueInsert {
  deviceId: string | null
  roomId: string
  project: string
  purpose: LeasePurpose
  workerId: string
  issueRef: string | null
  runId: string | null
  constraints: DeviceConstraints
  priority: number
  at: string
  ttlMs: number
  maxDurationMs: number
}

export interface AndroidDevicesRepo {
  listDevices(): AndroidDevice[]
  getDevice(id: string): AndroidDevice | null
  getDeviceBySerial(serial: string): AndroidDevice | null
  upsertDevice(input: DeviceUpsert): AndroidDevice
  markHealth(id: string, health: AndroidDevice['health'], at: string): void
  setNickname(id: string, nickname: string): AndroidDevice
  activeLease(deviceId: string): DeviceLease | null
  activeLeaseForRoom(roomId: string): DeviceLease | null
  latestLeaseForRoom(roomId: string): DeviceLease | null
  listActiveLeases(): DeviceLease[]
  getLease(id: string): DeviceLease | null
  insertLease(input: LeaseInsert): DeviceLease
  touchLease(id: string, heartbeatAt: string, activityAt: string | null): DeviceLease
  closeLease(id: string, state: 'released' | 'expired' | 'revoked', at: string, reason: string): DeviceLease
  acknowledgeRevokedLease(id: string, at: string, reason: string): DeviceLease
  waiting(deviceId: string | null): DeviceQueueEntry[]
  waitingForRoom(roomId: string, deviceId: string | null): DeviceQueueEntry | null
  getQueueEntry(id: string): DeviceQueueEntry | null
  enqueue(input: QueueInsert): DeviceQueueEntry
  resolveQueueEntry(id: string, state: 'granted' | 'cancelled', at: string): DeviceQueueEntry
  recordEvent(input: { deviceId: string | null; roomId: string | null; kind: DeviceEventKind; detail: string; at: string }): DeviceEvent
  recentEvents(limit?: number): DeviceEvent[]
}

export function androidDevicesRepo(db: Db): AndroidDevicesRepo {
  const { sqlite } = db
  const repo: AndroidDevicesRepo = {
    listDevices: () =>
      (sqlite.prepare('SELECT * FROM android_devices ORDER BY nickname, serial').all() as unknown as DeviceRow[]).map(toDevice),
    getDevice(id) {
      const row = sqlite.prepare('SELECT * FROM android_devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined
      return row ? toDevice(row) : null
    },
    getDeviceBySerial(serial) {
      const row = sqlite.prepare('SELECT * FROM android_devices WHERE serial = ?').get(serial) as unknown as DeviceRow | undefined
      return row ? toDevice(row) : null
    },
    upsertDevice(input) {
      // A reconnect must keep the nickname a human gave the phone, and must not
      // rewrite when the device was first seen.
      sqlite
        .prepare(
          `INSERT INTO android_devices
             (id, serial, nickname, model, android_version, api_level, connection, health, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(serial) DO UPDATE SET
             model = COALESCE(excluded.model, android_devices.model),
             android_version = COALESCE(excluded.android_version, android_devices.android_version),
             api_level = COALESCE(excluded.api_level, android_devices.api_level),
             connection = excluded.connection,
             health = excluded.health,
             last_seen_at = excluded.last_seen_at`
        )
        .run(
          input.id,
          input.serial,
          input.nickname,
          input.model,
          input.androidVersion,
          input.apiLevel,
          input.connection,
          input.health,
          input.seenAt,
          input.seenAt
        )
      // The serial is private but is the durable identity key. The public ID is
      // random, so a racing discovery must retain whichever opaque ID was
      // persisted first rather than fail or replace it.
      return repo.getDeviceBySerial(input.serial)!
    },
    markHealth(id, health, at) {
      sqlite.prepare('UPDATE android_devices SET health = ?, last_seen_at = ? WHERE id = ?').run(health, at, id)
    },
    setNickname(id, nickname) {
      const changed = sqlite.prepare('UPDATE android_devices SET nickname = ? WHERE id = ?').run(nickname, id)
      if (changed.changes === 0) throw new Error(`unknown Android device: ${id}`)
      return repo.getDevice(id)!
    },
    activeLease(deviceId) {
      const row = sqlite
        .prepare("SELECT * FROM android_device_leases WHERE device_id = ? AND state = 'active'")
        .get(deviceId) as unknown as LeaseRow | undefined
      return row ? toLease(row) : null
    },
    activeLeaseForRoom(roomId) {
      const row = sqlite
        .prepare("SELECT * FROM android_device_leases WHERE room_id = ? AND state = 'active'")
        .get(roomId) as unknown as LeaseRow | undefined
      return row ? toLease(row) : null
    },
    latestLeaseForRoom(roomId) {
      const row = sqlite
        .prepare('SELECT * FROM android_device_leases WHERE room_id = ? ORDER BY acquired_at DESC, rowid DESC LIMIT 1')
        .get(roomId) as unknown as LeaseRow | undefined
      return row ? toLease(row) : null
    },
    listActiveLeases: () =>
      (sqlite.prepare("SELECT * FROM android_device_leases WHERE state = 'active' ORDER BY acquired_at").all() as unknown as LeaseRow[]).map(toLease),
    getLease(id) {
      const row = sqlite.prepare('SELECT * FROM android_device_leases WHERE id = ?').get(id) as unknown as LeaseRow | undefined
      return row ? toLease(row) : null
    },
    insertLease(input) {
      const id = randomUUID()
      sqlite
        .prepare(
          `INSERT INTO android_device_leases
             (id, device_id, room_id, project, issue_ref, run_id, worker_id, purpose, state,
              acquired_at, heartbeat_at, activity_at, ttl_ms, max_duration_ms, released_at, release_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(
          id,
          input.deviceId,
          input.roomId,
          input.project,
          input.issueRef,
          input.runId,
          input.workerId,
          input.purpose,
          input.at,
          input.at,
          input.at,
          input.ttlMs,
          input.maxDurationMs
        )
      return repo.getLease(id)!
    },
    touchLease(id, heartbeatAt, activityAt) {
      const changed = sqlite
        .prepare(
          `UPDATE android_device_leases
             SET heartbeat_at = ?, activity_at = COALESCE(?, activity_at)
           WHERE id = ? AND state = 'active'`
        )
        .run(heartbeatAt, activityAt, id)
      if (changed.changes === 0) throw new Error(`no active lease to heartbeat: ${id}`)
      return repo.getLease(id)!
    },
    closeLease(id, state, at, reason) {
      const changed = sqlite
        .prepare(
          `UPDATE android_device_leases SET state = ?, released_at = ?, release_reason = ?
           WHERE id = ? AND state = 'active'`
        )
        .run(state, at, reason, id)
      if (changed.changes === 0) throw new Error(`no active lease to close: ${id}`)
      return repo.getLease(id)!
    },
    acknowledgeRevokedLease(id, at, reason) {
      const changed = sqlite
        .prepare(
          `UPDATE android_device_leases SET released_at = ?, release_reason = ?
           WHERE id = ? AND state = 'revoked' AND release_reason = 'device disconnected'`
        )
        .run(at, reason, id)
      if (changed.changes === 0) throw new Error(`no disconnected lease to acknowledge: ${id}`)
      return repo.getLease(id)!
    },
    waiting(deviceId) {
      const rows =
        deviceId === null
          ? (sqlite
              .prepare("SELECT * FROM android_device_queue WHERE state = 'waiting' ORDER BY priority DESC, requested_at, rowid")
              .all() as unknown as QueueRow[])
          : (sqlite
              .prepare(
                `SELECT * FROM android_device_queue
                 WHERE state = 'waiting' AND (device_id = ? OR device_id IS NULL)
                 ORDER BY priority DESC, requested_at, rowid`
              )
              .all(deviceId) as unknown as QueueRow[])
      return rows.map(toQueueEntry)
    },
    waitingForRoom(roomId, deviceId) {
      const row = sqlite
        .prepare("SELECT * FROM android_device_queue WHERE state = 'waiting' AND room_id = ? AND device_id IS ?")
        .get(roomId, deviceId) as unknown as QueueRow | undefined
      return row ? toQueueEntry(row) : null
    },
    getQueueEntry(id) {
      const row = sqlite.prepare('SELECT * FROM android_device_queue WHERE id = ?').get(id) as unknown as QueueRow | undefined
      return row ? toQueueEntry(row) : null
    },
    enqueue(input) {
      const id = randomUUID()
      sqlite
        .prepare(
          `INSERT INTO android_device_queue
             (id, device_id, room_id, project, purpose, worker_id, issue_ref, run_id, constraints_json,
              priority, state, requested_at, resolved_at, ttl_ms, max_duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, NULL, ?, ?)`
        )
        .run(
          id,
          input.deviceId,
          input.roomId,
          input.project,
          input.purpose,
          input.workerId,
          input.issueRef,
          input.runId,
          JSON.stringify(input.constraints),
          input.priority,
          input.at,
          input.ttlMs,
          input.maxDurationMs
        )
      return repo.getQueueEntry(id)!
    },
    resolveQueueEntry(id, state, at) {
      const changed = sqlite
        .prepare("UPDATE android_device_queue SET state = ?, resolved_at = ? WHERE id = ? AND state = 'waiting'")
        .run(state, at, id)
      if (changed.changes === 0) throw new Error(`no waiting queue entry: ${id}`)
      return repo.getQueueEntry(id)!
    },
    recordEvent(input) {
      const id = randomUUID()
      sqlite
        .prepare('INSERT INTO android_device_events (id, device_id, room_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.deviceId, input.roomId, input.kind, input.detail, input.at)
      return { id, deviceId: input.deviceId, roomId: input.roomId, kind: input.kind, detail: input.detail, at: input.at }
    },
    recentEvents: (limit = 50) =>
      (sqlite.prepare('SELECT * FROM android_device_events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as unknown as EventRow[]).map(toEvent)
  }
  return repo
}
