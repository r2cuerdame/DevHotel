import type { Db } from './db'

export interface SettingsRepo {
  get(k: string): string | null
  set(k: string, v: string): void
  setIfAbsent(k: string, v: string): boolean
  /** Claim one recovery intent only while every Room-mutating intent key is absent. */
  setIfAbsentWhenKeysAbsent(
    k: string,
    v: string,
    mutuallyExclusiveKeys: readonly [string, string, string]
  ): boolean
  setIfAbsentForActiveAndroidLease(
    k: string,
    v: string,
    lease: { id: string; deviceId: string; roomId: string }
  ): boolean
  setIfValue(k: string, expected: string, next: string): boolean
  delete(k: string): void
  deleteIfValue(k: string, v: string): boolean
  /** Release a setting only while the owning Room still has the exact durable revision. */
  deleteIfValueAndRoomRevision(
    k: string,
    v: string,
    roomId: string,
    workspaceVolumeRevision: number,
    stateRevision: number
  ): boolean
  deleteIfValueForActiveAndroidLease(
    k: string,
    v: string,
    lease: { id: string; deviceId: string; roomId: string }
  ): boolean
}

export function settingsRepo(db: Db): SettingsRepo {
  const { sqlite } = db
  return {
    get(k) {
      const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(k) as
        | { value: string }
        | undefined
      return row ? row.value : null
    },
    set(k, v) {
      sqlite
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(k, v)
    },
    setIfAbsent(k, v) {
      const result = sqlite
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
        .run(k, v)
      return result.changes === 1
    },
    setIfAbsentWhenKeysAbsent(k, v, mutuallyExclusiveKeys) {
      if (sqlite.isTransaction) {
        throw new Error('Room recovery intent claims require their own autocommit write')
      }
      if (
        !mutuallyExclusiveKeys.includes(k) ||
        new Set(mutuallyExclusiveKeys).size !== mutuallyExclusiveKeys.length
      ) {
        throw new Error('Room recovery intent keys must be distinct and include the claimed key')
      }
      // Keep this as one SQLite write statement. Separate reads followed by an
      // insert let two desktop processes claim different recovery keys after
      // both have observed the Room as idle. The write transaction serializes
      // those claims, and the later statement observes the earlier winner.
      const result = sqlite
        .prepare(
          `INSERT INTO settings (key, value)
           SELECT ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM settings WHERE key IN (?, ?, ?)
            )
           ON CONFLICT(key) DO NOTHING`
        )
        .run(k, v, ...mutuallyExclusiveKeys)
      return result.changes === 1
    },
    setIfAbsentForActiveAndroidLease(k, v, lease) {
      // One SQLite write statement is the hand-off from the active physical
      // lease to durable recovery ownership. Automatic lease closure performs
      // its final protection read under a competing write transaction, so the
      // two outcomes serialize: either this intent wins while the exact lease
      // is active, or closure wins and this insert affects no row.
      const result = sqlite
        .prepare(
          `INSERT INTO settings (key, value)
           SELECT ?, ?
             FROM android_device_leases
            WHERE id = ? AND device_id = ? AND room_id = ? AND state = 'active'
           ON CONFLICT(key) DO NOTHING`
        )
        .run(k, v, lease.id, lease.deviceId, lease.roomId)
      return result.changes === 1
    },
    setIfValue(k, expected, next) {
      const result = sqlite
        .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
        .run(next, k, expected)
      return result.changes === 1
    },
    delete(k) {
      sqlite.prepare('DELETE FROM settings WHERE key = ?').run(k)
    },
    deleteIfValue(k, v) {
      const result = sqlite.prepare('DELETE FROM settings WHERE key = ? AND value = ?').run(k, v)
      return result.changes === 1
    },
    deleteIfValueAndRoomRevision(k, v, roomId, workspaceVolumeRevision, stateRevision) {
      // One SQLite statement makes the Room fence check and intent release
      // indivisible across multiple desktop processes sharing this database.
      const result = sqlite.prepare(
        `DELETE FROM settings
         WHERE key = ? AND value = ?
           AND EXISTS (
             SELECT 1 FROM rooms
             WHERE id = ? AND workspace_volume_revision = ? AND state_revision = ?
           )`
      ).run(k, v, roomId, workspaceVolumeRevision, stateRevision)
      return result.changes === 1
    },
    deleteIfValueForActiveAndroidLease(k, v, lease) {
      // Serialize the final recovery release with every physical-lease close.
      // If the lease was lost first, retain the intent; if deletion wins first,
      // a later close is safe because the original locale was already sealed.
      const result = sqlite
        .prepare(
          `DELETE FROM settings
            WHERE key = ? AND value = ?
              AND EXISTS (
                SELECT 1 FROM android_device_leases
                 WHERE id = ? AND device_id = ? AND room_id = ? AND state = 'active'
              )`
        )
        .run(k, v, lease.id, lease.deviceId, lease.roomId)
      return result.changes === 1
    },
  }
}
