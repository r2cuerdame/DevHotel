import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GITHUB_SERVICE_DEFAULT_ENABLED,
  GitHubService,
  PINNED_GH,
  validateExpectedContentLength,
  type CredentialVault
} from './githubService'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_REPO', 'Gh_Pager', 'BROWSER']) delete process.env[key]
})

class TestVault implements CredentialVault {
  constructor(private readonly available = true) {}
  isAvailable(): boolean { return this.available }
  encryptString(value: string): Buffer {
    const encrypted = Buffer.from(value, 'utf8')
    for (let index = 0; index < encrypted.length; index++) encrypted[index] = encrypted[index]! ^ 0x5a
    return encrypted
  }
  decryptString(value: Buffer): string {
    const plaintext = Buffer.from(value)
    for (let index = 0; index < plaintext.length; index++) plaintext[index] = plaintext[index]! ^ 0x5a
    return plaintext.toString('utf8')
  }
}

const trustedDigest = (): { size: number; sha256: string } => ({
  size: PINNED_GH.executableSize,
  sha256: PINNED_GH.executableSha256
})

const credentialPayload = (vault: CredentialVault, token = 'github_pat_12345678901234567890'): Buffer => vault.encryptString(JSON.stringify({
  schema: 1,
  hostname: 'github.com',
  account: 'octocat',
  token
}))

function installedServiceRoot(prefix = 'devhotel-gh-auth-'): { root: string; exe: string } {
  const root = mkdtempSync(join(tmpdir(), prefix)); dirs.push(root)
  const exe = join(root, 'hotel-services', 'github', 'versions', PINNED_GH.version, 'bin', 'gh.exe')
  mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, '')
  mkdirSync(join(root, 'hotel-services', 'github'), { recursive: true })
  writeFileSync(join(root, 'hotel-services', 'github', 'current.json'), JSON.stringify({ version: PINNED_GH.version }))
  return { root, exe }
}

