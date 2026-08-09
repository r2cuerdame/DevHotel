import type { Actor } from './rooms'

export type QuickChange =
  | { kind: 'node-version'; version: string }
  | { kind: 'start-command'; command: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'https'; enabled: boolean }
  | { kind: 'internal-port'; port: number }
  | { kind: 'deps-install'; clean: boolean }
  | { kind: 'android-build' }
  | { kind: 'android-run' }
  | { kind: 'service-add'; service: 'postgres' | 'redis'; version?: string }
  | { kind: 'service-remove'; service: 'postgres' | 'redis' }
  | { kind: 'service-restart'; service: 'postgres' | 'redis' }
  | { kind: 'db-backup'; service: 'postgres' | 'redis' }
  | { kind: 'db-restore'; service: 'postgres' | 'redis'; file: string }
  | { kind: 'os-settings'; os: import('./rooms').RoomOsSettings }
  | { kind: 'package-manager'; pm: 'npm' | 'pnpm'; version?: string }
  | { kind: 'emulator-config'; device: string; version: string }
  | { kind: 'service-version'; service: 'postgres' | 'redis'; version: string }

export type ChangeStatus = 'pending' | 'applied' | 'verified' | 'rolled-back' | 'undone' | 'failed'

export interface ChangeEntry {
  id: string
  roomId: string
  seq: number
  /** QuickChange kind or an internal kind like 'undo', 'restart-web', 'create-room' */
  kind: string
  title: string
  actor: Actor
  component: string
  before: unknown
  after: unknown
  /** captured safety-state blob used by undo; null when the change captures nothing */
  captured: unknown
  steps: string[]
  verify: { ok: boolean; detail: string } | null
  undoable: boolean
  undoStrategy: string
  status: ChangeStatus
  rawLogPath: string | null
  createdAt: string
  undoneAt: string | null
}
