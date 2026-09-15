import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'
import type { ManagedRuntimeCommandResult, ManagedRuntimeCommandRunner } from './managedRuntime'

export interface ManagedHyperVRuntimeOptions {
  userData: string
  installId: string
  runtimeId: string
  runtimeVersion: string
  runner?: ManagedRuntimeCommandRunner
  guest?: ManagedHyperVGuestTransport
  now?: () => Date
}

export interface ManagedHyperVReleaseImage {
  file: string
  sha256: string
  sizeBytes: number
}

export interface ManagedHyperVGuestStatus {
  owner: 'devhotel'
  installId: string
  runtimeId: string
  runtimeVersion: string
  daemonVersion: string
  state: 'ready'
}

export interface ManagedHyperVGuestTransport {
  health(pipePath: string): Promise<ManagedHyperVGuestStatus>
}

export interface ManagedHyperVRuntimeMarker {
  schemaVersion: 1
  owner: 'devhotel'
  backend: 'hyper-v'
  installId: string
  runtimeId: string
  runtimeVersion: string
  vmName: string
  vmId: string | null
  vmPath: string
  diskPath: string
  seedPath: string
  pipePath: string
  baseImageDigest: string
  status: 'provisioning' | 'stopped' | 'starting' | 'ready' | 'broken'
  createdAt: string
  updatedAt: string
  failure?: string
}

export interface ManagedHyperVRuntimeObservation {
  state: 'not-installed' | 'preparing' | 'stopped' | 'ready' | 'broken'
  runtimeId: string | null
  runtimeVersion: string | null
  daemonVersion: string | null
  baseImageDigest: string | null
  detail: string
}

interface HyperVInspection {
  exists: boolean
  id: string | null
  state: string | null
  notes: string | null
}

const MARKER_FILE = 'provider.json'
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'] as const

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function isOpaqueId(value: string): boolean {
  return /^[0-9A-Za-z._-]{8,128}$/.test(value)
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function encodedPowerShell(script: string): string[] {
  return [...POWERSHELL_ARGS, Buffer.from(script, 'utf16le').toString('base64')]
}

function defaultRunner(executable: string, args: readonly string[]): Promise<ManagedRuntimeCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: ManagedRuntimeCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, stdout, stderr: `${stderr}Managed Hyper-V command timed out.` })
    }, 120_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}

function parseJsonRecord(stdout: string, message: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
    return value as Record<string, unknown>
  } catch {
    throw new Error(message)
  }
}

async function sha256File(file: string): Promise<{ digest: string; sizeBytes: number }> {
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Managed runtime image is not a regular file')
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Managed runtime image changed during verification')
    }
    return { digest: hash.digest('hex'), sizeBytes: after.size }
  } finally {
    await handle.close()
  }
}

function markerNotes(marker: ManagedHyperVRuntimeMarker): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: marker.owner,
    backend: marker.backend,
    installId: marker.installId,
    runtimeId: marker.runtimeId,
    runtimeVersion: marker.runtimeVersion,
    vmPath: marker.vmPath,
    diskPath: marker.diskPath,
    seedPath: marker.seedPath,
    pipePath: marker.pipePath,
    baseImageDigest: marker.baseImageDigest
  })
}

function assertExactPath(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && path.resolve(actual).toLocaleLowerCase('en-US') === path.resolve(expected).toLocaleLowerCase('en-US')
}

function validateNotes(raw: string | null, marker: ManagedHyperVRuntimeMarker): boolean {
  if (!raw) return false
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return (
      value['schemaVersion'] === 1 &&
      value['owner'] === 'devhotel' &&
      value['backend'] === 'hyper-v' &&
      value['installId'] === marker.installId &&
      value['runtimeId'] === marker.runtimeId &&
      value['runtimeVersion'] === marker.runtimeVersion &&
      value['baseImageDigest'] === marker.baseImageDigest &&
      value['pipePath'] === marker.pipePath &&
      assertExactPath(value['vmPath'], marker.vmPath) &&
      assertExactPath(value['diskPath'], marker.diskPath) &&
      assertExactPath(value['seedPath'], marker.seedPath)
    )
  } catch {
    return false
  }
}

