import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedHyperVRuntime,
  NamedPipeHyperVGuestTransport,
  type ManagedHyperVGuestStatus,
  type ManagedHyperVGuestTransport
} from '../backend/managedHyperVRuntime'
import type { ManagedRuntimeCommandRunner } from '../backend/managedRuntime'

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-hyperv-runtime-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const imageBytes = Buffer.from('test-alpine-virt-iso')
const imageDigest = createHash('sha256').update(imageBytes).digest('hex')

async function releaseImage() {
  const root = await tempDir()
  const file = path.join(root, 'base.iso')
  await writeFile(file, imageBytes)
  return { file, sha256: imageDigest, sizeBytes: imageBytes.byteLength }
}

function readPowerShellArray(script: string, variable: string): string[] {
  const start = script.indexOf(`$${variable}=@(`)
  if (start < 0) throw new Error(`Missing ${variable}`)
  const open = script.indexOf('(', start)
  const close = script.indexOf(')', open)
  const body = script.slice(open + 1, close)
  return [...body.matchAll(/'((?:''|[^'])*)'/g)].map((entry) => entry[1]!.replaceAll("''", "'"))
}

interface FakeVm {
  id: string
  state: string
  notes: string
}

function decodeScript(args: readonly string[]): string {
  expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  return Buffer.from(args[5]!, 'base64').toString('utf16le')
}

function readPowerShellLiteral(script: string, variable: string): string {
  const match = script.match(new RegExp(`\\$${variable}='((?:''|[^'])*)'`))
  if (!match) throw new Error(`Missing ${variable}`)
  return match[1]!.replaceAll("''", "'")
}

class FakeHyperV {
  vm: FakeVm | null = null
  readonly scripts: string[] = []
  readonly migrations: string[] = []
  /** What this Host pretends to answer to `-ExposeVirtualizationExtensions`. */
  grantsNested = true

