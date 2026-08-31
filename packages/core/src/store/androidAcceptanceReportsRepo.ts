import { isDeepStrictEqual } from 'node:util'
import {
  ANDROID_ACCEPTANCE_PINNED_RUN_MAX_BYTES_PER_ROOM,
  ANDROID_ACCEPTANCE_PINNED_RUN_MAX_PER_ROOM,
  ANDROID_ACCEPTANCE_REPORT_MAX_PER_ROOM,
  ANDROID_ACCEPTANCE_REPORT_MAX_ROOM_BYTES,
  zAndroidAcceptanceLogRef,
  type AndroidAcceptanceLogRef,
  type AndroidAcceptanceReport,
  type AndroidAcceptanceReportSummary
} from '@devhotel/shared'
import type { AndroidAcceptanceIntegrity } from '../androidAcceptanceIntegrity'
import {
  acceptanceReportSize,
  acceptanceReportSummary,
  verifyAndroidAcceptanceReport
} from '../androidAcceptanceReport'
import type { Db } from './db'

interface AcceptanceReportRow {
  id: string
  room_id: string
  stage: 'development' | 'final-physical'
  status: 'pass' | 'fail'
  application_id: string
  created_at: string
  size_bytes: number
  seal_hmac: string
  report_json: string
}

interface RunSnapshotRow {
  room_id: string
  run_id: string
  identity_hmac: string
  size_bytes: number
  snapshot_json: string
}

export interface AndroidAcceptanceReportsRepo {
  insert(report: AndroidAcceptanceReport): AndroidAcceptanceReport
  getForRoom(roomId: string, reportId: string): AndroidAcceptanceReport | null
  listReportsForRoom(roomId: string, limit?: number): AndroidAcceptanceReport[]
  listForRoom(roomId: string, limit?: number): AndroidAcceptanceReportSummary[]
  usageForRoom(roomId: string): { count: number; bytes: number }
  pinnedUsageForRoom(roomId: string): { count: number; bytes: number }
  isRunPinned(roomId: string, runId: string): boolean
}