function validateMarker(value: unknown, expected: Omit<ManagedHyperVRuntimeOptions, 'runner' | 'guest' | 'now'>): ManagedHyperVRuntimeMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Managed Hyper-V ownership marker is invalid')
  const marker = value as Partial<ManagedHyperVRuntimeMarker>
  if (
    marker.schemaVersion !== 1 ||
    marker.owner !== 'devhotel' ||
    marker.backend !== 'hyper-v' ||
    marker.installId !== expected.installId ||
    marker.runtimeId !== expected.runtimeId ||
    marker.runtimeVersion !== expected.runtimeVersion ||
    typeof marker.vmName !== 'string' ||
    !/^DevHotel-[a-f0-9]{16}$/.test(marker.vmName) ||
    (marker.vmId !== null && (typeof marker.vmId !== 'string' || !/^[a-f0-9-]{36}$/i.test(marker.vmId))) ||
    typeof marker.vmPath !== 'string' ||
    typeof marker.diskPath !== 'string' ||
    typeof marker.seedPath !== 'string' ||
    typeof marker.pipePath !== 'string' ||
    !/^\\\\\.\\pipe\\devhotel-runtime-[a-f0-9]{16}$/.test(marker.pipePath) ||
    typeof marker.baseImageDigest !== 'string' ||
    !isDigest(marker.baseImageDigest) ||
    !['provisioning', 'stopped', 'starting', 'ready', 'broken'].includes(marker.status ?? '') ||
    typeof marker.createdAt !== 'string' ||
    typeof marker.updatedAt !== 'string'
  ) {
    throw new Error('Managed Hyper-V ownership marker is invalid')
  }
  return marker as ManagedHyperVRuntimeMarker
}

/**
 * Owns the first separate-kernel Windows substrate. Hyper-V object names and
 * paths remain backend-private; callers observe only the product runtime
 * identity, version, digest, health and recovery state.
 */
export class ManagedHyperVRuntime {
  private readonly root: string
  private readonly markerPath: string
  private readonly installId: string
  private readonly runtimeId: string
  private readonly runtimeVersion: string
  private readonly runner: ManagedRuntimeCommandRunner
  private readonly guest?: ManagedHyperVGuestTransport
  private readonly now: () => Date
  private readonly vmName: string
  private readonly vmPath: string
  private readonly diskPath: string
  private readonly seedPath: string
  private readonly pipePath: string

  constructor(opts: ManagedHyperVRuntimeOptions) {
    if (!isOpaqueId(opts.installId) || !isOpaqueId(opts.runtimeId) || !/^[0-9A-Za-z._-]{1,64}$/.test(opts.runtimeVersion)) {
      throw new Error('Managed Hyper-V identity is invalid')
    }
    this.root = path.resolve(opts.userData, 'runtime', 'managed-linux', 'hyperv')
    this.markerPath = path.join(this.root, MARKER_FILE)
    this.installId = opts.installId
    this.runtimeId = opts.runtimeId
    this.runtimeVersion = opts.runtimeVersion
    this.runner = opts.runner ?? defaultRunner
    this.guest = opts.guest
    this.now = opts.now ?? (() => new Date())
    const suffix = createHash('sha256').update(`${opts.installId}\0${opts.runtimeId}`).digest('hex').slice(0, 16)
    this.vmName = `DevHotel-${suffix}`
    this.vmPath = path.join(this.root, 'machine')
    this.diskPath = path.join(this.vmPath, 'runtime.vhd')
    this.seedPath = path.join(this.vmPath, 'seed.vhdx')
    this.pipePath = `\\\\.\\pipe\\devhotel-runtime-${suffix}`
  }

