export type WorkspaceEntryKind = 'file' | 'symlink'

export interface WorkspaceSnapshotEntry {
  /** Linux-style path relative to /workspace, without a leading ./ */
  path: string
  kind: WorkspaceEntryKind
  /** Stable type, ownership, mode and content/target identity. */
  identity: string
}

export interface WorkspaceSnapshot {
  fingerprint: string
  entries: WorkspaceSnapshotEntry[]
}

export type WorkspacePathChangeReason = 'added' | 'modified' | 'deleted'

export interface WorkspacePathChange {
  path: string
  reason: WorkspacePathChangeReason
}

export const WORKSPACE_DRIFT_CONFLICT_REASON = 'room-source-modified' as const

/**
 * A checked sync conflict, intentionally carrying only Room-relative paths.
 * Host absolute paths and file contents never cross the control API boundary.
 */
export class WorkspaceDriftError extends Error {
  readonly code = 'workspace_drift'
  readonly conflictReason = WORKSPACE_DRIFT_CONFLICT_REASON

  constructor(readonly changedPaths: WorkspacePathChange[]) {
    const shown = changedPaths.slice(0, 20).map((change) => `${change.path} (${change.reason})`)
    const more = changedPaths.length > shown.length ? `, and ${changedPaths.length - shown.length} more` : ''
    super(
      'Room files changed since the last Host sync: ' +
        `${shown.join(', ')}${more}. Export or commit them first, or accept the current Room files ` +
        'as the new baseline (Reset baseline) and sync again.'
    )
    this.name = 'WorkspaceDriftError'
  }

  toResponse(): {
    error: 'workspace_drift'
    message: string
    conflictReason: typeof WORKSPACE_DRIFT_CONFLICT_REASON
    changedPaths: WorkspacePathChange[]
  } {
    return {
      error: this.code,
      message: this.message,
      conflictReason: this.conflictReason,
      changedPaths: this.changedPaths
    }
  }
}

export function diffWorkspaceSnapshots(
  baseline: WorkspaceSnapshot,
  current: WorkspaceSnapshot
): WorkspacePathChange[] {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]))
  const after = new Map(current.entries.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareWorkspacePaths)
  const changes: WorkspacePathChange[] = []

  for (const path of paths) {
    const previous = before.get(path)
    const next = after.get(path)
    if (!previous) changes.push({ path, reason: 'added' })
    else if (!next) changes.push({ path, reason: 'deleted' })
    else if (previous.kind !== next.kind || previous.identity !== next.identity) {
      changes.push({ path, reason: 'modified' })
    }
  }
  return changes
}

export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(snapshot)
}

export function parseWorkspaceSnapshot(raw: string | null): WorkspaceSnapshot | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed['fingerprint'] !== 'string' || !Array.isArray(parsed['entries'])) return null
  if (!/^[a-f0-9]{64}$/.test(parsed['fingerprint'])) return null

  const entries: WorkspaceSnapshotEntry[] = []
  for (const value of parsed['entries']) {
    if (!isRecord(value)) return null
    const path = value['path']
    const kind = value['kind']
    const identity = value['identity']
    if (
      typeof path !== 'string' ||
      !isSafeWorkspacePath(path) ||
      (kind !== 'file' && kind !== 'symlink') ||
      typeof identity !== 'string' ||
      identity.length < 1 ||
      identity.length > 512
    ) return null
    entries.push({ path, kind, identity })
  }
  entries.sort((a, b) => compareWorkspacePaths(a.path, b.path))
  return { fingerprint: parsed['fingerprint'], entries }
}

export function isSafeWorkspacePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 32_768 &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}

function compareWorkspacePaths(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
