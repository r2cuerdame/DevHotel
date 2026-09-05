import type { OperationError, OperationKind, OperationRecord, OperationStage, OperationStageKey, OperationStatus } from '@devhotel/shared'
import type { Db } from './db'

interface OperationRow {
  id: string
  kind: string
  room_id: string
  actor: string
  request_key: string | null
  status: string
  stage: string
  stages_json: string
  error_json: string | null
  started_at: string
  updated_at: string
  finished_at: string | null
}

function rowToRecord(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    kind: row.kind as OperationKind,
    roomId: row.room_id,
    actor: row.actor as OperationRecord['actor'],
    ...(row.request_key === null ? {} : { requestKey: row.request_key }),
    status: row.status as OperationStatus,
    stage: row.stage as OperationStageKey,
    stages: JSON.parse(row.stages_json) as OperationStage[],
    error: row.error_json === null ? null : (JSON.parse(row.error_json) as OperationError),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}

/** Room operations kept per Room; older finished records are pruned on write. */
const RETAINED_PER_ROOM = 50

export interface OperationsRepo {
  save(record: OperationRecord): void
  get(id: string): OperationRecord | null
  listForRoom(roomId: string, limit?: number): OperationRecord[]
  /**
   * Fails every operation still marked running, for use at startup: nothing is
   * driving them any more, so leaving them `running` would make a poll wait
   * forever on work that died with the previous process.
   */
  failInterrupted(detail: string, now: string): OperationRecord[]
}

export function operationsRepo(db: Db): OperationsRepo {
  const { sqlite } = db
  const repo: OperationsRepo = {
    save(record) {
      sqlite
        .prepare(
          `INSERT INTO operations (
             id, kind, room_id, actor, request_key, status, stage, stages_json, error_json, started_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             stage = excluded.stage,
             stages_json = excluded.stages_json,
             error_json = excluded.error_json,
             updated_at = excluded.updated_at,
             finished_at = excluded.finished_at`
        )
        .run(
          record.id,
          record.kind,
          record.roomId,
          record.actor,
          record.requestKey ?? null,
          record.status,
          record.stage,
          JSON.stringify(record.stages),
          record.error === null ? null : JSON.stringify(record.error),
          record.startedAt,
          record.updatedAt,
          record.finishedAt
        )
      // Keep the newest window per Room. A running operation is never pruned:
      // its ID is the handle a caller is still polling with.
      sqlite
        .prepare(
          `DELETE FROM operations
           WHERE room_id = ? AND status != 'running' AND id NOT IN (
             SELECT id FROM operations WHERE room_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
           )`
        )
        .run(record.roomId, record.roomId, RETAINED_PER_ROOM)
    },
    get(id) {
      const row = sqlite.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined
      return row ? rowToRecord(row) : null
    },
    listForRoom(roomId, limit = 20) {
      const rows = sqlite
        .prepare('SELECT * FROM operations WHERE room_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(roomId, limit) as unknown as OperationRow[]
      return rows.map(rowToRecord)
    },
    failInterrupted(detail, now) {
      const rows = sqlite.prepare("SELECT * FROM operations WHERE status = 'running'").all() as unknown as OperationRow[]
      const failed: OperationRecord[] = []
      for (const row of rows) {
        const record = rowToRecord(row)
        const stages = record.stages.map((stage) =>
          stage.status === 'running' ? { ...stage, status: 'failed' as const, detail, endedAt: now } : stage
        )
        const updated: OperationRecord = {
          ...record,
          status: 'failed',
          stages,
          error: { stage: record.stage, message: detail },
          updatedAt: now,
          finishedAt: now,
        }
        repo.save(updated)
        failed.push(updated)
      }
      return failed
    },
  }
  return repo
}
