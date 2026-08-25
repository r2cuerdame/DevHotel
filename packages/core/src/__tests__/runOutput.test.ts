import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutputWindow, RunOutputStore } from '../runOutput'
import { tempDir } from './fakes'

const roots: string[] = []

function store(opts?: { maxRetainedRuns?: number; maxRetainedBytes?: number }): { store: RunOutputStore; userData: string } {
  const userData = tempDir()
  roots.push(userData)
  return { store: new RunOutputStore(userData, opts), userData }
}

/** Deterministic, addressable log lines: line 0 … line n-1. */
function logLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OutputWindow', () => {
  it('keeps the tail and still reports what the command actually produced', () => {
    const window = new OutputWindow({ maxBytes: 256 })
    window.push(logLines(1000))
    window.end()

    const report = window.report()
    expect(report.lines).toBe(1000)
    expect(report.bytes).toBeGreaterThan(8000)
    expect(report.truncated).toBe(true)
    expect(report.returnedBytes).toBeLessThanOrEqual(256)
    expect(window.text().endsWith('line 999')).toBe(true)
    expect(window.text()).not.toContain('line 0\n')
  })

  it('keeps the head when asked, and stops accepting once full', () => {
    const window = new OutputWindow({ maxBytes: 256, mode: 'head' })
    window.push(logLines(1000))
    window.end()

    expect(window.text().startsWith('line 0\nline 1\n')).toBe(true)
    expect(window.full).toBe(true)
    expect(window.report().truncated).toBe(true)
    expect(window.report().lines).toBe(1000)
  })

  it('survives chunk boundaries that split a line', () => {
    const window = new OutputWindow({ maxBytes: 4096 })
    window.push('hello ')
    window.push('world\nsecond')
    window.push(' line')
    window.end()

    expect(window.text()).toBe('hello world\nsecond line')
    expect(window.report().lines).toBe(2)
  })

  it('filters server-side and counts what matched', () => {
    const window = new OutputWindow({ maxBytes: 4096, include: 'ERROR', exclude: 'ignorable' })
    window.push('info: starting\nERROR: boom\nERROR: ignorable\ninfo: done\n')
    window.end()

    const report = window.report()
    expect(window.text()).toBe('ERROR: boom')
    expect(report.filtered).toBe(true)
    expect(report.matchedLines).toBe(1)
    expect(report.lines).toBe(4)
    expect(window.withheld).toBe(true)
  })

  it('matches case-insensitively when asked', () => {
    const window = new OutputWindow({ maxBytes: 4096, include: 'error', ignoreCase: true })
    window.push('ERROR: boom\nfine\n')
    window.end()
    expect(window.text()).toBe('ERROR: boom')
  })

  it('slices a single line that is larger than the whole budget instead of dropping it', () => {
    const window = new OutputWindow({ maxBytes: 300 })
    window.push('x'.repeat(5000) + 'TAIL\n')
    window.end()

    expect(window.text().endsWith('TAIL')).toBe(true)
    expect(window.report().returnedBytes).toBeLessThanOrEqual(300)
    expect(window.report().truncated).toBe(true)
  })

  it('rejects budgets and filters it cannot honour', () => {
    expect(() => new OutputWindow({ maxBytes: 1 })).toThrow(/maxBytes/)
    expect(() => new OutputWindow({ maxBytes: 40_000_000 })).toThrow(/maxBytes/)
    expect(() => new OutputWindow({ include: '(' })).toThrow(/valid regular expression/)
    expect(() => new OutputWindow({ include: 'x'.repeat(500) })).toThrow(/longer than/)
  })
})

