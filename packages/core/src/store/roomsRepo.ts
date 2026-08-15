import type {
  PmKind,
  ProviderKind,
  RoomOsSettings,
  RoomRecord,
  RoomServices,
  RoomStatus,
  SourceType,
  WorkspaceMode,
  WorkspaceSyncStatus
} from '@devhotel/shared'
import type { Db } from './db'

interface RoomRow {
  id: string
  project: string
  nickname: string
  room_number: number
  provider: string
  source_type: string
  source_ref: string
  workspace_mode: string | null
  state_revision: number
  workspace_volume_revision: number
  sync_status: string | null
  last_synced_at: string | null
  host_sync_enabled: number
  workspace_fingerprint: string | null
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
  agentHostSync?: boolean
  android?: {
    device: string
    version: string
    resolution?: 'native' | 'balanced' | 'fast'
    orientation?: 'portrait' | 'landscape'
  }
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
    provider: parseProvider(row.provider, row.id),
    sourceType: row.source_type as SourceType,
    sourceRef: row.source_ref,
    workspaceMode: (row.workspace_mode ?? legacyWorkspaceMode(row.source_type)) as WorkspaceMode,
    stateRevision: row.state_revision ?? 0,
    workspaceVolumeRevision: row.workspace_volume_revision ?? 0,
    syncStatus: (row.sync_status ?? legacySyncStatus(row.source_type)) as WorkspaceSyncStatus,
    lastSyncedAt: row.last_synced_at,
    hostSyncEnabled: row.host_sync_enabled === 1,
    workspaceFingerprint: row.workspace_fingerprint,
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
    ...(parseExtra(row.extra).agentHostSync !== undefined
      ? { agentHostSync: parseExtra(row.extra).agentHostSync }
      : {}),
    ...(parseExtra(row.extra).android ? { android: parseExtra(row.extra).android } : {}),
    hostPort: row.host_port,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    thumbPath: row.thumb_path,
  }
}

type ColumnValue = string | number | null

const KNOWN_PROVIDERS: readonly ProviderKind[] = ['web', 'android', 'windows']

/**
 * A stored provider must be one this build knows. An unknown value used to be
 * cast straight through, and since every runtime branch reads "android or else
 * web", such a Room would quietly boot as a Node/Debian Web Room with Web
 * checks and Web change kinds. Corruption fails loudly here instead; a known
 * but unservable provider is caught where the Room is actually run.
 */
function parseProvider(value: string, roomId: string): ProviderKind {
  if ((KNOWN_PROVIDERS as readonly string[]).includes(value)) return value as ProviderKind
  throw new Error(
    `Room ${roomId} records provider '${value}', which this DevHotel build does not know. ` +
      'The Room database was written by a newer version or edited by hand.'
  )
}