  async readMarker(): Promise<ManagedHyperVRuntimeMarker | null> {
    if (!existsSync(this.markerPath)) return null
    const root = await realpath(this.root)
    const info = await lstat(this.markerPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed Hyper-V ownership marker is not a regular file')
    const canonicalMarker = await realpath(this.markerPath)
    if (path.dirname(canonicalMarker).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) {
      throw new Error('Managed Hyper-V ownership marker escaped its runtime root')
    }
    const marker = validateMarker(JSON.parse(await readFile(canonicalMarker, 'utf8')), {
      userData: path.dirname(path.dirname(path.dirname(this.root))),
      installId: this.installId,
      runtimeId: this.runtimeId,
      runtimeVersion: this.runtimeVersion
    })
    if (
      !assertExactPath(marker.vmPath, this.vmPath) ||
      !assertExactPath(marker.diskPath, this.diskPath) ||
      !assertExactPath(marker.seedPath, this.seedPath) ||
      marker.pipePath !== this.pipePath
    ) {
      throw new Error('Managed Hyper-V ownership marker paths are invalid')
    }
    return marker
  }

  async provision(image: ManagedHyperVReleaseImage): Promise<ManagedHyperVRuntimeMarker> {
    if (!isDigest(image.sha256) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 1) {
      throw new Error('Managed Hyper-V release image metadata is invalid')
    }
    const sourceInfo = await lstat(image.file)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Managed Hyper-V release image is not a regular file')
    const source = await realpath(image.file)
    const measured = await sha256File(source)
    if (measured.digest !== image.sha256 || measured.sizeBytes !== image.sizeBytes) {
      throw new Error('Managed Hyper-V release image verification failed')
    }

    await this.ensureRoot()
    const ownedImage = await this.installImage(source, image)
    let marker = await this.readMarker()
    const inspection = await this.inspectVm()
    if (!marker && inspection.exists) throw new Error('Managed Hyper-V VM name collides with an unowned VM')

    if (!marker) {
      const now = this.now().toISOString()
      marker = await this.writeMarker({
        schemaVersion: 1,
        owner: 'devhotel',
        backend: 'hyper-v',
        installId: this.installId,
        runtimeId: this.runtimeId,
        runtimeVersion: this.runtimeVersion,
        vmName: this.vmName,
        vmId: null,
        vmPath: this.vmPath,
        diskPath: this.diskPath,
        seedPath: this.seedPath,
        pipePath: this.pipePath,
        baseImageDigest: image.sha256,
        status: 'provisioning',
        createdAt: now,
        updatedAt: now
      })
    } else if (marker.baseImageDigest !== image.sha256) {
      throw new Error('Managed Hyper-V runtime update requires an explicit migration')
    }

    if (inspection.exists) {
      this.assertOwnedVm(inspection, marker)
      if (!marker.vmId) marker = await this.writeMarker({ ...marker, vmId: inspection.id, status: 'stopped', failure: undefined })
      return marker
    }

    const create = await this.runPowerShell(
      [
        `$vmName=${psLiteral(marker.vmName)}`,
        `$vmPath=${psLiteral(marker.vmPath)}`,
        `$diskPath=${psLiteral(marker.diskPath)}`,
        `$parentPath=${psLiteral(ownedImage)}`,
        `$seedPath=${psLiteral(marker.seedPath)}`,
        `$pipePath=${psLiteral(marker.pipePath)}`,
        `$notes=${psLiteral(markerNotes(marker))}`,
        `$userDataB64=${psLiteral(Buffer.from(this.cloudInitUserData(), 'utf8').toString('base64'))}`,
        `$metaDataB64=${psLiteral(Buffer.from(this.cloudInitMetaData(), 'utf8').toString('base64'))}`,
        "if (Get-VM -Name $vmName -ErrorAction SilentlyContinue) { throw 'Managed runtime VM collision' }",
        'New-Item -ItemType Directory -Force -Path $vmPath | Out-Null',
        "if (-not (Test-Path -LiteralPath $diskPath -PathType Leaf)) { New-VHD -Path $diskPath -ParentPath $parentPath -Differencing | Out-Null }",
        'if (-not (Test-Path -LiteralPath $seedPath -PathType Leaf)) {',
        '  New-VHD -Path $seedPath -Dynamic -SizeBytes 64MB | Out-Null',
        '  $seedDisk=Mount-VHD -Path $seedPath -Passthru',
        '  try {',
        '    $seedDisk | Initialize-Disk -PartitionStyle MBR -PassThru | Out-Null',
        '    $partition=$seedDisk | New-Partition -UseMaximumSize -AssignDriveLetter',
        "    $volume=$partition | Format-Volume -FileSystem FAT -NewFileSystemLabel 'CIDATA' -Confirm:$false",
        '    $drive=($volume.DriveLetter + ":\\")',
        "    [IO.File]::WriteAllBytes((Join-Path $drive 'user-data'),[Convert]::FromBase64String($userDataB64))",
        "    [IO.File]::WriteAllBytes((Join-Path $drive 'meta-data'),[Convert]::FromBase64String($metaDataB64))",
        '  } finally { Dismount-VHD -Path $seedPath -ErrorAction SilentlyContinue }',
        '}',
        '$vm=New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 4GB -VHDPath $diskPath -Path $vmPath',
        'Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -Path $seedPath',
        'Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true',
        'Set-VMFirmware -VM $vm -EnableSecureBoot Off',
        'Set-VMComPort -VM $vm -Number 2 -Path $pipePath',
        'Set-VM -VM $vm -Notes $notes -AutomaticStartAction StartIfRunning -AutomaticStopAction Save',
        '[pscustomobject]@{Id=$vm.Id.Guid;State=[string]$vm.State}|ConvertTo-Json -Compress'
      ].join(';')
    )
    const created = parseJsonRecord(create, 'Managed Hyper-V provider returned invalid creation evidence')
    if (typeof created['Id'] !== 'string') throw new Error('Managed Hyper-V provider did not return a VM identity')
    const after = await this.inspectVm()
    this.assertOwnedVm(after, marker)
    return await this.writeMarker({ ...marker, vmId: after.id, status: 'stopped', failure: undefined })
  }

  async start(): Promise<ManagedHyperVRuntimeObservation> {
    let marker = await this.requireOwnedVm()
    marker = await this.writeMarker({ ...marker, status: 'starting', failure: undefined })
    try {
      const inspection = await this.inspectVm()
      if (inspection.state?.toLocaleLowerCase('en-US') !== 'running') {
        await this.runPowerShell(`Start-VM -Name ${psLiteral(marker.vmName)} -ErrorAction Stop`)
      }
      const health = await this.requireGuestHealth(marker)
      await this.writeMarker({ ...marker, status: 'ready', failure: undefined })
      return this.readyObservation(marker, health)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      await this.writeMarker({ ...marker, status: 'broken', failure })
      throw error
    }
  }

  async repair(image: ManagedHyperVReleaseImage): Promise<ManagedHyperVRuntimeObservation> {
    await this.provision(image)
    return await this.start()
  }

  async stop(): Promise<ManagedHyperVRuntimeObservation> {
    const marker = await this.requireOwnedVm()
    const inspection = await this.inspectVm()
    if (inspection.state?.toLocaleLowerCase('en-US') === 'running') {
      await this.runPowerShell(`Save-VM -Name ${psLiteral(marker.vmName)} -ErrorAction Stop`)
    }
    await this.writeMarker({ ...marker, status: 'stopped', failure: undefined })
    return {
      state: 'stopped',
      runtimeId: marker.runtimeId,
      runtimeVersion: marker.runtimeVersion,
      daemonVersion: null,
      baseImageDigest: marker.baseImageDigest,
      detail: 'The DevHotel-managed runtime is stopped with its state preserved.'
    }
  }

  async observe(): Promise<ManagedHyperVRuntimeObservation> {
    try {
      const marker = await this.readMarker()
      if (!marker) {
        return {
          state: 'not-installed',
          runtimeId: null,
          runtimeVersion: null,
          daemonVersion: null,
          baseImageDigest: null,
          detail: 'The DevHotel-managed Hyper-V runtime is not installed.'
        }
      }
      const inspection = await this.inspectVm()
      this.assertOwnedVm(inspection, marker)
      if (inspection.state?.toLocaleLowerCase('en-US') !== 'running') {
        return {
          state: marker.status === 'broken' ? 'broken' : marker.status === 'provisioning' ? 'preparing' : 'stopped',
          runtimeId: marker.runtimeId,
          runtimeVersion: marker.runtimeVersion,
          daemonVersion: null,
          baseImageDigest: marker.baseImageDigest,
          detail: marker.status === 'broken' ? 'The DevHotel-managed runtime needs repair.' : 'The DevHotel-managed runtime is stopped.'
        }
      }
      const health = await this.requireGuestHealth(marker)
      if (marker.status !== 'ready') await this.writeMarker({ ...marker, status: 'ready', failure: undefined })
      return this.readyObservation(marker, health)
    } catch {
      return {
        state: 'broken',
        runtimeId: null,
        runtimeVersion: null,
        daemonVersion: null,
        baseImageDigest: null,
        detail: 'The DevHotel-managed runtime ownership or health proof is invalid.'
      }
    }
  }

  private readyObservation(marker: ManagedHyperVRuntimeMarker, health: ManagedHyperVGuestStatus): ManagedHyperVRuntimeObservation {
    return {
      state: 'ready',
      runtimeId: marker.runtimeId,
      runtimeVersion: marker.runtimeVersion,
      daemonVersion: health.daemonVersion,
      baseImageDigest: marker.baseImageDigest,
      detail: 'The DevHotel-managed separate-kernel runtime is ready.'
    }
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed Hyper-V root is not a real directory')
    return await realpath(this.root)
  }

  private async installImage(source: string, image: ManagedHyperVReleaseImage): Promise<string> {
    const imageRoot = path.join(this.root, 'images')
    await mkdir(imageRoot, { recursive: true })
    const imageRootInfo = await lstat(imageRoot)
    if (!imageRootInfo.isDirectory() || imageRootInfo.isSymbolicLink()) throw new Error('Managed Hyper-V image root is unsafe')
    if (path.extname(source).toLocaleLowerCase('en-US') !== '.vhd') {
      throw new Error('Managed Hyper-V release image must use the pinned VHD format')
    }
    const target = path.join(imageRoot, `${image.sha256}.vhd`)
    if (!existsSync(target)) {
      const temporary = path.join(imageRoot, `.${image.sha256}-${randomUUID()}.tmp`)
      try {
        await copyFile(source, temporary, fsConstants.COPYFILE_EXCL)
        const copied = await sha256File(temporary)
        if (copied.digest !== image.sha256 || copied.sizeBytes !== image.sizeBytes) {
          throw new Error('Managed Hyper-V owned image verification failed')
        }
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    const targetInfo = await lstat(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('Managed Hyper-V owned image is unsafe')
    const canonical = await realpath(target)
    const measured = await sha256File(canonical)
    if (measured.digest !== image.sha256 || measured.sizeBytes !== image.sizeBytes) {
      throw new Error('Managed Hyper-V owned image no longer matches its release digest')
    }
    return canonical
  }

  private async inspectVm(): Promise<HyperVInspection> {
    const output = await this.runPowerShell(
      [
        `$vm=Get-VM -Name ${psLiteral(this.vmName)} -ErrorAction SilentlyContinue`,
        "if ($null -eq $vm) { [pscustomobject]@{Exists=$false;Id=$null;State=$null;Notes=$null}|ConvertTo-Json -Compress } else { [pscustomobject]@{Exists=$true;Id=$vm.Id.Guid;State=[string]$vm.State;Notes=$vm.Notes}|ConvertTo-Json -Compress }"
      ].join(';')
    )
    const value = parseJsonRecord(output, 'Managed Hyper-V inspection returned invalid evidence')
    return {
      exists: value['Exists'] === true,
      id: typeof value['Id'] === 'string' ? value['Id'] : null,
      state: typeof value['State'] === 'string' ? value['State'] : null,
      notes: typeof value['Notes'] === 'string' ? value['Notes'] : null
    }
  }

  private assertOwnedVm(inspection: HyperVInspection, marker: ManagedHyperVRuntimeMarker): void {
    if (!inspection.exists || !inspection.id || !validateNotes(inspection.notes, marker)) {
      throw new Error('Managed Hyper-V VM ownership proof is invalid')
    }
    if (marker.vmId && inspection.id.toLocaleLowerCase('en-US') !== marker.vmId.toLocaleLowerCase('en-US')) {
      throw new Error('Managed Hyper-V VM identity changed')
    }
  }

  private async requireOwnedVm(): Promise<ManagedHyperVRuntimeMarker> {
    const marker = await this.readMarker()
    if (!marker) throw new Error('Managed Hyper-V ownership marker is missing')
    const inspection = await this.inspectVm()
    this.assertOwnedVm(inspection, marker)
    return marker
  }

  private async requireGuestHealth(marker: ManagedHyperVRuntimeMarker): Promise<ManagedHyperVGuestStatus> {
    if (!this.guest) throw new Error('Managed Hyper-V private daemon transport is unavailable')
    const health = await this.guest.health(marker.pipePath)
    if (
      health.owner !== 'devhotel' ||
      health.state !== 'ready' ||
      health.installId !== marker.installId ||
      health.runtimeId !== marker.runtimeId ||
      health.runtimeVersion !== marker.runtimeVersion ||
      typeof health.daemonVersion !== 'string' ||
      health.daemonVersion.length === 0
    ) {
      throw new Error('Managed Hyper-V guest identity or health proof is invalid')
    }
    return health
  }

  private async runPowerShell(script: string): Promise<string> {
    const result = await this.runner('powershell.exe', encodedPowerShell(script))
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'Managed Hyper-V provider command failed')
    }
    return result.stdout
  }

  private cloudInitMetaData(): string {
    return `instance-id: devhotel-${this.runtimeId}\nlocal-hostname: devhotel-runtime\n`
  }

  private cloudInitUserData(): string {
    const ownership = JSON.stringify({
      schemaVersion: 1,
      owner: 'devhotel',
      backend: 'hyper-v',
      installId: this.installId,
      runtimeId: this.runtimeId,
      runtimeVersion: this.runtimeVersion
    })
    const reply = JSON.stringify({
      owner: 'devhotel',
      installId: this.installId,
      runtimeId: this.runtimeId,
      runtimeVersion: this.runtimeVersion,
      daemonVersion: this.runtimeVersion,
      state: 'ready'
    })
    return [
      '#cloud-config',
      'write_files:',
      '  - path: /etc/devhotel/ownership.json',
      "    permissions: '0600'",
      '    content: |',
      `      ${ownership}`,
      '  - path: /usr/local/sbin/devhotel-runtime-agent',
      "    permissions: '0755'",
      '    content: |',
      '      #!/bin/sh',
      '      set -eu',
      "      stty -F /dev/ttyS1 raw -echo 115200 2>/dev/null || true",
      '      exec 3<>/dev/ttyS1',
      '      while IFS= read -r request <&3; do',
      "        case \"$request\" in health:[a-f0-9]*) request_id=${request#health:} ;; *) continue ;; esac",
      `        printf '%s\\n' '${reply.slice(0, -1)},"requestId":"'"$request_id"'"}' >&3`,
      '      done',
      '  - path: /etc/init.d/devhotel-runtime-agent',
      "    permissions: '0755'",
      '    content: |',
      '      #!/sbin/openrc-run',
      '      name="DevHotel private runtime agent"',
      '      command=/usr/local/sbin/devhotel-runtime-agent',
      '      command_background=true',
      '      pidfile=/run/devhotel-runtime-agent.pid',
      '      output_log=/var/log/devhotel-runtime-agent.log',
      '      error_log=/var/log/devhotel-runtime-agent.log',
      '      depend() { need localmount; }',
      'runcmd:',
      '  - [rc-update, add, devhotel-runtime-agent, default]',
      '  - [rc-service, devhotel-runtime-agent, restart]',
      ''
    ].join('\n')
  }

  private async writeMarker(marker: ManagedHyperVRuntimeMarker): Promise<ManagedHyperVRuntimeMarker> {
    await this.ensureRoot()
    const next = { ...marker, updatedAt: this.now().toISOString() }
    const temporary = path.join(this.root, `.provider-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.markerPath)
    } finally {
      await rm(temporary, { force: true })
    }
    return next
  }
}

export class NamedPipeHyperVGuestTransport implements ManagedHyperVGuestTransport {
  constructor(
    private readonly timeoutMs = 120_000,
    private readonly retryMs = 250
  ) {}

  async health(pipePath: string): Promise<ManagedHyperVGuestStatus> {
    if (!/^\\\\\.\\pipe\\devhotel-runtime-[a-f0-9]{16}$/.test(pipePath)) {
      throw new Error('Managed Hyper-V private daemon pipe identity is invalid')
    }
    const deadline = Date.now() + this.timeoutMs
    let lastError = 'private daemon did not answer'
    while (Date.now() < deadline) {
      try {
        return await this.healthOnce(pipePath, Math.min(2_000, Math.max(1, deadline - Date.now())))
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await new Promise((resolve) => setTimeout(resolve, this.retryMs))
      }
    }
    throw new Error(`Managed Hyper-V ${lastError}`)
  }

  private async healthOnce(pipePath: string, timeoutMs: number): Promise<ManagedHyperVGuestStatus> {
    const requestId = randomUUID().replaceAll('-', '')
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath)
      let settled = false
      let buffer = ''
      const finish = (error?: Error, status?: ManagedHyperVGuestStatus): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(status!)
      }
      const timer = setTimeout(() => finish(new Error('private daemon health check timed out')), timeoutMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`health:${requestId}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > 65_536) {
          finish(new Error('private daemon response exceeded its limit'))
          return
        }
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) return
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('{')) continue
          try {
            const value = parseJsonRecord(line, 'private daemon returned invalid health evidence')
            if (value['requestId'] !== requestId) continue
            finish(undefined, value as unknown as ManagedHyperVGuestStatus)
          } catch {
            continue
          }
        }
      })
      socket.on('error', (error) => finish(new Error(`private daemon connection failed: ${error.message}`)))
      socket.on('close', () => finish(new Error('private daemon closed without health evidence')))
    })
  }
}