describe('GitHub Hotel Service', () => {
  it('is available for Hotel provisioning without being enabled for an Agent by default', () => {
    expect(GITHUB_SERVICE_DEFAULT_ENABLED).toBe(false)
  })

  it('uses only its pinned executable and strips inherited token/context environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devhotel-gh-')); dirs.push(root)
    const exe = join(root, 'hotel-services', 'github', 'versions', PINNED_GH.version, 'bin', 'gh.exe')
    mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, '')
    mkdirSync(join(root, 'hotel-services', 'github'), { recursive: true }); writeFileSync(join(root, 'hotel-services', 'github', 'current.json'), JSON.stringify({ version: PINNED_GH.version }))
    process.env.GH_TOKEN = 'must-not-leak'; process.env.GITHUB_TOKEN = 'must-not-leak'; process.env.GH_REPO = 'must-not-leak'; process.env.Gh_Pager = 'must-not-leak'; process.env.BROWSER = 'must-not-leak'
    const runner = vi.fn(async (_exe: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(_exe).toBe(exe); expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.GH_REPO).toBeUndefined()
      expect(Object.keys(env).some((key) => key.toUpperCase() === 'GH_PAGER')).toBe(false); expect(env.BROWSER).toBeUndefined()
      expect(env.GH_CONFIG_DIR).toBe(join(root, 'hotel-services', 'github', 'runtime-config'))
      return args[0] === '--version'
        ? { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' }
    })
    const status = await new GitHubService(root, null, fetch, runner, undefined, trustedDigest).status()
    expect(status).toMatchObject({ installed: true, authenticated: false, version: PINNED_GH.version })
  })

  it('rejects Connect when the production credential vault is unavailable', async () => {
    const { root } = installedServiceRoot('devhotel-gh-vault-')
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))
    const service = new GitHubService(root, null, fetch, runner, new TestVault(false), trustedDigest)
    await expect(service.connect('github_pat_12345678901234567890')).rejects.toThrow('Secure credential storage is unavailable')
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'hotel-services', 'github', 'credential.bin'))).toBe(false)
  })

  it('validates the token before storing and never puts it in args or an error', async () => {
    const { root, exe } = installedServiceRoot('devhotel-gh-invalid-token-')
    const token = 'github_pat_12345678901234567890'
    process.env.GH_TOKEN = 'host-token'; process.env.GITHUB_TOKEN = 'host-github-token'
    const runner = vi.fn(async (_exe: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(_exe).toBe(exe)
      expect(args).not.toContain(token)
      if (args[0] === '--version') return { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      expect(args).toEqual(['api', 'user', '--jq', '.login'])
      expect(env.GH_TOKEN).toBe(token)
      expect(env.GITHUB_TOKEN).toBeUndefined()
      return { code: 1, stdout: token, stderr: `HTTP 401: ${token}` }
    })
    const service = new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest)
    await expect(service.connect(token)).rejects.toThrow('GitHub rejected this token')
    expect(existsSync(join(root, 'hotel-services', 'github', 'credential.bin'))).toBe(false)
  })

  it('stores one encrypted Hotel-owned payload and validates it after restart', async () => {
    const { root, exe } = installedServiceRoot('devhotel-gh-restart-')
    const token = 'github_pat_12345678901234567890'
    const database = join(root, 'devhotel.sqlite')
    writeFileSync(database, 'database sentinel: no credentials')
    const calls: string[][] = []
    const runner = vi.fn(async (_exe: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(_exe).toBe(exe); calls.push(args)
      if (args[0] === '--version') return { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      expect(args).toEqual(['api', 'user', '--jq', '.login']); expect(env.GH_TOKEN).toBe(token)
      return { code: 0, stdout: 'octocat\n', stderr: '' }
    })
    const vault = new TestVault()
    const connected = await new GitHubService(root, null, fetch, runner, vault, trustedDigest).connect(token)
    expect(connected).toMatchObject({ authenticated: true, account: 'octocat', credentialState: 'connected' })
    expect(JSON.stringify(connected)).not.toContain(token)
    const credentialFile = join(root, 'hotel-services', 'github', 'credential.bin')
    const ciphertext = readFileSync(credentialFile)
    expect(ciphertext.includes(Buffer.from(token))).toBe(false)
    expect(ciphertext.includes(Buffer.from('octocat'))).toBe(false)
    expect(readFileSync(database, 'utf8')).toBe('database sentinel: no credentials')
    expect(existsSync(join(root, 'hotel-services', 'github', 'config'))).toBe(false)

    const restarted = await new GitHubService(root, null, fetch, runner, vault, trustedDigest).status()
    expect(restarted).toMatchObject({ authenticated: true, account: 'octocat', credentialState: 'connected' })
    expect(calls.some((args) => args.includes('login') || args.includes('logout') || args.includes('auth'))).toBe(false)
  })

  it('recovers the one exact valid previous credential and deletes uncommitted temp ciphertext', async () => {
    const { root } = installedServiceRoot('devhotel-gh-credential-recovery-')
    const serviceRoot = join(root, 'hotel-services', 'github')
    const previous = join(serviceRoot, 'credential-11111111-1111-4111-8111-111111111111.previous')
    const temporary = join(serviceRoot, 'credential-22222222-2222-4222-8222-222222222222.tmp')
    const vault = new TestVault()
    writeFileSync(previous, credentialPayload(vault))
    writeFileSync(temporary, credentialPayload(vault, 'github_pat_99999999999999999999'))
    const runner = vi.fn(async (_exe: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      : { code: 0, stdout: 'octocat\n', stderr: '' })

    const status = await new GitHubService(root, null, fetch, runner, vault, trustedDigest).status()

    expect(status).toMatchObject({ authenticated: true, account: 'octocat' })
    expect(existsSync(join(serviceRoot, 'credential.bin'))).toBe(true)
    expect(existsSync(previous)).toBe(false)
    expect(existsSync(temporary)).toBe(false)
  })

  it('fails closed on ambiguous credential backups while deleting only uncommitted temp files', async () => {
    const { root } = installedServiceRoot('devhotel-gh-credential-ambiguous-')
    const serviceRoot = join(root, 'hotel-services', 'github')
    const vault = new TestVault()
    const previous = [
      join(serviceRoot, 'credential-11111111-1111-4111-8111-111111111111.previous'),
      join(serviceRoot, 'credential-22222222-2222-4222-8222-222222222222.previous')
    ]
    const temporary = join(serviceRoot, 'credential-33333333-3333-4333-8333-333333333333.tmp')
    for (const path of previous) writeFileSync(path, credentialPayload(vault))
    writeFileSync(temporary, credentialPayload(vault))
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))

    const status = await new GitHubService(root, null, fetch, runner, vault, trustedDigest).status()

    expect(status).toMatchObject({ authenticated: false, credentialState: 'unavailable' })
    expect(existsSync(join(serviceRoot, 'credential.bin'))).toBe(false)
    expect(previous.every(existsSync)).toBe(true)
    expect(existsSync(temporary)).toBe(false)
  })

  it('disconnects by deleting only its ciphertext and never calls gh auth or keyring commands', async () => {
    const { root } = installedServiceRoot('devhotel-gh-disconnect-')
    const token = 'github_pat_12345678901234567890'
    const runner = vi.fn(async (_exe: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      : { code: 0, stdout: 'octocat\n', stderr: '' })
    const service = new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest)
    await service.connect(token)
    const serviceRoot = join(root, 'hotel-services', 'github')
    const temporary = join(serviceRoot, 'credential-11111111-1111-4111-8111-111111111111.tmp')
    const previous = join(serviceRoot, 'credential-22222222-2222-4222-8222-222222222222.previous')
    const lookalike = join(serviceRoot, 'credential-not-a-uuid.previous')
    writeFileSync(temporary, credentialPayload(new TestVault()))
    writeFileSync(previous, credentialPayload(new TestVault()))
    writeFileSync(lookalike, 'not owned by the credential transaction')
    expect(existsSync(join(serviceRoot, 'credential.bin'))).toBe(true)
    const status = await service.disconnect()
    expect(status).toMatchObject({ authenticated: false, credentialState: 'disconnected' })
    expect(existsSync(join(serviceRoot, 'credential.bin'))).toBe(false)
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(previous)).toBe(false)
    expect(existsSync(lookalike)).toBe(true)
    expect(runner.mock.calls.flatMap((call) => call[1] as string[]).some((arg) => ['auth', 'login', 'logout'].includes(arg))).toBe(false)
  })

  it('rejects an exact credential artifact junction without touching its target', async () => {
    const { root } = installedServiceRoot('devhotel-gh-credential-junction-')
    const serviceRoot = join(root, 'hotel-services', 'github')
    const outside = mkdtempSync(join(tmpdir(), 'devhotel-gh-outside-credential-')); dirs.push(outside)
    const sentinel = join(outside, 'sentinel.txt'); writeFileSync(sentinel, 'keep')
    const junction = join(serviceRoot, 'credential-11111111-1111-4111-8111-111111111111.previous')
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))
    const service = new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest)

    await expect(service.disconnect()).rejects.toThrow(/non-regular managed artifact/)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    expect(existsSync(junction)).toBe(true)
  })

  it('reports corrupt ciphertext and an unavailable vault without exposing either as disconnected', async () => {
    const { root } = installedServiceRoot('devhotel-gh-corrupt-credential-')
    const credentialFile = join(root, 'hotel-services', 'github', 'credential.bin')
    writeFileSync(credentialFile, Buffer.from('not encrypted JSON'))
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))
    const corrupt = await new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest).status()
    expect(corrupt).toMatchObject({ authenticated: false, credentialState: 'unavailable', credentialVaultAvailable: true })
    const unavailable = await new GitHubService(root, null, fetch, runner, new TestVault(false), trustedDigest).status()
    expect(unavailable).toMatchObject({ authenticated: false, credentialState: 'unavailable', credentialVaultAvailable: false })
  })

  it('accepts an absent content-length but rejects malformed or mismatched declarations', () => {
    expect(() => validateExpectedContentLength(null, PINNED_GH.size)).not.toThrow()
    expect(() => validateExpectedContentLength(String(PINNED_GH.size), PINNED_GH.size)).not.toThrow()
    expect(() => validateExpectedContentLength('chunked', PINNED_GH.size)).toThrow(/header was invalid/)
    expect(() => validateExpectedContentLength('9007199254740993', PINNED_GH.size)).toThrow(/did not match/)
    expect(() => validateExpectedContentLength('1', PINNED_GH.size)).toThrow(/did not match/)
  })

  it('does not report a corrupt managed executable as installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devhotel-gh-corrupt-')); dirs.push(root)
    const exe = join(root, 'hotel-services', 'github', 'versions', PINNED_GH.version, 'bin', 'gh.exe')
    mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, 'corrupt')
    mkdirSync(join(root, 'hotel-services', 'github'), { recursive: true }); writeFileSync(join(root, 'hotel-services', 'github', 'current.json'), JSON.stringify({ version: PINNED_GH.version }))
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'invalid executable' }))
    await expect(new GitHubService(root, null, fetch, runner).status()).resolves.toMatchObject({ installed: false, detail: 'Built-in service needs repair' })
  })

  it('rejects a same-version replacement before any credential enters its environment', async () => {
    const { root } = installedServiceRoot('devhotel-gh-malicious-')
    const token = 'github_pat_12345678901234567890'
    const runner = vi.fn(async (_exe: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(env.GH_TOKEN).toBeUndefined()
      return args[0] === '--version'
        ? { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
        : { code: 0, stdout: 'attacker\n', stderr: '' }
    })

    const service = new GitHubService(root, null, fetch, runner, new TestVault())
    await expect(service.connect(token)).rejects.toThrow(/Repair the built-in/)
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'hotel-services', 'github', 'credential.bin'))).toBe(false)
  })

  it('rechecks the exact executable between status and Connect', async () => {
    const { root } = installedServiceRoot('devhotel-gh-status-connect-race-')
    const token = 'github_pat_12345678901234567890'
    let trusted = true
    const digest = vi.fn(() => trusted
      ? trustedDigest()
      : { size: PINNED_GH.executableSize, sha256: '0'.repeat(64) })
    const runner = vi.fn(async (_exe: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (args[0] === '--version') return { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      expect(env.GH_TOKEN).toBeUndefined()
      return { code: 0, stdout: 'octocat\n', stderr: '' }
    })
    const service = new GitHubService(root, null, fetch, runner, new TestVault(), digest)

    await expect(service.status()).resolves.toMatchObject({ installed: true, provisionState: 'provisioned' })
    trusted = false
    await expect(service.connect(token)).rejects.toThrow(/Repair the built-in/)
    expect(runner.mock.calls.filter((call) => (call[1] as string[])[0] === 'api')).toHaveLength(0)
  })

  it('keeps credentials on temporary network failure but marks a definitive HTTP 401 invalid', async () => {
    const { root } = installedServiceRoot('devhotel-gh-network-state-')
    const token = 'github_pat_12345678901234567890'
    let mode: 'connected' | 'offline' | 'unauthorized' = 'connected'
    const runner = vi.fn(async (_exe: string, args: string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }
      if (mode === 'offline') throw new Error('connect ETIMEDOUT')
      if (mode === 'unauthorized') return { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }
      return { code: 0, stdout: 'octocat\n', stderr: '' }
    })
    const service = new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest)
    await service.connect(token)
    const credential = join(root, 'hotel-services', 'github', 'credential.bin')

    mode = 'offline'
    await expect(service.status()).resolves.toMatchObject({ authenticated: false, credentialState: 'temporarily-unavailable', account: 'octocat' })
    expect(existsSync(credential)).toBe(true)

    mode = 'unauthorized'
    await expect(service.status()).resolves.toMatchObject({ authenticated: false, credentialState: 'invalid', account: 'octocat' })
    expect(existsSync(credential)).toBe(true)
  })

  it('reports and rejects concurrent provisioning, then clears the busy state on failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devhotel-gh-race-')); dirs.push(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => {
      await gate
      return new Response(new Uint8Array(PINNED_GH.size), { headers: { 'content-length': String(PINNED_GH.size) } })
    })
    const service = new GitHubService(root, null, fetcher as typeof fetch)
    const first = service.install()
    await expect(service.install()).rejects.toThrow(/already running/)
    const serviceRoot = join(root, 'hotel-services', 'github')
    const activeStages = readdirSync(serviceRoot).filter((name) => /^stage-/.test(name))
    expect(activeStages).toHaveLength(1)
    expect((await service.status()).installing).toBe(true)
    expect(activeStages.every((name) => existsSync(join(serviceRoot, name)))).toBe(true)
    release()
    await expect(first).rejects.toThrow(/SHA-256/)
    expect((await service.status()).installing).toBe(false)
    expect(readdirSync(serviceRoot).filter((name) => /^stage-/.test(name))).toHaveLength(0)
  })

  it('removes only exact bounded stale stage directories before status', async () => {
    const { root } = installedServiceRoot('devhotel-gh-stage-recovery-')
    const serviceRoot = join(root, 'hotel-services', 'github')
    const stale = join(serviceRoot, 'stage-11111111-1111-4111-8111-111111111111')
    const lookalike = join(serviceRoot, 'stage-manual-work')
    mkdirSync(join(stale, 'nested'), { recursive: true }); writeFileSync(join(stale, 'nested', 'partial.zip'), 'partial')
    mkdirSync(lookalike); writeFileSync(join(lookalike, 'keep.txt'), 'keep')
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))

    await new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest).status()

    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(join(lookalike, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('rejects an exact stale stage junction without traversing or deleting its target', async () => {
    const { root } = installedServiceRoot('devhotel-gh-stage-junction-')
    const serviceRoot = join(root, 'hotel-services', 'github')
    const outside = mkdtempSync(join(tmpdir(), 'devhotel-gh-outside-stage-')); dirs.push(outside)
    const sentinel = join(outside, 'sentinel.txt'); writeFileSync(sentinel, 'keep')
    const junction = join(serviceRoot, 'stage-11111111-1111-4111-8111-111111111111')
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const runner = vi.fn(async () => ({ code: 0, stdout: `gh version ${PINNED_GH.version}\n`, stderr: '' }))

    await expect(new GitHubService(root, null, fetch, runner, new TestVault(), trustedDigest).status()).rejects.toThrow(/not a regular directory/)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    expect(existsSync(junction)).toBe(true)
  })

  it.runIf(process.arch === 'x64' && existsSync(join(process.cwd(), 'resources', 'github', PINNED_GH.asset)))(
    'provisions the real pinned bundle and validates its exact executable',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'devhotel-gh-bundle-')); dirs.push(root)
      const archive = join(process.cwd(), 'resources', 'github', PINNED_GH.asset)
      const status = await new GitHubService(root, archive).install()
      expect(status).toMatchObject({ installed: true, installing: false, version: PINNED_GH.version })
      expect(existsSync(join(root, 'hotel-services', 'github', 'versions', PINNED_GH.version, 'bin', 'gh.exe'))).toBe(true)
    },
    30_000
  )

  it.runIf(process.arch === 'x64' && existsSync(join(process.cwd(), 'resources', 'github', PINNED_GH.asset)))(
    'streams a verified download without a content-length header',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'devhotel-gh-chunked-')); dirs.push(root)
      const archive = join(process.cwd(), 'resources', 'github', PINNED_GH.asset)
      const fetcher = vi.fn(async () => {
        const response = new Response(readFileSync(archive))
        expect(response.headers.get('content-length')).toBeNull()
        return response
      })
      const status = await new GitHubService(root, null, fetcher as typeof fetch).install()
      expect(status).toMatchObject({ installed: true, version: PINNED_GH.version })
    },
    30_000
  )
})
