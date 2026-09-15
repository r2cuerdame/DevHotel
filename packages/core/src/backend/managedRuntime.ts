import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export type ManagedRuntimeSupportCode =
  | 'ready'
  | 'virtualization-ready'
  | 'elevation-required'
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
  hyperVPowerShellAvailable: boolean
  hyperVManagementAccessible: boolean
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
  /** Stable DevHotel data-ownership identity supplied by the desktop bootstrap. */
  installId?: string
}

export type ManagedRuntimeProvisionPhase =
  | 'checking-windows-capabilities'
  | 'verifying-runtime-manifest'
  | 'provisioning-runtime-provider'
  | 'starting-private-daemon'
  | 'health-checking'
  | 'ready'
  | 'broken'

export interface ManagedRuntimeArtifact {
  /** Stable logical name shown in diagnostics; never a Host path. */
  id: string
  /** Relative path beneath the caller-provided staging root. */
  file: string
  sha256: string
  sizeBytes: number
}

export interface ManagedRuntimeRelease {
  runtimeVersion: string
  artifacts: readonly ManagedRuntimeArtifact[]
}

export interface ManagedRuntimeManifest {
  schemaVersion: 2
  owner: 'devhotel'
  backend: 'managed-linux'
  installId: string
  runtimeId: string
  status: 'provisioning' | 'ready' | 'broken'
  phase: ManagedRuntimeProvisionPhase
  runtimeVersion: string
  artifactDigests: Record<string, string>
  createdAt: string
  updatedAt: string
  failure?: string
}

