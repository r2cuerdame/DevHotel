import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import { zGitHubToken, type GitHubServiceStatus, type HotelServiceManifest } from '@devhotel/shared'

export const PINNED_GH = {
  version: '2.97.0',
  asset: 'gh_2.97.0_windows_amd64.zip',
  size: 14_938_517,
  sha256: '35d7fe05c4dd1411ffda1e73dfc7c6f44b75c936ca51fa6595c657fdc0350cec',
  executableSize: 41_775_416,
  executableSha256: 'e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3'
} as const

export const GITHUB_SERVICE_MANIFEST: HotelServiceManifest = {
  schemaVersion: 1,
  id: 'devhotel.github',
  title: 'GitHub Service',
  description: 'DevHotel-owned GitHub CLI and encrypted authentication context',
  category: 'integration',
  adapterId: 'github-cli',
  interface: 'cli',
  version: {
    current: PINNED_GH.version,
    pin: { mode: 'exact', value: PINNED_GH.version },
    update: { mode: 'manual', channel: 'stable' },
    rollback: { supported: false, strategy: 'none' }
  },
  lifecycle: {
    install: true,
    update: true,
    start: false,
    stop: false,
    restart: false,
    remove: false,
    rollback: false
  },
  supportedContexts: ['hotel', 'host-project', 'room'],
  permissions: [
    { id: 'github-credential', title: 'Use an approved GitHub credential', access: 'secret', risk: 'high', approval: 'once' },
    { id: 'github-read', title: 'Read approved repository metadata', access: 'read', risk: 'low', approval: 'once' },
    { id: 'github-write', title: 'Change an approved repository', access: 'write', risk: 'high', approval: 'per-use' }
  ],
  health: { capability: 'probe', timeoutMs: 20_000 }
}

/** Provisioned Hotel infrastructure is available, but never enabled for an Agent implicitly. */
export const GITHUB_SERVICE_DEFAULT_ENABLED = false

const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const DOWNLOAD_TIMEOUT_MS = 90_000
const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 256 * 1024
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const CREDENTIAL_ARTIFACT = new RegExp(`^credential-${UUID_V4}\\.(tmp|previous)$`)
const STAGE_ARTIFACT = new RegExp(`^stage-${UUID_V4}$`)
const MAX_GC_ENTRIES = 128
const MAX_GC_DEPTH = 8

export function validateExpectedContentLength(value: string | null, expected: number): void {
  if (value === null) return
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) throw new Error('GitHub CLI asset size header was invalid')
  const declared = Number(normalized)
  if (!Number.isSafeInteger(declared) || declared < 0 || declared !== expected) throw new Error('GitHub CLI asset size did not match the pinned manifest')
}

interface CommandResult { code: number; stdout: string; stderr: string }
type Runner = (exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<CommandResult>
type DigestReader = (file: string) => { size: number; sha256: string }
type StatusSink = (status: GitHubServiceStatus) => void

export interface CredentialVault {
  isAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface StoredCredential {
  schema: 1
  hostname: 'github.com'
  account: string
  token: string
}

const unavailableVault: CredentialVault = {
  isAvailable: () => false,
  encryptString: () => { throw new Error('Credential encryption is unavailable') },
  decryptString: () => { throw new Error('Credential decryption is unavailable') }
}

const readDigest: DigestReader = (file) => ({
  size: statSync(file).size,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
})

function safeInside(root: string, target: string): string {
  const resolvedRoot = resolve(root), resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('GitHub Service path escaped its Hotel-owned directory')
  return resolvedTarget
}

function currentVersionNeedsProvision(version: string | null): boolean {
  return version === null
}

export async function runBounded(exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', size = 0, settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error('GitHub Service command timed out')) } }, timeoutMs)
    const collect = (chunk: Buffer, stderrStream: boolean): void => {
      size += chunk.length
      if (size > MAX_OUTPUT) { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(new Error('GitHub Service command output exceeded its safety limit')) }; return }
      if (stderrStream) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8')
    }
    child.stdout.on('data', (c: Buffer) => collect(c, false)); child.stderr.on('data', (c: Buffer) => collect(c, true))
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    child.once('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ code: code ?? -1, stdout, stderr }) } })
  })
}

