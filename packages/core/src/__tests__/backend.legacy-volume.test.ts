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
const VOLUME = 'dh-r1-cache'

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
      canAdoptLegacyVolume: (roomId, name) => roomId === 'r1' && name === VOLUME
    })

    await expect(backend.adoptLegacyRoomVolumes('r1')).resolves.toEqual([VOLUME])
    await expect(backend.volumeSizes('r1')).resolves.toEqual({})
    const registry = JSON.parse(readFileSync(adoptionFile, 'utf8')) as { volumes: Record<string, unknown> }
    expect(registry.volumes[VOLUME]).toMatchObject({ roomId: 'r1', driver: 'local', scope: 'local' })
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
      new OciCliBackend({ ...base, canAdoptLegacyVolume: () => false }).adoptLegacyRoomVolumes('r1')
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
      new OciCliBackend({ ...base, canAdoptLegacyVolume: () => true }).adoptLegacyRoomVolumes('r1')
    ).rejects.toThrow(/unsafe or ambiguous/)
  })
})
