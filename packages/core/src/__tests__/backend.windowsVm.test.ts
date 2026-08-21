import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { link, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WindowsVmBackend,
  resolveVmrunExecutable,
  type VmwareCommandResult,
  type VmwareCommandRunner
} from '../backend/windowsVm'

interface CommandCall {
  executable: string
  args: string[]
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dh-vmware-test-'))
  temporaryRoots.push(root)
  return root
}

function ok(stdout = ''): VmwareCommandResult {
  return { code: 0, stdout, stderr: '' }
}

function canonical(candidate: string): string {
  return realpathSync.native(candidate)
}

function createHarness(opts: { cloneAliasesTemplate?: boolean; secondCloneFails?: boolean } = {}) {
  const root = tempRoot()
  const userData = path.join(root, 'user-data')
  const templateDir = path.join(root, 'template')
  const templateVmxPath = path.join(templateDir, 'base.vmx')
  mkdirSync(templateDir, { recursive: true })
  writeFileSync(
    templateVmxPath,
    [
      '.encoding = "windows-1252"',
      'displayName = "Base Windows"',
      'annotation = "localized-byte-preservation"',
      'isolation.tools.copy.disable = "FALSE"',
      'isolation.tools.paste.disable = "FALSE"',
      'isolation.tools.dnd.disable = "FALSE"',
      'isolation.tools.hgfs.disable = "FALSE"',
      'tools.guestlib.enableHostInfo = "TRUE"',
      'sharedFolder.maxNum = "1"',
      'sharedFolder0.present = "TRUE"',
      'sharedFolder0.hostPath = "C:\\\\source"',
      'usb.present = "TRUE"',
      'usb.autoConnect.device0 = "path:1/2"',
      'ethernet0.present = "TRUE"',
      'ethernet0.startConnected = "TRUE"',
      'ethernet0.connectionType = "nat"',
      'ethernet1.present = "TRUE"',
      'ethernet1.startConnected = "TRUE"',
      'serial0.present = "TRUE"',
      'serial0.fileName = "C:\\\\host\\\\serial.log"',
      'parallel0.present = "TRUE"',
      'parallel0.fileName = "LPT1"',
      'floppy0.present = "TRUE"',
      'floppy0.fileName = "C:\\\\host\\\\secret.flp"',
      'ide1:0.present = "TRUE"',
      'ide1:0.deviceType = "cdrom-image"',
      'ide1:0.fileName = "C:\\\\host\\\\secret.iso"',
      'scsi0:0.present = "TRUE"',
      'scsi0:0.fileName = "base-disk.vmdk"',
      'guestinfo.hostSecret = "must-not-cross"',
      'vmci0.present = "TRUE"'
    ].join('\n'),
    'utf8'
  )

  const calls: CommandCall[] = []
  const running = new Set<string>()
  let cloneCount = 0
  const runner: VmwareCommandRunner = async (executable, readonlyArgs) => {
    const args = [...readonlyArgs]
    calls.push({ executable, args })
    switch (args[0]) {
      case 'listSnapshots':
        return ok('Total snapshots: 2\nClean Base\nAnother\n')
      case 'clone': {
        cloneCount += 1
        if (opts.secondCloneFails && cloneCount === 2) return { code: 1, stdout: '', stderr: 'clone failed' }
        const target = args[2]
        if (!target) throw new Error('clone target missing')
        await mkdir(path.dirname(target), { recursive: true })
        if (opts.cloneAliasesTemplate) await link(templateVmxPath, target)
        else await writeFile(target, readFileSync(templateVmxPath, 'utf8'), 'utf8')
        return ok()
      }
      case 'disableSharedFolders':
        return ok()
      case 'start': {
        const vmx = args[1]
        if (vmx) running.add(path.resolve(vmx))
        return ok()
      }
      case 'stop': {
        const vmx = args[1]
        if (vmx) running.delete(path.resolve(vmx))
        return ok()
      }
      case 'deleteVM':
        return ok()
      case 'list':
        return ok(`Total running VMs: ${running.size}\n${[...running].join('\n')}${running.size ? '\n' : ''}`)
      default:
        return { code: 2, stdout: '', stderr: 'unexpected command' }
    }
  }
  const opened: string[] = []
  const backend = new WindowsVmBackend({
    userData,
    vmrunExecutable: 'C:\\VMware\\vmrun.exe',
    runner,
    consoleLauncher: (vmxPath) => {
      opened.push(vmxPath)
    },
    now: () => new Date('2026-08-21T12:00:00.000Z')
  })
  const roomDir = path.join(userData, 'runtime', 'vmware', 'rooms', 'room1abc')
  const roomVmxPath = path.join(roomDir, 'room.vmx')
  return { backend, calls, opened, running, root, userData, templateVmxPath, roomDir, roomVmxPath }
}

