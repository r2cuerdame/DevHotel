import type { PmKind, ProviderKind, RoomOsSettings, RoomRecord, RoomServices, RoomStatus, SourceType } from '@devhotel/shared'
import type { Db } from './db'

interface RoomRow {
  id: string
  project: string
  nickname: string
  room_number: number
  provider: string
  source_type: string
  source_ref: string
  runtime_kind: string
  runtime_version: string
  pm_kind: string
  pm_version: string | null
  start_command: string
  internal_port: number
  domain: string
  https: number
  status: string
  host_port: number | null
  created_at: string
  last_used_at: string
  thumb_path: string | null
  extra: string
}

interface ExtraJson {
  services?: RoomServices
  os?: RoomOsSettings
}

function parseExtra(extra: string): ExtraJson {
  try {
    return JSON.parse(extra) as ExtraJson
  } catch {
    return {}
  }
}

function rowToRoom(row: RoomRow): RoomRecord {
  return {
    id: row.id,
    project: row.project,
    nickname: row.nickname,
    roomNumber: row.room_number,
    provider: row.provider as ProviderKind,
    sourceType: row.source_type as SourceType,
    sourceRef: row.source_ref,
    runtime: { kind: row.runtime_kind as 'node' | 'jdk', version: row.runtime_version },
    packageManager: {
      kind: row.pm_kind as PmKind,
      ...(row.pm_version === null ? {} : { version: row.pm_version }),
    },
    startCommand: row.start_command,
    internalPort: row.internal_port,
    domain: row.domain,
    https: row.https === 1,
    status: row.status as RoomStatus,
    services: parseExtra(row.extra).services ?? {},
    os: parseExtra(row.extra).os ?? { env: {} },
    hostPort: row.host_port,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    thumbPath: row.thumb_path,
  }
}

type ColumnValue = string | number | null

function patchToColumns(patch: Partial<RoomRecord>): Record<string, ColumnValue> {
  const cols: Record<string, ColumnValue> = {}
  if (patch.project !== undefined) cols['project'] = patch.project
  if (patch.nickname !== undefined) cols['nickname'] = patch.nickname
  if (patch.roomNumber !== undefined) cols['room_number'] = patch.roomNumber
  if (patch.provider !== undefined) cols['provider'] = patch.provider
  if (patch.sourceType !== undefined) cols['source_type'] = patch.sourceType
  if (patch.sourceRef !== undefined) cols['source_ref'] = patch.sourceRef
  if (patch.runtime !== undefined) {
    cols['runtime_kind'] = patch.runtime.kind
    cols['runtime_version'] = patch.runtime.version
  }
  if (patch.packageManager !== undefined) {
    cols['pm_kind'] = patch.packageManager.kind
    cols['pm_version'] = patch.packageManager.version ?? null
  }
  if (patch.startCommand !== undefined) cols['start_command'] = patch.startCommand
  if (patch.internalPort !== undefined) cols['internal_port'] = patch.internalPort
  if (patch.domain !== undefined) cols['domain'] = patch.domain
  if (patch.https !== undefined) cols['https'] = patch.https ? 1 : 0
  if (patch.status !== undefined) cols['status'] = patch.status
  if (patch.hostPort !== undefined) cols['host_port'] = patch.hostPort
  if (patch.createdAt !== undefined) cols['created_at'] = patch.createdAt
  if (patch.lastUsedAt !== undefined) cols['last_used_at'] = patch.lastUsedAt
  if (patch.thumbPath !== undefined) cols['thumb_path'] = patch.thumbPath
  return cols
}

export interface RoomsRepo {
  create(r: RoomRecord): void
  get(id: string): RoomRecord | null
  list(): RoomRecord[]
  update(id: string, patch: Partial<RoomRecord>): void
  delete(id: string): void
  nextRoomNumber(): number
}

export function roomsRepo(db: Db): RoomsRepo {
  const { sqlite } = db
  return {
    create(r) {
      sqlite
        .prepare(
          `INSERT INTO rooms (
            id, project, nickname, room_number, provider, source_type, source_ref,
            runtime_kind, runtime_version, pm_kind, pm_version, start_command,
            internal_port, domain, https, status, host_port, created_at,
            last_used_at, thumb_path, extra
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.project,
          r.nickname,
          r.roomNumber,
          r.provider,
          r.sourceType,
          r.sourceRef,
          r.runtime.kind,
          r.runtime.version,
          r.packageManager.kind,
          r.packageManager.version ?? null,
          r.startCommand,
          r.internalPort,
          r.domain,
          r.https ? 1 : 0,
          r.status,
          r.hostPort,
          r.createdAt,
          r.lastUsedAt,
          r.thumbPath,
          JSON.stringify({ services: r.services ?? {}, os: r.os ?? { env: {} } }),
        )
    },
    get(id) {
      const row = sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined
      return row ? rowToRoom(row) : null
    },
    list() {
      const rows = sqlite
        .prepare('SELECT * FROM rooms ORDER BY last_used_at DESC')
        .all() as unknown as RoomRow[]
      return rows.map(rowToRoom)
    },
    update(id, patch) {
      const cols = patchToColumns(patch)
      if (patch.services !== undefined || patch.os !== undefined) {
        const row = sqlite.prepare('SELECT extra FROM rooms WHERE id = ?').get(id) as { extra: string } | undefined
        const extra = parseExtra(row?.extra ?? '{}')
        if (patch.services !== undefined) extra.services = patch.services
        if (patch.os !== undefined) extra.os = patch.os
        cols['extra'] = JSON.stringify(extra)
      }
      const names = Object.keys(cols)
      if (names.length === 0) return
      const assignments = names.map((n) => `${n} = ?`).join(', ')
      const values = names.map((n) => cols[n] ?? null)
      sqlite.prepare(`UPDATE rooms SET ${assignments} WHERE id = ?`).run(...values, id)
    },
    delete(id) {
      sqlite.prepare('DELETE FROM rooms WHERE id = ?').run(id)
    },
    nextRoomNumber() {
      const row = sqlite.prepare('SELECT MAX(room_number) AS m FROM rooms').get() as
        | { m: number | null }
        | undefined
      const max = row?.m ?? null
      return max === null ? 201 : max + 1
    },
  }
}
