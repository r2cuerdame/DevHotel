import type { QuickChange } from './changes'

export type CheckStatus = 'healthy' | 'warning' | 'broken' | 'unknown'

export type CheckStep =
  | 'backend'
  | 'metadata'
  | 'source'
  | 'line-endings'
  | 'runtime'
  | 'package-manager'
  | 'dependencies'
  | 'env'
  | 'services'
  | 'start-command'
  | 'process'
  | 'port'
  | 'gateway'
  | 'https'
  | 'http'

export type CheckFix = QuickChange | { kind: 'restart-web' } | { kind: 'start-services' }

export interface CheckResult {
  step: CheckStep
  status: CheckStatus
  summary: string
  detail?: string
  fix?: CheckFix
}

export interface CheckReport {
  roomId: string
  ranAt: string
  results: CheckResult[]
  overall: CheckStatus
}
