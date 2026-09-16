import { createHash } from 'node:crypto'
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

  readonly runner: ManagedRuntimeCommandRunner = async (executable, args) => {
    expect(executable).toBe('powershell.exe')
    const script = decodeScript(args)
    this.scripts.push(script)
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
      return { code: 0, stdout: JSON.stringify({ Id: this.vm.id, State: this.vm.state }), stderr: '' }
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
  return new ManagedHyperVRuntime({
    userData: await tempDir(),
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    runtimeVersion: '0.1.0',
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
    expect(fake.scripts.join('\n')).toContain('Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true')
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
})
