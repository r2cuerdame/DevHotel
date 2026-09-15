import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export type ManagedRuntimeSupportCode =
  | 'ready'
  | 'virtualization-ready'
  | 'unsupported-platform'
  | 'virtualization-disabled'
  | 'probe-failed'

export interface ManagedRuntimeSupport {
  supported: boolean
  code: ManagedRuntimeSupportCode
  detail: string
  hypervisorPresent: boolean
  virtualizationFirmwareEnabled: boolean
  slat: boolean
}

export interface ManagedRuntimeCommandResult {
  code: number
  stdout: string
  stderr: string
}
export type ManagedRuntimeCommandRunner = (
  executable: string,
  args: readonly string[]
) => Promise<ManagedRuntimeCommandResult>

export interface ManagedRuntimeBootstrapOptions {
  userData: string
  platform?: NodeJS.Platform
  runner?: ManagedRuntimeCommandRunner
  now?: () => Date
  runtimeId?: () => string
}

export interface ManagedRuntimeManifest {
  schemaVersion: 1
  owner: 'devhotel'
  backend: 'managed-linux'
  runtimeId: string
  status: 'provisioning' | 'ready' | 'broken'
  runtimeVersion: string
  createdAt: string
  updatedAt: string
  failure?: string
}

const MANIFEST_FILE = 'ownership.json'
async function defaultRunner(executable: string, args: readonly string[]): Promise<ManagedRuntimeCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(executable, [...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function parseProbe(stdout: string): Omit<ManagedRuntimeSupport, 'supported' | 'code' | 'detail'> | null {
  try {
    const value = JSON.parse(stdout.trim()) as Record<string, unknown>
    return {
      hypervisorPresent: value['HypervisorPresent'] === true,
      virtualizationFirmwareEnabled: value['VirtualizationFirmwareEnabled'] === true,
      slat: value['SecondLevelAddressTranslationExtensions'] === true
    }
  } catch {
    return null
  }
}
export async function probeManagedRuntimeSupport(opts: {
  platform?: NodeJS.Platform
  runner?: ManagedRuntimeCommandRunner
} = {}): Promise<ManagedRuntimeSupport> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') {
    return {
      supported: false,
      code: 'unsupported-platform',
      detail: 'The managed local runtime currently targets Windows 11.',
      hypervisorPresent: false,
      virtualizationFirmwareEnabled: false,
      slat: false
    }
  }

  const runner = opts.runner ?? defaultRunner
  const script = [
    '$cs=Get-CimInstance Win32_ComputerSystem',
    '$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1',
    '[pscustomobject]@{HypervisorPresent=[bool]$cs.HypervisorPresent;VirtualizationFirmwareEnabled=[bool]$cpu.VirtualizationFirmwareEnabled;SecondLevelAddressTranslationExtensions=[bool]$cpu.SecondLevelAddressTranslationExtensions}|ConvertTo-Json -Compress'
  ].join(';')
  const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const parsed = result.code === 0 ? parseProbe(result.stdout) : null
  if (!parsed) {
    return {
      supported: false,
      code: 'probe-failed',
      detail: result.stderr.trim() || 'Windows virtualization capability probe failed.',
      hypervisorPresent: false,
      virtualizationFirmwareEnabled: false,
      slat: false
    }
  }

  if (parsed.hypervisorPresent) {
    return { supported: true, code: 'ready', detail: 'Windows hypervisor is active.', ...parsed }
  }
  if (parsed.virtualizationFirmwareEnabled && parsed.slat) {
    return {
      supported: true,
      code: 'virtualization-ready',
      detail: 'Hardware virtualization is available; the DevHotel hypervisor feature may still need provisioning.',
      ...parsed
    }
  }
  return {
    supported: false,
    code: 'virtualization-disabled',
    detail: 'Hardware virtualization or SLAT is unavailable or disabled in firmware.',
    ...parsed
  }
}
export class ManagedRuntimeBootstrap {
  private readonly root: string
  private readonly manifestPath: string
  private readonly platform: NodeJS.Platform
  private readonly runner: ManagedRuntimeCommandRunner
  private readonly now: () => Date
  private readonly runtimeId: () => string

  constructor(opts: ManagedRuntimeBootstrapOptions) {
    this.root = path.resolve(opts.userData, 'runtime', 'managed-linux')
    this.manifestPath = path.join(this.root, MANIFEST_FILE)
    this.platform = opts.platform ?? process.platform
    this.runner = opts.runner ?? defaultRunner
    this.now = opts.now ?? (() => new Date())
    this.runtimeId = opts.runtimeId ?? randomUUID
  }

  async support(): Promise<ManagedRuntimeSupport> {
    return await probeManagedRuntimeSupport({ platform: this.platform, runner: this.runner })
  }

  private async ensureOwnedRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed runtime root is not a real directory')
    return await realpath(this.root)
  }
  async readManifest(): Promise<ManagedRuntimeManifest | null> {
    if (!existsSync(this.manifestPath)) return null
    const raw = await readFile(this.manifestPath, 'utf8')
    const value = JSON.parse(raw) as Partial<ManagedRuntimeManifest>
    if (
      value.schemaVersion !== 1 ||
      value.owner !== 'devhotel' ||
      value.backend !== 'managed-linux' ||
      typeof value.runtimeId !== 'string' ||
      typeof value.runtimeVersion !== 'string' ||
      !['provisioning', 'ready', 'broken'].includes(value.status ?? '')
    ) {
      throw new Error('Managed runtime ownership manifest is invalid')
    }
    return value as ManagedRuntimeManifest
  }

  async beginProvision(runtimeVersion: string): Promise<ManagedRuntimeManifest> {
    await this.ensureOwnedRoot()
    const existing = await this.readManifest()
    if (existing?.status === 'ready') return existing
    const now = this.now().toISOString()
    const manifest: ManagedRuntimeManifest = {
      schemaVersion: 1,
      owner: 'devhotel',
      backend: 'managed-linux',
      runtimeId: existing?.runtimeId ?? this.runtimeId(),
      status: 'provisioning',
      runtimeVersion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    return manifest
  }

  async markReady(runtimeId: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.requireManifest(runtimeId)
    return await this.writeStatus({ ...manifest, status: 'ready', failure: undefined })
  }

  async markBroken(runtimeId: string, failure: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.requireManifest(runtimeId)
    return await this.writeStatus({ ...manifest, status: 'broken', failure })
  }

  private async requireManifest(runtimeId: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.readManifest()
    if (!manifest) throw new Error('Managed runtime ownership manifest is missing')
    if (manifest.runtimeId !== runtimeId) throw new Error('Managed runtime identity changed')
    return manifest
  }

  private async writeStatus(manifest: ManagedRuntimeManifest): Promise<ManagedRuntimeManifest> {
    await this.ensureOwnedRoot()
    const next = { ...manifest, updatedAt: this.now().toISOString() }
    await writeFile(this.manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }
}