export interface ManagedRuntimeObservation {
  state: 'unsupported' | 'not-installed' | 'preparing' | 'ready' | 'broken'
  phase: ManagedRuntimeProvisionPhase | null
  detail: string
  support: ManagedRuntimeSupport
  runtimeId: string | null
  runtimeVersion: string | null
  artifactDigests: Record<string, string>
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
      slat: value['SecondLevelAddressTranslationExtensions'] === true,
      hyperVPowerShellAvailable: value['HyperVPowerShellAvailable'] === true,
      hyperVManagementAccessible: value['HyperVManagementAccessible'] === true
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
      slat: false,
      hyperVPowerShellAvailable: false,
      hyperVManagementAccessible: false
    }
  }

  const runner = opts.runner ?? defaultRunner
  const script = [
    '$cs=Get-CimInstance Win32_ComputerSystem',
    '$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1',
    '$hyperv=Get-Command New-VM -ErrorAction SilentlyContinue',
    '$hypervAccess=$false',
    'if ($hyperv) { try { Get-VMHost -ErrorAction Stop | Out-Null; $hypervAccess=$true } catch {} }',
    '[pscustomobject]@{HypervisorPresent=[bool]$cs.HypervisorPresent;VirtualizationFirmwareEnabled=[bool]$cpu.VirtualizationFirmwareEnabled;SecondLevelAddressTranslationExtensions=[bool]$cpu.SecondLevelAddressTranslationExtensions;HyperVPowerShellAvailable=[bool]$hyperv;HyperVManagementAccessible=[bool]$hypervAccess}|ConvertTo-Json -Compress'
  ].join(';')
  const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const parsed = result.code === 0 ? parseProbe(result.stdout) : null
  if (!parsed) {
    return {
      supported: false,
      code: 'probe-failed',
      detail: 'Windows virtualization capability probe failed.',
      hypervisorPresent: false,
      virtualizationFirmwareEnabled: false,
      slat: false,
      hyperVPowerShellAvailable: false,
      hyperVManagementAccessible: false
    }
  }

  if (parsed.hypervisorPresent && parsed.hyperVPowerShellAvailable && parsed.hyperVManagementAccessible) {
    return { supported: true, code: 'ready', detail: 'Windows hypervisor is active.', ...parsed }
  }
  if (parsed.hypervisorPresent && parsed.hyperVPowerShellAvailable) {
    return {
      supported: true,
      code: 'elevation-required',
      detail: 'DevHotel needs approval to manage its private Windows hypervisor runtime.',
      ...parsed
    }
  }
  if (parsed.hypervisorPresent || (parsed.virtualizationFirmwareEnabled && parsed.slat)) {
    return {
      supported: true,
      code: 'virtualization-ready',
      detail: 'Hardware virtualization is available; the DevHotel Hyper-V provider may still need provisioning.',
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
  private readonly platform: NodeJS.Platform
  private readonly runner: ManagedRuntimeCommandRunner
  private readonly now: () => Date
  private readonly runtimeId: () => string
  private readonly installId: string

  constructor(opts: ManagedRuntimeBootstrapOptions) {
    this.root = path.resolve(opts.userData, 'runtime', 'managed-linux')
    this.platform = opts.platform ?? process.platform
    this.runner = opts.runner ?? defaultRunner
    this.now = opts.now ?? (() => new Date())
    this.runtimeId = opts.runtimeId ?? randomUUID
    this.installId = opts.installId ?? randomUUID()
  }

  async support(): Promise<ManagedRuntimeSupport> {
    return await probeManagedRuntimeSupport({ platform: this.platform, runner: this.runner })
  }

  async observe(): Promise<ManagedRuntimeObservation> {
    const support = await this.support()
    try {
      const manifest = await this.readManifest()
      if (!manifest) {
        return {
          state: support.supported ? 'not-installed' : 'unsupported',
          phase: null,
          detail: support.detail,
          support,
          runtimeId: null,
          runtimeVersion: null,
          artifactDigests: {}
        }
      }
      return {
        state: manifest.status === 'ready' ? 'ready' : manifest.status === 'broken' ? 'broken' : 'preparing',
        phase: manifest.phase,
        detail:
          manifest.status === 'ready'
            ? 'The DevHotel-managed runtime is ready.'
            : manifest.status === 'broken'
              ? 'The DevHotel-managed runtime needs repair.'
              : 'The DevHotel-managed runtime is preparing.',
        support,
        runtimeId: manifest.runtimeId,
        runtimeVersion: manifest.runtimeVersion,
        artifactDigests: { ...manifest.artifactDigests }
      }
    } catch {
      return {
        state: 'broken',
        phase: 'broken',
        detail: 'The DevHotel-managed runtime ownership proof is invalid.',
        support,
        runtimeId: null,
        runtimeVersion: null,
        artifactDigests: {}
      }
    }
  }

  private async ownedRoot(create: boolean): Promise<string | null> {
    if (!existsSync(this.root)) {
      if (!create) return null
      await mkdir(this.root, { recursive: true })
    }
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed runtime root is not a real directory')
    return await realpath(this.root)
  }

  private async ensureOwnedRoot(): Promise<string> {
    const root = await this.ownedRoot(true)
    if (!root) throw new Error('Managed runtime root could not be created')
    return root
  }

  async readManifest(): Promise<ManagedRuntimeManifest | null> {
    const root = await this.ownedRoot(false)
    if (!root) return null
    const manifestPath = path.join(root, MANIFEST_FILE)
    if (!existsSync(manifestPath)) return null
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed runtime ownership manifest is not a regular file')
    const raw = await readFile(manifestPath, 'utf8')
    const value = JSON.parse(raw) as Partial<ManagedRuntimeManifest>
    if (
      value.schemaVersion !== 2 ||
      value.owner !== 'devhotel' ||
      value.backend !== 'managed-linux' ||
      typeof value.installId !== 'string' ||
      value.installId.length < 8 ||
      typeof value.runtimeId !== 'string' ||
      typeof value.runtimeVersion !== 'string' ||
      !['provisioning', 'ready', 'broken'].includes(value.status ?? '') ||
      ![
        'checking-windows-capabilities',
        'verifying-runtime-manifest',
        'provisioning-runtime-provider',
        'starting-private-daemon',
        'health-checking',
        'ready',
        'broken'
      ].includes(value.phase ?? '') ||
      !value.artifactDigests ||
      typeof value.artifactDigests !== 'object' ||
      Array.isArray(value.artifactDigests) ||
      Object.entries(value.artifactDigests).some(
        ([id, digest]) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      )
    ) {
      throw new Error('Managed runtime ownership manifest is invalid')
    }
    if (value.installId !== this.installId) throw new Error('Managed runtime installation identity changed')
    return value as ManagedRuntimeManifest
  }

  async beginProvision(runtimeVersion: string): Promise<ManagedRuntimeManifest> {
    await this.ensureOwnedRoot()
    const existing = await this.readManifest()
    if (existing && existing.runtimeVersion !== runtimeVersion) {
      throw new Error('Managed runtime update requires an explicit migration')
    }
    if (existing?.status === 'ready' || existing?.status === 'provisioning') return existing
    const now = this.now().toISOString()
    const manifest: ManagedRuntimeManifest = {
      schemaVersion: 2,
      owner: 'devhotel',
      backend: 'managed-linux',
      installId: existing?.installId ?? this.installId,
      runtimeId: existing?.runtimeId ?? this.runtimeId(),
      status: 'provisioning',
      phase: 'checking-windows-capabilities',
      runtimeVersion,
      artifactDigests: existing?.runtimeVersion === runtimeVersion ? existing.artifactDigests : {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    return await this.persistManifest(manifest)
  }

  async verifyRelease(
    runtimeId: string,
    release: ManagedRuntimeRelease,
    stagingRoot: string
  ): Promise<ManagedRuntimeManifest> {
    let manifest = await this.requireManifest(runtimeId)
    if (manifest.runtimeVersion !== release.runtimeVersion) {
      throw new Error('Managed runtime release version changed')
    }
    if (release.artifacts.length === 0) throw new Error('Managed runtime release has no artifacts')
    manifest = await this.writeStatus({
      ...manifest,
      status: 'provisioning',
      phase: 'verifying-runtime-manifest',
      failure: undefined
    })

    const canonicalRoot = await realpath(stagingRoot)
    const digests: Record<string, string> = {}
    const seen = new Set<string>()
    for (const artifact of release.artifacts) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(artifact.id) || seen.has(artifact.id)) {
        throw new Error('Managed runtime artifact identity is invalid')
      }
      seen.add(artifact.id)
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) {
        throw new Error('Managed runtime artifact metadata is invalid')
      }
      if (path.isAbsolute(artifact.file) || artifact.file.split(/[\\/]+/u).includes('..')) {
        throw new Error('Managed runtime artifact path escapes its staging root')
      }
      const candidate = path.resolve(canonicalRoot, artifact.file)
      const info = await lstat(candidate)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed runtime artifact is not a regular file')
      const canonicalFile = await realpath(candidate)
      const relative = path.relative(canonicalRoot, canonicalFile)
      if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Managed runtime artifact path escapes its staging root')
      }
      if (info.size !== artifact.sizeBytes) throw new Error(`Managed runtime artifact size mismatch: ${artifact.id}`)
      const handle = await open(canonicalFile, 'r')
      let digest: string
      try {
        const openedInfo = await handle.stat()
        if (!openedInfo.isFile() || openedInfo.size !== artifact.sizeBytes) {
          throw new Error(`Managed runtime artifact changed during verification: ${artifact.id}`)
        }
        const hash = createHash('sha256')
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        digest = hash.digest('hex')
      } finally {
        await handle.close()
      }
      if (digest !== artifact.sha256) throw new Error(`Managed runtime artifact digest mismatch: ${artifact.id}`)
      digests[artifact.id] = digest
    }

    return await this.writeStatus({
      ...manifest,
      phase: 'provisioning-runtime-provider',
      artifactDigests: digests
    })
  }

  async advance(runtimeId: string, phase: 'starting-private-daemon' | 'health-checking'): Promise<ManagedRuntimeManifest> {
    const manifest = await this.requireManifest(runtimeId)
    if (manifest.status !== 'provisioning') throw new Error('Managed runtime is not provisioning')
    const order: ManagedRuntimeProvisionPhase[] = [
      'checking-windows-capabilities',
      'verifying-runtime-manifest',
      'provisioning-runtime-provider',
      'starting-private-daemon',
      'health-checking'
    ]
    if (order.indexOf(phase) !== order.indexOf(manifest.phase) + 1) {
      throw new Error('Managed runtime provisioning phase is out of order')
    }
    return await this.writeStatus({ ...manifest, phase })
  }

  async markReady(runtimeId: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.requireManifest(runtimeId)
    if (manifest.phase !== 'health-checking') throw new Error('Managed runtime health check has not completed')
    return await this.writeStatus({ ...manifest, status: 'ready', phase: 'ready', failure: undefined })
  }

  async markBroken(runtimeId: string, failure: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.requireManifest(runtimeId)
    return await this.writeStatus({ ...manifest, status: 'broken', phase: 'broken', failure })
  }

  private async requireManifest(runtimeId: string): Promise<ManagedRuntimeManifest> {
    const manifest = await this.readManifest()
    if (!manifest) throw new Error('Managed runtime ownership manifest is missing')
    if (manifest.runtimeId !== runtimeId) throw new Error('Managed runtime identity changed')
    return manifest
  }

  private async writeStatus(manifest: ManagedRuntimeManifest): Promise<ManagedRuntimeManifest> {
    const next = { ...manifest, updatedAt: this.now().toISOString() }
    return await this.persistManifest(next)
  }

  private async persistManifest(manifest: ManagedRuntimeManifest): Promise<ManagedRuntimeManifest> {
    const root = await this.ensureOwnedRoot()
    const manifestPath = path.join(root, MANIFEST_FILE)
    const temporary = path.join(root, `.ownership-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, manifestPath)
    } finally {
      await rm(temporary, { force: true })
    }
    return manifest
  }
}
