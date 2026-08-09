import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeEngine } from '../changes/engine'
import { registerQuickChanges } from '../changes/definitions/index'
import type { ChangeCtx } from '../changes/types'
import { changesRepo, type ChangesRepo } from '../store/changesRepo'
import { roomsRepo, type RoomsRepo } from '../store/roomsRepo'
import { settingsRepo, type SettingsRepo } from '../store/settingsRepo'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'

let engine: ChangeEngine
let backend: FakeBackend
let gateway: FakeGateway
let rooms: RoomsRepo
let changes: ChangesRepo
let settings: SettingsRepo
let port: { port: number; close: () => void }

function ctx(roomId = 'room1abc'): ChangeCtx {
  return {
    roomId,
    backend,
    gateway: gateway.asGateway(),
    rooms,
    changes,
    settings,
    userData: tempDir(),
    log: () => undefined,
    room: () => rooms.get(roomId)!,
    webSpec: (overrides) => {
      const r = rooms.get(roomId)!
      const gen = Number(settings.get(`depsGen:${roomId}`) ?? '0')
      return {
        roomId,
        internalPort: r.internalPort,
        nodeMajor: r.runtime.version,
        sourceType: r.sourceType,
        sourceRef: r.sourceRef,
        startCommand: r.startCommand,
        env: {},
        depsVolumeOverride: gen > 0 ? `dh-${roomId}-deps-node${r.runtime.version}-g${gen}` : undefined,
        ...overrides
      }
    },
    isAwake: () => {
      const s = rooms.get(roomId)!.status
      return s === 'running' || s === 'ready' || s === 'attention'
    },
    syncRoute: async () => {
      const r = rooms.get(roomId)!
      if (r.hostPort != null) {
        await gateway.setRoute({ domain: r.domain, roomId, targetPort: r.hostPort, https: r.https })
      }
    }
  }
}

beforeEach(async () => {
  const db = testDb()
  engine = new ChangeEngine()
  registerQuickChanges(engine)
  backend = new FakeBackend()
  gateway = new FakeGateway()
  rooms = roomsRepo(db)
  changes = changesRepo(db)
  settings = settingsRepo(db)
  port = await listeningPort()
  rooms.create(makeRoom({ hostPort: port.port }))
})

afterEach(() => {
  port.close()
})

describe('node-version change', () => {
  it('installs deps for the new major, recreates web, verifies, and journals', async () => {
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.title).toBe('Node 22 → 24')
    expect(rooms.get('room1abc')!.runtime.version).toBe('24')
    expect(backend.calls.some((c) => c.startsWith('runOneShot'))).toBe(true)
    expect(backend.calls).toContain('recreateWeb:room1abc:node24:default')
    expect(changes.lastUndoable('room1abc')?.id).toBe(entry.id)
  })

  it('keeps a failed-verify change applied (no auto-rollback) and undo restores the old version', async () => {
    backend.webStateValue = 'exited'
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('applied')
    expect(entry.verify?.ok).toBe(false)
    expect(rooms.get('room1abc')!.runtime.version).toBe('24')

    backend.webStateValue = 'running'
    const undoEntry = await engine.undo(ctx(), entry.id, 'user')
    expect(undoEntry.title).toBe('Undo: Node 22 → 24')
    expect(rooms.get('room1abc')!.runtime.version).toBe('22')
    expect(changes.get(entry.id)!.status).toBe('undone')
    expect(backend.calls.filter((c) => c.startsWith('recreateWeb'))).toHaveLength(2)
  })

  it('rolls back when the new major dependency install fails during apply', async () => {
    backend.oneShotResult = { code: 1, stdout: '', stderr: 'EBADENGINE unsupported' }
    const entry = await engine.execute(ctx(), 'node-version', { version: '24' }, 'user')
    expect(entry.status).toBe('rolled-back')
    expect(rooms.get('room1abc')!.runtime.version).toBe('22')
  })

  it('rejects a no-op version in preflight without journaling', async () => {
    await expect(engine.execute(ctx(), 'node-version', { version: '22' }, 'user')).rejects.toThrow(/already uses/)
    expect(changes.list('room1abc')).toHaveLength(0)
  })
})

describe('domain change', () => {
  it('applies, routes, verifies against the gateway table', async () => {
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    expect(entry.status).toBe('verified')
    expect(gateway.routes.has('renamed.localhost')).toBe(true)
    expect(gateway.routes.has('demo-dev.localhost')).toBe(false)
  })

  it('auto-rolls back when routing fails', async () => {
    gateway.failNextSetRoute = true
    const entry = await engine.execute(ctx(), 'domain', { domain: 'renamed.localhost' }, 'user')
    expect(entry.status).toBe('rolled-back')
    expect(rooms.get('room1abc')!.domain).toBe('demo-dev.localhost')
    expect(gateway.routes.has('demo-dev.localhost')).toBe(true)
  })

  it('preflights against a taken domain', async () => {
    rooms.create(makeRoom({ id: 'room2def', domain: 'taken.localhost', roomNumber: 202 }))
    await expect(engine.execute(ctx(), 'domain', { domain: 'taken.localhost' }, 'user')).rejects.toThrow(/already used/)
  })
})

describe('deps clean reinstall', () => {
  it('installs into a fresh generation volume and undo swaps back', async () => {
    const entry = await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    expect(entry.status).toBe('verified')
    expect(settings.get('depsGen:room1abc')).toBe('1')
    expect(backend.calls).toContain('runOneShot:dh-room1abc-deps-node22-g1:pnpm install')
    expect(backend.calls).toContain('recreateWeb:room1abc:node22:dh-room1abc-deps-node22-g1')

    await engine.undo(ctx(), entry.id, 'user')
    expect(settings.get('depsGen:room1abc')).toBe('0')
  })

  it('plain install is honestly non-undoable', async () => {
    const entry = await engine.execute(ctx(), 'deps-install', { clean: false }, 'agent')
    expect(entry.undoable).toBe(false)
    expect(entry.actor).toBe('agent')
    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/cannot be undone/)
  })
})

describe('sleeping rooms', () => {
  it('records changes without touching the backend and defers verification', async () => {
    rooms.update('room1abc', { status: 'sleeping', hostPort: null })
    const entry = await engine.execute(ctx(), 'start-command', { command: 'pnpm start' }, 'user')
    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toMatch(/next wake/)
    expect(backend.calls.filter((c) => c.startsWith('recreateWeb'))).toHaveLength(0)
    expect(rooms.get('room1abc')!.startCommand).toBe('pnpm start')
  })
})

describe('engine safety', () => {
  it('rejects unknown change kinds', async () => {
    await expect(engine.execute(ctx(), 'format-host-disk', {}, 'agent')).rejects.toThrow(/Unknown change kind/)
  })

  it('refuses to undo an undone change twice', async () => {
    const entry = await engine.execute(ctx(), 'start-command', { command: 'pnpm start' }, 'user')
    await engine.undo(ctx(), entry.id, 'user')
    await expect(engine.undo(ctx(), entry.id, 'user')).rejects.toThrow(/already undone/)
  })
})
