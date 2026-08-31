import {
  zAndroidAcceptanceMacIdentity,
  type AndroidAcceptanceMacIdentity,
  type AndroidInstallReceipt
} from '@devhotel/shared'
import type { Db } from './db'

const DIGEST_PINNED_IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$/

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
  install_user_serial: number | null
  acceptance_artifact_size_bytes: number | null
  acceptance_source_state_revision: number | null
  acceptance_source_workspace_revision: number | null
  acceptance_source_identity_hmac: string | null
  acceptance_environment_identity_hmac: string | null
  acceptance_image_reference: string | null
  acceptance_image_sha256: string | null
}

export interface AndroidInstallAcceptanceProvenance {
  artifactSizeBytes: number
  stateRevision: number
  workspaceVolumeRevision: number
  sourceIdentity: AndroidAcceptanceMacIdentity
  environmentIdentity: AndroidAcceptanceMacIdentity
  imageReference: string
  imageSha256: string
}

function acceptanceProvenance(row: AndroidInstallRow): AndroidInstallAcceptanceProvenance | null {
  if (
    row.acceptance_artifact_size_bytes === null ||
    row.acceptance_source_state_revision === null ||
    row.acceptance_source_workspace_revision === null ||
    row.acceptance_source_identity_hmac === null ||
    row.acceptance_environment_identity_hmac === null ||
    row.acceptance_image_reference === null ||
    row.acceptance_image_sha256 === null
  ) return null
  const sourceIdentity: AndroidAcceptanceMacIdentity = {
    algorithm: 'hmac-sha256', keyVersion: 1, domain: 'source',
    value: row.acceptance_source_identity_hmac
  }
  const environmentIdentity: AndroidAcceptanceMacIdentity = {
    algorithm: 'hmac-sha256', keyVersion: 1, domain: 'environment',
    value: row.acceptance_environment_identity_hmac
  }
  if (
    !Number.isSafeInteger(row.acceptance_artifact_size_bytes) || row.acceptance_artifact_size_bytes < 1 ||
    row.acceptance_artifact_size_bytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(row.acceptance_source_state_revision) || row.acceptance_source_state_revision < 0 ||
    !Number.isSafeInteger(row.acceptance_source_workspace_revision) || row.acceptance_source_workspace_revision < 0 ||
    !/^[a-f0-9]{64}$/.test(sourceIdentity.value) ||
    !/^[a-f0-9]{64}$/.test(environmentIdentity.value) ||
    !/^[a-f0-9]{64}$/.test(row.acceptance_image_sha256) ||
    !DIGEST_PINNED_IMAGE_REFERENCE.test(row.acceptance_image_reference) ||
    /@sha256:([a-f0-9]{64})$/.exec(row.acceptance_image_reference)?.[1] !== row.acceptance_image_sha256
  ) return null
  return {
    artifactSizeBytes: row.acceptance_artifact_size_bytes,
    stateRevision: row.acceptance_source_state_revision,
    workspaceVolumeRevision: row.acceptance_source_workspace_revision,
    sourceIdentity,
    environmentIdentity,
    imageReference: row.acceptance_image_reference,
    imageSha256: row.acceptance_image_sha256
  }
}