export class GitHubService {
  private readonly root: string
  private readonly versionsDir: string
  private readonly credentialFile: string
  private readonly runtimeConfigDir: string
  private installing = false
  private activeStage: string | null = null
  constructor(
    private readonly userData: string,
    private readonly bundledArchive: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runner: Runner = runBounded,
    private readonly vault: CredentialVault = unavailableVault,
    private readonly digestReader: DigestReader = readDigest,
    private readonly statusSink?: StatusSink
  ) {
    this.root = join(userData, 'hotel-services', 'github')
    this.versionsDir = join(this.root, 'versions')
    this.credentialFile = join(this.root, 'credential.bin')
    this.runtimeConfigDir = join(this.root, 'runtime-config')
  }

  private ensurePrivateRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    try { chmodSync(this.root, 0o700) } catch { /* Windows ACL remains inherited from the app-owned user-data directory. */ }
  }

  private canonicalRoot(): string {
    this.ensurePrivateRoot()
    const rootStat = lstatSync(this.root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('GitHub Service storage is not a regular Hotel-owned directory')
    return realpathSync.native(this.root)
  }

  private assertCanonicalChild(path: string, canonicalRoot = this.canonicalRoot()): void {
    const safePath = safeInside(this.root, path)
    const canonicalPath = realpathSync.native(safePath)
    const rel = relative(canonicalRoot, canonicalPath)
    if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('GitHub Service artifact escaped its Hotel-owned directory')
  }

  private exactCredentialArtifacts(): { temporary: string[]; previous: string[] } {
    const canonicalRoot = this.canonicalRoot()
    const artifacts = { temporary: [] as string[], previous: [] as string[] }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const match = CREDENTIAL_ARTIFACT.exec(entry.name)
      if (!match) continue
      const path = safeInside(this.root, join(this.root, entry.name))
      const stat = lstatSync(path)
      if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('GitHub credential recovery found a non-regular managed artifact')
      }
      this.assertCanonicalChild(path, canonicalRoot)
      if (match[1] === 'tmp') artifacts.temporary.push(path)
      else artifacts.previous.push(path)
    }
    return artifacts
  }

  private readCredentialFile(path: string): { kind: 'unavailable' } | { kind: 'credential'; value: StoredCredential } {
    if (!this.vaultAvailable()) return { kind: 'unavailable' }
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) return { kind: 'unavailable' }
      this.assertCanonicalChild(path)
      const plaintext = this.vault.decryptString(readFileSync(path))
      if (plaintext.length > 4096) return { kind: 'unavailable' }
      const value = JSON.parse(plaintext) as Partial<StoredCredential>
      if (typeof value !== 'object' || value === null || Object.keys(value).sort().join(',') !== 'account,hostname,schema,token') return { kind: 'unavailable' }
      const validAccount = typeof value.account === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(value.account)
      if (value.schema !== 1 || value.hostname !== 'github.com' || !validAccount || !zGitHubToken.safeParse(value.token).success) return { kind: 'unavailable' }
      return { kind: 'credential', value: value as StoredCredential }
    } catch { return { kind: 'unavailable' } }
  }

  /**
   * A .tmp file was never committed. A single decryptable .previous file is
   * the only unambiguous recovery candidate when credential.bin is absent.
   * Ambiguous or unverifiable backups are retained and reported unavailable.
   */
  private recoverCredentialArtifacts(): boolean {
    const artifacts = this.exactCredentialArtifacts()
    for (const path of artifacts.temporary) rmSync(path, { force: true })
    if (existsSync(this.credentialFile)) {
      const current = this.readCredentialFile(this.credentialFile)
      if (current.kind !== 'credential') return false
      for (const path of artifacts.previous) rmSync(path, { force: true })
      return true
    }
    if (artifacts.previous.length === 0) return true
    if (artifacts.previous.length !== 1) return false
    const previous = artifacts.previous[0]!
    if (this.readCredentialFile(previous).kind !== 'credential') return false
    renameSync(previous, this.credentialFile)
    return true
  }

  private assertRemovableTree(path: string, canonicalRoot: string, state: { entries: number }, depth = 0): void {
    if (depth > MAX_GC_DEPTH || ++state.entries > MAX_GC_ENTRIES) throw new Error('GitHub Service stale stage exceeded cleanup bounds')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('GitHub Service stale stage contains a reparse point')
    this.assertCanonicalChild(path, canonicalRoot)
    if (stat.isFile()) return
    if (!stat.isDirectory()) throw new Error('GitHub Service stale stage contains a non-regular entry')
    for (const child of readdirSync(path)) {
      this.assertRemovableTree(safeInside(this.root, join(path, child)), canonicalRoot, state, depth + 1)
    }
  }

  private cleanupStaleStages(): void {
    const canonicalRoot = this.canonicalRoot()
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!STAGE_ARTIFACT.test(entry.name)) continue
      const path = safeInside(this.root, join(this.root, entry.name))
      if (this.activeStage !== null && resolve(path) === resolve(this.activeStage)) {
        const activeStat = lstatSync(path)
        if (!activeStat.isDirectory() || activeStat.isSymbolicLink()) throw new Error('GitHub Service active stage is not a regular directory')
        this.assertCanonicalChild(path, canonicalRoot)
        continue
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('GitHub Service stale stage is not a regular directory')
      this.assertRemovableTree(path, canonicalRoot, { entries: 0 })
      rmSync(path, { recursive: true, force: true })
    }
  }

  private prepareOwnedStorage(): boolean {
    this.cleanupStaleStages()
    return this.recoverCredentialArtifacts()
  }

  private vaultAvailable(): boolean {
    try { return this.vault.isAvailable() } catch { return false }
  }

  private executable(version = this.currentVersion()): string | null {
    if (!version) return null
    return join(this.versionsDir, version, 'bin', 'gh.exe')
  }

  private currentVersion(): string | null {
    try {
      const value = JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')) as { version?: unknown }
      return typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : null
    } catch { return null }
  }

  private env(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    const allowed = new Set([
      'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATH', 'PATHEXT',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'
    ])
    for (const [key, value] of Object.entries(process.env)) {
      const upper = key.toUpperCase()
      if (allowed.has(upper)) env[key] = value
    }
    env.GH_CONFIG_DIR = this.runtimeConfigDir
    env.GH_NO_UPDATE_NOTIFIER = '1'
    env.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1'
    env.GH_PROMPT_DISABLED = '1'
    if (token) env.GH_TOKEN = token
    return env
  }

  private async validPinnedExecutable(): Promise<boolean> {
    const version = this.currentVersion(), exe = this.executable(version)
    if (version !== PINNED_GH.version || !exe || !existsSync(exe)) return false
    try {
      const digest = this.digestReader(exe)
      if (digest.size !== PINNED_GH.executableSize || digest.sha256 !== PINNED_GH.executableSha256) return false
      const result = await this.runner(exe, ['--version'], this.env(), 15_000)
      return result.code === 0 && result.stdout.startsWith(`gh version ${PINNED_GH.version}`)
    } catch { return false }
  }

  private async requirePinnedExecutable(): Promise<string> {
    if (!(await this.validPinnedExecutable())) throw new Error('Repair the built-in GitHub Service first')
    return this.executable(PINNED_GH.version)!
  }

  private report(status: GitHubServiceStatus): GitHubServiceStatus {
    try { this.statusSink?.(status) } catch { /* Runtime state remains authoritative; persistence is retryable. */ }
    return status
  }

  private readCredential(): { kind: 'none' } | { kind: 'unavailable' } | { kind: 'credential'; value: StoredCredential } {
    if (!existsSync(this.credentialFile)) return { kind: 'none' }
    return this.readCredentialFile(this.credentialFile)
  }

  private removeCredentialArtifacts(): void {
    const canonicalRoot = this.canonicalRoot()
    const names = readdirSync(this.root)
      .filter((name) => CREDENTIAL_ARTIFACT.test(name))
      .concat(existsSync(this.credentialFile) ? ['credential.bin'] : [])
    let rejected = false
    for (const name of names) {
      const path = safeInside(this.root, join(this.root, name))
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) { rejected = true; continue }
        this.assertCanonicalChild(path, canonicalRoot)
        rmSync(path, { force: true })
      } catch { rejected = true }
    }
    if (rejected) throw new Error('GitHub credential cleanup rejected a non-regular managed artifact')
  }

  private writeCredential(value: StoredCredential): void {
    if (!this.vaultAvailable()) throw new Error('Secure credential storage is unavailable on this computer')
    this.ensurePrivateRoot()
    const temporary = safeInside(this.root, join(this.root, `credential-${randomUUID()}.tmp`))
    const backup = safeInside(this.root, join(this.root, `credential-${randomUUID()}.previous`))
    let movedPrevious = false
    try {
      const encrypted = this.vault.encryptString(JSON.stringify(value))
      if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > 64 * 1024) throw new Error('invalid encrypted credential')
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
      try { chmodSync(temporary, 0o600) } catch { /* See ensurePrivateRoot. */ }
      if (existsSync(this.credentialFile)) { renameSync(this.credentialFile, backup); movedPrevious = true }
      try { renameSync(temporary, this.credentialFile) }
      catch (error) {
        if (movedPrevious && existsSync(backup)) renameSync(backup, this.credentialFile)
        throw error
      }
      rmSync(backup, { force: true })
    } catch {
      throw new Error('GitHub credential could not be stored securely')
    } finally {
      rmSync(temporary, { force: true })
      if (existsSync(this.credentialFile)) rmSync(backup, { force: true })
    }
  }

  private async tokenAccount(token: string): Promise<
    | { kind: 'connected'; account: string }
    | { kind: 'invalid' }
    | { kind: 'temporarily-unavailable' }
    | { kind: 'repair-needed' }
  > {
    let exe: string
    try {
      // Repeat exact digest + version verification immediately before the only
      // command that receives a credential. A prior status check is not trust.
      exe = await this.requirePinnedExecutable()
    } catch {
      return { kind: 'repair-needed' }
    }
    try {
      const result = await this.runner(exe, ['api', 'user', '--jq', '.login'], this.env(token), 20_000)
      if (result.code !== 0) {
        const detail = `${result.stderr}\n${result.stdout}`
        return /(?:\bHTTP\s+401\b|bad credentials|authentication failed)/i.test(detail)
          ? { kind: 'invalid' }
          : { kind: 'temporarily-unavailable' }
      }
      const account = result.stdout.trim()
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(account)
        ? { kind: 'connected', account }
        : { kind: 'temporarily-unavailable' }
    } catch {
      return { kind: 'temporarily-unavailable' }
    }
  }

  async status(): Promise<GitHubServiceStatus> {
    const credentialRecoveryReady = this.prepareOwnedStorage()
    const executableValid = await this.validPinnedExecutable()
    if (!executableValid && this.bundledArchive && existsSync(this.bundledArchive) && !this.installing) return this.install()
    const version = this.currentVersion(), exe = this.executable(version)
    const credentialVaultAvailable = this.vaultAvailable()
    const stored = credentialRecoveryReady ? this.readCredential() : { kind: 'unavailable' as const }
    if (!version || !exe || !executableValid) return this.report({ installed: false, installing: this.installing, version: null, pinnedVersion: PINNED_GH.version, provisionState: this.installing ? 'provisioning' : currentVersionNeedsProvision(version) ? 'not-provisioned' : 'repair-needed', authenticated: false, account: stored.kind === 'credential' ? stored.value.account : null, credentialState: stored.kind === 'none' ? 'disconnected' : 'unavailable', credentialVaultAvailable, detail: this.installing ? 'Preparing built-in service…' : 'Built-in service needs repair' })
    if (stored.kind === 'none') return this.report({ installed: true, installing: this.installing, version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: false, account: null, credentialState: 'disconnected', credentialVaultAvailable, detail: 'Installed · not connected' })
    if (stored.kind === 'unavailable') return this.report({ installed: true, installing: this.installing, version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: false, account: null, credentialState: 'unavailable', credentialVaultAvailable, detail: 'Stored credential is unavailable' })
    const validation = await this.tokenAccount(stored.value.token)
    if (validation.kind === 'repair-needed') return this.report({ installed: false, installing: this.installing, version: null, pinnedVersion: PINNED_GH.version, provisionState: 'repair-needed', authenticated: false, account: stored.value.account, credentialState: 'unavailable', credentialVaultAvailable, detail: 'Built-in service needs repair' })
    if (validation.kind === 'temporarily-unavailable') return this.report({ installed: true, installing: this.installing, version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: false, account: stored.value.account, credentialState: 'temporarily-unavailable', credentialVaultAvailable, detail: 'GitHub is temporarily unreachable; the stored credential was kept' })
    if (validation.kind === 'invalid' || validation.account !== stored.value.account) return this.report({ installed: true, installing: this.installing, version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: false, account: stored.value.account, credentialState: 'invalid', credentialVaultAvailable, detail: 'Stored credential was rejected by GitHub' })
    return this.report({ installed: true, installing: this.installing, version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: true, account: validation.account, credentialState: 'connected', credentialVaultAvailable, detail: `Connected as ${validation.account}` })
  }

  async connect(token: string): Promise<GitHubServiceStatus> {
    const parsed = zGitHubToken.safeParse(token)
    if (!parsed.success) throw new Error('Enter a valid GitHub fine-grained personal access token')
    if (!this.prepareOwnedStorage()) throw new Error('Existing GitHub credential state could not be recovered safely')
    if (!this.vaultAvailable()) throw new Error('Secure credential storage is unavailable on this computer')
    const validation = await this.tokenAccount(parsed.data)
    if (validation.kind === 'repair-needed') throw new Error('Repair the built-in GitHub Service first')
    if (validation.kind === 'temporarily-unavailable') throw new Error('GitHub is temporarily unavailable; the token was not stored')
    if (validation.kind === 'invalid') throw new Error('GitHub rejected this token')
    this.writeCredential({ schema: 1, hostname: 'github.com', account: validation.account, token: parsed.data })
    return this.report({ installed: true, installing: this.installing, version: PINNED_GH.version, pinnedVersion: PINNED_GH.version, provisionState: 'provisioned', authenticated: true, account: validation.account, credentialState: 'connected', credentialVaultAvailable: true, detail: `Connected as ${validation.account}` })
  }

  async disconnect(): Promise<GitHubServiceStatus> {
    this.cleanupStaleStages()
    this.removeCredentialArtifacts()
    return this.status()
  }

  private async fetchAsset(url: string, destination: string): Promise<void> {
    let next = new URL(url)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (next.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(next.hostname)) throw new Error('GitHub download redirect was not on the allowlist')
        const response = await this.fetchImpl(next, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'DevHotel' } })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); if (!location) throw new Error('GitHub download redirect had no location')
          next = new URL(location, next); continue
        }
        if (!response.ok || !response.body) throw new Error(`GitHub CLI download failed (${response.status})`)
        validateExpectedContentLength(response.headers.get('content-length'), PINNED_GH.size)
        let received = 0
        const guarded = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { received += chunk.byteLength; if (received > PINNED_GH.size) throw new Error('GitHub CLI download exceeded its pinned size'); ctl.enqueue(chunk) } })
        await pipeline(Readable.fromWeb(response.body.pipeThrough(guarded) as never), createWriteStream(destination, { flags: 'wx' }))
        if (received !== PINNED_GH.size) throw new Error('GitHub CLI download was incomplete')
        return
      }
      throw new Error('Too many GitHub download redirects')
    } finally { clearTimeout(timer) }
  }

  async install(): Promise<GitHubServiceStatus> {
    if (process.arch !== 'x64') throw new Error('This build currently provides the verified GitHub CLI package for Windows x64 only')
    if (this.installing) throw new Error('GitHub Service installation is already running')
    this.cleanupStaleStages()
    this.installing = true
    this.ensurePrivateRoot(); mkdirSync(this.versionsDir, { recursive: true })
    const stage = safeInside(this.root, join(this.root, `stage-${randomUUID()}`)); mkdirSync(stage)
    this.activeStage = stage
    try {
      const zip = safeInside(stage, join(stage, PINNED_GH.asset))
      if (this.bundledArchive && existsSync(this.bundledArchive)) copyFileSync(this.bundledArchive, zip)
      else await this.fetchAsset(`https://github.com/cli/cli/releases/download/v${PINNED_GH.version}/${PINNED_GH.asset}`, zip)
      const actual = createHash('sha256').update(readFileSync(zip)).digest('hex')
      if (actual !== PINNED_GH.sha256) throw new Error('GitHub CLI SHA-256 verification failed')
      const unpack = safeInside(stage, join(stage, 'unpacked')); mkdirSync(unpack)
      const expectedEntries = new Set(['bin/gh.exe', 'LICENSE'])
      const seenEntries = new Set<string>()
      let uncompressedBytes = 0
      await extract(zip, { dir: unpack, onEntry: (entry) => {
        const normalized = entry.fileName.replaceAll('\\', '/')
        if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) throw new Error('GitHub CLI archive contains an unsafe path')
        if (!expectedEntries.has(normalized) || seenEntries.has(normalized)) throw new Error('GitHub CLI archive contains an unexpected entry')
        seenEntries.add(normalized)
        uncompressedBytes += entry.uncompressedSize
        if (seenEntries.size > expectedEntries.size || uncompressedBytes > 50 * 1024 * 1024) throw new Error('GitHub CLI archive exceeds its extraction bounds')
      } })
      if (seenEntries.size !== expectedEntries.size || [...expectedEntries].some((entry) => !seenEntries.has(entry))) throw new Error('GitHub CLI archive is incomplete')
      const candidate = join(unpack, 'bin', 'gh.exe')
      if (!existsSync(candidate)) throw new Error('Verified archive did not contain the exact expected gh.exe')
      const candidateDigest = this.digestReader(candidate)
      if (candidateDigest.size !== PINNED_GH.executableSize || candidateDigest.sha256 !== PINNED_GH.executableSha256) {
        throw new Error('Extracted gh.exe did not match the pinned executable digest')
      }
      const versionCheck = await this.runner(candidate, ['--version'], this.env(), 15_000)
      if (versionCheck.code !== 0 || !versionCheck.stdout.startsWith(`gh version ${PINNED_GH.version}`)) throw new Error('Extracted gh.exe did not report the pinned version')
      const target = safeInside(this.versionsDir, join(this.versionsDir, PINNED_GH.version))
      const quarantine = safeInside(this.versionsDir, join(this.versionsDir, `.previous-${PINNED_GH.version}-${randomUUID()}`))
      const hadTarget = existsSync(target)
      if (hadTarget) renameSync(target, quarantine)
      try { renameSync(unpack, target) }
      catch (error) { if (hadTarget && existsSync(quarantine)) renameSync(quarantine, target); throw error }
      const currentTmp = join(this.root, `current-${randomUUID()}.json`)
      writeFileSync(currentTmp, JSON.stringify({
        version: PINNED_GH.version,
        archiveSha256: PINNED_GH.sha256,
        executableSha256: PINNED_GH.executableSha256
      }), { encoding: 'utf8', flag: 'wx' })
      const current = join(this.root, 'current.json'), previous = join(this.root, `previous-${randomUUID()}.json`)
      const hadCurrent = existsSync(current)
      if (hadCurrent) renameSync(current, previous)
      try {
        renameSync(currentTmp, current)
        if (hadCurrent) rmSync(previous, { force: true })
        if (hadTarget) rmSync(quarantine, { recursive: true, force: true })
      } catch (error) {
        if (hadCurrent && existsSync(previous)) renameSync(previous, current)
        rmSync(target, { recursive: true, force: true })
        if (hadTarget && existsSync(quarantine)) renameSync(quarantine, target)
        throw error
      }
      this.installing = false
      return await this.status()
    } catch (error) {
      this.installing = false
      const stored = this.readCredential()
      this.report({
        installed: false,
        installing: false,
        version: null,
        pinnedVersion: PINNED_GH.version,
        provisionState: 'failed',
        authenticated: false,
        account: stored.kind === 'credential' ? stored.value.account : null,
        credentialState: stored.kind === 'none' ? 'disconnected' : 'unavailable',
        credentialVaultAvailable: this.vaultAvailable(),
        detail: 'Built-in service provisioning failed'
      })
      throw error
    } finally {
      this.installing = false
      rmSync(stage, { recursive: true, force: true })
      this.activeStage = null
    }
  }

}
