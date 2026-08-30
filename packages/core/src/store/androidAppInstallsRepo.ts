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
  package_incarnation: string
  log_fence: string | null
  install_user_id: number | null
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
    packageIncarnation: string
    logFence: string | null
    installUserId: number
  }): AndroidInstallReceipt
  get(roomId: string, target: AndroidInstallTarget, applicationId: string): AndroidInstallReceipt | null
  list(roomId: string, target: AndroidInstallTarget): AndroidInstallReceipt[]
  packageIncarnation(roomId: string, target: AndroidInstallTarget, applicationId: string): string | null
  logFence(roomId: string, target: AndroidInstallTarget, applicationId: string): string | null
  installUserId(roomId: string, target: AndroidInstallTarget, applicationId: string): number | null
  remove(roomId: string, target: AndroidInstallTarget, applicationId: string): void
  invalidateTargetApplication(target: AndroidInstallTarget, applicationId: string): void
  invalidateTarget(target: Pick<AndroidInstallTarget, 'kind' | 'targetId'>): void
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
           target_kind, target_id, lease_id, application_id, room_id, change_id, apk_sha256, installed_at,
           package_incarnation, log_fence, install_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_kind, target_id, application_id) DO UPDATE SET
           lease_id = excluded.lease_id,
           room_id = excluded.room_id,
           change_id = excluded.change_id,
           apk_sha256 = excluded.apk_sha256,
           installed_at = excluded.installed_at,
           package_incarnation = excluded.package_incarnation,
           log_fence = excluded.log_fence,
           install_user_id = excluded.install_user_id`
      ).run(
        input.target.kind,
        input.target.targetId,
        input.target.kind === 'physical' ? input.target.leaseId : null,
        input.applicationId,
        input.roomId,
        input.changeId,
        input.apkSha256,
        input.installedAt,
        input.packageIncarnation,
        input.logFence,
        input.installUserId
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
    packageIncarnation(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT package_incarnation FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as Pick<AndroidInstallRow, 'package_incarnation'> | undefined
      return row?.package_incarnation ?? null
    },
    logFence(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT log_fence FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as Pick<AndroidInstallRow, 'log_fence'> | undefined
      return row?.log_fence ?? null
    },
    installUserId(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT install_user_id FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as Pick<AndroidInstallRow, 'install_user_id'> | undefined
      return row?.install_user_id ?? null
    },
    remove(roomId, target, applicationId) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).run(roomId, ...targetParams(target), applicationId)
    },
    invalidateTargetApplication(target, applicationId) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE target_kind = ? AND target_id = ? AND application_id = ?`
      ).run(target.kind, target.targetId, applicationId)
    },
    invalidateTarget(target) {
      sqlite.prepare(
        'DELETE FROM android_app_installs WHERE target_kind = ? AND target_id = ?'
      ).run(target.kind, target.targetId)
    },
    clearTarget(roomId, target) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ?`
      ).run(roomId, ...targetParams(target))
    }
  }
}
