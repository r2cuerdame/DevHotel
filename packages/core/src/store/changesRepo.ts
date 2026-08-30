import type { Actor, ChangeEntry, ChangeStatus } from '@devhotel/shared'
import type { Db } from './db'

interface ChangeRow {
  id: string
  room_id: string
  seq: number
  kind: string
  title: string
  actor: string
  component: string
  before_json: string | null
  after_json: string | null
  captured_json: string | null
  steps_json: string
  verify_json: string | null
  undoable: number
  undo_strategy: string
  status: string
  raw_log_path: string | null
  created_at: string
  undone_at: string | null
}

function toJson(value: unknown): string | null {
  const s = JSON.stringify(value)
  return s === undefined ? null : s
}

function fromJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text)
}

function rowToEntry(row: ChangeRow): ChangeEntry {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: row.seq,
    kind: row.kind,
    title: row.title,
    actor: row.actor as Actor,
    component: row.component,
    before: fromJson(row.before_json),
    after: fromJson(row.after_json),
    captured: fromJson(row.captured_json),
    steps: JSON.parse(row.steps_json) as string[],
    verify: row.verify_json === null
      ? null
      : (JSON.parse(row.verify_json) as { ok: boolean; detail: string }),
    undoable: row.undoable === 1,
    undoStrategy: row.undo_strategy,
    status: row.status as ChangeStatus,
    rawLogPath: row.raw_log_path,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  }
}

type SetStatusPatch = Partial<Pick<ChangeEntry, 'verify' | 'undoneAt' | 'captured' | 'steps' | 'rawLogPath'>>

export interface ChangesRepo {
  append(e: Omit<ChangeEntry, 'seq'>): ChangeEntry
  list(roomId: string): ChangeEntry[]
  get(id: string): ChangeEntry | null
  setStatus(id: string, status: ChangeEntry['status'], patch?: SetStatusPatch): void
  lastUndoable(roomId: string): ChangeEntry | null
}

export function changesRepo(db: Db): ChangesRepo {
  const { sqlite } = db
  return {
    append(e) {
      const ownsTransaction = !sqlite.isTransaction
      if (ownsTransaction) sqlite.exec('BEGIN')
      try {
        const row = sqlite
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM changes WHERE room_id = ?')
          .get(e.roomId) as { s: number }
        const seq = row.s
        sqlite
          .prepare(
            `INSERT INTO changes (
              id, room_id, seq, kind, title, actor, component, before_json, after_json,
              captured_json, steps_json, verify_json, undoable, undo_strategy,
              status, raw_log_path, created_at, undone_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            e.id,
            e.roomId,
            seq,
            e.kind,
            e.title,
            e.actor,
            e.component,
            toJson(e.before),
            toJson(e.after),
            toJson(e.captured),
            JSON.stringify(e.steps),
            e.verify === null ? null : JSON.stringify(e.verify),
            e.undoable ? 1 : 0,
            e.undoStrategy,
            e.status,
            e.rawLogPath,
            e.createdAt,
            e.undoneAt,
          )
        if (ownsTransaction) sqlite.exec('COMMIT')
        return { ...e, seq }
      } catch (err) {
        if (ownsTransaction && sqlite.isTransaction) sqlite.exec('ROLLBACK')
        throw err
      }
    },
    list(roomId) {
      const rows = sqlite
        .prepare('SELECT * FROM changes WHERE room_id = ? ORDER BY seq DESC')
        .all(roomId) as unknown as ChangeRow[]
      return rows.map(rowToEntry)
    },
    get(id) {
      const row = sqlite.prepare('SELECT * FROM changes WHERE id = ?').get(id) as
        | ChangeRow
        | undefined
      return row ? rowToEntry(row) : null
    },
    setStatus(id, status, patch) {
      const assignments = ['status = ?']
      const values: (string | number | null)[] = [status]
      if (patch) {
        if ('verify' in patch) {
          assignments.push('verify_json = ?')
          values.push(patch.verify == null ? null : JSON.stringify(patch.verify))
        }
        if ('undoneAt' in patch) {
          assignments.push('undone_at = ?')
          values.push(patch.undoneAt ?? null)
        }
        if ('captured' in patch) {
          assignments.push('captured_json = ?')
          values.push(toJson(patch.captured))
        }
        if ('steps' in patch) {
          assignments.push('steps_json = ?')
          values.push(JSON.stringify(patch.steps ?? []))
        }
        if ('rawLogPath' in patch) {
          assignments.push('raw_log_path = ?')
          values.push(patch.rawLogPath ?? null)
        }
      }
      sqlite
        .prepare(`UPDATE changes SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values, id)
    },
    lastUndoable(roomId) {
      const row = sqlite
        .prepare(
          `SELECT * FROM changes
           WHERE room_id = ? AND undoable = 1 AND status IN ('verified', 'applied') AND verify_json IS NOT NULL
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(roomId) as ChangeRow | undefined
      return row ? rowToEntry(row) : null
    },
  }
}
