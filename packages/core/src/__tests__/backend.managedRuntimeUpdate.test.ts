import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_UPDATE_FILE,
  ManagedRuntimeUpdateLedger,
  isTerminalManagedRuntimeUpdateStage,
  type ManagedRuntimeUpdateJournal
} from '../backend/managedRuntimeUpdate'

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-update-ledger-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function ledger(root: string, installId = 'install-owned-1234'): ManagedRuntimeUpdateLedger {
  return new ManagedRuntimeUpdateLedger({ root, installId })
}

const plan = {
  runtimeId: 'runtime-owned',
  fromVersion: '0.1.0',
  toVersion: '0.2.0',
  fromArtifactDigests: { 'alpine-iso': 'a'.repeat(64) }
}

async function journalFile(root: string): Promise<string> {
  return await readFile(path.join(root, MANAGED_RUNTIME_UPDATE_FILE), 'utf8')
}

describe('ManagedRuntimeUpdateLedger', () => {
  it('records an update before anything on the Host is touched, and reads it back after a restart', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)

    expect(opened).toMatchObject({ stage: 'staging', attempts: 1, fromVersion: '0.1.0', toVersion: '0.2.0' })
    // A different process, which is what the next launch actually is.
    const reread = await ledger(root).read()
    expect(reread).toMatchObject({ updateId: opened.updateId, stage: 'staging' })
    expect(reread?.fromArtifactDigests).toEqual(plan.fromArtifactDigests)
  })

  it('counts attempts when the same update is re-opened instead of starting over', async () => {
    const root = await tempDir()
    const first = await ledger(root).begin(plan)
    await ledger(root).advance(first.updateId, 'applying')

    const second = await ledger(root).begin(plan)

    // Same update, one more attempt: a Host that keeps dying accumulates
    // evidence rather than an endless series of fresh-looking first tries.
    expect(second.updateId).toBe(first.updateId)
    expect(second.attempts).toBe(2)
    expect(second.stage).toBe('staging')
  })

  it('refuses a second, different update while one is still in flight', async () => {
    const root = await tempDir()
    await ledger(root).begin(plan)

    await expect(ledger(root).begin({ ...plan, toVersion: '0.3.0' })).rejects.toThrow(
      'Managed runtime already has a different update in flight'
    )
  })

  it('walks only the stages an update can actually reach', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)

    // Nothing may jump the health proof: committing straight out of an apply
    // would be the ledger agreeing a runtime is good because it exists.
    await expect(ledger(root).advance(opened.updateId, 'committed')).rejects.toThrow(
      'Managed runtime update cannot move from staging to committed'
    )
    await ledger(root).advance(opened.updateId, 'applying')
    await ledger(root).advance(opened.updateId, 'verifying')
    const committed = await ledger(root).advance(opened.updateId, 'committed')
    expect(committed.stage).toBe('committed')
    await expect(ledger(root).advance(opened.updateId, 'rolling-back')).rejects.toThrow(
      'Managed runtime update cannot move from committed to rolling-back'
    )
  })

  it('keeps a rolled-back update on disk and clears only a committed one', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)
    await ledger(root).advance(opened.updateId, 'applying')
    await ledger(root).advance(opened.updateId, 'rolling-back')
    const rolledBack = await ledger(root).fail(opened.updateId, 'rolled-back', 'guest never became healthy')

    expect(rolledBack).toMatchObject({ stage: 'rolled-back', failure: 'guest never became healthy' })
    // The barrier is the point: without it the next launch walks straight back
    // into the update that just cost the user a working runtime.
    await expect(ledger(root).clear(opened.updateId)).rejects.toThrow('Managed runtime update is not committed')
    expect(existsSync(path.join(root, MANAGED_RUNTIME_UPDATE_FILE))).toBe(true)
    expect(isTerminalManagedRuntimeUpdateStage(rolledBack.stage)).toBe(true)
  })

  it('forgets a committed update so a later one starts clean', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)
    await ledger(root).advance(opened.updateId, 'applying')
    await ledger(root).advance(opened.updateId, 'verifying')
    await ledger(root).advance(opened.updateId, 'committed')

    await ledger(root).clear(opened.updateId)

    expect(await ledger(root).read()).toBeNull()
  })

  it('never resumes an update another installation opened', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)

    // Same data directory, different install identity: the "previous version"
    // this names is a runtime this install never had.
    await expect(ledger(root, 'install-somebody-else').read()).rejects.toThrow(
      'Managed runtime update journal belongs to another installation'
    )
    expect(opened.installId).toBe('install-owned-1234')
  })

  it('rejects a journal whose contents were edited underneath it', async () => {
    const root = await tempDir()
    const opened = await ledger(root).begin(plan)
    const tampered: Record<string, unknown> = {
      ...(JSON.parse(await journalFile(root)) as ManagedRuntimeUpdateJournal),
      fromArtifactDigests: { 'alpine-iso': 'not-a-digest' }
    }
    await writeFile(path.join(root, MANAGED_RUNTIME_UPDATE_FILE), JSON.stringify(tampered), 'utf8')

    await expect(ledger(root).read()).rejects.toThrow('Managed runtime update journal is invalid')
    expect(opened.stage).toBe('staging')
  })

  it('refuses to open an update that changes nothing', async () => {
    const root = await tempDir()

    await expect(ledger(root).begin({ ...plan, toVersion: plan.fromVersion })).rejects.toThrow(
      'Managed runtime update has nothing to change'
    )
  })

  it('refuses to advance a journal that names a different update', async () => {
    const root = await tempDir()
    await ledger(root).begin(plan)

    await expect(ledger(root).advance('11111111-2222-4333-8444-555555555555', 'applying')).rejects.toThrow(
      'Managed runtime update identity changed'
    )
  })
})
