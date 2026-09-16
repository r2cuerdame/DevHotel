import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, tempDir, testDb } from './fakes'

/**
 * Source detection clones through the Room backend, which is the only layer that
 * knows how its engine reaches the Host filesystem. What this file proves is the
 * orchestrator half: the credential the vault resolved reaches that call, and the
 * secret never reaches the URL the Room stores. The argv and stdin shaping of the
 * clone itself belongs to the backend, and is proven in
 * `backend.engineExecutor.test.ts` against a real `OciCliBackend`.
 */
function writeDetectableProject(hostPath: string): void {
  mkdirSync(hostPath, { recursive: true })
  writeFileSync(`${hostPath}/package.json`, JSON.stringify({ name: 'private-app' }))
}

/**
 * A private repository needs a credential; the Room record, manifest.yaml and the logs
 * must never contain one. These two facts are the whole contract of this feature.
 */
describe('private repository clone credentials', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const listeners: (() => void)[] = []

  afterEach(() => {
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
    backend.cloneToHostDirectoryHandler = (_gitUrl, hostPath) => writeDetectableProject(hostPath)
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
    // detection cloned the stripped URL, with the credential the URL carried
    expect(backend.planClones.at(-1)).toEqual({
      gitUrl: 'https://github.com/acme/private.git',
      credential: { username: 'octocat', secret }
    })
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
    expect(backend.planClones.at(-1)?.credential).toBeNull()
  })
})
