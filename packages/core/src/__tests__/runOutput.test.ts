import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutputWindow, RunOutputStore } from '../runOutput'
import { tempDir } from './fakes'

const roots: string[] = []

function store(opts?: {
  maxRetainedRuns?: number
  maxRetainedBytes?: number
  isPinned?: (roomId: string, runId: string) => boolean
  withRetentionTransaction?: <T>(run: () => T) => T
}): { store: RunOutputStore; userData: string } {
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
    expect(window.text().endsWith('line 999\n')).toBe(true)
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
    expect(window.text()).toBe('ERROR: boom\n')
    expect(report.filtered).toBe(true)
    expect(report.matchedLines).toBe(1)
    expect(report.lines).toBe(4)
    expect(window.withheld).toBe(true)
  })

  it('matches case-insensitively when asked', () => {
    const window = new OutputWindow({ maxBytes: 4096, include: 'error', ignoreCase: true })
    window.push('ER')
    window.push('ROR: boom\nfine\n')
    window.end()
    expect(window.text()).toBe('ERROR: boom\n')
  })

  it('slices a single line that is larger than the whole budget instead of dropping it', () => {
    const window = new OutputWindow({ maxBytes: 300 })
    window.push('x'.repeat(5000) + 'TAIL\n')
    window.end()

    expect(window.text().endsWith('TAIL\n')).toBe(true)
    expect(window.report().returnedBytes).toBeLessThanOrEqual(300)
    expect(window.report().truncated).toBe(true)
  })

  it('rejects budgets and filters it cannot honour', () => {
    expect(() => new OutputWindow({ maxBytes: 1 })).toThrow(/maxBytes/)
    expect(() => new OutputWindow({ maxBytes: 40_000_000 })).toThrow(/maxBytes/)
    expect(() => new OutputWindow({ maxLines: 1_000_001 })).toThrow(/maxLines/)
    expect(() => new OutputWindow({ include: 'x'.repeat(500) })).toThrow(/longer than/)
  })

  it('preserves CRLF, final newlines, newline-only output and exact accounting', () => {
    const raw = Buffer.from('\r\nalpha\r\nbeta\nlast\r\n')
    const window = new OutputWindow({ maxBytes: 4096 })
    window.push(raw.subarray(0, 1))
    window.push(raw.subarray(1, 9))
    window.push(raw.subarray(9))
    window.end()

    expect(Buffer.from(window.text())).toEqual(raw)
    expect(window.report()).toMatchObject({
      bytes: raw.length,
      lines: 4,
      returnedBytes: raw.length,
      returnedLines: 4,
      truncated: false
    })

    const newlineOnly = new OutputWindow({ maxBytes: 256 })
    newlineOnly.push('\n')
    newlineOnly.end()
    expect(newlineOnly.text()).toBe('\n')
    expect(newlineOnly.report()).toMatchObject({ bytes: 1, lines: 1, returnedBytes: 1, returnedLines: 1 })
  })

  it('keeps memory bounded for an arbitrarily large unterminated line', () => {
    const window = new OutputWindow({ maxBytes: 256 })
    const chunk = Buffer.alloc(64 * 1024, 0x78)
    for (let index = 0; index < 1024; index++) {
      window.push(chunk)
      expect(window.bufferedBytes).toBeLessThanOrEqual(256)
    }
    window.push('TAIL')
    window.end()

    expect(window.report()).toMatchObject({ bytes: 64 * 1024 * 1024 + 4, lines: 1, returnedBytes: 256, truncated: true })
    expect(window.text().endsWith('TAIL')).toBe(true)
    expect(window.bufferedBytes).toBeLessThanOrEqual(256)
  })

  it('treats regex metacharacters literally with linear streaming matching', () => {
    const window = new OutputWindow({ maxBytes: 4096, include: '(a+)+$' })
    window.push(`${'a'.repeat(1_000_000)}!\n(a+)+$ is literal\n`)
    window.end()

    expect(window.text()).toBe('(a+)+$ is literal\n')
    expect(window.report()).toMatchObject({ lines: 2, matchedLines: 1, filtered: true })
  })

  it('accounts for callers that feed an already separated line', () => {
    const window = new OutputWindow({ maxBytes: 256 })
    expect(window.pushLine('abc')).toEqual({ kept: true })
    expect(window.text()).toBe('abc')
    expect(window.report()).toMatchObject({ bytes: 3, lines: 1, returnedBytes: 3, returnedLines: 1 })
  })

  it('uses fixed storage even for a million newline-only records', () => {
    const window = new OutputWindow({ maxBytes: 4096 })
    window.push('\n'.repeat(1_000_000))
    window.end()

    expect(window.text()).toBe('\n'.repeat(4096))
    expect(window.bufferedBytes).toBeLessThanOrEqual(4096)
    expect(window.report()).toMatchObject({
      bytes: 1_000_000,
      lines: 1_000_000,
      returnedBytes: 4096,
      returnedLines: 4096,
      truncated: true
    })
  })
})

