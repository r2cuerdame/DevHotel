import { randomUUID } from 'node:crypto'
import type { CheckReport } from '@devhotel/shared'
import type { Db } from './db'

export interface ChecksRepo {
  saveReport(r: CheckReport): void
  latest(roomId: string): CheckReport | null
}

export function checksRepo(db: Db): ChecksRepo {
  const { sqlite } = db
  return {
    saveReport(r) {
      sqlite
        .prepare('INSERT INTO checks (id, room_id, ran_at, report_json) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), r.roomId, r.ranAt, JSON.stringify(r))
    },
    latest(roomId) {
      const row = sqlite
        .prepare('SELECT report_json FROM checks WHERE room_id = ? ORDER BY ran_at DESC LIMIT 1')
        .get(roomId) as { report_json: string } | undefined
      return row ? (JSON.parse(row.report_json) as CheckReport) : null
    },
  }
}
