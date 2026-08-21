import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { generateManifestYaml, writeManifest } from '../manifest'

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: 'room-1',
    project: 'acme',
    nickname: 'Acme Site',
    roomNumber: 201,
    provider: 'web',
    sourceType: 'managed-git',
    sourceRef: 'https://github.com/acme/site.git',
    workspaceMode: 'hotel',
    stateRevision: 1,
    workspaceVolumeRevision: 0,
    syncStatus: 'synced',
    lastSyncedAt: '2026-08-10T10:00:00.000Z',
    hostSyncEnabled: false,
    workspaceFingerprint: 'abc',
    runtime: { kind: 'node', version: '22.12.0' },
    packageManager: { kind: 'pnpm', version: '9.15.0' },
    startCommand: 'pnpm dev',
    internalPort: 3000,
    domain: 'acme.dev.localhost',
    https: true,
    status: 'ready',
    services: {},
    os: { env: {} },
    hostPort: null,
    createdAt: '2026-08-10T10:00:00.000Z',
    lastUsedAt: '2026-08-10T11:00:00.000Z',
    thumbPath: null,
    ...overrides,
  }
}

describe('generateManifestYaml', () => {
  it('renders the full manifest shape for a managed-git room', () => {
    const parsed = load(generateManifestYaml(makeRoom()))
    expect(parsed).toEqual({
      project: 'acme',
      nickname: 'Acme Site',
      provider: 'web',
      source: { type: 'managed-git', repository: 'https://github.com/acme/site.git' },
      runtime: { node: '22' },
      packageManager: { type: 'pnpm', version: '9.15.0' },
      web: { command: 'pnpm dev', internalPort: 3000 },
      domain: { host: 'acme.dev.localhost', https: true },
      services: {},
      workingState: {
        owner: 'room',
        revision: 1,
        volumeRevision: 0,
        syncStatus: 'synced',
        lastSyncedAt: '2026-08-10T10:00:00.000Z'
      }
    })
  })

  it('uses source.path for linked-folder rooms', () => {
    const parsed = load(
      generateManifestYaml(
        makeRoom({ sourceType: 'linked-folder', sourceRef: 'C:\\code\\site', hostSyncEnabled: true }),
      ),
    ) as { source: unknown }
    expect(parsed.source).toEqual({ type: 'linked-folder', hostSync: 'enabled', path: 'C:\\code\\site' })
  })

  it('omits repository/path for empty rooms and version when absent', () => {
    const parsed = load(
      generateManifestYaml(
        makeRoom({ sourceType: 'empty', sourceRef: '', packageManager: { kind: 'npm' } }),
      ),
    ) as { source: unknown; packageManager: unknown }
    expect(parsed.source).toEqual({ type: 'empty' })
    expect(parsed.packageManager).toEqual({ type: 'npm' })
  })

  it('renders an offline VMware linked clone without Web or Host-path fields', () => {
    const yaml = generateManifestYaml(
      makeRoom({
        provider: 'windows',
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        runtime: { kind: 'windows', version: '11' },
        packageManager: { kind: 'none' },
        internalPort: 0,
        windows: { backend: 'vmware', templateId: 'b'.repeat(64), snapshot: 'devhotel-clean' }
      })
    )
    const parsed = load(yaml) as Record<string, unknown>
    expect(parsed.runtime).toEqual({ windows: '11' })
    expect(parsed.virtualization).toEqual({
      backend: 'vmware',
      templateId: 'b'.repeat(64),
      snapshot: 'devhotel-clean',
      clone: 'linked',
      network: 'offline'
    })
    expect(parsed).not.toHaveProperty('web')
    expect(yaml).not.toContain('.vmx')
  })
})

describe('writeManifest', () => {
  it('writes manifest.yaml under <userDataDir>/rooms/<id>', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'))
    try {
      const room = makeRoom()
      await writeManifest(dir, room)
      const file = path.join(dir, 'rooms', 'room-1', 'manifest.yaml')
      const parsed = load(fs.readFileSync(file, 'utf8')) as { project: string; runtime: unknown }
      expect(parsed.project).toBe('acme')
      expect(parsed.runtime).toEqual({ node: '22' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