function patchToColumns(patch: Partial<RoomRecord>): Record<string, ColumnValue> {
  const cols: Record<string, ColumnValue> = {}
  if (patch.project !== undefined) cols['project'] = patch.project
  if (patch.nickname !== undefined) cols['nickname'] = patch.nickname
  if (patch.roomNumber !== undefined) cols['room_number'] = patch.roomNumber
  if (patch.provider !== undefined) cols['provider'] = patch.provider
  if (patch.sourceType !== undefined) cols['source_type'] = patch.sourceType
  if (patch.sourceRef !== undefined) cols['source_ref'] = patch.sourceRef
  if (patch.workspaceMode !== undefined) cols['workspace_mode'] = patch.workspaceMode
  if (patch.stateRevision !== undefined) cols['state_revision'] = patch.stateRevision
  if (patch.workspaceVolumeRevision !== undefined) cols['workspace_volume_revision'] = patch.workspaceVolumeRevision
  if (patch.syncStatus !== undefined) cols['sync_status'] = patch.syncStatus
  if (patch.lastSyncedAt !== undefined) cols['last_synced_at'] = patch.lastSyncedAt
  if (patch.hostSyncEnabled !== undefined) cols['host_sync_enabled'] = patch.hostSyncEnabled ? 1 : 0
  if (patch.workspaceFingerprint !== undefined) cols['workspace_fingerprint'] = patch.workspaceFingerprint
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
  /** Atomically publish the Room workspace pointer and its matching dependency pointer. */
  publishWorkingState(input: {
    roomId: string
    expectedWorkspaceVolumeRevision: number
    expectedStateRevision: number
    workspaceVolumeRevision: number
    stateRevision: number
    syncStatus: WorkspaceSyncStatus
    depsKey: string
    legacyDepsKey: string
    expectedDepsGeneration: number
    depsGeneration: number
  }): void
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
            workspace_mode, state_revision, workspace_volume_revision, sync_status, last_synced_at, host_sync_enabled,
            workspace_fingerprint,
            runtime_kind, runtime_version, pm_kind, pm_version, start_command,
            internal_port, domain, https, status, host_port, created_at,
            last_used_at, thumb_path, extra
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.project,
          r.nickname,
          r.roomNumber,
          r.provider,
          r.sourceType,
          r.sourceRef,
          r.workspaceMode,
          r.stateRevision,
          r.workspaceVolumeRevision,
          r.syncStatus,
          r.lastSyncedAt,
          r.hostSyncEnabled ? 1 : 0,
          r.workspaceFingerprint,
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
          JSON.stringify({
            services: r.services ?? {},
            os: r.os ?? { env: {} },
            ...(r.agentHostSync !== undefined ? { agentHostSync: r.agentHostSync } : {}),
            ...(r.android ? { android: r.android } : {})
          }),
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
      if (
        patch.services !== undefined ||
        patch.os !== undefined ||
        patch.android !== undefined ||
        patch.agentHostSync !== undefined
      ) {
        const row = sqlite.prepare('SELECT extra FROM rooms WHERE id = ?').get(id) as { extra: string } | undefined
        const extra = parseExtra(row?.extra ?? '{}')
        if (patch.services !== undefined) extra.services = patch.services
        if (patch.os !== undefined) extra.os = patch.os
        if (patch.android !== undefined) extra.android = patch.android
        if (patch.agentHostSync !== undefined) extra.agentHostSync = patch.agentHostSync
        cols['extra'] = JSON.stringify(extra)
      }
      const names = Object.keys(cols)
      if (names.length === 0) return
      const assignments = names.map((n) => `${n} = ?`).join(', ')
      const values = names.map((n) => cols[n] ?? null)
      sqlite.prepare(`UPDATE rooms SET ${assignments} WHERE id = ?`).run(...values, id)
    },
    publishWorkingState(input) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const currentSetting = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(input.depsKey) as
          | { value: string }
          | undefined
        const legacySetting = currentSetting
          ? undefined
          : sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(input.legacyDepsKey) as { value: string } | undefined
        const rawGeneration = currentSetting?.value ?? legacySetting?.value ?? '0'
        const currentGeneration = Number.parseInt(rawGeneration, 10)
        if (!Number.isSafeInteger(currentGeneration) || currentGeneration !== input.expectedDepsGeneration) {
          throw new Error('Dependency working-state pointer changed before publish')
        }
        const updated = sqlite.prepare(
          `UPDATE rooms
           SET workspace_volume_revision = ?, state_revision = ?, sync_status = ?
           WHERE id = ? AND workspace_volume_revision = ? AND state_revision = ?`
        ).run(
          input.workspaceVolumeRevision,
          input.stateRevision,
          input.syncStatus,
          input.roomId,
          input.expectedWorkspaceVolumeRevision,
          input.expectedStateRevision
        )
        if (updated.changes !== 1) throw new Error('Room working-state pointer changed before publish')
        sqlite.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(input.depsKey, String(input.depsGeneration))
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    delete(id) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        sqlite.prepare('DELETE FROM changes WHERE room_id = ?').run(id)
        sqlite.prepare('DELETE FROM checks WHERE room_id = ?').run(id)
        sqlite
          .prepare(
            `DELETE FROM settings
             WHERE key = ? OR key LIKE ? OR key LIKE ? OR key = ?`
          )
          .run(`depsGen:${id}`, `depsGen:${id}:%`, `depsGenMax:${id}:%`, `workspaceGenMax:${id}`)
        sqlite.prepare('DELETE FROM rooms WHERE id = ?').run(id)
        sqlite.exec('COMMIT')
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
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

function legacyWorkspaceMode(sourceType: string): WorkspaceMode {
  return sourceType === 'linked-folder' ? 'legacy-host-bind' : sourceType === 'empty' ? 'empty' : 'hotel'
}

function legacySyncStatus(sourceType: string): WorkspaceSyncStatus {
  return sourceType === 'linked-folder' ? 'legacy' : sourceType === 'empty' ? 'empty' : 'synced'
}
