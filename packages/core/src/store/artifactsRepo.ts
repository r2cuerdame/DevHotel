import {
  zRoomArtifact,
  type Actor,
  type AndroidScreenshotArtifactMetadata,
  type RoomArtifact
} from '@devhotel/shared'
import { sanitizeAndroidScreenshotArtifactMetadata } from '../artifacts/sanitize'
import type { Db } from './db'

interface ArtifactRow {
  id: string
  room_id: string
  kind: string
  filename: string
  media_type: string
  size_bytes: number
  sha256: string
  actor: string
  created_at: string
  metadata_json: string
}

function rowToArtifact(row: ArtifactRow): RoomArtifact {
  let metadata: unknown
  try {
    // Keep the persisted receipt exact here. Dynamic secret registrations may
    // change over time; response-boundary sanitization must not change the
    // database side of the immutable disk-receipt comparison.
    metadata = JSON.parse(row.metadata_json)
  } catch {
    throw new Error(`Artifact ${row.id} has invalid metadata JSON`)
  }
  return zRoomArtifact.parse({
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    actor: row.actor,
    createdAt: row.created_at,
    metadata
  })
}

export interface ArtifactInsert {
  id: string
  roomId: string
  filename: string
  sizeBytes: number
  sha256: string
  actor: Actor
  createdAt: string
  metadata: AndroidScreenshotArtifactMetadata
}

export interface ArtifactsRepo {
  /**
   * Serialize filesystem publication/reconciliation with every other process
   * that shares this SQLite database. The callback is synchronous so the
   * BEGIN IMMEDIATE lock cannot escape its lexical operation.
   */
  withWriteTransaction<T>(work: () => T): T
  insert(input: ArtifactInsert): RoomArtifact
  hasRoomRevision(roomId: string, stateRevision: number, workspaceVolumeRevision: number): boolean
  getForRoom(roomId: string, artifactId: string): RoomArtifact | null
  listForRoom(roomId: string, limit?: number): RoomArtifact[]
  usageForRoom(roomId: string): { count: number; bytes: number }
  idsForRoom(roomId: string): Set<string>
  deleteForRoom(roomId: string, artifactId: string): void
}

export function artifactsRepo(db: Db): ArtifactsRepo {
  const { sqlite } = db
  return {
    withWriteTransaction(work) {
      if (sqlite.isTransaction) throw new Error('Artifact write transaction cannot be nested')
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = work()
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec('ROLLBACK')
        throw error
      }
    },
    insert(input) {
      const metadata = sanitizeAndroidScreenshotArtifactMetadata(input.metadata)
      const ownsTransaction = !sqlite.isTransaction
      if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE')
      try {
        sqlite
          .prepare(
            `INSERT INTO room_artifacts (
               id, room_id, kind, filename, media_type, size_bytes, sha256, actor, created_at, metadata_json
             ) VALUES (?, ?, 'android-screenshot', ?, 'image/png', ?, ?, ?, ?, ?)`
          )
          .run(
            input.id,
            input.roomId,
            input.filename,
            input.sizeBytes,
            input.sha256,
            input.actor,
            input.createdAt,
            JSON.stringify(metadata)
          )
        const inserted = this.getForRoom(input.roomId, input.id)
        if (!inserted) throw new Error('Artifact receipt was not inserted')
        if (ownsTransaction) sqlite.exec('COMMIT')
        return inserted
      } catch (error) {
        if (ownsTransaction && sqlite.isTransaction) sqlite.exec('ROLLBACK')
        throw error
      }
    },
    hasRoomRevision(roomId, stateRevision, workspaceVolumeRevision) {
      return sqlite.prepare(
        `SELECT 1 FROM rooms
         WHERE id = ? AND state_revision = ? AND workspace_volume_revision = ?`
      ).get(roomId, stateRevision, workspaceVolumeRevision) !== undefined
    },
    getForRoom(roomId, artifactId) {
      const row = sqlite
        .prepare('SELECT * FROM room_artifacts WHERE room_id = ? AND id = ?')
        .get(roomId, artifactId) as unknown as ArtifactRow | undefined
      return row ? rowToArtifact(row) : null
    },
    listForRoom(roomId, limit = 20) {
      const rows = sqlite
        .prepare('SELECT * FROM room_artifacts WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(roomId, limit) as unknown as ArtifactRow[]
      return rows.map(rowToArtifact)
    },
    usageForRoom(roomId) {
      const row = sqlite
        .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM room_artifacts WHERE room_id = ?')
        .get(roomId) as { count: number; bytes: number }
      return row
    },
    idsForRoom(roomId) {
      const rows = sqlite
        .prepare('SELECT id FROM room_artifacts WHERE room_id = ?')
        .all(roomId) as unknown as { id: string }[]
      return new Set(rows.map((row) => row.id))
    },
    deleteForRoom(roomId, artifactId) {
      sqlite.prepare('DELETE FROM room_artifacts WHERE room_id = ? AND id = ?').run(roomId, artifactId)
    }
  }
}