function validateAcceptanceProvenance(value: AndroidInstallAcceptanceProvenance): void {
  const source = zAndroidAcceptanceMacIdentity.safeParse(value.sourceIdentity)
  const environment = zAndroidAcceptanceMacIdentity.safeParse(value.environmentIdentity)
  if (
    !Number.isSafeInteger(value.artifactSizeBytes) || value.artifactSizeBytes < 1 ||
    value.artifactSizeBytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(value.stateRevision) || value.stateRevision < 0 ||
    !Number.isSafeInteger(value.workspaceVolumeRevision) || value.workspaceVolumeRevision < 0 ||
    !source.success || source.data.domain !== 'source' ||
    !environment.success || environment.data.domain !== 'environment' ||
    !DIGEST_PINNED_IMAGE_REFERENCE.test(value.imageReference) ||
    !/^[a-f0-9]{64}$/.test(value.imageSha256) ||
    /@sha256:([a-f0-9]{64})$/.exec(value.imageReference)?.[1] !== value.imageSha256
  ) {
    throw new Error('Android install acceptance provenance is invalid')
  }
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
    installUserSerial: number
    /** Required in production; omitted legacy/test rows fail acceptance closed. */
    acceptanceProvenance?: AndroidInstallAcceptanceProvenance
  }): AndroidInstallReceipt
  get(roomId: string, target: AndroidInstallTarget, applicationId: string): AndroidInstallReceipt | null
  list(roomId: string, target: AndroidInstallTarget): AndroidInstallReceipt[]
  packageIncarnation(roomId: string, target: AndroidInstallTarget, applicationId: string): string | null
  logFence(roomId: string, target: AndroidInstallTarget, applicationId: string): string | null
  installUserAuthority(
    roomId: string,
    target: AndroidInstallTarget,
    applicationId: string
  ): { userId: number; serial: number } | null
  acceptanceProvenance(
    roomId: string,
    target: AndroidInstallTarget,
    applicationId: string
  ): AndroidInstallAcceptanceProvenance | null
  remove(roomId: string, target: AndroidInstallTarget, applicationId: string): void
  removeForChange(roomId: string, changeId: string): void
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
      if (input.acceptanceProvenance) validateAcceptanceProvenance(input.acceptanceProvenance)
      sqlite.prepare(
        `INSERT INTO android_app_installs (
           target_kind, target_id, lease_id, application_id, room_id, change_id, apk_sha256, installed_at,
           package_incarnation, log_fence, install_user_id, install_user_serial,
           acceptance_artifact_size_bytes, acceptance_source_state_revision,
           acceptance_source_workspace_revision, acceptance_source_identity_hmac,
           acceptance_environment_identity_hmac, acceptance_image_reference, acceptance_image_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_kind, target_id, application_id) DO UPDATE SET
           lease_id = excluded.lease_id,
           room_id = excluded.room_id,
           change_id = excluded.change_id,
           apk_sha256 = excluded.apk_sha256,
           installed_at = excluded.installed_at,
           package_incarnation = excluded.package_incarnation,
           log_fence = excluded.log_fence,
           install_user_id = excluded.install_user_id,
           install_user_serial = excluded.install_user_serial,
           acceptance_artifact_size_bytes = excluded.acceptance_artifact_size_bytes,
           acceptance_source_state_revision = excluded.acceptance_source_state_revision,
           acceptance_source_workspace_revision = excluded.acceptance_source_workspace_revision,
           acceptance_source_identity_hmac = excluded.acceptance_source_identity_hmac,
           acceptance_environment_identity_hmac = excluded.acceptance_environment_identity_hmac,
           acceptance_image_reference = excluded.acceptance_image_reference,
           acceptance_image_sha256 = excluded.acceptance_image_sha256`
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
        input.installUserId,
        input.installUserSerial,
        input.acceptanceProvenance?.artifactSizeBytes ?? null,
        input.acceptanceProvenance?.stateRevision ?? null,
        input.acceptanceProvenance?.workspaceVolumeRevision ?? null,
        input.acceptanceProvenance?.sourceIdentity.value ?? null,
        input.acceptanceProvenance?.environmentIdentity.value ?? null,
        input.acceptanceProvenance?.imageReference ?? null,
        input.acceptanceProvenance?.imageSha256 ?? null
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
    installUserAuthority(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT install_user_id, install_user_serial FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as Pick<
        AndroidInstallRow,
        'install_user_id' | 'install_user_serial'
      > | undefined
      if (!row || row.install_user_id === null || row.install_user_serial === null) return null
      return { userId: row.install_user_id, serial: row.install_user_serial }
    },
    acceptanceProvenance(roomId, target, applicationId) {
      const row = sqlite.prepare(
        `SELECT * FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).get(roomId, ...targetParams(target), applicationId) as AndroidInstallRow | undefined
      return row ? acceptanceProvenance(row) : null
    },
    remove(roomId, target, applicationId) {
      sqlite.prepare(
        `DELETE FROM android_app_installs
         WHERE room_id = ? AND target_kind = ? AND target_id = ? AND lease_id IS ? AND application_id = ?`
      ).run(roomId, ...targetParams(target), applicationId)
    },
    removeForChange(roomId, changeId) {
      sqlite.prepare(
        'DELETE FROM android_app_installs WHERE room_id = ? AND change_id = ?'
      ).run(roomId, changeId)
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
