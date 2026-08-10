export type RoomStatus = 'preparing' | 'running' | 'ready' | 'sleeping' | 'attention' | 'broken'
export type SourceType = 'managed-git' | 'linked-folder' | 'empty'
export type Actor = 'user' | 'devhotel' | 'agent'
export type PmKind = 'npm' | 'pnpm' | 'gradle'
export type ProviderKind = 'web' | 'android' | 'windows'
/** Guest LCD scaling: swiftshader renders in software, so fewer pixels = a much faster phone. */
export type EmulatorResolution = 'native' | 'balanced' | 'fast'
/** Where `/workspace` actually lives. Legacy host binds are compatibility-only. */
export type WorkspaceMode = 'hotel' | 'legacy-host-bind' | 'empty'
export type WorkspaceSyncStatus = 'synced' | 'modified' | 'legacy' | 'empty'

export type ServiceKind = 'postgres' | 'redis'
export type CloneServiceMode = 'copy' | 'empty' | 'exclude'

export interface RoomServices {
  postgres?: { version: string }
  redis?: { version: string }
}

/** Per-room "control panel" settings applied to the room's containers. */
export interface RoomOsSettings {
  env: Record<string, string>
  /** CPU limit (docker --cpus); undefined = unlimited */
  cpus?: number
  /** memory limit in MB (docker --memory); undefined = unlimited */
  memoryMB?: number
  /** IANA timezone applied as TZ, e.g. Asia/Seoul */
  timezone?: string
}

export interface RoomRecord {
  id: string
  project: string
  nickname: string
  roomNumber: number
  provider: ProviderKind
  sourceType: SourceType
  /** git URL for managed-git, host folder path for linked-folder, '' for empty */
  sourceRef: string
  /** Runtime boundary for `/workspace`; never infer this from sourceType. */
  workspaceMode: WorkspaceMode
  /** Monotonic logical revision advanced by tracked DevHotel sync/mutation operations. */
  stateRevision: number
  /** Selects the owned source volume generation; 0 keeps the original volume name. */
  workspaceVolumeRevision: number
  syncStatus: WorkspaceSyncStatus
  lastSyncedAt: string | null
  /** Fingerprint of the last published/synced Room-owned source tree. */
  workspaceFingerprint: string | null
  /** Whether this Room may explicitly import again from sourceRef. Clones detach by default. */
  hostSyncEnabled: boolean
  runtime: { kind: 'node' | 'jdk'; version: string }
  packageManager: { kind: PmKind; version?: string }
  startCommand: string
  internalPort: number
  domain: string
  https: boolean
  status: RoomStatus
  services: RoomServices
  os: RoomOsSettings
  /** android rooms: emulator device/OS/resolution selection */
  android?: { device: string; version: string; resolution?: EmulatorResolution }
  /** ephemeral 127.0.0.1 port published by the anchor; null while sleeping */
  hostPort: number | null
  createdAt: string
  lastUsedAt: string
  thumbPath: string | null
}

/** Which detection rule decided a value — shown in the Room Plan UI. */
export interface Detected<T> {
  value: T
  source: string
}

export interface RoomPlan {
  project: string
  framework: string | null
  runtime: Detected<string> & { kind: 'node' | 'jdk' }
  packageManager: Detected<PmKind> & { version?: string }
  startCommand: Detected<string>
  internalPort: Detected<number>
  domain: string
  https: boolean
  warnings: string[]
}

export interface CreateRoomInput {
  sourceType: SourceType
  sourceRef: string
  project: string
  nickname: string
  actor: Actor
  /** room provider — defaults to 'web' */
  provider?: ProviderKind
  planOverrides?: {
    runtimeVersion?: string
    pmKind?: PmKind
    startCommand?: string
    internalPort?: number
    domain?: string
    https?: boolean
  }
}

/** Options for making an independent environment from an existing Web room. */
export interface CloneRoomInput {
  sourceRoomId: string
  nickname: string
  copyDependencies: boolean
  /** copy service configuration and data, start with empty data, or omit services */
  services: CloneServiceMode
  actor: Actor
}

export interface BackupInfo {
  /** Opaque Room-scoped filename; never an absolute Host path. */
  id: string
  service: ServiceKind
  size: number
  createdAt: string
}

export interface RoomInspection {
  room: RoomRecord
  urls: { app: string }
  /** host folder holding this room's manifest.yaml, logs/, thumbnail */
  dataDir: string
  backups: BackupInfo[]
  stackLine: string
  latestCheck: import('./checks').CheckReport | null
  recentChanges: import('./changes').ChangeEntry[]
  lastUndoable: import('./changes').ChangeEntry | null
  storage: Record<string, number> | null
}
