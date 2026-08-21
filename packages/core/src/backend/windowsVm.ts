import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'

export interface VmwareCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface VmwareCommandOptions {
  timeoutMs?: number
}

/** Injectable so lifecycle and ownership behavior can be tested without VMware. */
export type VmwareCommandRunner = (
  executable: string,
  args: readonly string[],
  opts?: VmwareCommandOptions
) => Promise<VmwareCommandResult>

/** The desktop owns how a VMX is opened in the visible VMware console. */
export type VmwareConsoleLauncher = (vmxPath: string) => Promise<void> | void

export interface ResolveVmrunExecutableOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (candidate: string) => boolean
}

export interface WindowsVmBackendOptions {
  userData: string
  vmrunExecutable?: string
  runner?: VmwareCommandRunner
  consoleLauncher?: VmwareConsoleLauncher
  now?: () => Date
}

export interface InspectWindowsVmTemplateInput {
  templateVmxPath: string
  snapshot: string
}

export interface WindowsVmTemplateIdentity {
  /** Provider-keyed opaque ID; the Host path cannot be recovered or guessed from it. */
  templateId: string
  snapshot: string
}

export interface CreateWindowsVmInput extends InspectWindowsVmTemplateInput {
  roomId: string
}

export interface WindowsVmIdentity extends WindowsVmTemplateIdentity {
  roomId: string
}

export type WindowsVmState = 'running' | 'stopped' | 'missing'

type OwnershipStatus = 'creating' | 'ready' | 'broken'

interface OwnershipMarker {
  schemaVersion: 2
  owner: 'devhotel'
  backend: 'vmware-workstation'
  roomId: string
  status: OwnershipStatus
  templateId: string
  /** Detects changes to the selected VM and its snapshot metadata without exposing Host paths. */
  templateFingerprint: string
  /** Internal ownership data only. Public APIs return templateId instead. */
  templateVmxPath: string
  snapshot: string
  vmxFile: 'room.vmx'
  createdAt: string
  updatedAt: string
  failure?: string
}

interface InspectedTemplate extends WindowsVmTemplateIdentity {
  templateVmxPath: string
  templateFingerprint: string
}

interface OwnedRoom {
  roomDir: string
  vmxPath: string
  markerPath: string
  marker: OwnershipMarker
}

const ROOM_ID = /^[a-z0-9]{8}$/
const SNAPSHOT_NAME = /^[A-Za-z0-9._ -]{1,120}$/
const OWNERSHIP_FILE = 'ownership.json'
const ROOM_VMX_FILE = 'room.vmx'
const DEFAULT_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 10 * 60_000

function withoutOuterQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (env[key]) return env[key]
  if (platform !== 'win32') return undefined
  const found = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  return found ? env[found] : undefined
}

/** Resolve an explicit override, PATH entry, or an installed Workstation Pro CLI. */
export function resolveVmrunExecutable(opts: ResolveVmrunExecutableOptions = {}): string {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const fileExists = opts.fileExists ?? existsSync
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const executableName = platform === 'win32' ? 'vmrun.exe' : 'vmrun'

  const override = envValue(env, 'DEVHOTEL_VMRUN_PATH', platform)
  if (override?.trim()) return withoutOuterQuotes(override)

  const searchPath = envValue(env, 'PATH', platform) ?? ''
  for (const rawDir of searchPath.split(pathApi.delimiter)) {
    const dir = withoutOuterQuotes(rawDir)
    if (!dir) continue
    const candidate = pathApi.join(dir, executableName)
    if (fileExists(candidate)) return candidate
  }

  if (platform === 'win32') {
    const roots = [
      envValue(env, 'ProgramW6432', platform),
      envValue(env, 'ProgramFiles', platform),
      envValue(env, 'ProgramFiles(x86)', platform),
      'C:\\Program Files',
      'C:\\Program Files (x86)'
    ].filter((value): value is string => !!value?.trim())
    const seen = new Set<string>()
    for (const root of roots) {
      const candidate = path.win32.join(withoutOuterQuotes(root), 'VMware', 'VMware Workstation', executableName)
      const key = candidate.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (fileExists(candidate)) return candidate
    }
  }

  return executableName
}

