import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, tempDir, testDb } from './fakes'

/**
 * Source detection clones for real through docker. This stub stands in for that one
 * command so the test can read exactly what would have been sent, argv and stdin alike.
 */
const dockerRuns: { args: string[]; input?: string }[] = []
vi.mock('../backend/cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/cli')>()
  return {
    ...actual,
    runDocker: async (args: string[], opts: { input?: string } = {}) => {
      dockerRuns.push({ args, ...(opts.input === undefined ? {} : { input: opts.input }) })
      // `<host path>:/workspace` — a Windows host path has its own colon, so split off the target
      const workspace = args[args.indexOf('-v') + 1]?.replace(/:\/workspace$/, '')
      if (workspace) {
        mkdirSync(workspace, { recursive: true })
        writeFileSync(`${workspace}/package.json`, JSON.stringify({ name: 'private-app' }))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  }
})

/**
 * A private repository needs a credential; the Room record, manifest.yaml and the logs
 * must never contain one. These two facts are the whole contract of this feature.
 */
describe('private repository clone credentials', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const listeners: (() => void)[] = []

  afterEach(() => {
    dockerRuns.length = 0
    for (const close of listeners.splice(0)) close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function setup(gitCredential?: (url: string) => Promise<{ username: string; secret: string } | null>) {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    // the Room is verified by connecting to its published port, so give it a real one
    const listener = await listeningPort()
    backend.hostPort = listener.port
    listeners.push(listener.close)
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      ...(gitCredential ? { gitCredential } : {})
    })
    return { backend, orch }
  }

  it('strips an inline token from the URL it stores while still using it to clone', async () => {
    const { backend, orch } = await setup()
    const secret = 'github_pat_secret_value'
    const room = await orch.createRoom({
      sourceType: 'managed-git',
      sourceRef: `https://octocat:${secret}@github.com/acme/private.git`,
      project: 'private-app',
      nickname: 'dev',
      actor: 'user'
    })

    expect(room.sourceRef).toBe('https://github.com/acme/private.git')
    expect(JSON.stringify(orch.rooms.get(room.id))).not.toContain(secret)
    expect(backend.lastGitCredential).toEqual({ username: 'octocat', secret })
    // detection cloned with the same credential, on stdin and never in argv
    const detection = dockerRuns.at(-1)!
    expect(detection.args.join(' ')).not.toContain(secret)
    expect(detection.args).toContain('https://github.com/acme/private.git')
    expect(detection.input).toBe(`octocat
${secret}
`)
  })

  it('hands a managed-git Room the connected GitHub Service credential', async () => {
    const credential = { username: 'octocat', secret: 'github_pat_vault_value' }
    const resolver = vi.fn(async () => credential)
    const { backend, orch } = await setup(resolver)

    const room = await orch.createRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://github.com/acme/private.git',
      project: 'private-app',
      nickname: 'dev',
      actor: 'user'
    })

    expect(backend.lastGitCredential).toEqual(credential)
    expect(room.sourceRef).toBe('https://github.com/acme/private.git')
    expect(JSON.stringify(orch.rooms.get(room.id))).not.toContain('github_pat_vault_value')
  })

  it('keeps cloning anonymously when the vault cannot answer', async () => {
    const { backend, orch } = await setup(async () => {
      throw new Error('vault locked')
    })

    await orch.createRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://github.com/acme/public.git',
      project: 'public-app',
      nickname: 'dev',
      actor: 'user'
    })

    expect(backend.lastGitCredential).toBeNull()
    expect(dockerRuns.at(-1)?.input).toBeUndefined()
  })
})