describe('RunOutputStore', () => {
  it('keeps no artifact when the response already carried everything', () => {
    const { store: runs, userData } = store()
    const run = runs.begin('room1abc', ['echo', 'hi'], 'agent')
    run.push('stdout', 'hi\n')
    const outcome = runs.complete(run, 0)

    expect(outcome.retained).toBe(false)
    expect(outcome.stdout.text).toBe('hi')
    expect(outcome.notes).toEqual([])
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', run.runId))).toBe(false)
    expect(runs.list('room1abc')).toEqual([])
  })

  it('retains the complete raw output when the response is bounded, and says so', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['adb', 'logcat', '-d'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(5000))
    const outcome = runs.complete(run, 0)

    expect(outcome.retained).toBe(true)
    expect(outcome.stdout.report.truncated).toBe(true)
    expect(outcome.stdout.report.retained).toBe(true)
    expect(outcome.stdout.report.lines).toBe(5000)
    expect(outcome.notes.join(' ')).toContain(`run ${run.runId}`)
    expect(outcome.notes.join(' ')).toMatch(/returned \d+ of \d+ bytes/)

    const listed = runs.list('room1abc')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.runId).toBe(run.runId)
    expect(listed[0]?.status).toBe('exited')
    expect(listed[0]?.stdout.lines).toBe(5000)
  })

  it('reads a bounded run back in full by paging with nextOffset', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['cat', 'huge.xml'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(5000))
    runs.complete(run, 0)

    const seen: string[] = []
    let offset = 0
    for (let page = 0; page < 200; page++) {
      const read = runs.read('room1abc', run.runId, { offsetBytes: offset, maxBytes: 4096, mode: 'head' })
      if (read.text.length > 0) seen.push(read.text)
      if (read.eof) break
      expect(read.nextOffset).toBeGreaterThan(offset)
      offset = read.nextOffset
    }

    const joined = seen.join('\n')
    expect(joined.split('\n')).toHaveLength(5000)
    expect(joined.startsWith('line 0\n')).toBe(true)
    expect(joined.endsWith('line 4999')).toBe(true)
  })

  it('finds a line the bounded response dropped, without a shell pipeline', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['gradlew', 'assembleDebug'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(2000))
    run.push('stdout', 'FAILURE: needle in the middle\n')
    run.push('stdout', logLines(2000, 'after'))
    runs.complete(run, 1)

    const read = runs.read('room1abc', run.runId, { include: 'needle', maxBytes: 4096 })
    expect(read.text).toBe('FAILURE: needle in the middle')
    expect(read.matchedLines).toBe(1)
    expect(read.scannedLines).toBe(4001)
    expect(read.eof).toBe(true)
  })

  it('retains stdout and stderr independently for a mixed-stream command', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['sh', '-lc', 'build'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(3000, 'out'))
    run.push('stderr', logLines(3000, 'err'))
    const outcome = runs.complete(run, 2)

    expect(outcome.stdout.report.retained).toBe(true)
    expect(outcome.stderr.report.retained).toBe(true)
    expect(outcome.notes).toHaveLength(2)

    const out = runs.read('room1abc', run.runId, { stream: 'stdout', include: '^out 2999$', maxBytes: 4096 })
    const err = runs.read('room1abc', run.runId, { stream: 'stderr', include: '^err 2999$', maxBytes: 4096 })
    expect(out.text).toBe('out 2999')
    expect(err.text).toBe('err 2999')
  })

  it('exposes a running command and its output before it exits', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['gradlew', 'test'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(100, 'progress'))

    const listed = runs.list('room1abc')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status).toBe('running')
    expect(listed[0]?.stdout.lines).toBe(100)

    const read = runs.read('room1abc', run.runId, { include: 'progress 99', maxBytes: 4096 })
    expect(read.status).toBe('running')
    expect(read.text).toBe('progress 99')

    runs.complete(run, 0)
  })

  it('refuses to invent output for a run the Room does not have', () => {
    const { store: runs } = store()
    expect(() => runs.read('room1abc', '11111111-2222-3333-4444-555555555555')).toThrow(/no output is retained/)
    expect(() => runs.read('room1abc', 'not-a-uuid')).toThrow(/invalid run id/)
  })

  it('keeps Room storage bounded by dropping the oldest retained runs', () => {
    const { store: runs, userData } = store({ maxRetainedRuns: 3 })
    for (let i = 0; i < 5; i++) {
      const run = runs.begin('room1abc', ['echo', String(i)], 'agent', { maxBytes: 256 })
      run.push('stdout', logLines(200, `run${i}`))
      runs.complete(run, 0)
    }

    expect(readdirSync(join(userData, 'rooms', 'room1abc', 'runs'))).toHaveLength(3)
    expect(runs.list('room1abc')).toHaveLength(3)
  })
})
