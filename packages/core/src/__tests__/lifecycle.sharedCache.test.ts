import { describe, expect, it } from 'vitest'
import { buildWebCreateArgs } from '../backend/naming'
import { parseVolumeNameAndLabels } from '../volumeGc'
import {
  isSharedCacheVolumeName,
  nodeSharedCacheMounts,
  provesSharedCacheOwnership,
  sharedCacheLabels,
  sharedCachePurpose,
  sharedCacheVolume
} from '../lifecycle/sharedCache'
import type { WebSpec } from '../backend/types'

function spec(overrides: Partial<WebSpec> = {}): WebSpec {
  return {
    roomId: 'room1abc',
    internalPort: 3000,
    nodeMajor: '22',
    sourceType: 'managed-git',
    sourceRef: 'https://example.invalid/repo.git',
    workspaceMode: 'hotel',
    workspaceVolumeRevision: 0,
    startCommand: 'pnpm dev',
    ...overrides
  }
}

describe('a shared cache can never be mistaken for a Room disk', () => {
  it('cannot collide with a Room prefix, because a Room ID is eight characters', () => {
    expect(sharedCacheVolume('packages')).toBe('dh-shared-packages')
    expect(isSharedCacheVolumeName('dh-shared-packages')).toBe(true)
    expect(isSharedCacheVolumeName('dh-room1abc-cache')).toBe(false)
    expect(sharedCachePurpose('dh-shared-packages')).toBe('packages')
  })

  it('is invisible to the Room disk reconciler, which cannot attribute it to a Room', () => {
    const parsed = parseVolumeNameAndLabels('dh-shared-packages', sharedCacheLabels('packages'))
    expect(parsed.roomId).toBeNull()
    expect(parsed.purpose).toBe('external')
  })

  it('rejects a purpose that is not a plain lowercase word', () => {
    expect(() => sharedCacheVolume('../escape')).toThrow(/invalid shared cache purpose/)
    expect(() => sharedCacheVolume('NPM')).toThrow(/invalid shared cache purpose/)
  })
})

describe('shared cache ownership proof', () => {
  it('accepts the complete Hotel-scope label set', () => {
    expect(provesSharedCacheOwnership('dh-shared-packages', sharedCacheLabels('packages'))).toBe(true)
  })

  it('refuses a cache missing any part of the label set', () => {
    const labels = sharedCacheLabels('packages')
    for (const key of Object.keys(labels)) {
      const partial = { ...labels }
      delete partial[key]
      expect(provesSharedCacheOwnership('dh-shared-packages', partial)).toBe(false)
    }
  })

  it('refuses a cache whose labels claim it belongs to a Room', () => {
    // Something built it with the wrong rules; guessing which rules win is how a
    // Room-scoped deletion reaches a Hotel-scoped disk.
    expect(provesSharedCacheOwnership('dh-shared-packages', { ...sharedCacheLabels('packages'), 'devhotel.room': 'room1abc' })).toBe(
      false
    )
  })

  it('refuses a cache whose declared purpose does not match its name', () => {
    expect(provesSharedCacheOwnership('dh-shared-packages', sharedCacheLabels('gradle'))).toBe(false)
  })
})

describe('a Room that mounts the shared package store', () => {
  it('points its package manager at the shared store instead of its own cache', () => {
    const args = buildWebCreateArgs(spec({ sharedCaches: nodeSharedCacheMounts() }))
    expect(args).toContain('dh-shared-packages:/shared-cache')
    expect(args).toContain('npm_config_cache=/shared-cache/npm')
    expect(args).toContain('PNPM_HOME=/shared-cache/pnpm')
  })

  it('still gets its own /cache for everything it can dirty', () => {
    const args = buildWebCreateArgs(spec({ sharedCaches: nodeSharedCacheMounts() }))
    expect(args).toContain('dh-room1abc-cache:/cache')
  })

  it('keeps the per-Room store when no shared cache is mounted', () => {
    const args = buildWebCreateArgs(spec())
    expect(args).toContain('npm_config_cache=/cache/npm')
    expect(args.some((arg) => arg.startsWith('dh-shared-'))).toBe(false)
  })
})
