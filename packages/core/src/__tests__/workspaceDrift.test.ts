import { describe, expect, it } from 'vitest'
import {
  diffWorkspaceSnapshots,
  parseWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  type WorkspaceSnapshot
} from '../workspaceDrift'

function snapshot(fingerprint: string, entries: WorkspaceSnapshot['entries']): WorkspaceSnapshot {
  return { fingerprint, entries }
}

describe('workspace drift snapshots', () => {
  it('reports exact added, modified, and deleted source paths in byte order', () => {
    const baseline = snapshot('a'.repeat(64), [
      { path: 'README.md', kind: 'file', identity: 'old-readme' },
      { path: 'app/src/main/java/App.kt', kind: 'file', identity: 'old-source' },
      { path: 'removed.txt', kind: 'file', identity: 'removed' }
    ])
    const current = snapshot('b'.repeat(64), [
      { path: 'README.md', kind: 'file', identity: 'old-readme' },
      { path: 'app/src/main/java/App.kt', kind: 'file', identity: 'new-source' },
      { path: 'new.txt', kind: 'file', identity: 'new' }
    ])

    expect(diffWorkspaceSnapshots(baseline, current)).toEqual([
      { path: 'app/src/main/java/App.kt', reason: 'modified' },
      { path: 'new.txt', reason: 'added' },
      { path: 'removed.txt', reason: 'deleted' }
    ])
  })

  it('round-trips only safe Room-relative snapshot paths', () => {
    const value = snapshot('c'.repeat(64), [
      { path: 'app/src/main/AndroidManifest.xml', kind: 'file', identity: '81a4:0:0:hash' }
    ])
    expect(parseWorkspaceSnapshot(serializeWorkspaceSnapshot(value))).toEqual(value)
    expect(parseWorkspaceSnapshot(JSON.stringify({ ...value, entries: [{ ...value.entries[0], path: '../Host/secret' }] }))).toBeNull()
  })
})
