import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Actor } from '@devhotel/shared'

/** Inline bytes returned per stream when the caller does not choose a budget. */
export const DEFAULT_OUTPUT_BYTES = 64_000
export const MIN_OUTPUT_BYTES = 256
export const MAX_OUTPUT_BYTES = 4_000_000
/** Filters are agent-supplied regular expressions: keep them small and cheap. */
export const MAX_FILTER_LENGTH = 200
/** A longer line is matched on its first bytes only, so one pathological line cannot stall a scan. */
const MATCH_LINE_CAP = 8_192
/** Whole-file scans stop rather than block the main process on a runaway pattern. */
const SCAN_TIME_BUDGET_MS = 15_000
const DEFAULT_RETAINED_RUNS = 20
const DEFAULT_RETAINED_BYTES = 256 * 1024 * 1024

export type OutputStreamName = 'stdout' | 'stderr'
export type OutputMode = 'head' | 'tail'

export interface OutputSelection {
  /** Inline budget for this stream, in bytes. */
  maxBytes?: number
  maxLines?: number
  /** Which end of the output to keep when it does not fit — defaults to the tail. */
  mode?: OutputMode
  /** Keep only lines matching this regular expression. */
  include?: string
  /** Drop lines matching this regular expression. */
  exclude?: string
  ignoreCase?: boolean
}

export interface StreamReport {
  /** Raw bytes the command wrote to this stream. */
  bytes: number
  /** Raw lines the command wrote to this stream. */
  lines: number
  returnedBytes: number
  returnedLines: number
  /** Lines kept by the filter; present only when a filter was applied. */
  matchedLines?: number
  /** Content the command produced is not in the returned text. */
  truncated: boolean
  /** A filter was applied, so the returned text is a selection rather than a prefix/suffix. */
  filtered: boolean
  /** The complete raw stream is retained and readable by run id. */
  retained: boolean
}

/**
 * What the window did with one line. `partialBytes` means only that many bytes
 * of the line fit, which is what lets a reader resume mid-line instead of
 * skipping the rest of an oversized one.
 */
