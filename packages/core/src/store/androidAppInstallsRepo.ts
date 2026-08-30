import type { AndroidInstallReceipt } from '@devhotel/shared'
import type { Db } from './db'

export type AndroidInstallTarget =
  | { kind: 'emulator'; targetId: string; deviceId: null }
  | { kind: 'physical'; targetId: string; deviceId: string; leaseId: string }

interface AndroidInstallRow {
  target_kind: 'emulator' | 'physical'
  target_id: string
  lease_id: string | null
  application_id: string
  room_id: string
  change_id: string
  apk_sha256: string
  installed_at: string
}

function receipt(row: AndroidInstallRow): AndroidInstallReceipt {
  return {
    roomId: row.room_id,
    target: {
      kind: row.target_kind,
      deviceId: row.target_kind === 'physical' ? row.target_id : null
    },
    applicationId: row.application_id,
    changeId: row.change_id,
    apkSha256: row.apk_sha256,
    installedAt: row.installed_at
  }
}

export interface AndroidAppInstallsRepo {
  record(input: {
    roomId: string
    target: AndroidInstallTarget
    applicationId: string
    changeId: string
    apkSha256: string
    installedAt: string
  }): AndroidInstallReceipt
  get(roomId: string, target: AndroidInstallTarget, applicationId: string): AndroidInstallReceipt | null
  list(roomId: string, target: AndroidInstallTarget): AndroidInstallReceipt[]
  remove(roomId: string, target: AndroidInstallTarget, applicationId: string): void
  clearTarget(roomId: string, target: AndroidInstallTarget): void
}

export function androidAppInstallsRepo(db: Db): AndroidAppInstallsRepo {
  const sqlite = db.sqlite
  const targetParams = (target: AndroidInstallTarget): [string, string, string | null] => [
    target.kind,
    target.targetId,
    target.kind === 'physical' ? target.leaseId : null
  ]
  return {
    record(input) {
      sqlite.prepare(
        `INSERT INTO android_app_installs (
           target_kind, target_id, lease_id, application_id, room_id, change_id, apk_sha256, installed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_kind, target_id, application_id) DO UPDATE SET
           lease_id = excluded.lease_id,
           room_id = excluded.room_id,
           change_id = excluded.change_id,
           apk_sha256 = excluded.apk_sha256,
           installed_at = excluded.installed_at`
      ).run(
        input.target.kind,
        input.target.targetId,
        input.target.kind === 'physical' ? input.target.leaseId : null,
        input.applicationId,
        input.roomId,
        input.changeId,
        input.apkSha256,
        input.installedAt
      )
      return this.get(input.roomId, input.target, input.applicationId)!
    },
    get(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT * FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as AndroidInstallRow | undefined
      return row ? receipt(row) : null
    },
    list(roomId, target) {
      return (sqlite.prepare(
        `SELECT * FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ?
         ORDER BY application_id`
      ).all(roomId, ...targetParams(target)) as unknown as AndroidInstallRow[]).map(receipt)
    },
    remove(roomId, target, applicationId) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).run(roomId, ...targetParams(target), applicationId)
    },
    clearTarget(roomId, target) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ?`
      ).run(roomId, ...targetParams(target))
    }
  }
}