export function androidAcceptanceReportsRepo(
  db: Db,
  integrity: AndroidAcceptanceIntegrity,
  options: {
    maxPerRoom?: number
    maxRoomBytes?: number
    maxPinnedRunsPerRoom?: number
    maxPinnedRunBytesPerRoom?: number
  } = {}
): AndroidAcceptanceReportsRepo {
  const { sqlite } = db
  const maxPerRoom = options.maxPerRoom ?? ANDROID_ACCEPTANCE_REPORT_MAX_PER_ROOM
  const maxRoomBytes = options.maxRoomBytes ?? ANDROID_ACCEPTANCE_REPORT_MAX_ROOM_BYTES
  const maxPinnedRunsPerRoom = options.maxPinnedRunsPerRoom ?? ANDROID_ACCEPTANCE_PINNED_RUN_MAX_PER_ROOM
  const maxPinnedRunBytesPerRoom = options.maxPinnedRunBytesPerRoom ?? ANDROID_ACCEPTANCE_PINNED_RUN_MAX_BYTES_PER_ROOM

  const hydrate = (row: AcceptanceReportRow): AndroidAcceptanceReport => {
    let value: unknown
    try {
      value = JSON.parse(row.report_json)
    } catch {
      throw new Error(`Android acceptance report ${row.id} has invalid JSON`)
    }
    const report = verifyAndroidAcceptanceReport(value, integrity)
    if (
      report.id !== row.id || report.roomId !== row.room_id || report.stage !== row.stage ||
      report.status !== row.status || report.applicationId !== row.application_id ||
      report.createdAt !== row.created_at || report.seal.value !== row.seal_hmac ||
      acceptanceReportSize(report) !== row.size_bytes
    ) {
      throw new Error(`Android acceptance report ${row.id} receipt does not match its durable row`)
    }

    const snapshots = sqlite.prepare(
      `SELECT s.* FROM android_acceptance_report_runs rr
       JOIN android_acceptance_run_snapshots s
         ON s.room_id = rr.room_id AND s.run_id = rr.run_id
       WHERE rr.report_id = ? AND rr.room_id = ? ORDER BY s.run_id`
    ).all(report.id, report.roomId) as unknown as RunSnapshotRow[]
    if (snapshots.length !== report.logs.length) {
      throw new Error(`Android acceptance report ${row.id} has incomplete retained-run pins`)
    }
    const expected = new Map(report.logs.map((log) => [log.runId, log]))
    for (const snapshot of snapshots) {
      let parsed: AndroidAcceptanceLogRef
      try {
        parsed = zAndroidAcceptanceLogRef.parse(JSON.parse(snapshot.snapshot_json))
      } catch {
        throw new Error(`Android acceptance report ${row.id} has a corrupt retained-run pin`)
      }
      const log = expected.get(snapshot.run_id)
      if (
        snapshot.room_id !== report.roomId || snapshot.identity_hmac !== parsed.identity.value ||
        snapshot.size_bytes !== parsed.sizeBytes || !log || !isDeepStrictEqual(parsed, log)
      ) {
        throw new Error(`Android acceptance report ${row.id} retained-run pin does not match its receipt`)
      }
      expected.delete(snapshot.run_id)
    }
    if (expected.size !== 0) throw new Error(`Android acceptance report ${row.id} has missing retained-run pins`)
    return report
  }

  const getForRoom = (roomId: string, reportId: string): AndroidAcceptanceReport | null => {
    const row = sqlite
      .prepare('SELECT * FROM android_acceptance_reports WHERE room_id = ? AND id = ?')
      .get(roomId, reportId) as unknown as AcceptanceReportRow | undefined
    return row ? hydrate(row) : null
  }
  const usageForRoom = (roomId: string): { count: number; bytes: number } => sqlite
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM android_acceptance_reports WHERE room_id = ?')
    .get(roomId) as { count: number; bytes: number }
  const pinnedUsageForRoom = (roomId: string): { count: number; bytes: number } => sqlite
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM android_acceptance_run_snapshots WHERE room_id = ?')
    .get(roomId) as { count: number; bytes: number }
  const listReportsForRoom = (roomId: string, limit = 20): AndroidAcceptanceReport[] => (
    sqlite
      .prepare('SELECT * FROM android_acceptance_reports WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(roomId, limit) as unknown as AcceptanceReportRow[]
  ).map(hydrate)

  return {
    insert(value) {
      const report = verifyAndroidAcceptanceReport(value, integrity)
      const reportJson = JSON.stringify(report)
      const sizeBytes = Buffer.byteLength(reportJson, 'utf8')
      const ownsTransaction = !sqlite.isTransaction
      if (ownsTransaction) sqlite.exec('BEGIN IMMEDIATE')
      try {
        const usage = usageForRoom(report.roomId)
        if (usage.count >= maxPerRoom || usage.bytes + sizeBytes > maxRoomBytes) {
          throw new Error(`Room Android acceptance report quota reached (${maxPerRoom} reports / ${maxRoomBytes} bytes)`)
        }

        const newSnapshots: AndroidAcceptanceLogRef[] = []
        for (const log of report.logs) {
          const existing = sqlite.prepare(
            'SELECT * FROM android_acceptance_run_snapshots WHERE room_id = ? AND run_id = ?'
          ).get(report.roomId, log.runId) as unknown as RunSnapshotRow | undefined
          if (!existing) {
            newSnapshots.push(log)
            continue
          }
          let existingLog: AndroidAcceptanceLogRef
          try {
            existingLog = zAndroidAcceptanceLogRef.parse(JSON.parse(existing.snapshot_json))
          } catch {
            throw new Error(`Retained run ${log.runId} has a corrupt acceptance pin`)
          }
          if (
            existing.identity_hmac !== log.identity.value || existing.size_bytes !== log.sizeBytes ||
            !isDeepStrictEqual(existingLog, log)
          ) {
            throw new Error(`Retained run ${log.runId} no longer matches its immutable acceptance pin`)
          }
        }
        const pinnedUsage = pinnedUsageForRoom(report.roomId)
        const additionalBytes = newSnapshots.reduce((total, log) => total + log.sizeBytes, 0)
        if (
          pinnedUsage.count + newSnapshots.length > maxPinnedRunsPerRoom ||
          pinnedUsage.bytes + additionalBytes > maxPinnedRunBytesPerRoom
        ) {
          throw new Error(
            `Room Android acceptance retained-run quota reached (${maxPinnedRunsPerRoom} runs / ${maxPinnedRunBytesPerRoom} bytes)`
          )
        }

        sqlite.prepare(
          `INSERT INTO android_acceptance_reports (
             id, room_id, stage, status, application_id, created_at, size_bytes, seal_hmac, report_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          report.id, report.roomId, report.stage, report.status, report.applicationId,
          report.createdAt, sizeBytes, report.seal.value, reportJson
        )
        for (const log of newSnapshots) {
          sqlite.prepare(
            `INSERT INTO android_acceptance_run_snapshots
               (room_id, run_id, identity_hmac, size_bytes, snapshot_json)
             VALUES (?, ?, ?, ?, ?)`
          ).run(report.roomId, log.runId, log.identity.value, log.sizeBytes, JSON.stringify(log))
        }
        for (const log of report.logs) {
          sqlite.prepare(
            `INSERT INTO android_acceptance_report_runs (report_id, room_id, run_id)
             VALUES (?, ?, ?)`
          ).run(report.id, report.roomId, log.runId)
        }
        const inserted = getForRoom(report.roomId, report.id)
        if (!inserted) throw new Error('Android acceptance report receipt was not inserted')
        if (ownsTransaction) sqlite.exec('COMMIT')
        return inserted
      } catch (error) {
        if (ownsTransaction && sqlite.isTransaction) sqlite.exec('ROLLBACK')
        throw error
      }
    },
    getForRoom,
    listReportsForRoom,
    listForRoom(roomId, limit = 20) {
      return listReportsForRoom(roomId, limit).map(acceptanceReportSummary)
    },
    usageForRoom,
    pinnedUsageForRoom,
    isRunPinned(roomId, runId) {
      return Boolean(sqlite.prepare(
        'SELECT 1 FROM android_acceptance_run_snapshots WHERE room_id = ? AND run_id = ?'
      ).get(roomId, runId))
    }
  }
}
