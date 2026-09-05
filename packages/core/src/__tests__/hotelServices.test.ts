import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HotelServiceManifest, RoomRecord } from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hotelServicesRepo, openDb, roomsRepo } from '../index'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function manifest(id = 'devhotel.github', adapterId = 'github-cli'): HotelServiceManifest {
  return {
    schemaVersion: 1,
    id,
    title: 'GitHub Service',
    description: 'Built-in integration',
    category: 'integration',
    adapterId,
    interface: 'cli',
    version: {
      current: '2.97.0',
      pin: { mode: 'exact', value: '2.97.0' },
      update: { mode: 'manual', channel: 'stable' },
      rollback: { supported: false, strategy: 'none' }
    },
    lifecycle: {
      install: true,
      update: true,
      start: false,
      stop: false,
      restart: false,
      remove: false,
      rollback: false
    },
    supportedContexts: ['hotel', 'host-project', 'room'],
    permissions: [
      { id: 'repository-read', title: 'Read approved repositories', access: 'read', risk: 'low', approval: 'once' }
    ],
    health: { capability: 'probe', timeoutMs: 20_000 }
  }
}

function room(id = 'room1abc'): RoomRecord {
  const now = new Date().toISOString()
  return {
    id,
    project: 'demo',
    nickname: 'dev',
    roomNumber: 201,
    provider: 'web',
    sourceType: 'managed-git',
    sourceRef: 'https://example.test/demo.git',
    workspaceMode: 'hotel',
    stateRevision: 1,
    workspaceVolumeRevision: 0,
    syncStatus: 'synced',
    lastSyncedAt: now,
    hostSyncEnabled: false,
    workspaceFingerprint: 'abc',
    runtime: { kind: 'node', version: '22' },
    packageManager: { kind: 'pnpm', version: '10' },
    startCommand: 'pnpm dev',
    internalPort: 3000,
    domain: 'demo.localhost',
    https: false,
    status: 'sleeping',
    services: {},
    os: { env: {} },
    hostPort: null,
    createdAt: now,
    lastUsedAt: now,
    thumbPath: null
  }
}

