import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const VOLUME = `dh-${ROOM_ID}-cache`

function legacyInspect(driver = 'local'): string {
  return JSON.stringify([
    {
      Name: VOLUME,
      Driver: driver,
      Scope: 'local',
      Mountpoint: `/var/lib/docker/volumes/${VOLUME}/_data`,
      Labels: null,
      Options: null
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
    const registry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { volumes: Record<string, unknown> }
    expect(registry.volumes[VOLUME]).toMatchObject({ roomId: ROOM_ID, driver: 'local', scope: 'local' })
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
  })

  it('removes an exactly recorded legacy volume without force and retires its ownership record first', async () => {
    const adoptionFile = join(dir, 'legacy-volumes.json')
    let exists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'engine-one' }), stderr: '' }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return exists
          ? { code: 0, stdout: legacyInspect(), stderr: '' }
          : { code: 1, stdout: '', stderr: 'no such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
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
    await backend.removeManagedVolume(VOLUME)

    expect(mockedRunDocker.mock.calls.some(([args]) =>
      args[0] === 'volume' && args[1] === 'rm' && args.join(' ') === `volume rm ${VOLUME}`
    )).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args.includes('-f'))).toBe(false)
    const registry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { volumes: Record<string, unknown> }
    expect(registry.volumes[VOLUME]).toBeUndefined()
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
})