describe('RunOutputStore', () => {
  it('keeps no artifact when the response already carried everything', () => {
    const { store: runs, userData } = store()
    const run = runs.begin('room1abc', ['echo', 'hi'], 'agent')
    run.push('stdout', 'hi\n')
    const outcome = runs.complete(run, 0)

    expect(outcome.retained).toBe(false)
    expect(outcome.stdout.text).toBe('hi\n')
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

    const joined = seen.join('')
    expect(joined).toBe(logLines(5000))
    expect(joined.split('\n').filter(Boolean)).toHaveLength(5000)
    expect(joined.startsWith('line 0\n')).toBe(true)
    expect(joined.endsWith('line 4999\n')).toBe(true)
  })

  it('finds a line the bounded response dropped, without a shell pipeline', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['gradlew', 'assembleDebug'], 'agent', { maxBytes: 512 })
    run.push('stdout', logLines(2000))
    run.push('stdout', 'FAILURE: needle in the middle\n')
    run.push('stdout', logLines(2000, 'after'))
    runs.complete(run, 1)

    const read = runs.read('room1abc', run.runId, { include: 'needle', maxBytes: 4096 })
    expect(read.text).toBe('FAILURE: needle in the middle\n')
    expect(read.matchedLines).toBe(1)
    expect(read.scannedLines).toBe(4001)
    expect(read.eof).toBe(true)
  })

  it('pages filtered matches without duplicating or skipping line terminators', () => {
    const { store: runs } = store()
    const raw = Array.from({ length: 2000 }, (_, index) =>
      index % 7 === 0 ? `MATCH ${index}\r\n` : `noise ${index}\n`
    ).join('')
    const expected = raw.split(/(?<=\n)/).filter((line) => line.includes('MATCH')).join('')
    const run = runs.begin('room1abc', ['scan'], 'agent', { maxBytes: 256 })
    run.push('stdout', raw)
    runs.complete(run, 0)

    const pages: string[] = []
    let offset = 0
    for (let page = 0; page < 100; page++) {
      const read = runs.read('room1abc', run.runId, {
        include: 'MATCH',
        mode: 'head',
        maxBytes: 256,
        offsetBytes: offset
      })
      pages.push(read.text)
      if (read.eof) break
      expect(read.nextOffset).toBeGreaterThan(offset)
      offset = read.nextOffset
    }

    expect(pages.join('')).toBe(expected)
  })

  it('does not advance a live filtered read past an unfinished possible match', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['live-filter'], 'agent', { maxBytes: 256 })
    run.push('stdout', 'ERR')

    const pending = runs.read('room1abc', run.runId, { include: 'ERROR', maxBytes: 256 })
    expect(pending).toMatchObject({ text: '', nextOffset: 0, eof: false, status: 'running' })

    run.push('stdout', 'OR\n')
    const matched = runs.read('room1abc', run.runId, { include: 'ERROR', maxBytes: 256 })
    expect(matched).toMatchObject({ text: 'ERROR\n', nextOffset: 6, eof: true, matchedLines: 1 })
    runs.complete(run, 0)
  })

  it('pages every byte of a filtered matching line larger than one page', () => {
    const { store: runs } = store()
    const raw = `NEEDLE${'.'.repeat(600)}\n`
    const run = runs.begin('room1abc', ['long-match'], 'agent', { maxBytes: 256 })
    run.push('stdout', raw)
    runs.complete(run, 0)

    const pages: string[] = []
    let offset = 0
    for (let page = 0; page < 10; page++) {
      const read = runs.read('room1abc', run.runId, {
        include: 'NEEDLE',
        maxBytes: 256,
        offsetBytes: offset
      })
      pages.push(read.text)
      if (read.eof) break
      expect(read.nextOffset).toBeGreaterThan(offset)
      offset = read.nextOffset
    }

    expect(pages.join('')).toBe(raw)
  })

  it('re-evaluates the full line when a filtered read starts at an arbitrary mid-line offset', () => {
    const { store: runs } = store()
    const raw = `NEEDLE blocked ${'.'.repeat(600)}\n`
    const run = runs.begin('room1abc', ['filtered-offset'], 'agent', { maxBytes: 256 })
    run.push('stdout', raw)
    runs.complete(run, 0)

    const read = runs.read('room1abc', run.runId, {
      include: 'NEEDLE',
      exclude: 'blocked',
      offsetBytes: 256,
      maxBytes: 256
    })
    expect(read).toMatchObject({ text: '', nextOffset: Buffer.byteLength(raw), eof: true, matchedLines: 0 })
  })

  it('does not split valid UTF-8 code points across text pages', () => {
    const { store: runs } = store()
    const raw = 'é'.repeat(300)
    const run = runs.begin('room1abc', ['unicode'], 'agent', { maxBytes: 256 })
    run.push('stdout', raw)
    runs.complete(run, 0)

    const pages: string[] = []
    let offset = 0
    for (let page = 0; page < 10; page++) {
      const read = runs.read('room1abc', run.runId, { maxBytes: 257, offsetBytes: offset })
      pages.push(read.text)
      expect(read.text).not.toContain('\ufffd')
      if (read.eof) break
      expect(read.nextOffset).toBeGreaterThan(offset)
      offset = read.nextOffset
    }

    expect(pages.join('')).toBe(raw)
    expect(Buffer.byteLength(pages.join(''))).toBe(600)
  })

  it('bounds synchronous filter scans and directs oversized logical lines to raw paging', () => {
    const { store: runs } = store()
    const raw = Buffer.alloc(5 * 1024 * 1024, 0x78)
    const run = runs.begin('room1abc', ['one-giant-line'], 'agent', { maxBytes: 256 })
    run.push('stdout', raw)
    runs.complete(run, 0)

    const page = runs.read('room1abc', run.runId, { maxBytes: 256 })
    expect(page).toMatchObject({ text: 'x'.repeat(256), nextOffset: 256, eof: false })
    expect(page.scannedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(() => runs.read('room1abc', run.runId, { include: 'x', maxBytes: 256 })).toThrow(
      /logical lines no longer than 4194304 bytes/
    )
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

    const out = runs.read('room1abc', run.runId, { stream: 'stdout', include: 'out 2999', maxBytes: 4096 })
    const err = runs.read('room1abc', run.runId, { stream: 'stderr', include: 'err 2999', maxBytes: 4096 })
    expect(out.text).toBe('out 2999\n')
    expect(err.text).toBe('err 2999\n')
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
    expect(read.text).toBe('progress 99\n')

    runs.complete(run, 0)
  })

  it('pages an unterminated live line byte-exactly as it grows', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['progress'], 'agent', { maxBytes: 256 })
    let offset = 0
    let seen = ''
    for (const chunk of ['progress ', '50%\r', '\n']) {
      run.push('stdout', chunk)
      const read = runs.read('room1abc', run.runId, { mode: 'head', maxBytes: 256, offsetBytes: offset })
      expect(read.status).toBe('running')
      seen += read.text
      offset = read.nextOffset
    }

    expect(seen).toBe('progress 50%\r\n')
    expect(runs.list('room1abc')[0]?.stdout).toMatchObject({ bytes: 14, lines: 1 })
    runs.complete(run, 0)
  })

  it('rewinds an active UTF-8 read when a code point is split across producer chunks', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['utf8-progress'], 'agent', { maxBytes: 256 })
    run.push('stdout', Buffer.from([0xc3]))

    const pending = runs.read('room1abc', run.runId, { maxBytes: 256 })
    expect(pending).toMatchObject({
      text: '',
      returnedBytes: 0,
      nextOffset: 0,
      eof: false,
      status: 'running'
    })

    run.push('stdout', Buffer.from([0xa9, 0x0a]))
    const complete = runs.read('room1abc', run.runId, { maxBytes: 256, offsetBytes: pending.nextOffset })
    expect(complete).toMatchObject({ text: 'é\n', returnedBytes: 3, nextOffset: 3, eof: true })
    runs.complete(run, 0)
  })

  it('rewinds an active UTF-8 tail read before an incomplete trailing code point', () => {
    const { store: runs } = store()
    const run = runs.begin('room1abc', ['utf8-tail'], 'agent', { maxBytes: 256 })
    run.push('stdout', Buffer.from([0x61, 0xc3]))

    const pending = runs.read('room1abc', run.runId, { mode: 'tail', maxBytes: 256 })
    expect(pending).toMatchObject({ text: 'a', returnedBytes: 1, nextOffset: 1, eof: false, truncated: true })

    run.push('stdout', Buffer.from([0xa9, 0x0a]))
    const complete = runs.read('room1abc', run.runId, {
      mode: 'tail',
      maxBytes: 256,
      offsetBytes: pending.nextOffset
    })
    expect(complete).toMatchObject({ text: 'é\n', returnedBytes: 3, nextOffset: 4, eof: true })
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

  it('never prunes the just-finished run even when it alone exceeds the byte budget', () => {
    const { store: runs, userData } = store({ maxRetainedBytes: 512 })
    const completed: string[] = []
    for (let index = 0; index < 2; index++) {
      const run = runs.begin('room1abc', ['echo', String(index)], 'agent', { maxBytes: 256 })
      run.push('stdout', logLines(1000, `oversize${index}`))
      const outcome = runs.complete(run, 0)
      expect(outcome.retained).toBe(true)
      expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', run.runId, 'stdout.log'))).toBe(true)
      completed.push(run.runId)
    }

    expect(runs.list('room1abc').map((run) => run.runId)).toEqual([completed[1]])
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', completed[0] ?? ''))).toBe(false)
  })

  it('rechecks pins and removes an unpinned suffix inside one retention transaction', () => {
    let inTransaction = false
    let transactionCalls = 0
    const pinned = new Set<string>()
    const { store: runs, userData } = store({
      maxRetainedRuns: 1,
      isPinned: (_roomId, runId) => {
        expect(inTransaction).toBe(true)
        return pinned.has(runId)
      },
      withRetentionTransaction: (run) => {
        expect(inTransaction).toBe(false)
        transactionCalls += 1
        inTransaction = true
        try {
          return run()
        } finally {
          inTransaction = false
        }
      }
    })
    const first = runs.begin('room1abc', ['first'], 'agent', { maxBytes: 256 })
    first.push('stdout', Buffer.alloc(2048, 0x61))
    runs.complete(first, 0)
    pinned.add(first.runId)
    const second = runs.begin('room1abc', ['second'], 'agent', { maxBytes: 256 })
    second.push('stdout', Buffer.alloc(2048, 0x62))
    runs.complete(second, 0)

    expect(transactionCalls).toBe(2)
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', first.runId))).toBe(true)
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', second.runId))).toBe(true)
  })

  it('skips pruning safely when another process owns the retention transaction', () => {
    const { store: runs, userData } = store({
      maxRetainedRuns: 1,
      withRetentionTransaction: () => {
        throw new Error('SQLITE_BUSY: database is locked')
      }
    })
    const first = runs.begin('room1abc', ['first'], 'agent', { maxBytes: 256 })
    first.push('stdout', Buffer.alloc(2048, 0x61))
    expect(runs.complete(first, 0).retained).toBe(true)
    const second = runs.begin('room1abc', ['second'], 'agent', { maxBytes: 256 })
    second.push('stdout', Buffer.alloc(2048, 0x62))

    expect(() => runs.complete(second, 0)).not.toThrow()
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', first.runId))).toBe(true)
    expect(existsSync(join(userData, 'rooms', 'room1abc', 'runs', second.runId))).toBe(true)
  })

  it('prunes one oldest-first suffix instead of filling byte-budget holes with older runs', () => {
    const { store: runs } = store({ maxRetainedBytes: 1800 })
    const ids: string[] = []
    for (const size of [300, 900, 1000]) {
      const run = runs.begin('room1abc', ['bytes', String(size)], 'agent', { maxBytes: 256 })
      run.push('stdout', Buffer.alloc(size, 0x78))
      runs.complete(run, 0)
      ids.push(run.runId)
    }

    expect(runs.list('room1abc').map((run) => run.runId)).toEqual([ids[2]])
  })

  it('deletes retained logs whose manifest is corrupt or structurally invalid', () => {
    const { store: runs, userData } = store()
    const run = runs.begin('room1abc', ['corrupt-manifest'], 'agent', { maxBytes: 256 })
    run.push('stdout', Buffer.alloc(4096, 0x78))
    runs.complete(run, 0)
    const directory = join(userData, 'rooms', 'room1abc', 'runs', run.runId)

    writeFileSync(join(directory, 'run.json'), JSON.stringify({ runId: run.runId, startedAt: 7 }))
    expect(runs.list('room1abc')).toEqual([])
    runs.prune('room1abc')
    expect(existsSync(directory)).toBe(false)
  })

  it('retains exact raw bytes even when the bounded text contains binary and no newline', () => {
    const { store: runs, userData } = store()
    const run = runs.begin('room1abc', ['binary-producer'], 'agent', { maxBytes: 256 })
    const raw = Buffer.concat([Buffer.from([0x00, 0xff, 0x0d, 0x0a]), Buffer.alloc(4096, 0x7f), Buffer.from([0xfe])])
    run.push('stdout', raw.subarray(0, 3))
    run.push('stdout', raw.subarray(3))
    const outcome = runs.complete(run, 0)

    expect(outcome.retained).toBe(true)
    expect(outcome.stdout.report.bytes).toBe(raw.length)
    expect(readFileSync(join(userData, 'rooms', 'room1abc', 'runs', run.runId, 'stdout.log'))).toEqual(raw)

    const pages: Buffer[] = []
    let offset = 0
    for (let page = 0; page < 32; page++) {
      const read = runs.read('room1abc', run.runId, { encoding: 'base64', maxBytes: 257, offsetBytes: offset })
      expect(read.text).toBe('')
      expect(read.encoding).toBe('base64')
      pages.push(Buffer.from(read.contentBase64 ?? '', 'base64'))
      if (read.eof) break
      expect(read.nextOffset).toBeGreaterThan(offset)
      offset = read.nextOffset
    }
    expect(Buffer.concat(pages)).toEqual(raw)

    const tail = runs.read('room1abc', run.runId, { encoding: 'base64', mode: 'tail', maxBytes: 256 })
    expect(Buffer.from(tail.contentBase64 ?? '', 'base64')).toEqual(raw.subarray(raw.length - 256))
    expect(tail).toMatchObject({
      bytes: raw.length,
      returnedBytes: 256,
      nextOffset: raw.length,
      eof: true,
      truncated: true
    })
  })
})