describe('Hotel Services control-plane persistence', () => {
  it('registers a strict manifest without claiming the service was provisioned or connected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-services-')); dirs.push(dir)
    const db = openDb(dir), repo = hotelServicesRepo(db)
    expect((db.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const columns = (db.sqlite.prepare('PRAGMA table_info(hotel_services)').all() as { name: string }[]).map((column) => column.name)
    expect(columns).toContain('manifest_json')
    expect(columns).not.toContain('installed')
    const registered = repo.register({ manifest: manifest(), availability: 'available', enabled: true, initialConnectionState: 'disconnected' })

    expect(registered).toMatchObject({
      manifest: { id: 'devhotel.github', adapterId: 'github-cli' },
      availability: 'available',
      registrationState: 'registered',
      provisionState: 'not-provisioned',
      connectionState: 'disconnected',
      enabled: true
    })

    repo.updateState('devhotel.github', { provisionState: 'provisioned', connectionState: 'connected' })
    const reconciled = repo.register({ manifest: manifest(), availability: 'available', enabled: false, initialConnectionState: 'disconnected' })
    expect(reconciled).toMatchObject({ provisionState: 'provisioned', connectionState: 'connected', enabled: true })
    db.close()
  })

  it('rejects lifecycle states that would conflate provisioning, connection, and registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-services-state-')); dirs.push(dir)
    const db = openDb(dir), repo = hotelServicesRepo(db)
    repo.register({ manifest: manifest(), availability: 'available', enabled: true, initialConnectionState: 'disconnected' })

    expect(() => repo.updateState('devhotel.github', { connectionState: 'connected' })).toThrow(/before it is provisioned/)
    repo.updateState('devhotel.github', { provisionState: 'provisioned', connectionState: 'connected' })
    expect(() => repo.updateState('devhotel.github', { registrationState: 'unregistered' })).toThrow(/cannot remain enabled or connected/)
    db.close()
  })

  it('registers an unrelated adapter through the same catalog contract and rejects malformed manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-services-catalog-')); dirs.push(dir)
    const db = openDb(dir), repo = hotelServicesRepo(db)
    expect(repo.register({ manifest: manifest('hotel.aws', 'aws-cli'), availability: 'available', enabled: false, initialConnectionState: 'disconnected' }).manifest.adapterId).toBe('aws-cli')
    expect(() => repo.register({ manifest: manifest('hotel.aws', 'different-adapter'), availability: 'available', enabled: false, initialConnectionState: 'disconnected' })).toThrow(/adapter collision/)
    expect(() => repo.register({
      manifest: { ...manifest('hotel.bad'), unexpected: true } as unknown as HotelServiceManifest,
      availability: 'available',
      enabled: false,
      initialConnectionState: 'not-applicable'
    })).toThrow()
    db.close()
  })

  it('supports Hotel, Host-project, and Room assignments with extensible agent adapters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-services-scopes-')); dirs.push(dir)
    const db = openDb(dir), repo = hotelServicesRepo(db)
    roomsRepo(db).create(room())
    repo.register({ manifest: manifest(), availability: 'available', enabled: true, initialConnectionState: 'disconnected' })

    const hotel = repo.assign({ serviceId: 'devhotel.github', scopeKind: 'hotel', scopeRef: null, agentAdapterId: 'future-agent', enabled: true, approved: true })
    const project = repo.assign({ serviceId: 'devhotel.github', scopeKind: 'host-project', scopeRef: 'project:devhotel', agentAdapterId: 'codex', enabled: true, approved: true })
    const scopedRoom = repo.assign({ serviceId: 'devhotel.github', scopeKind: 'room', scopeRef: 'room1abc', agentAdapterId: 'claude-code', enabled: true, approved: true })

    expect(hotel.scopeRef).toBeNull()
    expect(project.scopeRef).toBe('project:devhotel')
    expect(scopedRoom.scopeRef).toBe('room1abc')
    expect(repo.assign({ serviceId: 'devhotel.github', scopeKind: 'hotel', scopeRef: null, agentAdapterId: 'future-agent', enabled: true, approved: true }).id).toBe(hotel.id)
    expect(repo.assign({ serviceId: 'devhotel.github', scopeKind: 'hotel', scopeRef: null, agentAdapterId: 'future-agent', enabled: false, approved: true })).toMatchObject({ id: hotel.id, enabled: false })
    expect(() => repo.assign({ serviceId: 'devhotel.github', scopeKind: 'room', scopeRef: 'missing1', agentAdapterId: 'codex', enabled: true, approved: true })).toThrow()
    db.close()
  })

  it('enforces foreign keys and cascades Room assignment plus exact injection ownership on Room deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-services-cascade-')); dirs.push(dir)
    const db = openDb(dir), services = hotelServicesRepo(db), rooms = roomsRepo(db)
    expect((db.sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    rooms.create(room())
    services.register({ manifest: manifest(), availability: 'available', enabled: true, initialConnectionState: 'disconnected' })
    const assignment = services.assign({ serviceId: 'devhotel.github', scopeKind: 'room', scopeRef: 'room1abc', agentAdapterId: 'codex', enabled: true, approved: true })
    services.saveInjection(assignment.id, '.codex/config.toml', 'devhotel.github', 'a'.repeat(64))

    rooms.delete('room1abc')

    expect(services.getAssignment({ serviceId: 'devhotel.github', scopeKind: 'room', scopeRef: 'room1abc', agentAdapterId: 'codex' })).toBeNull()
    expect(services.getInjection(assignment.id)).toBeNull()
    expect(services.get('devhotel.github')).not.toBeNull()
    db.close()
  })
})