  readonly runner: ManagedRuntimeCommandRunner = async (executable, args) => {
    expect(executable).toBe('powershell.exe')
    const script = decodeScript(args)
    this.scripts.push(script)
    if (script.includes('Migrated=$true')) {
      if (this.vm) {
        if (this.vm.notes !== readPowerShellLiteral(script, 'notes')) {
          return { code: 1, stdout: '', stderr: 'Managed Hyper-V VM ownership proof is invalid' }
        }
        this.vm = null
      }
      this.migrations.push(script)
      return { code: 0, stdout: JSON.stringify({ Migrated: true }), stderr: '' }
    }
    if (script.includes('Remove-VM -VM $vm -Force')) {
      if (this.vm) {
        // The provider's own fences, enforced the way Hyper-V would.
        if (this.vm.notes !== readPowerShellLiteral(script, 'notes')) {
          return { code: 1, stdout: '', stderr: 'Managed Hyper-V VM ownership proof is invalid' }
        }
        this.vm = null
      }
      return { code: 0, stdout: JSON.stringify({ Removed: true }), stderr: '' }
    }
    if (script.includes('$vm=Get-VM')) {
      return {
        code: 0,
        stdout: JSON.stringify(
          this.vm
            ? { Exists: true, Id: this.vm.id, State: this.vm.state, Notes: this.vm.notes }
            : { Exists: false, Id: null, State: null, Notes: null }
        ),
        stderr: ''
      }
    }
    if (script.includes('New-VM -Name')) {
      this.vm = {
        id: '11111111-2222-3333-4444-555555555555',
        state: 'Off',
        notes: readPowerShellLiteral(script, 'notes')
      }
      return {
        code: 0,
        stdout: JSON.stringify({ Id: this.vm.id, State: this.vm.state, Nested: this.grantsNested }),
        stderr: ''
      }
    }
    if (script.includes('Start-VM -Name')) {
      if (!this.vm) return { code: 1, stdout: '', stderr: 'missing VM' }
      this.vm.state = 'Running'
      return { code: 0, stdout: '', stderr: '' }
    }
    if (script.includes('Save-VM -Name')) {
      if (!this.vm) return { code: 1, stdout: '', stderr: 'missing VM' }
      this.vm.state = 'Saved'
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected PowerShell command' }
  }
}

function health(overrides: Partial<ManagedHyperVGuestStatus> = {}): ManagedHyperVGuestTransport {
  return {
    health: vi.fn(async (): Promise<ManagedHyperVGuestStatus> => ({
      owner: 'devhotel',
      installId: 'install-owned',
      runtimeId: 'runtime-owned',
      runtimeVersion: '0.1.0',
      daemonVersion: '0.1.0',
      state: 'ready',
      ...overrides
    }))
  }
}

async function runtime(fake: FakeHyperV, guest = health()) {
  return runtimeAt(fake, await tempDir(), '0.1.0', guest)
}

/** A provider pinned to one version over a chosen data root, as the real factory builds one. */
function runtimeAt(fake: FakeHyperV, userData: string, runtimeVersion: string, guest = health({ runtimeVersion, daemonVersion: runtimeVersion })) {
  return new ManagedHyperVRuntime({
    userData,
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    runtimeVersion,
    runner: fake.runner,
    guest,
    now: () => new Date('2026-09-16T00:00:00Z')
  })
}

describe('ManagedHyperVRuntime', () => {
  it('rejects identities that could escape generated guest or PowerShell data', async () => {
    const userData = await tempDir()
    expect(
      () =>
        new ManagedHyperVRuntime({
          userData,
          installId: "install'; reboot",
          runtimeId: 'runtime-owned',
          runtimeVersion: '0.1.0'
        })
    ).toThrow('identity is invalid')
  })

  it('copies a verified immutable image and creates an owned separate-kernel VM', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    const marker = await managed.provision(await releaseImage())

    expect(marker).toMatchObject({
      owner: 'devhotel',
      backend: 'hyper-v',
      installId: 'install-owned',
      runtimeId: 'runtime-owned',
      runtimeVersion: '0.1.0',
      vmId: fake.vm?.id,
      baseImageDigest: imageDigest,
      status: 'stopped'
    })
    expect(marker.vmName).toMatch(/^DevHotel-[a-f0-9]{16}$/)
    expect(fake.scripts.join('\n')).toContain('Set-VMFirmware -VM $vm -EnableSecureBoot Off')
    expect(fake.scripts.join('\n')).toContain('Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true -ErrorAction Stop')
    expect(fake.scripts.join('\n')).toContain('Set-VMComPort -VM $vm -Number 2 -Path $pipePath')
    expect(fake.scripts.join('\n')).toContain('Format-Volume -FileSystem FAT -NewFileSystemLabel')

    // The guest bootstrap travels as an Alpine apkovl the initramfs discovers,
    // not as a cloud-init seed the pinned image would never read.
    const createScript = fake.scripts.find((script) => script.includes('New-VM -Name'))!
    expect(readPowerShellLiteral(createScript, 'overlayName')).toBe('devhotel.apkovl.tar.gz')
    const overlay = gunzipSync(Buffer.from(readPowerShellLiteral(createScript, 'overlayB64'), 'base64')).toString('utf8')
    expect(overlay).toContain('etc/devhotel/ownership.json')
    expect(overlay).toContain('usr/local/sbin/devhotel-runtime-agent')
    expect(overlay).toContain('etc/runlevels/default/devhotel-runtime-agent')
    expect(overlay).toContain('runtime-owned')
    expect(createScript).not.toContain('cloud-config')
    expect(createScript).not.toContain('CIDATA')

    expect(await readFile(path.join(path.dirname(marker.vmPath), 'images', `${imageDigest}.iso`))).toEqual(imageBytes)
    expect(marker.overlayDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('boots the Generation 2 VM from the pinned ISO on a SCSI DVD', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    const marker = await managed.provision(await releaseImage())
    const createScript = fake.scripts.find((script) => script.includes('New-VM -Name'))!

    // Generation 2 boots a SCSI .vhdx or a virtual DVD; it has no IDE
    // controller, so the boot media must be the DVD, never a .vhd.
    expect(createScript).toContain('New-VM -Name $vmName -Generation 2')
    expect(createScript).toContain('-NoVHD')
    expect(createScript).toContain('$dvd=Add-VMDvdDrive -VM $vm -Path $isoPath -Passthru')
    expect(createScript).toContain('Set-VMFirmware -VM $vm -EnableSecureBoot Off -FirstBootDevice $dvd')
    expect(createScript).not.toContain('-VHDPath')
    expect(path.extname(readPowerShellLiteral(createScript, 'isoPath'))).toBe('.iso')
    expect(path.extname(marker.isoPath)).toBe('.iso')
  })

  it('still provisions on a Host that refuses nested virtualization', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    await managed.provision(await releaseImage())
    const createScript = fake.scripts.find((script) => script.includes('New-VM -Name'))!

    // Nested virtualization only matters later, for KVM in the guest. Hyper-V
    // refuses it on hosts that cannot nest -- including inside a VM, since it
    // does not stack three levels deep -- and the runtime boots and serves Web
    // Rooms without it, so a refusal must not cost the user the whole VM.
    expect(createScript).toContain(
      'try { Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true -ErrorAction Stop; $nested=$true }'
    )
    // The fallback still has to set the processor count, or the VM keeps one.
    expect(createScript).toContain('catch { Set-VMProcessor -VM $vm -Count 4 -ErrorAction Stop }')

    // -ErrorAction Stop is load-bearing: a bare cmdlet failure is a
    // non-terminating error that `catch` never sees, which is how this came to
    // be silently ignored rather than handled.
    expect(createScript).not.toMatch(/ExposeVirtualizationExtensions \$true(?! -ErrorAction Stop)/)

    // Whether the VM got it is reported back, so it is a recorded outcome
    // rather than something nobody can tell apart from success.
    expect(createScript).toContain('Nested=$nested')
  })

  it('lets the Hyper-V VM account traverse to its attachments, and no more', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    const marker = await managed.provision(await releaseImage())
    const createScript = fake.scripts.find((script) => script.includes('New-VM -Name'))!

    // A VM worker runs as a per-VM virtual account that is in no ordinary
    // group, so it cannot traverse a user profile path. Hyper-V grants it the
    // attachment files themselves, but a file it cannot reach still fails the
    // start with "failed to open attachment ... Access is denied".
    expect(createScript).toContain("/grant '*S-1-5-83-0:(X)'")

    // (X) is traverse only, and carries no (OI)/(CI), so nothing below these
    // directories is listed, read or inherited.
    expect(createScript).not.toMatch(/S-1-5-83-0:\((OI|CI|F|M|R)/)

    // Every ancestor has to be granted: one unreachable link breaks the whole
    // path, so granting only the leaf would still fail the start.
    const granted = readPowerShellArray(createScript, 'traverse')
    expect(granted[0]).toBe(path.parse(marker.vmPath).root)
    expect(granted.at(-1)).toBe(marker.vmPath)
    for (const [index, dir] of granted.slice(1).entries()) {
      expect(path.dirname(dir)).toBe(granted[index])
    }
    // The attachments all live at or under the deepest granted directory.
    for (const attachment of [marker.seedPath, marker.statePath, marker.isoPath]) {
      expect(granted.some((dir) => attachment.startsWith(dir + path.sep))).toBe(true)
    }
  })

  it('keeps the runtime state disk out of the disposable seed rebuild', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    const marker = await managed.provision(await releaseImage())
    const createScript = fake.scripts.find((script) => script.includes('New-VM -Name'))!

    // The seed is regenerated from the marker identity, so destroying it is
    // safe. The state disk holds Room data and must only ever be created.
    expect(createScript).toContain('Remove-Item -LiteralPath $seedPath -Force -ErrorAction Stop')
    expect(createScript).not.toContain('Remove-Item -LiteralPath $statePath')
    expect(createScript).toContain('if (-not (Test-Path -LiteralPath $statePath)) { New-VHD -Path $statePath')
    expect(path.extname(marker.statePath)).toBe('.vhdx')
  })

  it('demands a deliberate migration when the generated guest overlay changes', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    const image = await releaseImage()
    const marker = await managed.provision(image)

    // Simulate a DevHotel build whose overlay bytes differ from the recorded
    // ones. Re-seeding underneath a running install would silently change the
    // guest's identity payload, so this must be refused by name.
    await writeFile(
      path.join(path.dirname(marker.vmPath), 'provider.json'),
      JSON.stringify({ ...marker, overlayDigest: 'b'.repeat(64) }),
      'utf8'
    )
    fake.vm = null

    await expect(managed.provision(image)).rejects.toThrow(/overlay changed.*version bump/i)
  })

