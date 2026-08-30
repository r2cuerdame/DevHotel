import { createHmac, randomUUID } from 'node:crypto'
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
import { redactSecrets } from '../diagnostics/redact'

interface DeviceRow {
  id: string
  serial: string
  physical_identity: string
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
  // Read-time redaction covers rows created by older builds as well as the
  // write-time sink below.
  detail: redactSecrets(row.detail),
  at: row.at
})

export interface DeviceUpsert {
  id: string
  serial: string
  physicalIdentity: string
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

export interface LeaseGrant {
  lease: DeviceLease
  cancelledWaiters: DeviceQueueEntry[]
}

export interface AndroidDevicesRepo {
  listDevices(): AndroidDevice[]
  getDevice(id: string): AndroidDevice | null
  getDeviceBySerial(serial: string): AndroidDevice | null
  getDeviceByPhysicalIdentity(physicalIdentity: string): AndroidDevice | null
  getPhysicalIdentityBySerial(serial: string): string | null
  /** Install-keyed correlation token; raw probe output never enters a correlation column or event. */
  physicalIdentity(material: string, domain: 'physical' | 'transport'): string
  upsertDevice(input: DeviceUpsert): AndroidDevice
  markHealth(id: string, health: AndroidDevice['health'], at: string): void
  setNickname(id: string, nickname: string): AndroidDevice
  activeLease(deviceId: string): DeviceLease | null
  activeLeaseForRoom(roomId: string): DeviceLease | null
  latestLeaseForRoom(roomId: string): DeviceLease | null
  listActiveLeases(): DeviceLease[]
  getLease(id: string): DeviceLease | null
  /** Atomically creates the lease and consumes this Room's durable queue rows. */
  grantLease(input: LeaseInsert, queuedRequestId: string | null): LeaseGrant
  touchLease(id: string, heartbeatAt: string, activityAt: string | null): DeviceLease
  closeLease(id: string, state: 'released' | 'expired' | 'revoked', at: string, reason: string): DeviceLease
  acknowledgeRevokedLease(id: string, at: string, reason: string): DeviceLease
  waiting(deviceId: string | null): DeviceQueueEntry[]
  waitingForRoom(roomId: string): DeviceQueueEntry | null
  getQueueEntry(id: string): DeviceQueueEntry | null
  enqueue(input: QueueInsert): DeviceQueueEntry
  resolveQueueEntry(id: string, state: 'granted' | 'cancelled', at: string): DeviceQueueEntry
  recordEvent(input: { deviceId: string | null; roomId: string | null; kind: DeviceEventKind; detail: string; at: string }): DeviceEvent
  recentEvents(limit?: number): DeviceEvent[]
}

export function androidDevicesRepo(db: Db): AndroidDevicesRepo {
  const { sqlite } = db
  const secret = sqlite
    .prepare("SELECT value FROM android_device_broker_secrets WHERE name = 'physical-identity-hmac-v1'")
    .get() as { value: Uint8Array } | undefined
  if (!secret || secret.value.byteLength !== 32) throw new Error('Android Device Broker identity key is unavailable')
  const identityKey = Buffer.from(secret.value)
  const deviceRowById = (id: string): DeviceRow | undefined =>
    sqlite.prepare('SELECT * FROM android_devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined
  const deviceRowBySerial = (serial: string): DeviceRow | undefined =>
    sqlite.prepare('SELECT * FROM android_devices WHERE serial = ?').get(serial) as unknown as DeviceRow | undefined
  const deviceRowByPhysicalIdentity = (physicalIdentity: string): DeviceRow | undefined =>
    sqlite.prepare('SELECT * FROM android_devices WHERE physical_identity = ?').get(physicalIdentity) as unknown as DeviceRow | undefined
  const repo: AndroidDevicesRepo = {
    listDevices: () =>
      (sqlite.prepare('SELECT * FROM android_devices ORDER BY nickname, serial').all() as unknown as DeviceRow[]).map(toDevice),
    getDevice(id) {
      const row = deviceRowById(id)
      return row ? toDevice(row) : null
    },
    getDeviceBySerial(serial) {
      const row = deviceRowBySerial(serial)
      return row ? toDevice(row) : null
    },
    getDeviceByPhysicalIdentity(physicalIdentity) {
      const row = deviceRowByPhysicalIdentity(physicalIdentity)
      return row ? toDevice(row) : null
    },
    getPhysicalIdentityBySerial(serial) {
      return deviceRowBySerial(serial)?.physical_identity ?? null
    },
    physicalIdentity(material, domain) {
      return createHmac('sha256', identityKey)
        .update(`devhotel.android-device.${domain}\0`, 'utf8')
        .update(material, 'utf8')
        .digest('hex')
    },
    upsertDevice(input) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const identityRow = deviceRowByPhysicalIdentity(input.physicalIdentity)
        const serialRow = deviceRowBySerial(input.serial)
        let survivor = identityRow ?? serialRow
        let merged: DeviceRow | null = null

        if (identityRow && serialRow && identityRow.id !== serialRow.id) {
          const identityActive = sqlite
            .prepare("SELECT 1 FROM android_device_leases WHERE device_id = ? AND state = 'active'")
            .get(identityRow.id)
          const serialActive = sqlite
            .prepare("SELECT 1 FROM android_device_leases WHERE device_id = ? AND state = 'active'")
            .get(serialRow.id)
          if (identityActive && serialActive) {
            throw new Error('one physical Android device has multiple active lease records')
          }

          // An active lease owns its exact transport until release. Otherwise
          // the existing physical-identity row keeps its public opaque ID and
          // human nickname while an alternate transport is folded into it.
          survivor = serialActive ? serialRow : identityRow
          merged = survivor.id === identityRow.id ? serialRow : identityRow

          sqlite.prepare('UPDATE android_device_leases SET device_id = ? WHERE device_id = ?').run(survivor.id, merged.id)
          const pinnedRows = sqlite
            .prepare('SELECT id, constraints_json FROM android_device_queue WHERE device_id = ?')
            .all(merged.id) as unknown as { id: string; constraints_json: string }[]
          for (const row of pinnedRows) {
            const constraints = JSON.parse(row.constraints_json) as DeviceConstraints
            if (constraints.deviceId === merged.id) constraints.deviceId = survivor.id
            sqlite
              .prepare('UPDATE android_device_queue SET device_id = ?, constraints_json = ? WHERE id = ?')
              .run(survivor.id, JSON.stringify(constraints), row.id)
          }
          sqlite.prepare('UPDATE android_device_events SET device_id = ? WHERE device_id = ?').run(survivor.id, merged.id)
          sqlite.prepare('DELETE FROM android_devices WHERE id = ?').run(merged.id)
        }

        if (!survivor) {
          sqlite
            .prepare(
              `INSERT INTO android_devices
                 (id, serial, physical_identity, nickname, model, android_version, api_level,
                  connection, health, first_seen_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              input.id,
              input.serial,
              input.physicalIdentity,
              input.nickname,
              input.model,
              input.androidVersion,
              input.apiLevel,
              input.connection,
              input.health,
              input.seenAt,
              input.seenAt
            )
          survivor = deviceRowById(input.id)!
        } else {
          const activeLease = sqlite
            .prepare("SELECT 1 FROM android_device_leases WHERE device_id = ? AND state = 'active'")
            .get(survivor.id)
          if (activeLease && survivor.serial !== input.serial) {
            // A different broker process may have granted between inventory
            // planning and this transaction. Never rewrite the exact serial an
            // in-flight lease captured; the caller retries from fresh state.
            throw new Error('active Android device transport changed during inventory reconciliation')
          }
          const firstSeenAt = merged && merged.first_seen_at < survivor.first_seen_at
            ? merged.first_seen_at
            : survivor.first_seen_at
          sqlite
            .prepare(
              `UPDATE android_devices
                 SET serial = ?, physical_identity = ?,
                     model = COALESCE(?, model, ?),
                     android_version = COALESCE(?, android_version, ?),
                     api_level = COALESCE(?, api_level, ?),
                     connection = ?, health = ?, first_seen_at = ?, last_seen_at = ?
               WHERE id = ?`
            )
            .run(
              input.serial,
              input.physicalIdentity,
              input.model,
              merged?.model ?? null,
              input.androidVersion,
              merged?.android_version ?? null,
              input.apiLevel,
              merged?.api_level ?? null,
              input.connection,
              input.health,
              firstSeenAt,
              input.seenAt,
              survivor.id
            )
        }
        const persistedId = survivor.id
        sqlite.exec('COMMIT')
        return repo.getDevice(persistedId)!
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
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
    grantLease(input, queuedRequestId) {
      const id = randomUUID()
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        if (queuedRequestId !== null) {
          const chosen = sqlite
            .prepare("SELECT * FROM android_device_queue WHERE id = ? AND state = 'waiting'")
            .get(queuedRequestId) as unknown as QueueRow | undefined
          if (!chosen) throw new Error(`no waiting queue entry: ${queuedRequestId}`)
          if (chosen.room_id !== input.roomId) throw new Error('queued lease Room does not match the selected request')
        }

        const cancelledRows = (queuedRequestId === null
          ? sqlite
              .prepare("SELECT * FROM android_device_queue WHERE room_id = ? AND state = 'waiting' ORDER BY priority DESC, requested_at, rowid")
              .all(input.roomId)
          : sqlite
              .prepare("SELECT * FROM android_device_queue WHERE room_id = ? AND state = 'waiting' AND id <> ? ORDER BY priority DESC, requested_at, rowid")
              .all(input.roomId, queuedRequestId)) as unknown as QueueRow[]

        // Insert first. If exclusivity or any other write fails, the surrounding
        // transaction leaves every durable waiter in place for the next sweep.
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

        if (queuedRequestId !== null) {
          const granted = sqlite
            .prepare("UPDATE android_device_queue SET state = 'granted', resolved_at = ? WHERE id = ? AND state = 'waiting'")
            .run(input.at, queuedRequestId)
          if (granted.changes !== 1) throw new Error(`no waiting queue entry: ${queuedRequestId}`)
        }
        for (const row of cancelledRows) {
          const cancelled = sqlite
            .prepare("UPDATE android_device_queue SET state = 'cancelled', resolved_at = ? WHERE id = ? AND state = 'waiting'")
            .run(input.at, row.id)
          if (cancelled.changes !== 1) throw new Error(`no waiting queue entry: ${row.id}`)
        }
        const leaseRow = sqlite.prepare('SELECT * FROM android_device_leases WHERE id = ?').get(id) as unknown as
          | LeaseRow
          | undefined
        if (!leaseRow) throw new Error(`lease insert did not persist: ${id}`)
        const lease = toLease(leaseRow)
        sqlite.exec('COMMIT')

        return {
          lease,
          cancelledWaiters: cancelledRows.map((row) => ({
            ...toQueueEntry(row),
            state: 'cancelled',
            resolvedAt: input.at
          }))
        }
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
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
    waitingForRoom(roomId) {
      const row = sqlite
        .prepare("SELECT * FROM android_device_queue WHERE state = 'waiting' AND room_id = ? ORDER BY priority DESC, requested_at, rowid LIMIT 1")
        .get(roomId) as unknown as QueueRow | undefined
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
      const detail = redactSecrets(input.detail)
      sqlite
        .prepare('INSERT INTO android_device_events (id, device_id, room_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.deviceId, input.roomId, input.kind, detail, input.at)
      return { id, deviceId: input.deviceId, roomId: input.roomId, kind: input.kind, detail, at: input.at }
    },
    recentEvents: (limit = 50) =>
      (sqlite.prepare('SELECT * FROM android_device_events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as unknown as EventRow[]).map(toEvent)
  }
  return repo
}
