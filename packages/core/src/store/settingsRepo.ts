import type { Db } from './db'

export interface SettingsRepo {
  get(k: string): string | null
  set(k: string, v: string): void
  setIfAbsent(k: string, v: string): boolean
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
  }
}
