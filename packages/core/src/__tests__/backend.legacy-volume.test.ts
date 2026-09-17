import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import type { WebSpec } from '../backend/types'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const VOLUME = `dh-${ROOM_ID}-cache`
const CREATED_AT = '2026-09-07T01:23:45.123456789Z'

function legacyInspect(driver = 'local', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Name: VOLUME,
      CreatedAt: CREATED_AT,
      Driver: driver,
      Scope: 'local',
      Mountpoint: `/var/lib/docker/volumes/${VOLUME}/_data`,
      Labels: null,
      Options: null,
      ...overrides
    }
  ])
}

describe('legacy Room volume adoption', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-adopt-'))
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: legacyInspect(), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records exact local inspect identity without recreating or deleting data', async () => {
    const adoptionFile = join(dir, 'legacy-volumes.json')
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: adoptionFile,
      canAdoptLegacyVolume: (roomId, name) => roomId === ROOM_ID && name === VOLUME
    })

    await expect(backend.adoptLegacyRoomVolumes(ROOM_ID)).resolves.toEqual([VOLUME])
    await expect(backend.volumeSizes(ROOM_ID)).resolves.toEqual({})
    const registry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { schema: number; volumes: Record<string, unknown> }
    expect(registry.schema).toBe(2)
    expect(registry.volumes[VOLUME]).toMatchObject({
      roomId: ROOM_ID,
      driver: 'local',
      scope: 'local',
      createdAt: CREATED_AT
    })
    expect(
      mockedRunDocker.mock.calls.some(
        ([args]) => args[0] === 'volume' && (args[1] === 'rm' || args[1] === 'create')
      )
    ).toBe(false)
  })

  it('refuses adoption without DB+manifest authorization or with a non-local driver', async () => {
    const base = {
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: join(dir, 'legacy-volumes.json')
    }
    await expect(
      new OciCliBackend({ ...base, canAdoptLegacyVolume: () => false }).adoptLegacyRoomVolumes(ROOM_ID)
    ).rejects.toThrow(/not authorized/)

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: legacyInspect('nfs'), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(
      new OciCliBackend({ ...base, canAdoptLegacyVolume: () => true }).adoptLegacyRoomVolumes(ROOM_ID)
    ).rejects.toThrow(/unsafe or ambiguous/)

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: legacyInspect('local', { CreatedAt: undefined }), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(
      new OciCliBackend({ ...base, canAdoptLegacyVolume: () => true }).adoptLegacyRoomVolumes(ROOM_ID)
    ).rejects.toThrow(/unsafe or ambiguous/)
  })

  it('removes an exactly recorded legacy volume without force and retires ownership only after success', async () => {
    const adoptionFile = join(dir, 'legacy-volumes.json')
    let exists = true
    let removalAllowed = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return exists
          ? { code: 0, stdout: legacyInspect(), stderr: '' }
          : { code: 1, stdout: '', stderr: 'no such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        if (!removalAllowed) return { code: 1, stdout: '', stderr: 'volume is in use' }
        exists = false
        return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: adoptionFile,
      canAdoptLegacyVolume: () => true
    })

    await backend.adoptLegacyRoomVolumes(ROOM_ID)
    await expect(backend.removeManagedVolume(VOLUME)).rejects.toThrow(/volume is in use/)
    const retained = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { volumes: Record<string, unknown> }
    expect(retained.volumes[VOLUME]).toBeDefined()

    removalAllowed = true
    await backend.removeManagedVolume(VOLUME)

    expect(mockedRunDocker.mock.calls.some(([args]) =>
      args[0] === 'volume' && args[1] === 'rm' && args.join(' ') === `volume rm ${VOLUME}`
    )).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args.includes('-f'))).toBe(false)
    const registry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { volumes: Record<string, unknown> }
    expect(registry.volumes[VOLUME]).toBeUndefined()
  })

  it('rejects a recreated or metadata-changed volume that inherited a stale adoption record', async () => {
    const adoptionFile = join(dir, 'legacy-volumes.json')
    let currentInspect = legacyInspect()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: currentInspect, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: adoptionFile,
      canAdoptLegacyVolume: () => true
    })

    await backend.adoptLegacyRoomVolumes(ROOM_ID)
    currentInspect = legacyInspect('local', { CreatedAt: '2026-09-07T02:23:45.123456789Z' })
    await expect(backend.removeManagedVolume(VOLUME)).rejects.toThrow(/ownership metadata/)

    currentInspect = legacyInspect('local', { Labels: { external: '1' } })
    await expect(backend.removeManagedVolume(VOLUME)).rejects.toThrow(/ownership metadata/)

    currentInspect = legacyInspect('local', { Options: { type: 'none' } })
    await expect(backend.removeManagedVolume(VOLUME)).rejects.toThrow(/ownership metadata/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
  })

  it('fails closed on a legacy registry without the creation identity schema', async () => {
    const adoptionFile = join(dir, 'legacy-volumes.json')
    const backend = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: adoptionFile,
      canAdoptLegacyVolume: () => true
    })
    await backend.adoptLegacyRoomVolumes(ROOM_ID)

    const oldRegistry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as {
      schema: number
      volumes: Record<string, Record<string, unknown>>
    }
    oldRegistry.schema = 1
    delete oldRegistry.volumes[VOLUME]!['createdAt']
    writeFileSync(adoptionFile, JSON.stringify(oldRegistry, null, 2) + '\n', 'utf8')

    const restarted = new OciCliBackend({
      identityFile: join(dir, 'engine.json'),
      legacyVolumeAdoptionFile: adoptionFile,
      canAdoptLegacyVolume: () => true
    })
    await expect(restarted.removeManagedVolume(VOLUME)).rejects.toThrow(/stale, invalid/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
  })

  it('marks fallback volume sizes unknown so bounded GC cannot delete them', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'system' && args[1] === 'df') return { code: 1, stdout: '', stderr: 'unavailable' }
      if (args[0] === 'volume' && args[1] === 'ls') {
        return {
          code: 0,
          stdout: JSON.stringify({
            Name: 'dh-room1abc-cache',
            Driver: 'local',
            Scope: 'local',
            Mountpoint: '/var/lib/docker/volumes/dh-room1abc-cache/_data',
            Labels: 'devhotel.managed=1,devhotel.room=room1abc,devhotel.role=volume',
            Links: '0'
          }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({ identityFile: join(dir, 'engine.json') })

    await expect(backend.listVolumesWithUsage()).resolves.toEqual([
      expect.objectContaining({
        name: 'dh-room1abc-cache',
        sizeBytes: 0,
        sizeKnown: false,
        ownership: 'managed-labels'
      })
    ])
  })

  it('refuses to silently create an empty volume when workspaceVolumeRevision > 0 is missing, throwing a DATA_LOSS error', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return { code: 0, stdout: '[]', stderr: '' }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              Name: `dh-${ROOM_ID}-net`,
              Driver: 'bridge',
              Labels: { 'devhotel.managed': '1', 'devhotel.room': ROOM_ID, 'devhotel.role': 'network' }
            }
          ]),
          stderr: ''
        }
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'no such volume' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const backend = new OciCliBackend({ identityFile: join(dir, 'engine.json') })
    const spec: WebSpec = {
      roomId: ROOM_ID,
      internalPort: 3000,
      nodeMajor: '22',
      sourceType: 'linked-folder',
      sourceRef: 'C:\\src',
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      startCommand: 'npm start'
    }

    await expect(backend.recreateWeb(spec)).rejects.toThrow(
      expect.objectContaining({
        name: 'DevHotelError',
        code: 'DATA_LOSS'
      })
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'volume' && args[1] === 'create')).toBe(false)
  })
})
