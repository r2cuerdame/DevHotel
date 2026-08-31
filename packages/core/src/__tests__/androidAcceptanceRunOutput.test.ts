import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AndroidAcceptanceIntegrity } from '../androidAcceptanceIntegrity'
import { RunOutputStore } from '../runOutput'
import { openDb, type Db } from '../store/db'

const ROOM_ID = 'aaaa1111'
let root: string
let db: Db

function retainedRun(runs: RunOutputStore, label: string) {
  const run = runs.begin(ROOM_ID, ['test-command', label], 'agent', { maxBytes: 256 })
  run.push('stdout', Array.from({ length: 500 }, (_, index) => `${label} ${index}\n`).join(''))
  const outcome = runs.complete(run, 0)
  expect(outcome.retained).toBe(true)
  return run.runId
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devhotel-acceptance-runs-'))
  db = openDb(join(root, 'db'))
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('acceptance retained-run evidence', () => {
  it('authenticates exact completed bytes without returning commands or raw log text', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const runs = new RunOutputStore(root, { acceptanceIntegrity: integrity })
    const runId = retainedRun(runs, 'sensitive-output')
    const reference = runs.retainedReference(ROOM_ID, runId, 4 * 1024 * 1024)

    expect(reference.runId).toBe(runId)
    expect(reference.identity).toMatchObject({ domain: 'retained-log', algorithm: 'hmac-sha256' })
    expect(JSON.stringify(reference)).not.toContain('test-command')
    expect(JSON.stringify(reference)).not.toContain('sensitive-output')
    expect(() => runs.verifyRetainedReference(ROOM_ID, reference, 4 * 1024 * 1024)).not.toThrow()

    const stdoutPath = join(runs.runDir(ROOM_ID, runId), 'stdout.log')
    const bytes = readFileSync(stdoutPath)
    bytes[0] = bytes[0] === 0x78 ? 0x79 : 0x78
    writeFileSync(stdoutPath, bytes)
    expect(() => runs.verifyRetainedReference(ROOM_ID, reference, 4 * 1024 * 1024))
      .toThrow(/no longer matches/)
  })

  it('keeps pinned runs while pruning unpinned runs under the ordinary retention budget', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const pinned = new Set<string>()
    const runs = new RunOutputStore(root, {
      maxRetainedRuns: 1,
      maxRetainedBytes: 1024 * 1024,
      acceptanceIntegrity: integrity,
      isPinned: (roomId, runId) => roomId === ROOM_ID && pinned.has(runId)
    })
    const first = retainedRun(runs, 'first')
    pinned.add(first)
    const second = retainedRun(runs, 'second')
    expect(existsSync(runs.runDir(ROOM_ID, first))).toBe(true)
    expect(existsSync(runs.runDir(ROOM_ID, second))).toBe(true)

    const third = retainedRun(runs, 'third')
    expect(existsSync(runs.runDir(ROOM_ID, first))).toBe(true)
    expect(existsSync(runs.runDir(ROOM_ID, second))).toBe(false)
    expect(existsSync(runs.runDir(ROOM_ID, third))).toBe(true)
  })

  it('fails pruning closed when pin lookup is unavailable', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const runs = new RunOutputStore(root, {
      maxRetainedRuns: 1,
      acceptanceIntegrity: integrity,
      isPinned: () => { throw new Error('database unavailable') }
    })
    const first = retainedRun(runs, 'first')
    const second = retainedRun(runs, 'second')
    expect(existsSync(runs.runDir(ROOM_ID, first))).toBe(true)
    expect(existsSync(runs.runDir(ROOM_ID, second))).toBe(true)
  })
})
