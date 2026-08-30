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
import type { Actor } from '@devhotel/shared'

/** Inline bytes returned per stream when the caller does not choose a budget. */
export const DEFAULT_OUTPUT_BYTES = 64_000
export const MIN_OUTPUT_BYTES = 256
export const MAX_OUTPUT_BYTES = 4_000_000
export const MAX_OUTPUT_LINES = 1_000_000
/** Filters are agent-supplied literal strings: keep their matching state small. */
export const MAX_FILTER_LENGTH = 200
/** One synchronous retained-file read is capped so it cannot freeze Electron on a huge log. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const DEFAULT_RETAINED_RUNS = 20
const DEFAULT_RETAINED_BYTES = 256 * 1024 * 1024

export type OutputStreamName = 'stdout' | 'stderr'
export type OutputMode = 'head' | 'tail'
export type OutputChunk = string | Uint8Array
export type OutputEncoding = 'utf8' | 'base64'

export interface OutputSelection {
  /** Inline budget for this stream, in bytes. */
  maxBytes?: number
  maxLines?: number
  /** Which end of the output to keep when it does not fit — defaults to the tail. */
  mode?: OutputMode
  /** Keep only lines containing this literal UTF-8 string. */
  include?: string
  /** Drop lines containing this literal UTF-8 string. */
  exclude?: string
  /** ASCII case-insensitive matching; non-ASCII filters remain exact. */
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

export interface LineFate {
  kept: boolean
  partialBytes?: number
}

function asBuffer(chunk: OutputChunk): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

/** Encode even a backend's accidentally huge buffered string in bounded pieces. */
function forEachRawChunk(chunk: OutputChunk, visit: (raw: Buffer) => void): void {
  if (typeof chunk !== 'string') {
    visit(asBuffer(chunk))
    return
  }
  const maxCodeUnits = 64 * 1024
  for (let start = 0; start < chunk.length;) {
    let end = Math.min(chunk.length, start + maxCodeUnits)
    if (end < chunk.length) {
      const last = chunk.charCodeAt(end - 1)
      const next = chunk.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    }
    visit(Buffer.from(chunk.slice(start, end), 'utf8'))
    start = end
  }
}

function foldAscii(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
}

/**
 * Streaming Knuth-Morris-Pratt matcher. Unlike JavaScript RegExp, its work is
 * linear in the bytes received and its memory is fixed by the (capped) needle.
 * Metacharacters therefore have no special meaning: filters are deliberately
 * literal substrings on the Electron main thread.
 */
class LiteralMatcher {
  private readonly needle: Buffer
  private readonly failure: Uint32Array
  private progress = 0
  matched = false

  constructor(pattern: string, private readonly ignoreCase: boolean) {
    this.needle = Buffer.from(pattern, 'utf8')
    if (ignoreCase) {
      for (let index = 0; index < this.needle.length; index++) this.needle[index] = foldAscii(this.needle[index] ?? 0)
    }
    this.failure = new Uint32Array(this.needle.length)
    for (let index = 1, prefix = 0; index < this.needle.length; index++) {
      const byte = this.needle[index] ?? 0
      while (prefix > 0 && byte !== this.needle[prefix]) prefix = this.failure[prefix - 1] ?? 0
      if (byte === this.needle[prefix]) prefix++
      this.failure[index] = prefix
    }
  }

  push(chunk: Uint8Array): void {
    if (this.matched) return
    for (const raw of chunk) {
      const byte = this.ignoreCase ? foldAscii(raw) : raw
      while (this.progress > 0 && byte !== this.needle[this.progress]) {
        this.progress = this.failure[this.progress - 1] ?? 0
      }
      if (byte === this.needle[this.progress]) this.progress++
      if (this.progress === this.needle.length) {
        this.matched = true
        return
      }
    }
  }

  reset(): void {
    this.progress = 0
    this.matched = false
  }
}

