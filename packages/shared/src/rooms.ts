export type RoomStatus = 'preparing' | 'running' | 'ready' | 'sleeping' | 'attention' | 'broken'
export type SourceType = 'managed-git' | 'linked-folder' | 'empty'
export type Actor = 'user' | 'devhotel' | 'agent'
export type PmKind = 'npm' | 'pnpm' | 'gradle' | 'none'
export type ProviderKind = 'web' | 'android' | 'windows'
export type RuntimeKind = 'node' | 'jdk' | 'windows'

/** What a Room provider can do in this build — the registry's own answer, so the UI never invents availability. */
export interface ProviderInfo {
  kind: ProviderKind
  label: string
  available: boolean
  unavailableReason?: string
  execution: 'served' | 'build-only'
  preview: 'browser' | 'none'
  requiresKvm: boolean
}
/** Guest LCD scaling: swiftshader renders in software, so fewer pixels = a much faster phone. */
export type EmulatorResolution = 'native' | 'balanced' | 'fast'
export type EmulatorOrientation = 'portrait' | 'landscape'
/** Room Apps and their data when a Room is reset: keep them, start them empty, or take the apps out. */
export type ResetServiceMode = 'keep' | 'empty' | 'remove'
/** Where `/workspace` actually lives. Legacy host binds are compatibility-only. */
export type WorkspaceMode = 'hotel' | 'legacy-host-bind' | 'empty'
export type WorkspaceSyncStatus = 'synced' | 'modified' | 'legacy' | 'empty'
export type RuntimeComponentState = 'running' | 'exited' | 'stopped' | 'missing' | 'unknown' | 'not-checked'
export type RoomRuntimeState = 'running' | 'degraded' | 'dead' | 'stopped' | 'unknown'

/** Live, read-only runtime observation. This never replaces persisted working-state or sync metadata. */
export interface RoomRuntimeStatus {
  state: RoomRuntimeState
  expected: 'running' | 'stopped' | 'transitional'
  recordedStatus: RoomStatus
  main: RuntimeComponentState
  emulator: RuntimeComponentState | null
  observedAt: string
  detail: string
  recoveryHint: string | null
}

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

/** User-owned VMware template used to materialize one Windows Room clone. */
export interface VmwareRoomConfig {
  backend: 'vmware'
  /** Opaque fingerprint of the user-selected template; its Host path stays in the provider ownership ledger. */
  templateId: string
  /** Immutable baseline snapshot from which the Room linked clone is created. */
  snapshot: string
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
  runtime: { kind: RuntimeKind; version: string }
  packageManager: { kind: PmKind; version?: string }
  startCommand: string
  internalPort: number
  domain: string
  https: boolean
  status: RoomStatus
  services: RoomServices
  os: RoomOsSettings
  /**
   * Inbound Host-sync grant for agents (goal.md §5.11): scoped to this Room and
   * to reading its own linked folder, revocable at any time from the Room.
   * Defaults to allowed — the human already chose this folder when creating the
   * Room, and sync never reads any other path.
   */
  agentHostSync?: boolean
  /** android rooms: emulator device/OS/resolution/orientation selection */
  android?: { device: string; version: string; resolution?: EmulatorResolution; orientation?: EmulatorOrientation }
  /** windows rooms: provider-owned VM template and clean baseline. */
  windows?: VmwareRoomConfig
  /** ephemeral 127.0.0.1 port published by the anchor; null while sleeping */
  hostPort: number | null
  createdAt: string
  lastUsedAt: string
  thumbPath: string | null
}

/** A public Room record with a fresh, read-only runtime observation attached. */
export type RuntimeRoomRecord = RoomRecord & { runtimeStatus: RoomRuntimeStatus }

/** Which detection rule decided a value — shown in the Room Plan UI. */
export interface Detected<T> {
  value: T
  source: string
}

export interface RoomPlan {
  project: string
  framework: string | null
  runtime: Detected<string> & { kind: RuntimeKind }
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
  /** Required only for a user-created Windows Room. */
  windows?: {
    /** Native-picker-approved path, accepted only on the trusted desktop create boundary. */
    baseVmxPath: string
    snapshot: string
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
  /** Present on revalidated user/Agent inspection surfaces; absent on internal metadata-only reads. */
  runtimeStatus?: RoomRuntimeStatus
  /** Windows VM Rooms do not expose an embedded browser URL. */
  urls: { app: string | null }
  /** host folder holding this room's manifest.yaml, logs/, thumbnail */
  dataDir: string
  backups: BackupInfo[]
  stackLine: string
  latestCheck: import('./checks').CheckReport | null
  recentChanges: import('./changes').ChangeEntry[]
  lastUndoable: import('./changes').ChangeEntry | null
  storage: Record<string, number> | null
}