export const defaultVmwareCommandRunner: VmwareCommandRunner = (
  executable,
  args,
  opts = {}
) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Could not launch VMware command: ${error.message}`))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({
        code: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr: timedOut ? `${stderr}\nVMware command timed out after ${timeoutMs}ms` : stderr
      })
    })
  })

/**
 * VMware Workstation lifecycle with a fail-closed, offline VMX policy.
 * Every mutable path is derived from one validated Room ID beneath userData.
 */
export class WindowsVmBackend {
  private readonly providerRoot: string
  private readonly managedRoot: string
  private readonly identityKeyPath: string
  private readonly vmrunExecutable: string
  private readonly runner: VmwareCommandRunner
  private readonly consoleLauncher: VmwareConsoleLauncher | undefined
  private readonly now: () => Date
  private identityKeyPromise: Promise<Buffer> | undefined

  constructor(opts: WindowsVmBackendOptions) {
    if (!path.isAbsolute(opts.userData)) throw new Error('VMware userData must be an absolute path')
    this.providerRoot = path.resolve(opts.userData, 'runtime', 'vmware')
    this.managedRoot = path.join(this.providerRoot, 'rooms')
    this.identityKeyPath = path.join(this.providerRoot, 'provider.key')
    this.vmrunExecutable = opts.vmrunExecutable ?? resolveVmrunExecutable()
    this.runner = opts.runner ?? defaultVmwareCommandRunner
    this.consoleLauncher = opts.consoleLauncher
    this.now = opts.now ?? (() => new Date())
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.runner(this.vmrunExecutable, ['list'], { timeoutMs: 30_000 })
      if (result.code !== 0) return { ok: false, detail: 'VMware vmrun is not responding' }
      parseCountedOutput(result.stdout, /^Total running VMs: (\d+)$/, 'running VM inventory')
      return { ok: true, detail: 'VMware Workstation vmrun is available' }
    } catch {
      return { ok: false, detail: 'VMware vmrun is unavailable or returned an invalid response' }
    }
  }

  /** Compare fresh discovery with this process's pinned executable without exposing either path. */
  isConfiguredFor(executable: string): boolean {
    return samePath(this.vmrunExecutable, executable)
  }

  async listSnapshots(templateVmxPath: string): Promise<string[]> {
    const canonical = await this.canonicalTemplatePath(templateVmxPath)
    return this.snapshotsForCanonicalTemplate(canonical)
  }

  async inspectTemplate(input: InspectWindowsVmTemplateInput): Promise<WindowsVmTemplateIdentity> {
    const { templateId, snapshot } = await this.inspectTemplateInternal(input)
    return { templateId, snapshot }
  }

  async create(input: CreateWindowsVmInput): Promise<WindowsVmIdentity> {
    validateRoomId(input.roomId)
    const inspected = await this.inspectTemplateInternal(input)
    return this.materialize(input.roomId, inspected)
  }

  async start(roomId: string): Promise<void> {
    const owned = await this.requireOwnedRoom(roomId)
    if (owned.marker.status !== 'ready') throw new Error(`Windows Room ${roomId} is ${owned.marker.status}`)
    if (!(await isRegularFile(owned.vmxPath))) throw new Error(`Windows Room ${roomId} has no owned VMX`)
    await assertDistinctClone(owned.vmxPath, owned.marker.templateVmxPath)
    if ((await this.state(roomId)) === 'running') return
    await this.secureCloneVmx(owned.vmxPath)
    await this.mustRun(['start', owned.vmxPath, 'nogui'], 'start Windows Room')
  }

  async state(roomId: string): Promise<WindowsVmState> {
    const owned = await this.loadOwnedRoom(roomId)
    if (!owned || !(await isRegularFile(owned.vmxPath))) return 'missing'
    const target = await realpath(owned.vmxPath)
    const result = await this.mustRun(['list'], 'list running Windows Rooms', 30_000)
    const listed = parseCountedOutput(result.stdout, /^Total running VMs: (\d+)$/, 'running VM inventory')
    for (const candidate of listed) {
      if (await pathsReferToSameFile(candidate, target)) return 'running'
    }
    return 'stopped'
  }

  async sleep(roomId: string): Promise<void> {
    const owned = await this.requireOwnedRoom(roomId)
    if (!(await isRegularFile(owned.vmxPath))) return
    await assertDistinctClone(owned.vmxPath, owned.marker.templateVmxPath)
    if ((await this.state(roomId)) !== 'running') return
    await this.mustRun(['stop', owned.vmxPath, 'soft'], 'sleep Windows Room')
  }

  async delete(roomId: string): Promise<{ reclaimedBytes: number }> {
    validateRoomId(roomId)
    const root = await this.ensureManagedRoot()
    const roomDir = path.join(this.managedRoot, roomId)
    if (!(await pathExists(roomDir))) return { reclaimedBytes: 0 }
    let owned: OwnedRoom
    try {
      const loaded = await this.loadOwnedRoom(roomId)
      if (!loaded) return { reclaimedBytes: 0 }
      owned = loaded
    } catch (error) {
      const canonicalRoomDir = await this.validateOwnedRoomDirectory(roomId, root)
      if ((await readdir(canonicalRoomDir)).length !== 0) {
        throw error
      }
      await rmdir(canonicalRoomDir)
      return { reclaimedBytes: 0 }
    }
    if ((await isRegularFile(owned.vmxPath)) && (await this.state(roomId)) === 'running') {
      await this.mustRun(['stop', owned.vmxPath, 'soft'], 'sleep Windows Room before deletion')
    }
    const reclaimedBytes = await directorySizeWithoutFollowingLinks(owned.roomDir)
    await this.disposeOwnedClone(owned)
    return { reclaimedBytes }
  }

  async reset(roomId: string): Promise<WindowsVmIdentity> {
    const owned = await this.requireOwnedRoom(roomId)
    const template: InspectedTemplate = {
      templateId: owned.marker.templateId,
      templateFingerprint: owned.marker.templateFingerprint,
      templateVmxPath: owned.marker.templateVmxPath,
      snapshot: owned.marker.snapshot
    }

    try {
      // Validate the immutable source before destroying the existing clone.
      const currentTemplate = await this.inspectTemplateInternal({
        templateVmxPath: template.templateVmxPath,
        snapshot: template.snapshot
      })
      if (currentTemplate.templateId !== template.templateId) {
        throw new Error('The VMware template identity changed; reset was refused')
      }
      if (currentTemplate.templateFingerprint !== template.templateFingerprint) {
        throw new Error('The VMware template or snapshot fingerprint changed; reset was refused')
      }
      if ((await this.state(roomId)) === 'running') await this.sleep(roomId)
      await this.disposeOwnedClone(await this.requireOwnedRoom(roomId))
      return await this.materialize(roomId, template)
    } catch (error) {
      await this.leaveBrokenOwnership(roomId, template, error)
      throw error
    }
  }

  async validateBaseline(roomId: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const owned = await this.requireOwnedRoom(roomId)
      const current = await this.inspectTemplateInternal({
        templateVmxPath: owned.marker.templateVmxPath,
        snapshot: owned.marker.snapshot
      })
      if (
        current.templateId !== owned.marker.templateId ||
        current.templateFingerprint !== owned.marker.templateFingerprint
      ) {
        return { ok: false, detail: 'VMware template or clean snapshot changed after Room creation' }
      }
      return { ok: true, detail: 'VMware template and clean snapshot are unchanged' }
    } catch (error) {
      return { ok: false, detail: safeFailure(error) }
    }
  }

  async openConsole(roomId: string): Promise<void> {
    if (!this.consoleLauncher) throw new Error('No VMware console launcher is configured')
    const owned = await this.requireOwnedRoom(roomId)
    if (owned.marker.status !== 'ready') throw new Error(`Windows Room ${roomId} is ${owned.marker.status}`)
    if (!(await isRegularFile(owned.vmxPath))) throw new Error(`Windows Room ${roomId} has no owned VMX`)
    await assertDistinctClone(owned.vmxPath, owned.marker.templateVmxPath)
    if ((await this.state(roomId)) !== 'running') await this.secureCloneVmx(owned.vmxPath)
    await this.consoleLauncher(owned.vmxPath)
  }

  private async inspectTemplateInternal(
    input: InspectWindowsVmTemplateInput
  ): Promise<InspectedTemplate> {
    validateSnapshotName(input.snapshot)
    const templateVmxPath = await this.canonicalTemplatePath(input.templateVmxPath)
    await this.ensureTemplatePoweredOff(templateVmxPath)
    const snapshots = await this.snapshotsForCanonicalTemplate(templateVmxPath)
    if (!snapshots.includes(input.snapshot)) {
      throw new Error(`VMware template does not contain the exact snapshot '${input.snapshot}'`)
    }
    const [templateId, templateFingerprint] = await Promise.all([
      this.templateIdFor(templateVmxPath),
      templateFingerprintFor(templateVmxPath, input.snapshot)
    ])
    return { templateId, templateFingerprint, templateVmxPath, snapshot: input.snapshot }
  }

  private async materialize(roomId: string, template: InspectedTemplate): Promise<WindowsVmIdentity> {
    validateRoomId(roomId)
    validateSnapshotName(template.snapshot)
    const canonicalTemplate = await this.canonicalTemplatePath(template.templateVmxPath)
    if ((await this.templateIdFor(canonicalTemplate)) !== template.templateId) {
      throw new Error('The VMware template identity changed before clone')
    }
    if ((await templateFingerprintFor(canonicalTemplate, template.snapshot)) !== template.templateFingerprint) {
      throw new Error('The VMware template or snapshot changed before clone')
    }
    const existing = await this.loadOwnedRoom(roomId)
    if (existing) throw new Error(`Windows Room ${roomId} already has managed VMware data`)

    const root = await this.ensureManagedRoot()
    const roomDir = path.join(this.managedRoot, roomId)
    await mkdir(roomDir, { recursive: false })
    const canonicalRoomDir = await this.validateOwnedRoomDirectory(roomId, root)
    const markerPath = path.join(canonicalRoomDir, OWNERSHIP_FILE)
    const vmxPath = path.join(canonicalRoomDir, ROOM_VMX_FILE)
    const createdAt = this.now().toISOString()
    const marker: OwnershipMarker = {
      schemaVersion: 2,
      owner: 'devhotel',
      backend: 'vmware-workstation',
      roomId,
      status: 'creating',
      templateId: template.templateId,
      templateFingerprint: template.templateFingerprint,
      templateVmxPath: canonicalTemplate,
      snapshot: template.snapshot,
      vmxFile: ROOM_VMX_FILE,
      createdAt,
      updatedAt: createdAt
    }
    await writeMarkerAtomically(markerPath, marker)

    try {
      await this.mustRun(
        ['clone', canonicalTemplate, vmxPath, 'linked', `-snapshot=${template.snapshot}`],
        'create linked Windows Room clone',
        CLONE_TIMEOUT_MS
      )
      if (!(await isRegularFile(vmxPath))) throw new Error('VMware clone completed without an owned VMX')
      await assertDistinctClone(vmxPath, canonicalTemplate)
      await this.secureCloneVmx(vmxPath)
      const ready: OwnershipMarker = {
        ...marker,
        status: 'ready',
        updatedAt: this.now().toISOString()
      }
      await writeMarkerAtomically(markerPath, ready)
      return { roomId, templateId: template.templateId, snapshot: template.snapshot }
    } catch (error) {
      const broken: OwnershipMarker = {
        ...marker,
        status: 'broken',
        updatedAt: this.now().toISOString(),
        failure: safeFailure(error)
      }
      await writeMarkerAtomically(markerPath, broken)
      throw error
    }
  }

  private async secureCloneVmx(vmxPath: string): Promise<void> {
    await hardenVmx(vmxPath)
    // Defense in depth. Some vmrun/Workstation editions may not implement this
    // command while powered off; the VMX policy above remains authoritative.
    try {
      await this.runner(this.vmrunExecutable, ['disableSharedFolders', vmxPath], { timeoutMs: 30_000 })
    } catch {
      // A spawn-level failure will be caught by the next lifecycle command.
    }
    // vmrun may rewrite the VMX, so close the policy again after the command.
    await hardenVmx(vmxPath)
  }

  private async snapshotsForCanonicalTemplate(templateVmxPath: string): Promise<string[]> {
    const result = await this.mustRun(
      ['listSnapshots', templateVmxPath],
      'list VMware template snapshots',
      30_000
    )
    return parseCountedOutput(result.stdout, /^Total snapshots: (\d+)$/, 'snapshot inventory')
  }

  private async ensureTemplatePoweredOff(templateVmxPath: string): Promise<void> {
    const result = await this.mustRun(['list'], 'check VMware template power state', 30_000)
    const running = parseCountedOutput(
      result.stdout,
      /^Total running VMs: (\d+)$/,
      'running VM inventory'
    )
    for (const candidate of running) {
      if (await pathsReferToSameFile(candidate, templateVmxPath)) {
        throw new Error('The VMware template must be powered off before creating or resetting a Room')
      }
    }
  }

  private async canonicalTemplatePath(templateVmxPath: string): Promise<string> {
    if (!templateVmxPath.trim()) throw new Error('A VMware template VMX is required')
    const rawResolved = path.resolve(templateVmxPath)
    const root = await this.ensureManagedRoot()
    if (isPathWithinOrEqual(rawResolved, root)) {
      throw new Error('A VMware template cannot live inside the managed Room root')
    }
    let canonical: string
    try {
      canonical = await realpath(rawResolved)
    } catch {
      throw new Error('The VMware template VMX does not exist')
    }
    const info = await lstat(canonical)
    if (!info.isFile() || path.extname(canonical).toLowerCase() !== '.vmx') {
      throw new Error('The VMware template must be a regular .vmx file')
    }
    if (isPathWithinOrEqual(canonical, root)) {
      throw new Error('A VMware template cannot live inside the managed Room root')
    }
    return canonical
  }

  private async templateIdFor(canonicalTemplatePath: string): Promise<string> {
    const key = await this.identityKey()
    return createHmac('sha256', key).update(normalizedPath(canonicalTemplatePath), 'utf8').digest('hex')
  }

  private identityKey(): Promise<Buffer> {
    this.identityKeyPromise ??= this.loadOrCreateIdentityKey()
    return this.identityKeyPromise
  }

  private async loadOrCreateIdentityKey(): Promise<Buffer> {
    await this.ensureProviderRoot()
    const readExisting = async (): Promise<Buffer> => {
      const info = await lstat(this.identityKeyPath)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('VMware provider identity key is not a regular file')
      }
      const key = await readFile(this.identityKeyPath)
      if (key.length !== 32) throw new Error('VMware provider identity key is invalid')
      return key
    }

    try {
      return await readExisting()
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    const generated = randomBytes(32)
    try {
      await writeFile(this.identityKeyPath, generated, { flag: 'wx', mode: 0o600 })
      return generated
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return readExisting()
      throw error
    }
  }

  private async mustRun(args: readonly string[], label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<VmwareCommandResult> {
    const result = await this.runner(this.vmrunExecutable, args, { timeoutMs })
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code})`)
    return result
  }

  private async ensureProviderRoot(): Promise<string> {
    await mkdir(this.providerRoot, { recursive: true })
    const providerInfo = await lstat(this.providerRoot)
    if (!providerInfo.isDirectory() || providerInfo.isSymbolicLink()) {
      throw new Error('VMware provider root is not a real directory')
    }
    return realpath(this.providerRoot)
  }

  private async ensureManagedRoot(): Promise<string> {
    const providerRoot = await this.ensureProviderRoot()
    await mkdir(this.managedRoot, { recursive: true })
    const rootInfo = await lstat(this.managedRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('VMware managed Room root is not a real directory')
    }
    const root = await realpath(this.managedRoot)
    if (!samePath(path.dirname(root), providerRoot)) {
      throw new Error('VMware managed Room root is outside the provider root')
    }
    return root
  }

  private async loadOwnedRoom(roomId: string): Promise<OwnedRoom | null> {
    validateRoomId(roomId)
    const root = await this.ensureManagedRoot()
    const roomDir = path.join(this.managedRoot, roomId)
    if (!(await pathExists(roomDir))) return null
    const canonicalRoomDir = await this.validateOwnedRoomDirectory(roomId, root)
    const markerPath = path.join(canonicalRoomDir, OWNERSHIP_FILE)
    const markerInfo = await lstat(markerPath).catch(() => null)
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) {
      throw new Error(`Windows Room ${roomId} has no valid ownership marker`)
    }
    const marker = parseOwnershipMarker(await readFile(markerPath, 'utf8'), roomId)
    if (!path.isAbsolute(marker.templateVmxPath)) throw new Error('VMware ownership marker has an invalid template identity')
    if (isPathWithinOrEqual(marker.templateVmxPath, root)) {
      throw new Error('VMware ownership marker points its template inside the managed Room root')
    }
    const vmxPath = path.join(canonicalRoomDir, marker.vmxFile)
    if (!samePath(path.dirname(vmxPath), canonicalRoomDir)) {
      throw new Error('VMware ownership marker escapes its Room directory')
    }
    return { roomDir: canonicalRoomDir, vmxPath, markerPath, marker }
  }

  private async requireOwnedRoom(roomId: string): Promise<OwnedRoom> {
    const owned = await this.loadOwnedRoom(roomId)
    if (!owned) throw new Error(`Windows Room ${roomId} has no managed VMware data`)
    return owned
  }

  private async validateOwnedRoomDirectory(roomId: string, canonicalRoot?: string): Promise<string> {
    validateRoomId(roomId)
    const root = canonicalRoot ?? (await this.ensureManagedRoot())
    const roomDir = path.join(this.managedRoot, roomId)
    const info = await lstat(roomDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Windows Room ${roomId} managed path is not a real directory`)
    }
    const canonicalRoomDir = await realpath(roomDir)
    if (!samePath(path.dirname(canonicalRoomDir), root) || path.basename(canonicalRoomDir) !== roomId) {
      throw new Error(`Windows Room ${roomId} managed path is outside the exact Room root`)
    }
    return canonicalRoomDir
  }

  private async disposeOwnedClone(owned: OwnedRoom): Promise<void> {
    const roomId = owned.marker.roomId
    await this.validateOwnedRoomDirectory(roomId)
    if (await isRegularFile(owned.vmxPath)) {
      await assertDistinctClone(owned.vmxPath, owned.marker.templateVmxPath)
      await this.mustRun(['deleteVM', owned.vmxPath], 'delete Windows Room clone', 5 * 60_000)
    }
    // Re-resolve and re-read after the external process: never recursively
    // remove a path or marker that was swapped while vmrun was working.
    const revalidated = await this.requireOwnedRoom(roomId)
    if (!samePath(revalidated.roomDir, owned.roomDir)) {
      throw new Error('Windows Room ownership changed during deletion')
    }
    if (
      !samePath(revalidated.markerPath, owned.markerPath) ||
      !samePath(revalidated.vmxPath, owned.vmxPath) ||
      !sameOwnershipMarker(revalidated.marker, owned.marker)
    ) {
      throw new Error('Windows Room ownership marker changed during deletion')
    }
    await rm(revalidated.roomDir, { recursive: true, force: false })
  }

  private async leaveBrokenOwnership(roomId: string, template: InspectedTemplate, error: unknown): Promise<void> {
    validateRoomId(roomId)
    const root = await this.ensureManagedRoot()
    const lexicalRoomDir = path.join(this.managedRoot, roomId)
    if (!(await pathExists(lexicalRoomDir))) await mkdir(lexicalRoomDir, { recursive: false })
    const roomDir = await this.validateOwnedRoomDirectory(roomId, root)
    const markerPath = path.join(roomDir, OWNERSHIP_FILE)
    let createdAt = this.now().toISOString()
    if (await pathExists(markerPath)) {
      try {
        createdAt = parseOwnershipMarker(await readFile(markerPath, 'utf8'), roomId).createdAt
      } catch {
        // Replace only the exact marker under the already-validated Room dir.
      }
    }
    await writeMarkerAtomically(markerPath, {
      schemaVersion: 2,
      owner: 'devhotel',
      backend: 'vmware-workstation',
      roomId,
      status: 'broken',
      templateId: template.templateId,
      templateFingerprint: template.templateFingerprint,
      templateVmxPath: template.templateVmxPath,
      snapshot: template.snapshot,
      vmxFile: ROOM_VMX_FILE,
      createdAt,
      updatedAt: this.now().toISOString(),
      failure: safeFailure(error)
    })
  }
}

function validateRoomId(roomId: string): void {
  if (!ROOM_ID.test(roomId)) throw new Error('Windows Room ID must be exactly 8 lowercase letters or digits')
}

export function validateSnapshotName(snapshot: string): void {
  if (snapshot !== snapshot.trim() || !SNAPSHOT_NAME.test(snapshot)) {
    throw new Error('VMware snapshot names may contain only letters, digits, spaces, dot, underscore and hyphen')
  }
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right)
}

function isPathWithinOrEqual(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizedPath(candidate)
  const normalizedRoot = normalizedPath(root)
  if (normalizedCandidate === normalizedRoot) return true
  const relative = path.relative(normalizedRoot, normalizedCandidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function pathsReferToSameFile(candidate: string, target: string): Promise<boolean> {
  try {
    return samePath(await realpath(candidate), target)
  } catch {
    return samePath(candidate, target)
  }
}

async function assertDistinctClone(cloneVmxPath: string, templateVmxPath: string): Promise<void> {
  if (await filesReferToSameObject(cloneVmxPath, templateVmxPath)) {
    throw new Error('VMware clone aliases the immutable template; lifecycle operation refused')
  }
}

/**
 * Detect source replacement without hashing multi-gigabyte virtual disks.
 * Small VMware metadata is content-hashed; disk/suspend images contribute
 * stable name, size and modification-time facts. The baseline contract asks
 * users to keep the template directory unchanged, so false negatives fail
 * closed while ordinary reads do not rotate the fingerprint.
 */
async function templateFingerprintFor(templateVmxPath: string, snapshot: string): Promise<string> {
  const directory = path.dirname(templateVmxPath)
  const relevantExtensions = new Set(['.vmx', '.vmsd', '.vmdk', '.vmsn', '.nvram'])
  const contentExtensions = new Set(['.vmx', '.vmsd', '.nvram'])
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => relevantExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const hash = createHash('sha256')
    .update('devhotel-vmware-template-v1\0', 'utf8')
    .update(normalizedPath(templateVmxPath), 'utf8')
    .update('\0', 'utf8')
    .update(snapshot, 'utf8')

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    const info = await lstat(candidate)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`VMware template metadata '${entry.name}' is not a regular file`)
    }
    hash
      .update('\0', 'utf8')
      .update(entry.name, 'utf8')
      .update('\0', 'utf8')
      .update(String(info.size), 'utf8')
      .update('\0', 'utf8')
      .update(String(info.mtimeMs), 'utf8')
    if (contentExtensions.has(path.extname(entry.name).toLowerCase())) {
      hash.update('\0').update(await readFile(candidate))
    }
  }
  return hash.digest('hex')
}

async function filesReferToSameObject(left: string, right: string): Promise<boolean> {
  try {
    const [leftCanonical, rightCanonical, leftInfo, rightInfo] = await Promise.all([
      realpath(left),
      realpath(right),
      stat(left),
      stat(right)
    ])
    if (samePath(leftCanonical, rightCanonical)) return true
    return leftInfo.ino !== 0 && leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function parseCountedOutput(stdout: string, headerPattern: RegExp, label: string): string[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const first = (lines.shift() ?? '').replace(/^\uFEFF/, '')
  const match = headerPattern.exec(first)
  if (!match?.[1]) throw new Error(`VMware returned an invalid ${label}`)
  const expected = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(expected) || expected < 0 || lines.some((line) => line === '') || lines.length !== expected) {
    throw new Error(`VMware returned an inconsistent ${label}`)
  }
  return lines
}

function vmxKey(line: string): string | null {
  const match = /^\s*([^#;][^=]*?)\s*=/.exec(line)
  return match?.[1]?.trim().toLowerCase() ?? null
}

function vmxValue(line: string): string {
  const raw = line.slice(line.indexOf('=') + 1).trim()
  return withoutOuterQuotes(raw).trim().toLowerCase()
}

/** Apply the powered-off Clean Room policy atomically to the owned clone only. */
async function hardenVmx(vmxPath: string): Promise<void> {
  const info = await lstat(vmxPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Owned VMware clone VMX is not a regular file')
  // VMX files may declare legacy encodings. latin1 gives a byte-preserving
  // round trip for every retained line while all policy keys we inspect/add
  // are ASCII, so hardening cannot corrupt a localized display name.
  const original = (await readFile(vmxPath)).toString('latin1')
  const originalLines = original.split(/\r?\n/)
  const ethernetIndexes = new Set<string>(['0'])
  const disabledHostDevices = new Set<string>()
  const retained: string[] = []
  const exactManagedKeys = new Set([
    'isolation.tools.copy.disable',
    'isolation.tools.paste.disable',
    'isolation.tools.dnd.disable',
    'isolation.tools.hgfs.disable',
    'isolation.tools.setguioptions.enable',
    'tools.guestlib.enablehostinfo',
    'sharedfolder.maxnum',
    'usb.present',
    'usb_xhci.present',
    'ehci.present',
    'xhci.present'
  ])

  // Serial/parallel/floppy devices are direct Host channels. CD/DVD devices
  // are disabled when their VMX block identifies physical media or an ISO;
  // virtual-disk controller entries remain intact for the linked clone chain.
  for (const line of originalLines) {
    const key = vmxKey(line)
    if (!key) continue
    const directHostDevice = /^((?:serial|parallel|floppy)\d+)\./.exec(key)
    if (directHostDevice?.[1]) disabledHostDevices.add(directHostDevice[1])
    const removable = /^((?:ide|sata|scsi|nvme)\d+:\d+)\.(devicetype|filename)$/.exec(key)
    if (!removable?.[1] || !removable[2]) continue
    const value = vmxValue(line)
    if (
      (removable[2] === 'devicetype' && (value.includes('cdrom') || value.includes('atapi'))) ||
      (removable[2] === 'filename' && (value.endsWith('.iso') || value === 'auto detect'))
    ) {
      disabledHostDevices.add(removable[1])
    }
  }

  for (const line of originalLines) {
    const key = vmxKey(line)
    if (!key) {
      if (line !== '') retained.push(line)
      continue
    }
    const ethernet = /^ethernet(\d+)\./.exec(key)
    if (ethernet?.[1]) {
      ethernetIndexes.add(ethernet[1])
      // A disabled adapter needs none of its former NAT/bridged/custom policy.
      // Retaining it makes a later accidental toggle silently regain network.
      continue
    }
    if (exactManagedKeys.has(key)) continue
    if (key.startsWith('sharedfolder') || key.startsWith('hgfs.')) continue
    if (key.startsWith('usb.') || key.startsWith('usb_xhci.')) continue
    const device = /^((?:serial|parallel|floppy)\d+|(?:ide|sata|scsi|nvme)\d+:\d+)\./.exec(key)
    if (device?.[1] && disabledHostDevices.has(device[1])) continue
    if (key.startsWith('guestinfo.') || key.startsWith('vmci0.')) continue
    retained.push(line)
  }

  retained.push(
    'isolation.tools.copy.disable = "TRUE"',
    'isolation.tools.paste.disable = "TRUE"',
    'isolation.tools.dnd.disable = "TRUE"',
    'isolation.tools.hgfs.disable = "TRUE"',
    'isolation.tools.setGUIOptions.enable = "FALSE"',
    'sharedFolder.maxNum = "0"',
    'usb.present = "FALSE"',
    'usb_xhci.present = "FALSE"',
    'ehci.present = "FALSE"',
    'xhci.present = "FALSE"',
    'vmci0.present = "FALSE"',
    'tools.guestlib.enableHostInfo = "FALSE"'
  )
  for (const index of [...ethernetIndexes].sort((a, b) => Number(a) - Number(b))) {
    retained.push(
      `ethernet${index}.present = "FALSE"`,
      `ethernet${index}.startConnected = "FALSE"`
    )
  }
  for (const device of [...disabledHostDevices].sort()) {
    retained.push(
      `${device}.present = "FALSE"`,
      `${device}.startConnected = "FALSE"`,
      `${device}.clientDevice = "FALSE"`
    )
  }

  await writeFileAtomically(vmxPath, Buffer.from(`${retained.join('\n')}\n`, 'latin1'))
}

async function writeMarkerAtomically(markerPath: string, marker: OwnershipMarker): Promise<void> {
  await writeFileAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
}

async function writeFileAtomically(target: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    if (typeof contents === 'string') {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' })
    } else {
      await writeFile(temporary, contents, { flag: 'wx' })
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function parseOwnershipMarker(raw: string, expectedRoomId: string): OwnershipMarker {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`Windows Room ${expectedRoomId} ownership marker is not valid JSON`)
  }
  if (!isRecord(value)) throw new Error(`Windows Room ${expectedRoomId} ownership marker is invalid`)
  const status = value['status']
  const snapshot = value['snapshot']
  if (
    value['schemaVersion'] !== 2 ||
    value['owner'] !== 'devhotel' ||
    value['backend'] !== 'vmware-workstation' ||
    value['roomId'] !== expectedRoomId ||
    !['creating', 'ready', 'broken'].includes(String(status)) ||
    typeof value['templateId'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['templateId']) ||
    typeof value['templateFingerprint'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['templateFingerprint']) ||
    typeof value['templateVmxPath'] !== 'string' ||
    typeof snapshot !== 'string' ||
    value['vmxFile'] !== ROOM_VMX_FILE ||
    typeof value['createdAt'] !== 'string' ||
    typeof value['updatedAt'] !== 'string' ||
    (value['failure'] !== undefined && typeof value['failure'] !== 'string')
  ) {
    throw new Error(`Windows Room ${expectedRoomId} ownership marker is invalid`)
  }
  validateSnapshotName(snapshot)
  return value as unknown as OwnershipMarker
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameOwnershipMarker(left: OwnershipMarker, right: OwnershipMarker): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.owner === right.owner &&
    left.backend === right.backend &&
    left.roomId === right.roomId &&
    left.status === right.status &&
    left.templateId === right.templateId &&
    left.templateFingerprint === right.templateFingerprint &&
    samePath(left.templateVmxPath, right.templateVmxPath) &&
    left.snapshot === right.snapshot &&
    left.vmxFile === right.vmxFile &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.failure === right.failure
  )
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    const info = await lstat(candidate)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

async function directorySizeWithoutFollowingLinks(root: string): Promise<number> {
  const info = await lstat(root)
  if (info.isSymbolicLink()) throw new Error('Refusing to size a linked VMware Room directory')
  if (!info.isDirectory()) return info.size
  let total = info.size
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink()) {
      total += (await lstat(candidate)).size
    } else if (entry.isDirectory()) {
      total += await directorySizeWithoutFollowingLinks(candidate)
    } else {
      total += (await stat(candidate)).size
    }
  }
  return total
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\0]+/g, ' ').slice(0, 500)
}