export interface LineFate {
  kept: boolean
  partialBytes?: number
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function sliceBytes(line: string, max: number, from: OutputMode): string {
  const buf = Buffer.from(line, 'utf8')
  if (buf.byteLength <= max) return line
  return from === 'head' ? buf.subarray(0, max).toString('utf8') : buf.subarray(buf.byteLength - max).toString('utf8')
}

function compileFilter(pattern: string | undefined, ignoreCase: boolean | undefined, label: string): RegExp | undefined {
  if (pattern === undefined || pattern === '') return undefined
  if (pattern.length > MAX_FILTER_LENGTH) {
    throw new Error(`${label} pattern is longer than ${MAX_FILTER_LENGTH} characters`)
  }
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (err) {
    throw new Error(`${label} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function normalizeSelection(selection: OutputSelection = {}): Required<Pick<OutputSelection, 'maxBytes' | 'mode'>> & OutputSelection {
  const requested = selection.maxBytes ?? DEFAULT_OUTPUT_BYTES
  if (!Number.isFinite(requested) || requested < MIN_OUTPUT_BYTES || requested > MAX_OUTPUT_BYTES) {
    throw new Error(`maxBytes must be between ${MIN_OUTPUT_BYTES} and ${MAX_OUTPUT_BYTES}`)
  }
  if (selection.maxLines !== undefined && (!Number.isInteger(selection.maxLines) || selection.maxLines < 1)) {
    throw new Error('maxLines must be a positive integer')
  }
  return { ...selection, maxBytes: Math.floor(requested), mode: selection.mode ?? 'tail' }
}

/**
 * A bounded view of one output stream. Lines are fed in as they arrive (or as
 * a retained file is scanned) and only the selected window is kept in memory,
 * so a gigabyte of logcat costs the configured budget and nothing more. Raw
 * byte/line counters keep running, which is what makes truncation reportable
 * instead of silent.
 */
export class OutputWindow {
  private readonly includeRe?: RegExp
  private readonly excludeRe?: RegExp
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly mode: OutputMode
  private readonly filtering: boolean
  private rest = ''
  private ended = false
  private kept: string[] = []
  private keptBytes = 0

  /** Raw bytes seen. */
  bytes = 0
  /** Raw lines seen. */
  lines = 0
  /** Lines that passed the filter. */
  matched = 0
  /** Lines the filter removed. */
  droppedByFilter = 0
  /** Matching content exists that the window does not contain. */
  truncated = false
  /** Head mode only: the window cannot accept more, so scanning may stop. */
  full = false

  constructor(selection: OutputSelection = {}) {
    const normalized = normalizeSelection(selection)
    this.maxBytes = normalized.maxBytes
    this.maxLines = normalized.maxLines ?? Number.MAX_SAFE_INTEGER
    this.mode = normalized.mode
    this.includeRe = compileFilter(selection.include, selection.ignoreCase, 'include')
    this.excludeRe = compileFilter(selection.exclude, selection.ignoreCase, 'exclude')
    this.filtering = this.includeRe !== undefined || this.excludeRe !== undefined
  }

  /** Feed raw output; partial lines are held until their newline arrives. */
  push(chunk: string): void {
    if (chunk.length === 0) return
    this.bytes += byteLength(chunk)
    const text = this.rest + chunk
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) break
      this.pushLine(text.slice(start, nl))
      start = nl + 1
    }
    this.rest = text.slice(start)
  }

  /** Feed one complete line. Reports whether — and how much of — it was kept. */
  pushLine(line: string): LineFate {
    this.lines++
    if (!this.matches(line)) {
      this.droppedByFilter++
      return { kept: false }
    }
    this.matched++
    if (this.full) {
      this.truncated = true
      return { kept: false }
    }
    return this.add(line)
  }

  /** Flush a trailing line that never got its newline. */
  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.rest.length > 0) this.pushLine(this.rest)
    this.rest = ''
  }

  text(): string {
    return this.kept.join('\n')
  }

  report(retained = false): StreamReport {
    const text = this.text()
    return {
      bytes: this.bytes,
      lines: this.lines,
      returnedBytes: byteLength(text),
      returnedLines: this.kept.length,
      ...(this.filtering ? { matchedLines: this.matched } : {}),
      truncated: this.truncated,
      filtered: this.filtering,
      retained
    }
  }

  /** Content the command produced is missing from the returned text. */
  get withheld(): boolean {
    return this.truncated || this.droppedByFilter > 0
  }

  private matches(line: string): boolean {
    if (!this.filtering) return true
    const probe = line.length > MATCH_LINE_CAP ? line.slice(0, MATCH_LINE_CAP) : line
    if (this.includeRe && !this.includeRe.test(probe)) return false
    if (this.excludeRe && this.excludeRe.test(probe)) return false
    return true
  }

  private add(line: string): LineFate {
    this.kept.push(line)
    this.keptBytes += byteLength(line) + 1
    if (this.mode === 'head') {
      if (this.keptBytes <= this.maxBytes && this.kept.length <= this.maxLines) return { kept: true }
      this.full = true
      this.truncated = true
      if (this.kept.length > 1) {
        const dropped = this.kept.pop()
        this.keptBytes -= byteLength(dropped ?? '') + 1
        return { kept: false }
      }
      // One line alone is over budget: return the part that fits and let the
      // reader resume inside the line rather than losing its remainder.
      const only = sliceBytes(line, this.maxBytes, 'head')
      this.kept = [only]
      this.keptBytes = byteLength(only)
      return { kept: true, partialBytes: this.keptBytes }
    }
    while (this.kept.length > 1 && (this.keptBytes > this.maxBytes || this.kept.length > this.maxLines)) {
      const dropped = this.kept.shift()
      this.keptBytes -= byteLength(dropped ?? '') + 1
      this.truncated = true
    }
    if (this.kept.length === 1 && this.keptBytes > this.maxBytes) {
      const only = sliceBytes(this.kept[0] ?? '', this.maxBytes, 'tail')
      if (only !== this.kept[0]) this.truncated = true
      this.kept = [only]
      this.keptBytes = byteLength(only)
    }
    return { kept: true }
  }
}

/**
 * One stream of one run: the window the caller gets back, plus the complete
 * raw copy on disk. The file is opened on the first byte, so commands that say
 * nothing (UI nav taps, probes) never touch storage, and it is deleted again
 * unless something was actually withheld from the response.
 */
class RunSink {
  readonly window: OutputWindow
  private fd: number | null = null
  private writeError: Error | null = null
  retained = false

  constructor(private readonly file: string, selection: OutputSelection) {
    this.window = new OutputWindow(selection)
  }

  push(chunk: string): void {
    if (chunk.length === 0) return
    this.window.push(chunk)
    // Once retention has failed the window keeps working; retrying the write
    // per chunk would only repeat the same error.
    if (this.writeError) return
    if (this.fd === null) this.open()
    if (this.fd === null) return
    try {
      // Written synchronously so a still-running command is readable *now*:
      // a buffered stream would leave a live tail several chunks behind.
      writeSync(this.fd, chunk, null, 'utf8')
    } catch (err) {
      this.writeError = err instanceof Error ? err : new Error(String(err))
    }
  }

  finish(): { retained: boolean; error: string | null } {
    this.window.end()
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // The data is already on the file; a close error changes nothing.
      }
      this.fd = null
    }
    if (this.writeError) {
      rmSync(this.file, { force: true })
      return { retained: false, error: this.writeError.message }
    }
    if (!this.window.bytes) return { retained: false, error: null }
    // Nothing was held back: the caller already has every byte, so keeping a
    // second copy would only grow Hotel storage.
    if (!this.window.withheld) {
      rmSync(this.file, { force: true })
      return { retained: false, error: null }
    }
    this.retained = true
    return { retained: true, error: null }
  }

  private open(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      this.fd = openSync(this.file, 'w')
    } catch (err) {
      // Retention must never take the command (or the app) down with it.
      this.writeError = err instanceof Error ? err : new Error(String(err))
    }
  }
}

export interface RunSummary {
  runId: string
  roomId: string
  cmd: string[]
  actor: Actor
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'exited'
  code: number | null
  stdout: { bytes: number; lines: number; retained: boolean }
  stderr: { bytes: number; lines: number; retained: boolean }
}

export interface RunOutcome {
  runId: string
  stdout: { text: string; report: StreamReport }
  stderr: { text: string; report: StreamReport }
  retained: boolean
  notes: string[]
}

/** One command whose output is being produced right now. */
export class ActiveRun {
  private readonly sinks: Record<OutputStreamName, RunSink>
  private finished = false

  constructor(
    readonly runId: string,
    readonly roomId: string,
    readonly cmd: string[],
    readonly actor: Actor,
    readonly startedAt: string,
    private readonly dir: string,
    selection: OutputSelection
  ) {
    this.sinks = {
      stdout: new RunSink(join(dir, 'stdout.log'), selection),
      stderr: new RunSink(join(dir, 'stderr.log'), selection)
    }
  }

  push(stream: OutputStreamName, chunk: string): void {
    if (this.finished) return
    this.sinks[stream].push(chunk)
  }

  summary(): RunSummary {
    return {
      runId: this.runId,
      roomId: this.roomId,
      cmd: this.cmd,
      actor: this.actor,
      startedAt: this.startedAt,
      finishedAt: null,
      status: 'running',
      code: null,
      stdout: streamSummary(this.sinks.stdout),
      stderr: streamSummary(this.sinks.stderr)
    }
  }

  finish(code: number): { outcome: RunOutcome; summary: RunSummary } {
    this.finished = true
    const stdout = this.sinks.stdout.finish()
    const stderr = this.sinks.stderr.finish()
    const notes: string[] = []
    if (stdout.error) notes.push(`stdout could not be retained: ${stdout.error}`)
    if (stderr.error) notes.push(`stderr could not be retained: ${stderr.error}`)
    const retained = stdout.retained || stderr.retained
    const summary: RunSummary = {
      runId: this.runId,
      roomId: this.roomId,
      cmd: this.cmd,
      actor: this.actor,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: 'exited',
      code,
      stdout: streamSummary(this.sinks.stdout),
      stderr: streamSummary(this.sinks.stderr)
    }
    for (const name of ['stdout', 'stderr'] as const) {
      const note = describeStream(name, this.sinks[name].window, this.sinks[name].retained, this.runId)
      if (note) notes.push(note)
    }
    return {
      outcome: {
        runId: this.runId,
        stdout: { text: this.sinks.stdout.window.text(), report: this.sinks.stdout.window.report(stdout.retained) },
        stderr: { text: this.sinks.stderr.window.text(), report: this.sinks.stderr.window.report(stderr.retained) },
        retained,
        notes
      },
      summary
    }
  }

  get directory(): string {
    return this.dir
  }
}

function streamSummary(sink: RunSink): { bytes: number; lines: number; retained: boolean } {
  return { bytes: sink.window.bytes, lines: sink.window.lines, retained: sink.retained }
}

function describeStream(name: OutputStreamName, window: OutputWindow, retained: boolean, runId: string): string | null {
  if (!window.withheld) return null
  const report = window.report(retained)
  const parts = [
    `${name}: returned ${report.returnedBytes} of ${report.bytes} bytes (${report.returnedLines} of ${report.lines} lines)`
  ]
  if (report.filtered) parts.push(`${report.matchedLines ?? 0} lines matched the filter`)
  parts.push(
    retained
      ? `complete raw output retained as run ${runId} — read it with read_run_output`
      : 'the complete raw output could not be retained'
  )
  return parts.join('; ')
}

export interface RunReadOptions extends OutputSelection {
  stream?: OutputStreamName
  /** Start the scan at this byte offset — pass a previous read's nextOffset to page forward. */
  offsetBytes?: number
}

export interface RunReadResult {
  runId: string
  stream: OutputStreamName
  status: 'running' | 'exited'
  text: string
  /** Size of the retained stream at the moment of the read. */
  bytes: number
  offsetBytes: number
  /** Byte offset just past the last returned line — pass it back to continue. */
  nextOffset: number
  eof: boolean
  scannedBytes: number
  scannedLines: number
  returnedBytes: number
  returnedLines: number
  matchedLines?: number
  truncated: boolean
  filtered: boolean
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Room-owned retention for command output. Every run streams to
 * `<userData>/rooms/<roomId>/runs/<runId>/`, which makes a long command
 * readable while it is still running and keeps the complete raw output when
 * the bounded response could not carry it.
 */
export class RunOutputStore {
  private readonly active = new Map<string, ActiveRun>()
  private readonly maxRetainedRuns: number
  private readonly maxRetainedBytes: number

  constructor(
    private readonly userData: string,
    opts: { maxRetainedRuns?: number; maxRetainedBytes?: number } = {}
  ) {
    this.maxRetainedRuns = opts.maxRetainedRuns ?? DEFAULT_RETAINED_RUNS
    this.maxRetainedBytes = opts.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES
  }

  roomDir(roomId: string): string {
    return join(this.userData, 'rooms', roomId, 'runs')
  }

  runDir(roomId: string, runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error('invalid run id')
    return join(this.roomDir(roomId), runId)
  }

  begin(roomId: string, cmd: string[], actor: Actor, selection: OutputSelection = {}): ActiveRun {
    normalizeSelection(selection)
    const runId = randomUUID()
    const run = new ActiveRun(runId, roomId, cmd, actor, new Date().toISOString(), this.runDir(roomId, runId), selection)
    this.active.set(runId, run)
    return run
  }

  complete(run: ActiveRun, code: number): RunOutcome {
    const { outcome, summary } = run.finish(code)
    this.active.delete(run.runId)
    if (outcome.retained) {
      try {
        writeFileSync(join(run.directory, 'run.json'), JSON.stringify(summary, null, 2), 'utf8')
      } catch {
        // A missing manifest only costs discoverability, never the command.
      }
    } else if (existsSync(run.directory)) {
      rmSync(run.directory, { recursive: true, force: true })
    }
    this.prune(run.roomId)
    return outcome
  }

  /** Active runs first, then retained runs, newest first. */
  list(roomId: string): RunSummary[] {
    const running = [...this.active.values()].filter((run) => run.roomId === roomId).map((run) => run.summary())
    const retained = this.retainedSummaries(roomId)
    running.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    retained.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return [...running, ...retained]
  }

  read(roomId: string, runId: string, opts: RunReadOptions = {}): RunReadResult {
    const dir = this.runDir(roomId, runId)
    const active = this.active.get(runId)
    const known = (active && active.roomId === roomId) || existsSync(join(dir, 'run.json'))
    if (!known) {
      throw new Error(`no output is retained for run ${runId} — list_room_runs shows what this Room still has`)
    }
    const stream: OutputStreamName = opts.stream ?? 'stdout'
    const file = join(dir, `${stream}.log`)
    const status: 'running' | 'exited' = active ? 'running' : 'exited'
    const window = new OutputWindow(opts)
    const offsetBytes = Math.max(0, Math.floor(opts.offsetBytes ?? 0))
    if (!existsSync(file)) {
      return emptyRead(runId, stream, status, offsetBytes)
    }
    const size = statSync(file).size
    if (offsetBytes >= size) return { ...emptyRead(runId, stream, status, offsetBytes), bytes: size, nextOffset: size, eof: true }
    const scan = scanFile(file, offsetBytes, window)
    const report = window.report(true)
    return {
      runId,
      stream,
      status,
      text: window.text(),
      bytes: size,
      offsetBytes,
      nextOffset: scan.nextOffset,
      eof: scan.reachedEnd,
      scannedBytes: scan.scannedBytes,
      scannedLines: report.lines,
      returnedBytes: report.returnedBytes,
      returnedLines: report.returnedLines,
      ...(report.matchedLines !== undefined ? { matchedLines: report.matchedLines } : {}),
      truncated: report.truncated || !scan.reachedEnd,
      filtered: report.filtered
    }
  }

  /** Drop the oldest retained runs once a Room holds too many, or too much. */
  prune(roomId: string): void {
    const root = this.roomDir(roomId)
    if (!existsSync(root)) return
    const summaries = this.retainedSummaries(roomId, true)
    summaries.sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt))
    let kept = 0
    let bytes = 0
    for (const entry of summaries) {
      kept++
      bytes += entry.bytes
      if (kept > this.maxRetainedRuns || bytes > this.maxRetainedBytes) {
        rmSync(join(root, entry.summary.runId), { recursive: true, force: true })
      }
    }
    // Directories without a manifest are crash leftovers: no run can read them.
    for (const name of safeReaddir(root)) {
      if (this.active.has(name)) continue
      if (!existsSync(join(root, name, 'run.json'))) rmSync(join(root, name), { recursive: true, force: true })
    }
  }

  private retainedSummaries(roomId: string): RunSummary[]
  private retainedSummaries(roomId: string, withBytes: true): { summary: RunSummary; bytes: number }[]
  private retainedSummaries(roomId: string, withBytes = false): RunSummary[] | { summary: RunSummary; bytes: number }[] {
    const root = this.roomDir(roomId)
    const out: { summary: RunSummary; bytes: number }[] = []
    for (const name of safeReaddir(root)) {
      if (this.active.has(name)) continue
      const manifest = join(root, name, 'run.json')
      if (!existsSync(manifest)) continue
      try {
        const summary = JSON.parse(readFileSync(manifest, 'utf8')) as RunSummary
        if (summary.runId !== name) continue
        out.push({ summary, bytes: retainedBytes(join(root, name)) })
      } catch {
        // An unreadable manifest is pruned rather than reported.
      }
    }
    return withBytes ? out : out.map((entry) => entry.summary)
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function retainedBytes(dir: string): number {
  let total = 0
  for (const name of ['stdout.log', 'stderr.log']) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      // absent stream
    }
  }
  return total
}

function emptyRead(runId: string, stream: OutputStreamName, status: 'running' | 'exited', offsetBytes: number): RunReadResult {
  return {
    runId,
    stream,
    status,
    text: '',
    bytes: 0,
    offsetBytes,
    nextOffset: offsetBytes,
    eof: true,
    scannedBytes: 0,
    scannedLines: 0,
    returnedBytes: 0,
    returnedLines: 0,
    truncated: false,
    filtered: false
  }
}

/**
 * Scan a retained stream from `offsetBytes`, feeding complete lines into the
 * window. Head mode stops as soon as the window is full, so paging through a
 * multi-gigabyte log costs one window per call; `nextOffset` resumes exactly
 * after the last returned line, which stays correct even when a filter skipped
 * the lines in between.
 */
function scanFile(
  file: string,
  offsetBytes: number,
  window: OutputWindow
): { nextOffset: number; scannedBytes: number; reachedEnd: boolean } {
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const decoder = new StringDecoder('utf8')
  const deadline = Date.now() + SCAN_TIME_BUDGET_MS
  const NEWLINE = '\n'
  let position = offsetBytes
  let pending = ''
  /** Absolute byte offset of `pending`'s first character. */
  let pendingStart = offsetBytes
  /** Offset just past the last line the window kept. */
  let afterKept = offsetBytes
  /** Offset just past the last complete line seen, kept or not. */
  let afterSeen = offsetBytes
  let reachedEnd = false
  let outOfTime = false
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, position)
      if (read === 0) {
        pending += decoder.end()
        if (pending.length > 0) {
          const lineStart = pendingStart
          afterSeen = pendingStart + byteLength(pending)
          if (!window.full) {
            const fate = window.pushLine(pending)
            if (fate.kept) afterKept = fate.partialBytes === undefined ? afterSeen : lineStart + fate.partialBytes
          }
        }
        reachedEnd = !window.full
        break
      }
      position += read
      pending += decoder.write(buffer.subarray(0, read))
      let start = 0
      for (;;) {
        const nl = pending.indexOf(NEWLINE, start)
        if (nl === -1) break
        const line = pending.slice(start, nl)
        const lineStart = pendingStart + byteLength(pending.slice(0, start))
        const lineEnd = pendingStart + byteLength(pending.slice(0, nl + 1))
        afterSeen = lineEnd
        const fate = window.pushLine(line)
        if (fate.kept) afterKept = fate.partialBytes === undefined ? lineEnd : lineStart + fate.partialBytes
        start = nl + 1
        if (window.full) break
      }
      if (start > 0) {
        pendingStart += byteLength(pending.slice(0, start))
        pending = pending.slice(start)
      }
      outOfTime = Date.now() > deadline
      if (window.full || outOfTime) break
    }
  } finally {
    closeSync(fd)
  }
  // Resuming after the last *kept* line never skips a matching line; when the
  // scan gave up on time instead, resume after the last line it looked at.
  const nextOffset = reachedEnd ? afterSeen : outOfTime ? Math.max(afterSeen, afterKept) : afterKept
  return { nextOffset, scannedBytes: position - offsetBytes, reachedEnd }
}
