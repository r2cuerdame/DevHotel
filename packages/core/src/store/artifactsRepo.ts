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
    metadata = sanitizeAndroidScreenshotArtifactMetadata(JSON.parse(row.metadata_json))
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
  insert(input: ArtifactInsert): RoomArtifact
  getForRoom(roomId: string, artifactId: string): RoomArtifact | null
  listForRoom(roomId: string, limit?: number): RoomArtifact[]
  usageForRoom(roomId: string): { count: number; bytes: number }
  idsForRoom(roomId: string): Set<string>
  deleteForRoom(roomId: string, artifactId: string): void
}

export function artifactsRepo(db: Db): ArtifactsRepo {
  const { sqlite } = db
  return {
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
