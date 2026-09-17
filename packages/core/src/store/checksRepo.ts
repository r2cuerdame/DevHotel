import { randomUUID } from 'node:crypto'
import type { CheckReport } from '@devhotel/shared'
import type { Db } from './db'

/**
 * Check reports kept per Room. Only the latest report is read back today; the
 * window exists so a Room polled every few seconds for weeks cannot grow the
 * control plane without bound. See docs/control-plane-retention.md.
 */
export const CHECKS_RETAINED_PER_ROOM = 20

export interface ChecksRepo {
  saveReport(r: CheckReport): void
  latest(roomId: string): CheckReport | null
}

export function checksRepo(db: Db): ChecksRepo {
  const { sqlite } = db
  return {
    saveReport(r) {
      const ownsTransaction = !sqlite.isTransaction
      if (ownsTransaction) sqlite.exec('BEGIN')
      try {
        sqlite
          .prepare('INSERT INTO checks (id, room_id, ran_at, report_json) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), r.roomId, r.ranAt, JSON.stringify(r))
        sqlite
          .prepare(
            `DELETE FROM checks WHERE rowid IN (
               SELECT rowid FROM checks WHERE room_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT -1 OFFSET ?
             )`
          )
          .run(r.roomId, CHECKS_RETAINED_PER_ROOM)
        if (ownsTransaction) sqlite.exec('COMMIT')
      } catch (error) {
        if (ownsTransaction && sqlite.isTransaction) sqlite.exec('ROLLBACK')
        throw error
      }
    },
    latest(roomId) {
      const row = sqlite
        .prepare('SELECT report_json FROM checks WHERE room_id = ? ORDER BY ran_at DESC LIMIT 1')
        .get(roomId) as { report_json: string } | undefined
      return row ? (JSON.parse(row.report_json) as CheckReport) : null
    },
  }
}