function compileFilter(
  pattern: string | undefined,
  ignoreCase: boolean | undefined,
  label: string
): LiteralMatcher | undefined {
  if (pattern === undefined || pattern === '') return undefined
  if (pattern.length > MAX_FILTER_LENGTH) {
    throw new Error(`${label} filter is longer than ${MAX_FILTER_LENGTH} characters`)
  }
  return new LiteralMatcher(pattern, ignoreCase === true)
}

/** One line's bounded head or tail, implemented as a fixed-size byte ring. */
class BoundedByteBuffer {
  private readonly storage: Buffer
  private start = 0
  private length = 0
  totalBytes = 0

  constructor(
    private readonly capacity: number,
    private readonly mode: OutputMode
  ) {
    this.storage = Buffer.allocUnsafe(capacity)
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.totalBytes += chunk.byteLength
    const source = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.mode === 'head') {
      const copy = Math.min(source.length, this.capacity - this.length)
      if (copy > 0) source.copy(this.storage, this.length, 0, copy)
      this.length += copy
      return
    }
    if (source.length >= this.capacity) {
      source.copy(this.storage, 0, source.length - this.capacity)
      this.start = 0
      this.length = this.capacity
      return
    }
    const overflow = Math.max(0, this.length + source.length - this.capacity)
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity
      this.length -= overflow
    }
    const writeAt = (this.start + this.length) % this.capacity
    const first = Math.min(source.length, this.capacity - writeAt)
    source.copy(this.storage, writeAt, 0, first)
    if (first < source.length) source.copy(this.storage, 0, first)
    this.length += source.length
  }

  bytes(): Buffer {
    if (this.length === 0) return Buffer.alloc(0)
    const out = Buffer.allocUnsafe(this.length)
    const first = Math.min(this.length, this.capacity - this.start)
    this.storage.copy(out, 0, this.start, this.start + first)
    if (first < this.length) this.storage.copy(out, first, 0, this.length - first)
    return out
  }

  reset(): void {
    this.start = 0
    this.length = 0
    this.totalBytes = 0
  }

  get bufferedBytes(): number {
    return this.length
  }
}

interface DroppedBytes {
  bytes: number
  newlines: number
}

/** Fixed-size selected-output ring; one allocation regardless of line count. */
class ByteRing {
  private readonly storage: Buffer
  private start = 0
  private length = 0

  constructor(private readonly capacity: number) {
    this.storage = Buffer.allocUnsafe(capacity)
  }

  append(chunk: Uint8Array): DroppedBytes {
    if (chunk.byteLength === 0) return { bytes: 0, newlines: 0 }
    const source = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (source.length >= this.capacity) {
      const dropped = this.dropPrefix(this.length)
      source.copy(this.storage, 0, source.length - this.capacity)
      this.start = 0
      this.length = this.capacity
      return dropped
    }
    const overflow = Math.max(0, this.length + source.length - this.capacity)
    const dropped = this.dropPrefix(overflow)
    const writeAt = (this.start + this.length) % this.capacity
    const first = Math.min(source.length, this.capacity - writeAt)
    source.copy(this.storage, writeAt, 0, first)
    if (first < source.length) source.copy(this.storage, 0, first)
    this.length += source.length
    return dropped
  }

  /** Drop the oldest complete/partial logical line. */
  dropFirstLine(): DroppedBytes {
    const newline = this.indexOf(0x0a)
    return this.dropPrefix(newline === -1 ? this.length : newline + 1)
  }

  /** A tail byte window may start inside a valid UTF-8 sequence. */
  trimLeadingContinuation(): number {
    let dropped = 0
    while (dropped < 3 && this.length > 0 && isUtf8Continuation(this.byteAt(0))) {
      this.dropPrefix(1)
      dropped++
    }
    return dropped
  }

  bytes(): Buffer {
    if (this.length === 0) return Buffer.alloc(0)
    const out = Buffer.allocUnsafe(this.length)
    const first = Math.min(this.length, this.capacity - this.start)
    this.storage.copy(out, 0, this.start, this.start + first)
    if (first < this.length) this.storage.copy(out, first, 0, this.length - first)
    return out
  }

  get byteLength(): number {
    return this.length
  }

