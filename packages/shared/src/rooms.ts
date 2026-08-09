export type RoomStatus = 'preparing' | 'running' | 'ready' | 'sleeping' | 'attention' | 'broken'
export type SourceType = 'managed-git' | 'linked-folder' | 'empty'
export type Actor = 'user' | 'devhotel' | 'agent'
export type PmKind = 'npm' | 'pnpm' | 'gradle'
export type ProviderKind = 'web' | 'android' | 'windows'

export type ServiceKind = 'postgres' | 'redis'

export interface RoomServices {
  postgres?: { version: string }
  redis?: { version: string }
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
  runtime: { kind: 'node' | 'jdk'; version: string }
  packageManager: { kind: PmKind; version?: string }
  startCommand: string
  internalPort: number
  domain: string
  https: boolean
  status: RoomStatus
  services: RoomServices
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

export interface RoomInspection {
  room: RoomRecord
  urls: { app: string }
  /** host folder holding this room's manifest.yaml, logs/, thumbnail */
  dataDir: string
  stackLine: string
  latestCheck: import('./checks').CheckReport | null
  recentChanges: import('./changes').ChangeEntry[]
  lastUndoable: import('./changes').ChangeEntry | null
  storage: Record<string, number> | null
}