describe('resolveVmrunExecutable', () => {
  it('prefers the explicit override, then PATH, then standard Workstation candidates', () => {
    expect(
      resolveVmrunExecutable({
        env: { DEVHOTEL_VMRUN_PATH: ' "D:\\Runtime\\vmrun.exe" ', PATH: 'C:\\tools' },
        platform: 'win32',
        fileExists: () => false
      })
    ).toBe('D:\\Runtime\\vmrun.exe')

    expect(
      resolveVmrunExecutable({
        env: { Path: 'C:\\missing;"D:\\VMware Bin"' },
        platform: 'win32',
        fileExists: (candidate) => candidate === 'D:\\VMware Bin\\vmrun.exe'
      })
    ).toBe('D:\\VMware Bin\\vmrun.exe')

    const standard = 'C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe'
    expect(
      resolveVmrunExecutable({
        env: { PATH: '', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        platform: 'win32',
        fileExists: (candidate) => candidate === standard
      })
    ).toBe(standard)

    expect(
      resolveVmrunExecutable({
        env: { PATH: '', ProgramFiles: 'C:\\Program Files' },
        platform: 'win32',
        fileExists: (candidate) => candidate.includes('VMware Player')
      })
    ).toBe('vmrun.exe')
  })
})

describe('WindowsVmBackend template inspection', () => {
  it('compares fresh vmrun discovery without returning the pinned path', () => {
    const { backend } = createHarness()

    expect(backend.isConfiguredFor('C:\\VMware\\vmrun.exe')).toBe(true)
    expect(backend.isConfiguredFor('C:\\Other\\vmrun.exe')).toBe(false)
  })

  it('uses official vmrun argv and requires an exact safe snapshot name', async () => {
    const { backend, calls, templateVmxPath } = createHarness()
    await expect(backend.health()).resolves.toEqual({
      ok: true,
      detail: 'VMware Workstation vmrun is available'
    })
    const identity = await backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean Base' })
    const identityPath = process.platform === 'win32' ? canonical(templateVmxPath).toLowerCase() : canonical(templateVmxPath)
    const pathOnlyId = createHash('sha256').update(identityPath).digest('hex')

    expect(identity).toEqual({ templateId: expect.stringMatching(/^[a-f0-9]{64}$/), snapshot: 'Clean Base' })
    expect(identity.templateId).not.toBe(pathOnlyId)
    await expect(backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean Base' })).resolves.toEqual(identity)
    expect(JSON.stringify(identity)).not.toContain(templateVmxPath)
    expect(calls.map((call) => call.args)).toContainEqual(['list'])
    expect(calls.map((call) => call.args)).toContainEqual(['listSnapshots', canonical(templateVmxPath)])
    expect(calls.flatMap((call) => call.args)).not.toContain('-T')

    await expect(backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean' })).rejects.toThrow(/exact snapshot/)
    await expect(backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean/Base' })).rejects.toThrow(/snapshot names/)
    await expect(backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean\\Base' })).rejects.toThrow(/snapshot names/)
  })

  it('refuses to clone or reset from a powered-on template', async () => {
    const { backend, running, templateVmxPath } = createHarness()
    running.add(canonical(templateVmxPath))

    await expect(
      backend.inspectTemplate({ templateVmxPath, snapshot: 'Clean Base' })
    ).rejects.toThrow(/must be powered off/)
  })
})

describe('WindowsVmBackend owned lifecycle', () => {
  it('creates a linked clone, records ownership, and hardens every Host integration offline', async () => {
    const { backend, calls, templateVmxPath, roomDir, roomVmxPath } = createHarness()
    const identity = await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })

    expect(identity).toMatchObject({ roomId: 'room1abc', snapshot: 'Clean Base' })
    expect(JSON.stringify(identity)).not.toContain(templateVmxPath)
    expect(calls.map((call) => call.args)).toContainEqual([
      'clone',
      canonical(templateVmxPath),
      canonical(roomVmxPath),
      'linked',
      '-snapshot=Clean Base'
    ])
    expect(calls.map((call) => call.args)).toContainEqual([
      'disableSharedFolders',
      canonical(roomVmxPath)
    ])

    const vmx = await readFile(roomVmxPath, 'utf8')
    expect(vmx).toContain('displayName = "Base Windows"')
    expect(vmx).toContain('annotation = "localized-byte-preservation"')
    expect(vmx).toContain('isolation.tools.copy.disable = "TRUE"')
    expect(vmx).toContain('isolation.tools.paste.disable = "TRUE"')
    expect(vmx).toContain('isolation.tools.dnd.disable = "TRUE"')
    expect(vmx).toContain('isolation.tools.hgfs.disable = "TRUE"')
    expect(vmx).toContain('sharedFolder.maxNum = "0"')
    expect(vmx).not.toContain('sharedFolder0.')
    expect(vmx).toContain('usb.present = "FALSE"')
    expect(vmx).not.toContain('usb.autoConnect')
    expect(vmx).toContain('ethernet0.present = "FALSE"')
    expect(vmx).toContain('ethernet0.startConnected = "FALSE"')
    expect(vmx).toContain('ethernet1.present = "FALSE"')
    expect(vmx).toContain('ethernet1.startConnected = "FALSE"')
    expect(vmx).not.toMatch(/ethernet\d+\.present\s*=\s*"TRUE"/i)
    expect(vmx).not.toMatch(/ethernet\d+\.startConnected\s*=\s*"TRUE"/i)
    expect(vmx).not.toContain('connectionType = "nat"')
    expect(vmx).toContain('serial0.present = "FALSE"')
    expect(vmx).toContain('parallel0.present = "FALSE"')
    expect(vmx).toContain('floppy0.present = "FALSE"')
    expect(vmx).toContain('ide1:0.present = "FALSE"')
    expect(vmx).not.toContain('secret.iso')
    expect(vmx).not.toContain('serial.log')
    expect(vmx).not.toContain('secret.flp')
    expect(vmx).toContain('scsi0:0.present = "TRUE"')
    expect(vmx).toContain('scsi0:0.fileName = "base-disk.vmdk"')
    expect(vmx).not.toContain('guestinfo.hostSecret')
    expect(vmx).toContain('vmci0.present = "FALSE"')
    expect(vmx).toContain('tools.guestlib.enableHostInfo = "FALSE"')
    expect(vmx).not.toMatch(/tools\.guestlib\.enablehostinfo\s*=\s*"TRUE"/i)
    expect(vmx.match(/^tools\.guestlib\.enablehostinfo\s*=/gim)).toHaveLength(1)

    const marker = JSON.parse(await readFile(path.join(roomDir, 'ownership.json'), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({
      schemaVersion: 2,
      owner: 'devhotel',
      backend: 'vmware-workstation',
      roomId: 'room1abc',
      status: 'ready',
      templateVmxPath: canonical(templateVmxPath),
      snapshot: 'Clean Base',
      vmxFile: 'room.vmx'
    })
    expect(marker['templateFingerprint']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('starts nogui, matches the exact running VMX, sleeps softly, and opens only the owned console', async () => {
    const { backend, calls, opened, templateVmxPath, roomVmxPath } = createHarness()
    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })

    await expect(backend.state('room1abc')).resolves.toBe('stopped')
    await backend.start('room1abc')
    await expect(backend.state('room1abc')).resolves.toBe('running')
    await backend.openConsole('room1abc')
    await backend.sleep('room1abc')
    await expect(backend.state('room1abc')).resolves.toBe('stopped')

    expect(calls.map((call) => call.args)).toContainEqual(['start', canonical(roomVmxPath), 'nogui'])
    expect(calls.map((call) => call.args)).toContainEqual(['stop', canonical(roomVmxPath), 'soft'])
    expect(opened).toEqual([canonical(roomVmxPath)])
  })

  it('does not treat a prefix or same basename in another directory as the owned running VM', async () => {
    const { backend, calls, userData, templateVmxPath, roomVmxPath } = createHarness()
    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    const runnerCallCount = calls.length

    const prefixCollision = `${roomVmxPath}.backup`
    const basenameCollision = path.join(path.dirname(path.dirname(roomVmxPath)), 'foreign', path.basename(roomVmxPath))
    const replacement = new WindowsVmBackend({
      userData,
      vmrunExecutable: 'vmrun.exe',
      runner: async (_executable, args) => {
        if (args[0] === 'list') {
          return ok(`Total running VMs: 2\n${prefixCollision}\n${basenameCollision}\n`)
        }
        return ok()
      }
    })
    await expect(replacement.state('room1abc')).resolves.toBe('stopped')
    expect(calls).toHaveLength(runnerCallCount)
    expect(existsSync(roomVmxPath)).toBe(true)
  })

  it('soft-stops before exact marker revalidation and never removes the template', async () => {
    const { backend, calls, templateVmxPath, roomDir, roomVmxPath } = createHarness()
    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    await backend.start('room1abc')
    const canonicalRoomVmx = canonical(roomVmxPath)
    await expect(backend.delete('room1abc')).resolves.toMatchObject({ reclaimedBytes: expect.any(Number) })

    expect(calls.map((call) => call.args)).toContainEqual(['stop', canonicalRoomVmx, 'soft'])
    expect(calls.map((call) => call.args)).toContainEqual(['deleteVM', canonicalRoomVmx])
    await expect(readFile(templateVmxPath, 'utf8')).resolves.toContain('Base Windows')
    expect(existsSync(roomDir)).toBe(false)
  })

  it('cleans an exact empty pre-marker directory and treats an absent clone as already deleted', async () => {
    const { backend, roomDir } = createHarness()
    await mkdir(roomDir, { recursive: true })

    await expect(backend.delete('room1abc')).resolves.toEqual({ reclaimedBytes: 0 })
    expect(existsSync(roomDir)).toBe(false)
    await expect(backend.delete('room1abc')).resolves.toEqual({ reclaimedBytes: 0 })
  })

  it('refuses a clone that aliases the immutable template without hardening the template', async () => {
    const { backend, templateVmxPath, roomDir } = createHarness({ cloneAliasesTemplate: true })
    const original = await readFile(templateVmxPath, 'utf8')

    await expect(
      backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    ).rejects.toThrow(/aliases the immutable template/)

    await expect(readFile(templateVmxPath, 'utf8')).resolves.toBe(original)
    const marker = JSON.parse(await readFile(path.join(roomDir, 'ownership.json'), 'utf8')) as {
      status: string
    }
    expect(marker.status).toBe('broken')
  })

  it('refuses invalid IDs, templates under the managed root, and a forged ownership marker', async () => {
    const { backend, calls, userData, templateVmxPath, roomDir } = createHarness()
    await expect(
      backend.create({ roomId: '../room1', templateVmxPath, snapshot: 'Clean Base' })
    ).rejects.toThrow(/exactly 8/)

    const nestedTemplate = path.join(userData, 'runtime', 'vmware', 'rooms', 'templates', 'base.vmx')
    await mkdir(path.dirname(nestedTemplate), { recursive: true })
    await writeFile(nestedTemplate, 'displayName = "unsafe"\n')
    await expect(
      backend.inspectTemplate({ templateVmxPath: nestedTemplate, snapshot: 'Clean Base' })
    ).rejects.toThrow(/cannot live inside/)

    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    const markerPath = path.join(roomDir, 'ownership.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    marker['roomId'] = 'evilroom'
    await writeFile(markerPath, JSON.stringify(marker), 'utf8')
    const deleteCallsBefore = calls.filter((call) => call.args[0] === 'deleteVM').length
    await expect(backend.delete('room1abc')).rejects.toThrow(/ownership marker/)
    expect(calls.filter((call) => call.args[0] === 'deleteVM')).toHaveLength(deleteCallsBefore)
    await expect(readFile(templateVmxPath, 'utf8')).resolves.toContain('Base Windows')
  })

  it('resets through soft stop and deleteVM, then clones the exact same template snapshot', async () => {
    const { backend, calls, templateVmxPath, roomDir, roomVmxPath } = createHarness()
    const first = await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    await backend.start('room1abc')
    const reset = await backend.reset('room1abc')

    expect(reset).toEqual(first)
    expect(calls.map((call) => call.args)).toContainEqual(['stop', canonical(roomVmxPath), 'soft'])
    expect(calls.map((call) => call.args)).toContainEqual(['deleteVM', canonical(roomVmxPath)])
    const clones = calls.filter((call) => call.args[0] === 'clone')
    expect(clones).toHaveLength(2)
    expect(clones[1]?.args).toEqual(clones[0]?.args)
    const marker = JSON.parse(await readFile(path.join(roomDir, 'ownership.json'), 'utf8')) as { status: string }
    expect(marker.status).toBe('ready')
    await expect(readFile(templateVmxPath, 'utf8')).resolves.toContain('Base Windows')
  })

  it('refuses reset when the template metadata changed after the clone was created', async () => {
    const { backend, templateVmxPath, roomDir } = createHarness()
    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    await expect(backend.validateBaseline('room1abc')).resolves.toEqual({
      ok: true,
      detail: 'VMware template and clean snapshot are unchanged'
    })
    await writeFile(templateVmxPath, `${await readFile(templateVmxPath, 'utf8')}\nannotation = "changed"\n`, 'utf8')

    await expect(backend.validateBaseline('room1abc')).resolves.toMatchObject({ ok: false })
    await expect(backend.reset('room1abc')).rejects.toThrow(/fingerprint changed/)
    const marker = JSON.parse(await readFile(path.join(roomDir, 'ownership.json'), 'utf8')) as { status: string }
    expect(marker.status).toBe('broken')
  })

  it('keeps a broken ownership marker when reset recloning fails', async () => {
    const { backend, templateVmxPath, roomDir } = createHarness({ secondCloneFails: true })
    await backend.create({ roomId: 'room1abc', templateVmxPath, snapshot: 'Clean Base' })
    await expect(backend.reset('room1abc')).rejects.toThrow(/linked Windows Room clone failed/)

    const marker = JSON.parse(await readFile(path.join(roomDir, 'ownership.json'), 'utf8')) as {
      status: string
      templateVmxPath: string
      snapshot: string
    }
    expect(marker).toMatchObject({
      status: 'broken',
      templateVmxPath: canonical(templateVmxPath),
      snapshot: 'Clean Base'
    })
    await expect(readFile(templateVmxPath, 'utf8')).resolves.toContain('Base Windows')
  })
})