  private dropPrefix(requested: number): DroppedBytes {
    const count = Math.min(Math.max(0, requested), this.length)
    let newlines = 0
    for (let index = 0; index < count; index++) {
      if (this.byteAt(index) === 0x0a) newlines++
    }
    this.start = this.capacity === 0 ? 0 : (this.start + count) % this.capacity
    this.length -= count
    return { bytes: count, newlines }
  }

  private indexOf(needle: number): number {
    for (let index = 0; index < this.length; index++) {
      if (this.byteAt(index) === needle) return index
    }
    return -1
  }

  private byteAt(index: number): number {
    return this.storage[(this.start + index) % this.capacity] ?? 0
  }
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function utf8SequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 1
}

/** Do not return a trailing lead byte without the rest of its UTF-8 sequence. */
function utf8SafeHeadLength(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0
  let lead = bytes.byteLength - 1
  while (lead > 0 && isUtf8Continuation(bytes[lead] ?? 0)) lead--
  const available = bytes.byteLength - lead
  return utf8SequenceLength(bytes[lead] ?? 0) > available ? lead : bytes.byteLength
}

export function normalizeSelection(selection: OutputSelection = {}): Required<Pick<OutputSelection, 'maxBytes' | 'mode'>> & OutputSelection {
  const requested = selection.maxBytes ?? DEFAULT_OUTPUT_BYTES
  if (!Number.isFinite(requested) || requested < MIN_OUTPUT_BYTES || requested > MAX_OUTPUT_BYTES) {
    throw new Error(`maxBytes must be between ${MIN_OUTPUT_BYTES} and ${MAX_OUTPUT_BYTES}`)
  }
  if (
    selection.maxLines !== undefined &&
    (!Number.isInteger(selection.maxLines) || selection.maxLines < 1 || selection.maxLines > MAX_OUTPUT_LINES)
  ) {
    throw new Error(`maxLines must be between 1 and ${MAX_OUTPUT_LINES}`)
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
  private readonly includeMatcher?: LiteralMatcher
  private readonly excludeMatcher?: LiteralMatcher
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly mode: OutputMode
  private readonly filtering: boolean
  private readonly current: BoundedByteBuffer
  private readonly selected: ByteRing
  private currentRawBytes = 0
  private ended = false
  private finalUtf8 = false
  private keptLines = 0
  private readonly initialLineSkipBytes: number
  private readonly preserveRawPageBytes: boolean
  /** Bytes through the last complete line received by this window. */
  completedInputBytes = 0
  /** Input offset just past the most recent kept bytes, relative to this window. */
  lastKeptInputOffset = 0
  /** Distinguishes a legitimate zero resume offset from no selected input. */
  hasKeptInputOffset = false

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

  constructor(
    selection: OutputSelection = {},
    internal: { initialLineSkipBytes?: number; preserveRawPageBytes?: boolean } = {}
  ) {
    const normalized = normalizeSelection(selection)
    this.maxBytes = normalized.maxBytes
    this.maxLines = normalized.maxLines ?? Number.MAX_SAFE_INTEGER
    this.mode = normalized.mode
    this.includeMatcher = compileFilter(selection.include, selection.ignoreCase, 'include')
    this.excludeMatcher = compileFilter(selection.exclude, selection.ignoreCase, 'exclude')
    this.filtering = this.includeMatcher !== undefined || this.excludeMatcher !== undefined
    this.current = new BoundedByteBuffer(this.maxBytes, this.mode)
    this.selected = new ByteRing(this.maxBytes)
    this.initialLineSkipBytes = Math.max(0, Math.floor(internal.initialLineSkipBytes ?? 0))
    this.preserveRawPageBytes = internal.preserveRawPageBytes === true
  }

  /** Feed raw bytes; a line candidate never grows beyond maxBytes. */
  push(chunk: OutputChunk): void {
    forEachRawChunk(chunk, (raw) => this.pushRaw(raw))
  }

  private pushRaw(raw: Buffer): void {
    if (raw.length === 0) return
    this.bytes += raw.length
    let start = 0
    for (;;) {
      const nl = raw.indexOf(0x0a, start)
      if (nl === -1) break
      this.pushLineBytes(raw.subarray(start, nl), raw.subarray(nl, nl + 1))
      start = nl + 1
    }
    this.pushFragment(raw.subarray(start))
  }

  /** Feed one complete line. Reports whether — and how much of — it was kept. */
  pushLine(line: string): LineFate {
    const raw = Buffer.from(line, 'utf8')
    this.bytes += raw.length
    this.pushFragment(raw)
    return this.finishLine()
  }

  /** Flush a trailing line that never got its newline. */
  end(finalUtf8 = true): void {
    if (this.ended) return
    this.ended = true
    this.finalUtf8 = finalUtf8
    if (this.currentRawBytes > 0) this.finishLine()
  }

  text(): string {
    return this.rawBytes().toString('utf8')
  }

  /** The exact selected bytes, for lossless base64 retained-output reads. */
  rawBytes(): Buffer {
    return this.selected.bytes()
  }

  report(retained = false): StreamReport {
    return {
      bytes: this.bytes,
      lines: this.lines,
      returnedBytes: this.selected.byteLength,
      returnedLines: this.keptLines,
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

  /** Test/debug invariant: selected bytes plus the current line stay bounded. */
  get bufferedBytes(): number {
    return this.selected.byteLength + this.current.bufferedBytes
  }

  get isFiltering(): boolean {
    return this.filtering
  }

  get pendingInputBytes(): number {
    return this.currentRawBytes
  }

  /** An unfiltered raw page may stop mid-line; a filter must see the whole line. */
  get canFinalizePartialPage(): boolean {
    if (this.mode !== 'head' || this.currentRawBytes === 0) return false
    const remaining = this.maxBytes - this.selected.byteLength
    if (this.currentRawBytes < remaining) return false
    return !this.filtering
  }

  private pushFragment(fragment: Uint8Array): void {
    if (fragment.byteLength === 0) return
    this.captureLineBytes(fragment)
    this.includeMatcher?.push(fragment)
    this.excludeMatcher?.push(fragment)
  }

  /** Capture only the requested suffix of the first aligned line. */
  private captureLineBytes(fragment: Uint8Array): void {
    const skip = this.lines === 0 ? this.initialLineSkipBytes : 0
    const captureAt = Math.min(fragment.byteLength, Math.max(0, skip - this.currentRawBytes))
    if (captureAt < fragment.byteLength) this.current.push(fragment.subarray(captureAt))
    this.currentRawBytes += fragment.byteLength
  }

  private pushLineBytes(content: Uint8Array, terminator: Uint8Array): LineFate {
    this.pushFragment(content)
    this.captureLineBytes(terminator)
    return this.finishLine()
  }

  private finishLine(): LineFate {
    const rawLineBytes = this.currentRawBytes
    const lineStart = this.completedInputBytes
    const captureSkip = this.lines === 0 ? Math.min(this.initialLineSkipBytes, rawLineBytes) : 0
    const selectedRawLineBytes = rawLineBytes - captureSkip
    this.completedInputBytes += rawLineBytes
    this.lines++
    const matches = (!this.includeMatcher || this.includeMatcher.matched) &&
      (!this.excludeMatcher || !this.excludeMatcher.matched)
    let fate: LineFate
    if (!matches) {
      this.droppedByFilter++
      fate = { kept: false }
    } else {
      this.matched++
      fate = this.add(this.current.bytes(), selectedRawLineBytes)
      if (fate.kept) {
        this.hasKeptInputOffset = true
        this.lastKeptInputOffset = fate.partialBytes === undefined
          ? this.completedInputBytes
          : lineStart + captureSkip + fate.partialBytes
      }
    }
    this.current.reset()
    this.currentRawBytes = 0
    this.includeMatcher?.reset()
    this.excludeMatcher?.reset()
    return fate
  }

  private add(line: Buffer, rawLineBytes: number): LineFate {
    if (this.full) {
      this.truncated = true
      return { kept: false }
    }
    if (rawLineBytes > line.length) this.truncated = true
    if (this.mode === 'head') {
      const remaining = this.maxBytes - this.selected.byteLength
      if (remaining <= 0 || this.keptLines >= this.maxLines) {
        this.full = true
        this.truncated = true
        return { kept: false }
      }
      // A filtered page must resume at a line boundary. Splitting a matching
      // line here would make the next request start after its match text and
      // silently discard the remainder when it re-applies the filter.
      if (this.filtering && this.keptLines > 0 && line.length > remaining) {
        this.full = true
        this.truncated = true
        return { kept: false }
      }
      const proposed = line.subarray(0, Math.min(line.length, remaining))
      const canReturnFinalInvalidUtf8 = this.finalUtf8 && proposed.length === line.length
      const safeLength = this.preserveRawPageBytes || canReturnFinalInvalidUtf8
        ? proposed.length
        : utf8SafeHeadLength(proposed)
      if (safeLength === 0) {
        this.full = true
        this.truncated = true
        // The producer may append the continuation bytes after this active
        // snapshot. Mark offset zero as an intentional resume point.
        return { kept: true, partialBytes: 0 }
      }
      const selected = proposed.subarray(0, safeLength)
      if (selected.length < line.length) this.truncated = true
      this.selected.append(selected)
      this.keptLines++
      this.full =
        this.selected.byteLength >= this.maxBytes || this.keptLines >= this.maxLines || selected.length < rawLineBytes
      return selected.length < rawLineBytes ? { kept: true, partialBytes: selected.length } : { kept: true }
    }
    const tailEnd = this.preserveRawPageBytes || this.finalUtf8 ? line.length : utf8SafeHeadLength(line)
    const trailingIncompleteBytes = line.length - tailEnd
    let tailStart = 0
    while (
      !this.preserveRawPageBytes &&
      tailStart < Math.min(3, tailEnd) &&
      isUtf8Continuation(line[tailStart] ?? 0)
    ) tailStart++
    const selected = line.subarray(tailStart, tailEnd)
    if (tailStart > 0 || trailingIncompleteBytes > 0) this.truncated = true
    if (selected.length === 0) {
      return { kept: true, partialBytes: Math.max(0, rawLineBytes - trailingIncompleteBytes) }
    }
    const dropped = this.selected.append(selected)
    this.keptLines = Math.max(0, this.keptLines - dropped.newlines) + 1
    if (dropped.bytes > 0) this.truncated = true
    if (!this.preserveRawPageBytes && this.selected.trimLeadingContinuation() > 0) this.truncated = true
    while (this.keptLines > this.maxLines) {
      const removed = this.selected.dropFirstLine()
      if (removed.bytes === 0) break
      this.keptLines = Math.max(0, this.keptLines - Math.max(1, removed.newlines))
      this.truncated = true
    }
    return trailingIncompleteBytes > 0
      ? { kept: true, partialBytes: rawLineBytes - trailingIncompleteBytes }
      : { kept: true }
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

  push(chunk: OutputChunk): void {
    forEachRawChunk(chunk, (raw) => {
      if (raw.length === 0) return
      this.window.push(raw)
      // Once retention has failed the window keeps working; retrying the write
      // per chunk would only repeat the same error.
      if (this.writeError) return
      if (this.fd === null) this.open()
      if (this.fd === null) return
      try {
        // Written synchronously so a still-running command is readable *now*:
        // a buffered stream would leave a live tail several chunks behind.
        let offset = 0
        while (offset < raw.length) {
          const written = writeSync(this.fd, raw, offset, raw.length - offset)
          if (written <= 0) throw new Error('retained output write made no progress')
          offset += written
        }
      } catch (err) {
        this.writeError = err instanceof Error ? err : new Error(String(err))
      }
    })
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
      try {
        rmSync(this.file, { force: true })
      } catch {
        // Best-effort cleanup; the run manifest will not advertise this file.
      }
      return { retained: false, error: this.writeError.message }
    }
    if (!this.window.bytes) return { retained: false, error: null }
    // Nothing was held back: the caller already has every byte, so keeping a
    // second copy would only grow Hotel storage.
    if (!this.window.withheld) {
      try {
        rmSync(this.file, { force: true })
      } catch {
        // The run directory cleanup below gets another chance.
      }
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

  push(stream: OutputStreamName, chunk: OutputChunk): void {
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
  /** Return exact selected bytes as base64 instead of decoding them as UTF-8 text. */
  encoding?: OutputEncoding
}

export interface RunReadResult {
  runId: string
  stream: OutputStreamName
  status: 'running' | 'exited'
  text: string
  encoding: OutputEncoding
  /** Present when encoding=base64; concatenate decoded pages for exact recovery. */
  contentBase64?: string
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
  private lastFinishedAtMs = 0

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
    // ISO timestamps only carry milliseconds. Make completion order strict so
    // several tiny commands finishing in one tick still prune oldest-first.
    this.lastFinishedAtMs = Math.max(Date.now(), this.lastFinishedAtMs + 1)
    summary.finishedAt = new Date(this.lastFinishedAtMs).toISOString()
    this.active.delete(run.runId)
    if (outcome.retained) {
      try {
        writeFileSync(join(run.directory, 'run.json'), JSON.stringify(summary, null, 2), 'utf8')
      } catch (error) {
        // Without a manifest the advertised run id cannot be read after this
        // method returns. Fail the retention claim closed and clean up.
        outcome.retained = false
        outcome.stdout.report.retained = false
        outcome.stderr.report.retained = false
        outcome.notes = [
          `complete raw output could not be retained: ${error instanceof Error ? error.message : String(error)}`
        ]
        try {
          rmSync(run.directory, { recursive: true, force: true })
        } catch {
          // An undiscoverable leftover is swept by a later prune.
        }
      }
    } else if (existsSync(run.directory)) {
      try {
        rmSync(run.directory, { recursive: true, force: true })
      } catch {
        // Storage cleanup must not turn a successful Room command into failure.
      }
    }
    this.prune(run.roomId, outcome.retained ? run.runId : undefined)
    return outcome
  }

  /** Active runs first, then retained runs, newest first. */
  list(roomId: string): RunSummary[] {
    const running = [...this.active.values()].filter((run) => run.roomId === roomId).map((run) => run.summary())
    const retained = this.retainedSummaries(roomId)
    running.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    retained.sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
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
    const encoding: OutputEncoding = opts.encoding ?? 'utf8'
    const file = join(dir, `${stream}.log`)
    const status: 'running' | 'exited' = active ? 'running' : 'exited'
    const offsetBytes = Math.max(0, Math.floor(opts.offsetBytes ?? 0))
    if (!existsSync(file)) {
      return emptyRead(runId, stream, status, offsetBytes, encoding)
    }
    const size = statSync(file).size
    if (offsetBytes >= size) {
      return { ...emptyRead(runId, stream, status, offsetBytes, encoding), bytes: size, nextOffset: size, eof: true }
    }
    const filtering = hasFilters(opts)
    if (filtering && opts.mode === 'tail') {
      throw new Error('filtered retained-output reads use head paging; omit mode or set mode=head')
    }
    const selection: RunReadOptions = {
      ...opts,
      // A retained read is a paging operation, unlike exec's inline diagnostic
      // window. Start at the requested offset unless tail was explicit.
      mode: filtering ? 'head' : (opts.mode ?? 'head')
    }
    const normalized = normalizeSelection(selection)
    const filteredLineStart = filtering ? findFilteredLineStart(file, offsetBytes) : offsetBytes
    const scanOffset = !filtering && normalized.mode === 'tail'
      ? Math.max(offsetBytes, size - normalized.maxBytes - (encoding === 'utf8' ? 3 : 0))
      : filteredLineStart
    const window = new OutputWindow(selection, {
      initialLineSkipBytes: filtering ? offsetBytes - filteredLineStart : 0,
      preserveRawPageBytes: encoding === 'base64'
    })
    const scan = scanFile(
      file,
      scanOffset,
      size,
      window,
      status === 'exited' || !filtering,
      status === 'exited'
    )
    const report = window.report(true)
    return {
      runId,
      stream,
      status,
      text: encoding === 'utf8' ? window.text() : '',
      encoding,
      ...(encoding === 'base64' ? { contentBase64: window.rawBytes().toString('base64') } : {}),
      bytes: size,
      offsetBytes,
      nextOffset: scan.nextOffset,
      eof: scan.reachedEnd,
      scannedBytes: scan.scannedBytes,
      scannedLines: report.lines,
      returnedBytes: report.returnedBytes,
      returnedLines: report.returnedLines,
      ...(report.matchedLines !== undefined ? { matchedLines: report.matchedLines } : {}),
      truncated: scanOffset > offsetBytes || report.truncated || !scan.reachedEnd || scan.pendingLine,
      filtered: report.filtered
    }
  }

  /** Drop the oldest retained runs once a Room holds too many, or too much. */
  prune(roomId: string, protectedRunId?: string): void {
    const root = this.roomDir(roomId)
    if (!existsSync(root)) return
    const summaries = this.retainedSummaries(roomId, true)
    summaries.sort((a, b) => {
      if (a.summary.runId === b.summary.runId) return 0
      if (a.summary.runId === protectedRunId) return -1
      if (b.summary.runId === protectedRunId) return 1
      return (b.summary.finishedAt ?? b.summary.startedAt).localeCompare(a.summary.finishedAt ?? a.summary.startedAt)
    })
    let kept = 0
    let bytes = 0
    let pruningSuffix = false
    for (const [index, entry] of summaries.entries()) {
      // The newest/just-finished run is the only recovery path promised in the
      // exec response. Keep it even when that one run alone exceeds the byte
      // budget, then evict every older run until the policy is satisfied.
      const mustKeep = index === 0
      const fits = !pruningSuffix && kept < this.maxRetainedRuns && bytes + entry.bytes <= this.maxRetainedBytes
      if (!mustKeep && !fits) {
        // Retention is newest-first, not a bin-packing problem. Once one run
        // does not fit, every older run is part of the pruned suffix even if a
        // smaller one could fit in the remaining bytes.
        pruningSuffix = true
        try {
          rmSync(join(root, entry.summary.runId), { recursive: true, force: true })
        } catch {
          // A later completion retries pruning; never fail the command itself.
        }
        continue
      }
      kept++
      bytes += entry.bytes
      if (bytes > this.maxRetainedBytes || kept >= this.maxRetainedRuns) pruningSuffix = true
    }
    // Missing or invalid manifests are crash leftovers: no run can safely read
    // or account for them, so their logs must not escape the retention cap.
    for (const name of safeReaddir(root)) {
      if (this.active.has(name)) continue
      const directory = join(root, name)
      if (!readRetainedSummary(join(directory, 'run.json'), name, roomId)) {
        try {
          rmSync(directory, { recursive: true, force: true })
        } catch {
          // A later prune retries crash-leftover cleanup.
        }
      }
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
      const summary = readRetainedSummary(manifest, name, roomId)
      if (summary) out.push({ summary, bytes: retainedBytes(join(root, name)) })
    }
    return withBytes ? out : out.map((entry) => entry.summary)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredStreamSummary(value: unknown): value is RunSummary['stdout'] {
  if (!isRecord(value)) return false
  return Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 &&
    Number.isSafeInteger(value.lines) && (value.lines as number) >= 0 &&
    typeof value.retained === 'boolean'
}

function readRetainedSummary(file: string, runId: string, roomId: string): RunSummary | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(value)) return null
    if (value.runId !== runId || value.roomId !== roomId) return null
    if (!Array.isArray(value.cmd) || !value.cmd.every((part) => typeof part === 'string')) return null
    if (value.actor !== 'user' && value.actor !== 'devhotel' && value.actor !== 'agent') return null
    if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) return null
    if (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))) return null
    if (value.status !== 'exited' || (value.code !== null && !Number.isInteger(value.code))) return null
    if (!isStoredStreamSummary(value.stdout) || !isStoredStreamSummary(value.stderr)) return null
    return value as unknown as RunSummary
  } catch {
    return null
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

function emptyRead(
  runId: string,
  stream: OutputStreamName,
  status: 'running' | 'exited',
  offsetBytes: number,
  encoding: OutputEncoding
): RunReadResult {
  return {
    runId,
    stream,
    status,
    text: '',
    encoding,
    ...(encoding === 'base64' ? { contentBase64: '' } : {}),
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

function hasFilters(selection: OutputSelection): boolean {
  return (selection.include !== undefined && selection.include !== '') ||
    (selection.exclude !== undefined && selection.exclude !== '')
}

/**
 * Align a filtered continuation to its logical line so include and exclude are
 * re-evaluated instead of trusting an arbitrary caller-supplied mid-line
 * offset. The backward work is fixed; longer lines use unfiltered byte paging.
 */
function findFilteredLineStart(file: string, offsetBytes: number): number {
  if (offsetBytes <= 0) return 0
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let cursor = offsetBytes
  let inspected = 0
  try {
    while (cursor > 0 && inspected < MAX_SCAN_BYTES) {
      const requested = Math.min(buffer.byteLength, cursor, MAX_SCAN_BYTES - inspected)
      const start = cursor - requested
      const read = readSync(fd, buffer, 0, requested, start)
      if (read === 0) break
      const newline = buffer.subarray(0, read).lastIndexOf(0x0a)
      if (newline !== -1) return start + newline + 1
      cursor = start
      inspected += read
    }
    if (cursor === 0) return 0
    throw new Error(
      `filtered retained-output reads require logical lines no longer than ${MAX_SCAN_BYTES} bytes; ` +
      'page this stream without include/exclude'
    )
  } finally {
    closeSync(fd)
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
  size: number,
  window: OutputWindow,
  finalizeTrailingLine: boolean,
  finalizeUtf8: boolean
): { nextOffset: number; scannedBytes: number; reachedEnd: boolean; pendingLine: boolean } {
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const scanLimit = Math.min(size, offsetBytes + MAX_SCAN_BYTES)
  let position = offsetBytes
  let reachedEnd = false
  try {
    while (position < scanLimit) {
      const requested = Math.min(buffer.byteLength, scanLimit - position)
      const read = readSync(fd, buffer, 0, requested, position)
      if (read === 0) break
      position += read
      window.push(buffer.subarray(0, read))
      // An unfiltered head page can make progress without waiting for an
      // unbounded logical line to terminate.
      if (window.canFinalizePartialPage) window.end(false)
      if (window.full) break
    }
    reachedEnd = position >= size
    if (reachedEnd && finalizeTrailingLine) window.end(finalizeUtf8)

    // A filtered first pass has to see a complete line before it can decide
    // whether that line matches. Refuse a >4 MiB logical line instead of
    // synchronously scanning an attacker-controlled amount on Electron's main
    // thread. Unfiltered byte paging remains available for that output.
    if (
      window.isFiltering &&
      !reachedEnd &&
      position >= scanLimit &&
      window.pendingInputBytes > 0 &&
      window.completedInputBytes === 0
    ) {
      throw new Error(
        `filtered retained-output reads require logical lines no longer than ${MAX_SCAN_BYTES} bytes; ` +
        'page this stream without include/exclude'
      )
    }
  } finally {
    closeSync(fd)
  }
  const pendingLine = window.pendingInputBytes > 0
  const relativeNext = reachedEnd && !window.truncated && !pendingLine
    ? position - offsetBytes
    : window.hasKeptInputOffset
      ? window.lastKeptInputOffset
      : window.completedInputBytes
  const nextOffset = offsetBytes + relativeNext
  // If the window filled before the snapshot ended, the caller has more to
  // page even when the final 64KB read happened to reach the snapshot's EOF.
  reachedEnd = reachedEnd && !pendingLine && (!window.truncated || nextOffset >= size)
  return { nextOffset, scannedBytes: position - offsetBytes, reachedEnd, pendingLine }
}
