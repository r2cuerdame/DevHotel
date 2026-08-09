import type { Actor } from './rooms'

export type QuickChange =
  | { kind: 'node-version'; version: string }
  | { kind: 'start-command'; command: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'https'; enabled: boolean }
  | { kind: 'internal-port'; port: number }
  | { kind: 'deps-install'; clean: boolean }

export type ChangeStatus = 'pending' | 'applied' | 'verified' | 'rolled-back' | 'undone' | 'failed'

export interface ChangeEntry {
  id: string
  roomId: string
  seq: number
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
