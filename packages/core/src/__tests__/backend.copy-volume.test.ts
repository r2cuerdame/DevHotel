import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const SOURCE_ROOM = 'source'
const TARGET_ROOM = 'target'
const SOURCE = 'dh-source-src'
const TARGET = 'dh-target-src'
const ok = { code: 0, stdout: '', stderr: '' }

function volumeInspect(roomId: string, name: string): string {
  return JSON.stringify([
    {
      Name: name,
      Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'volume',
        'devhotel.managed': '1'
      }
    }
  ])
}

describe('OciCliBackend.copyVolume', () => {
  let targetExists: boolean

  beforeEach(() => {
    targetExists = false
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (args[2] === SOURCE) return { code: 0, stdout: volumeInspect(SOURCE_ROOM, SOURCE), stderr: '' }
        if (args[2] === TARGET && targetExists) {
          return { code: 0, stdout: volumeInspect(TARGET_ROOM, TARGET), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'Error: No such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        targetExists = true
        return ok
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        targetExists = false
        return ok
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      return ok
    })
  })

  it('copies through a read-only source mount and creates an owned target', async () => {
    await new OciCliBackend().copyVolume(SOURCE_ROOM, SOURCE, TARGET_ROOM, TARGET)

    expect(mockedRunDocker).toHaveBeenCalledWith(['volume', 'inspect', SOURCE])
    expect(mockedRunDocker).toHaveBeenCalledWith([
      'volume',
      'create',
      '--label',
      `devhotel.room=${TARGET_ROOM}`,
      '--label',
      'devhotel.role=volume',
      '--label',
      'devhotel.managed=1',
      TARGET
    ])
    const copyCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')
    expect(copyCall?.[0]).toEqual([
      'run',
      '--rm',
      '-v',
      `${SOURCE}:/from:ro`,
      '-v',
      `${TARGET}:/to`,
      'alpine',
      'sh',
      '-c',
      'cd /from && tar cf - . | tar xpf - -C /to'
    ])
  })

  it('rejects unexpected names, unowned sources, and an existing target', async () => {
    await expect(
      new OciCliBackend().copyVolume(SOURCE_ROOM, 'user-volume', TARGET_ROOM, TARGET)
    ).rejects.toThrow(/invalid Room source volume name/)
    expect(mockedRunDocker).not.toHaveBeenCalled()

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (args[2] === SOURCE) {
          return { code: 0, stdout: JSON.stringify([{ Name: SOURCE, Labels: {} }]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'Error: No such volume' }
      }
      return ok
    })
    await expect(new OciCliBackend().copyVolume(SOURCE_ROOM, SOURCE, TARGET_ROOM, TARGET)).rejects.toThrow(
      /ownership metadata/
    )

    targetExists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return args[2] === SOURCE
          ? { code: 0, stdout: volumeInspect(SOURCE_ROOM, SOURCE), stderr: '' }
          : { code: 0, stdout: volumeInspect(TARGET_ROOM, TARGET), stderr: '' }
      }
      return ok
    })
    await expect(new OciCliBackend().copyVolume(SOURCE_ROOM, SOURCE, TARGET_ROOM, TARGET)).rejects.toThrow(
      /already exists/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false)
  })

  it('strictly removes a partially copied target when tar fails', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (args[2] === SOURCE) return { code: 0, stdout: volumeInspect(SOURCE_ROOM, SOURCE), stderr: '' }
        if (args[2] === TARGET && targetExists) {
          return { code: 0, stdout: volumeInspect(TARGET_ROOM, TARGET), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'Error: No such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        targetExists = true
        return ok
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        targetExists = false
        return ok
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') return { code: 2, stdout: '', stderr: 'tar failed' }
      return ok
    })

    await expect(new OciCliBackend().copyVolume(SOURCE_ROOM, SOURCE, TARGET_ROOM, TARGET)).rejects.toThrow(/tar failed/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['volume', 'rm', '-f', TARGET])
  })

  it('imports a Host folder only through a short-lived read-only mount and excludes generated caches', async () => {
    const imported = 'dh-target-src-r1'
    let exists = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return exists
          ? { code: 0, stdout: volumeInspect(TARGET_ROOM, imported), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'create') exists = true
      return ok
    })

    await new OciCliBackend().importHostFolder(TARGET_ROOM, 'C:\\approved\\project', 1)

    const helper = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')?.[0] ?? []
    expect(helper).toContain('type=bind,source=C:\\approved\\project,target=/source,readonly')
    expect(helper).toContain('--network')
    expect(helper).toContain('none')
    for (const generated of ['node_modules', '.next', '.gradle', '.kotlin', 'build', 'target']) {
      expect(helper.at(-1)).toContain(`--exclude='./${generated}'`)
    }
    expect(helper.at(-1)).toContain('.devhotel-sync-include')
    expect(helper.at(-1)).toContain('tar -C /source -cf - "$include"')
    // An opted-in path must be canonicalised, not just checked lexically: tar
    // follows symlinked parents, so without this the include list could copy
    // files from outside the folder the human linked.
    expect(helper.at(-1)).toContain('include_probe=$include_dir')
    expect(helper.at(-1)).toContain('include_root=$(realpath "$include_probe"')
    expect(helper.at(-1)).toMatch(/\/source\|\/source\/\*\)/)
    expect(helper).toContain(`${imported}:/workspace`)
  })

  it('removes a staged Host import volume when the helper copy fails', async () => {
    const imported = 'dh-target-src-r1'
    let exists = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return exists
          ? { code: 0, stdout: volumeInspect(TARGET_ROOM, imported), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        exists = true
        return ok
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        exists = false
        return ok
      }
      if (args[0] === 'run') return { code: 2, stdout: '', stderr: 'copy failed' }
      return ok
    })

    await expect(new OciCliBackend().importHostFolder(TARGET_ROOM, 'C:\\approved\\project', 1)).rejects.toThrow(
      /copy failed/
    )
    expect(mockedRunDocker).toHaveBeenCalledWith(['volume', 'rm', '-f', imported])
  })
})