  it('reuses the owned ISO instead of copying it again', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    const image = await releaseImage()

    const first = await managed.provision(image)
    fake.vm = null
    const second = await managed.provision(image)

    expect(second.isoPath).toBe(first.isoPath)
    expect(second.baseImageDigest).toBe(imageDigest)
  })

  it('requires a fresh matching nonce from the private named-pipe daemon', async () => {
    const pipePath = '\\\\.\\pipe\\devhotel-runtime-0123456789abcdef'
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      socket.once('data', (request) => {
        const requestId = String(request).trim().slice('health:'.length)
        socket.end(
          `${JSON.stringify({
            requestId,
            owner: 'devhotel',
            installId: 'install-owned',
            runtimeId: 'runtime-owned',
            runtimeVersion: '0.1.0',
            daemonVersion: '0.1.0',
            state: 'ready'
          })}\n`
        )
      })
    })
    await new Promise<void>((resolve, reject) => server.listen(pipePath, resolve).once('error', reject))
    try {
      await expect(new NamedPipeHyperVGuestTransport(2_000, 10).health(pipePath)).resolves.toMatchObject({
        runtimeId: 'runtime-owned',
        state: 'ready'
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('starts only after Host VM notes and guest daemon identities both match', async () => {
    const fake = new FakeHyperV()
    const guest = health()
    const managed = await runtime(fake, guest)
    await managed.provision(await releaseImage())

    await expect(managed.start()).resolves.toMatchObject({
      state: 'ready',
      runtimeId: 'runtime-owned',
      runtimeVersion: '0.1.0',
      daemonVersion: '0.1.0',
      baseImageDigest: imageDigest
    })
    expect(guest.health).toHaveBeenCalledOnce()
    expect(fake.vm?.state).toBe('Running')
  })

  it('refuses a colliding VM before any Hyper-V mutation', async () => {
    const fake = new FakeHyperV()
    fake.vm = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      state: 'Running',
      notes: JSON.stringify({ owner: 'someone-else' })
    }
    const managed = await runtime(fake)

    await expect(managed.provision(await releaseImage())).rejects.toThrow('collides with an unowned VM')
    expect(fake.scripts.some((script) => script.includes('New-VM -Name'))).toBe(false)
  })

  it('refuses Host marker, VM identity, release digest, and guest identity drift', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake, health({ runtimeId: 'runtime-forged' }))
    const image = await releaseImage()
    const marker = await managed.provision(image)

    await expect(managed.start()).rejects.toThrow('guest identity')
    fake.vm!.id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await expect(managed.start()).rejects.toThrow('VM identity changed')
    fake.vm!.id = marker.vmId!
    await writeFile(image.file, Buffer.from('tampered'))
    await expect(managed.repair(image)).rejects.toThrow('release image verification failed')
  })

  it('resumes an interrupted provisioning marker without recreating an owned VM', async () => {
    const fake = new FakeHyperV()
    const userData = await tempDir()
    const options = {
      userData,
      installId: 'install-owned',
      runtimeId: 'runtime-owned',
      runtimeVersion: '0.1.0',
      runner: fake.runner,
      guest: health()
    }
    const first = new ManagedHyperVRuntime(options)
    const image = await releaseImage()
    await first.provision(image)
    const createCount = fake.scripts.filter((script) => script.includes('New-VM -Name')).length

    const resumed = new ManagedHyperVRuntime(options)
    await expect(resumed.repair(image)).resolves.toMatchObject({ state: 'ready' })
    expect(fake.scripts.filter((script) => script.includes('New-VM -Name'))).toHaveLength(createCount)
  })

  it('rebuilds only the exact owned disks when an interrupted provision left no VM', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    const image = await releaseImage()
    await managed.provision(image)
    fake.vm = null

    await expect(managed.repair(image)).resolves.toMatchObject({ state: 'ready' })

    const recreated = fake.scripts.filter((script) => script.includes('New-VM -Name')).at(-1)!
    expect(recreated).toContain('Remove-Item -LiteralPath $seedPath -Force -ErrorAction Stop')
    expect(recreated.indexOf('Remove-Item -LiteralPath $seedPath')).toBeLessThan(recreated.indexOf('New-VHD -Path $seedPath'))
    // A repair must never destroy Room state.
    expect(recreated).not.toContain('Remove-Item -LiteralPath $statePath')
  })

  it('saves the exact owned VM and leaves it recoverable across app or Host restart', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    await managed.provision(await releaseImage())
    await managed.start()

    await expect(managed.stop()).resolves.toMatchObject({ state: 'stopped' })
    expect(fake.vm?.state).toBe('Saved')
    await expect(managed.start()).resolves.toMatchObject({ state: 'ready' })
  })

  it('records whether this Host granted nested virtualization', async () => {
    const granted = new FakeHyperV()
    const refused = new FakeHyperV()
    refused.grantsNested = false

    const withNested = await runtime(granted)
    const withoutNested = await runtime(refused)
    await withNested.provision(await releaseImage())
    await withoutNested.provision(await releaseImage())

    // Both provision. The difference is that the answer survives, because only
    // a guest that was granted it can later run KVM-backed Android emulators,
    // and nothing else on the Host records which of the two happened.
    await expect(withNested.observe()).resolves.toMatchObject({ nestedVirtualization: true })
    await expect(withoutNested.observe()).resolves.toMatchObject({ nestedVirtualization: false })
  })

  it('removes the owned VM before the disks it holds open', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    const marker = await managed.provision(await releaseImage())
    await managed.start()

    await expect(managed.remove()).resolves.toBe('removed')
    expect(fake.vm).toBeNull()

    const removeScript = fake.scripts.find((script) => script.includes('Remove-VM -VM $vm -Force'))!
    // A running guest is turned off rather than saved: a saved state only keeps
    // the VHDX attachments open against the delete that follows it.
    expect(removeScript).toContain("if ([string]$vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force -ErrorAction Stop }")
    // Order is the whole point. While the VM is registered, Hyper-V holds its
    // attachments, so deleting the directory first either fails on the lock or
    // leaves a VM pointing at disks that no longer exist.
    expect(removeScript.indexOf('Remove-VM -VM $vm -Force')).toBeLessThan(
      removeScript.indexOf('Remove-Item -LiteralPath $vmPath')
    )
    expect(existsSync(marker.vmPath.replace(/machine$/, 'provider.json'))).toBe(false)
  })

  it('refuses to remove a VM it cannot prove it created', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    await managed.provision(await releaseImage())

    // Someone else's VM now answers to this name -- a collision, or a restored
    // backup. Deleting it would destroy data DevHotel never owned.
    fake.vm = { ...fake.vm!, notes: JSON.stringify({ owner: 'someone-else' }) }

    await expect(managed.remove()).resolves.toBe('refused')
    expect(fake.vm).not.toBeNull()
    expect(fake.scripts.some((script) => script.includes('Remove-VM'))).toBe(false)
  })

  it('reports nothing to remove on a Host that was never provisioned', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)

    await expect(managed.remove()).resolves.toBe('nothing-owned')
    expect(fake.scripts.some((script) => script.includes('Remove-VM'))).toBe(false)
  })

  it('fails closed and sanitizes observation when ownership metadata is forged', async () => {
    const fake = new FakeHyperV()
    const managed = await runtime(fake)
    const marker = await managed.provision(await releaseImage())
    await writeFile(
      path.join(path.dirname(marker.vmPath), 'provider.json'),
      JSON.stringify({ owner: 'someone-else', failure: 'C:\\private\\secret' })
    )

    const observation = await managed.observe()
    expect(observation).toMatchObject({ state: 'broken', runtimeId: null, runtimeVersion: null })
    expect(JSON.stringify(observation)).not.toContain('private')
  })
  it('moves an owned runtime to another version without recreating the Room state disk', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    const before = await runtimeAt(fake, userData, '0.1.0').provision(image)

    const migrated = await runtimeAt(fake, userData, '0.2.0').migrateFrom('0.1.0', image)

    expect(migrated).toMatchObject({
      runtimeVersion: '0.2.0',
      installId: before.installId,
      runtimeId: before.runtimeId,
      // Same VM name, same paths: this is the same runtime moved, not a new one
      // standing beside it.
      vmName: before.vmName,
      statePath: before.statePath,
      vmPath: before.vmPath,
      status: 'stopped'
    })
    // The guest bootstrap is what the version change is for, so its digest has
    // to move with it.
    expect(migrated.overlayDigest).not.toBe(before.overlayDigest)

    const teardown = fake.migrations.at(0)!
    expect(teardown).toContain('Remove-VM -VM $vm -Force')
    // The whole promise of an update: the disk the Rooms are on is never
    // named by the teardown, so it cannot be detached, deleted or rebuilt.
    expect(teardown).not.toContain(before.statePath)
    expect(teardown).not.toContain('New-VHD')
    expect(teardown).toContain(before.seedPath)

    // And the rebuild reuses the state disk it found rather than making one.
    const rebuild = fake.scripts.filter((script) => script.includes('New-VM -Name')).at(-1)!
    expect(rebuild).toContain('if (-not (Test-Path -LiteralPath $statePath)) { New-VHD -Path $statePath')
    expect(readPowerShellLiteral(rebuild, 'statePath')).toBe(before.statePath)
  })

  it('refuses to migrate a VM it cannot prove it created', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    await runtimeAt(fake, userData, '0.1.0').provision(image)
    // Something else now answers to this name — a restored VM, a collision, a
    // user's own machine renamed onto it.
    fake.vm = { ...fake.vm!, notes: JSON.stringify({ owner: 'somebody-else' }) }

    await expect(runtimeAt(fake, userData, '0.2.0').migrateFrom('0.1.0', image)).rejects.toThrow(
      'Managed Hyper-V VM ownership proof is invalid'
    )
    // Refused means nothing happened, not "deleted anyway and reported".
    expect(fake.vm).not.toBeNull()
    expect(fake.migrations).toEqual([])
  })

  it('finishes a migration that was interrupted after the marker was written', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    await runtimeAt(fake, userData, '0.1.0').provision(image)
    const target = runtimeAt(fake, userData, '0.2.0')
    await target.migrateFrom('0.1.0', image)
    // What a crash between the VM rebuild and the next launch leaves: a marker
    // already on the target version.
    fake.vm = null

    const finished = await target.migrateFrom('0.1.0', image)

    expect(finished).toMatchObject({ runtimeVersion: '0.2.0', status: 'stopped' })
    expect(fake.vm).not.toBeNull()
    // The VM was rebuilt, not torn down a second time.
    expect(fake.migrations).toHaveLength(1)
  })

  it('rolls back by migrating in the other direction, still keeping the state disk', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    const original = await runtimeAt(fake, userData, '0.1.0').provision(image)
    await runtimeAt(fake, userData, '0.2.0').migrateFrom('0.1.0', image)

    const restored = await runtimeAt(fake, userData, '0.1.0').migrateFrom('0.2.0', image)

    expect(restored).toMatchObject({ runtimeVersion: '0.1.0', statePath: original.statePath })
    expect(restored.overlayDigest).toBe(original.overlayDigest)
    expect(fake.migrations).toHaveLength(2)
    for (const teardown of fake.migrations) expect(teardown).not.toContain(original.statePath)
  })

  it('refuses a migration that would change nothing', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    await runtimeAt(fake, userData, '0.1.0').provision(image)

    await expect(runtimeAt(fake, userData, '0.1.0').migrateFrom('0.1.0', image)).rejects.toThrow(
      'Managed Hyper-V migration has nothing to change'
    )
  })

  it('prunes only the owned boot images no marker points at any more', async () => {
    const userData = await tempDir()
    const fake = new FakeHyperV()
    const image = await releaseImage()
    const managed = runtimeAt(fake, userData, '0.1.0')
    const marker = await managed.provision(image)
    const imageRoot = path.join(path.dirname(marker.vmPath), 'images')
    // One superseded image, and one file that is not this provider's to judge.
    await writeFile(path.join(imageRoot, `${'b'.repeat(64)}.iso`), 'superseded')
    await writeFile(path.join(imageRoot, 'notes.txt'), 'not ours')

    await expect(managed.pruneUnreferencedImages()).resolves.toBe(1)

    expect(existsSync(path.join(imageRoot, `${imageDigest}.iso`))).toBe(true)
    expect(existsSync(path.join(imageRoot, `${'b'.repeat(64)}.iso`))).toBe(false)
    // Named by nothing this provider wrote, so it is left alone rather than
    // guessed about.
    expect(existsSync(path.join(imageRoot, 'notes.txt'))).toBe(true)
  })
})
