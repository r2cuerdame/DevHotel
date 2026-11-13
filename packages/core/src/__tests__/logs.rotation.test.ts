import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogLineEvent } from '../logs'
import { LogHub } from '../logs'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

// Keep real filesystem IO by default; inject Windows sharing violations
// without holding real handles open on the Host.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync)
  }
})

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

const ROOM = 'room1abc'
const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync)
  vi.mocked(readFileSync).mockReset().mockImplementation(actualFs.readFileSync as typeof readFileSync)
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code })
}

function hub(opts: { maxLogBytes?: number; rotateRetryMs?: number } = {}) {
  const userData = tempDir()
  dirs.push(userData)
  const logs = new LogHub(userData, new FakeBackend(), { maxLogBytes: 120, rotateRetryMs: 0, ...opts })
  const emitted: string[] = []
  logs.on('line', (event: LogLineEvent) => emitted.push(event.line))
  const file = logs.logFile(ROOM, 'orchestrator')
  const lines = (path: string): string[] =>
    existsSync(path) ? actualFs.readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
  // `orchestrator()` prefixes a timestamp; strip it to compare the message.
  const messages = (path: string): string[] => lines(path).map((l) => l.replace(/^\S+ /, ''))
  return { logs, emitted, file, messages }
}

/**
 * With the 24-character timestamp each logged line takes 35 bytes, so the
 * 120-byte cap is crossed by the fourth line and the fifth write rotates.
 */
function line(n: number): string {
  return `line-${String(n).padStart(4, '0')}`
}

describe('log rotation', () => {
  it('moves a full log to .1 and starts a new file, still emitting every line live', () => {
    const { logs, emitted, file, messages } = hub()
    for (let n = 1; n <= 5; n++) logs.orchestrator(ROOM, line(n))

    expect(messages(`${file}.1`)).toEqual([line(1), line(2), line(3), line(4)])
    expect(messages(file)).toEqual([line(5)])
    expect(emitted.map((l) => l.replace(/^\S+ /, ''))).toEqual([1, 2, 3, 4, 5].map(line))
  })

  it.each(['EBUSY', 'EPERM', 'EACCES'])(
    'keeps writing to the current file when the rotation fails with %s, then rotates once the lock is gone',
    (code) => {
      const { logs, emitted, file, messages } = hub()
      for (let n = 1; n <= 4; n++) logs.orchestrator(ROOM, line(n))

      vi.mocked(renameSync).mockImplementation(() => {
        throw fsError(code)
      })
      logs.orchestrator(ROOM, line(5))
      logs.orchestrator(ROOM, line(6))

      expect(messages(file)).toEqual([1, 2, 3, 4, 5, 6].map(line))
      expect(existsSync(`${file}.1`)).toBe(false)
      expect(emitted).toHaveLength(6)
      // Each later write tried the rotation again instead of giving up.
      expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(2)

      vi.mocked(renameSync).mockImplementation(actualFs.renameSync)
      logs.orchestrator(ROOM, line(7))

      expect(messages(`${file}.1`)).toEqual([1, 2, 3, 4, 5, 6].map(line))
      expect(messages(file)).toEqual([line(7)])
    }
  )

  it('waits out the retry interval after a failed rotation before trying again', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { logs, file, messages } = hub({ rotateRetryMs: 1000 })
      for (let n = 1; n <= 4; n++) logs.orchestrator(ROOM, line(n))
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw fsError('EBUSY')
      })
      logs.orchestrator(ROOM, line(5))
      logs.orchestrator(ROOM, line(6))
      expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1000)
      logs.orchestrator(ROOM, line(7))
      expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(2)
      expect(messages(file)).toEqual([line(7)])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('log tail across a rotation', () => {
  it('fills the requested lines from the end of .1, oldest first', () => {
    const { logs, file } = hub()
    for (let n = 1; n <= 6; n++) logs.orchestrator(ROOM, line(n))
    expect(existsSync(`${file}.1`)).toBe(true)

    const strip = (lines: string[]): string[] => lines.map((l) => l.replace(/^\S+ /, ''))
    expect(strip(logs.tail(ROOM, 'orchestrator', 3))).toEqual([line(4), line(5), line(6)])
    expect(strip(logs.tail(ROOM, 'orchestrator', 300))).toEqual([1, 2, 3, 4, 5, 6].map(line))
    // A current file with enough lines does not need .1 at all.
    expect(strip(logs.tail(ROOM, 'orchestrator', 2))).toEqual([line(5), line(6)])
  })

  it('redacts secrets in lines taken from .1', () => {
    const { logs, file } = hub({ maxLogBytes: 1 })
    logs.orchestrator(ROOM, 'first')
    logs.orchestrator(ROOM, 'second')
    // A line left in the rotated file by an older build.
    appendFileSync(`${file}.1`, 'pairing token: legacy-private-token\n', 'utf8')

    const tail = logs.tail(ROOM, 'orchestrator')
    expect(tail).toHaveLength(3)
    expect(tail.join('\n')).not.toContain('legacy-private-token')
  })

  it.each(['ENOENT', 'EBUSY'])('returns what it can read when a log fails with %s mid-read', (code) => {
    const { logs, file } = hub()
    for (let n = 1; n <= 6; n++) logs.orchestrator(ROOM, line(n))

    vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (String(path) === file) throw fsError(code)
      return (actualFs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof readFileSync)
    expect(logs.tail(ROOM, 'orchestrator').map((l) => l.replace(/^\S+ /, ''))).toEqual([1, 2, 3, 4].map(line))

    vi.mocked(readFileSync).mockImplementation(() => {
      throw fsError(code)
    })
    expect(logs.tail(ROOM, 'orchestrator')).toEqual([])
  })

  it('still builds the diagnostic report when the web log cannot be read', async () => {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const orch = new RoomOrchestrator({
      userData,
      backend: new FakeBackend(),
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
    const room = makeRoom({ id: 'diagroom1', domain: 'diagroom1.localhost', status: 'sleeping' })
    orch.rooms.create(room)
    orch.logs.orchestrator(room.id, 'created')
    const webLog = orch.logs.logFile(room.id, 'web')
    appendFileSync(`${webLog}.1`, 'earlier web output\n', 'utf8')
    appendFileSync(webLog, 'recent web output\n', 'utf8')

    vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (String(path) === webLog) throw fsError('EBUSY')
      return (actualFs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof readFileSync)

    const report = await orch.getDiagnostic(room.id)
    expect(report).toContain('earlier web output')
    expect(report).not.toContain('recent web output')
  })
})
