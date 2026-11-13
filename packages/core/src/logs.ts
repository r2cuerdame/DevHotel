import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import type { IsolationBackend } from './backend/types'
import { redactSecrets, secretSpans } from './diagnostics/redact'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const ROTATE_RETRY_MS = 1000
/** Longest piece of a line emitted on its own when the line has no newline in sight. */
export const MAX_LOG_LINE_CHARS = 64 * 1024
/** How far back from the cap a forced split looks for whitespace. */
const SPLIT_LOOKBACK_CHARS = 1024
/**
 * Output kept past the cap before a forced split, so a credential that is
 * still arriving at the end of the buffer has already taken a recognisable
 * shape when the cut point is chosen.
 */
const SPLIT_LOOKAHEAD_CHARS = 1024
const SPLIT_WINDOW_CHARS = MAX_LOG_LINE_CHARS + SPLIT_LOOKAHEAD_CHARS

export type LogKind = 'web' | 'orchestrator'

export interface LogLineEvent {
  roomId: string
  kind: LogKind
  line: string
}

/**
 * Cut point for an over-long line. Each piece is redacted on its own, so a
 * cut must never fall inside a value `redactSecrets` recognises: prefer
 * whitespace outside every secret, else cut just before the secret that
 * straddles the cap. When one secret-shaped value runs from the start past
 * the cap, cut right after it; if that value may still be growing (`open`),
 * return -1 so the caller masks the rest of the line instead.
 */
function forcedCut(text: string, open: boolean): number {
  const spans = secretSpans(text)
  const inside = (i: number): [number, number] | undefined => spans.find(([start, end]) => start < i && i < end)
  for (let i = MAX_LOG_LINE_CHARS; i > MAX_LOG_LINE_CHARS - SPLIT_LOOKBACK_CHARS; i--) {
    if (/\s/.test(text[i - 1] ?? '') && !inside(i)) return i
  }
  let cut = MAX_LOG_LINE_CHARS
  for (;;) {
    const span = inside(cut)
    const code = text.charCodeAt(cut - 1)
    if (span) cut = span[0]
    else if (code >= 0xd800 && code <= 0xdbff) cut--
    else break
  }
  if (cut > 0) return cut
  cut = MAX_LOG_LINE_CHARS
  for (let span = inside(cut); span; span = inside(cut)) cut = span[1]
  return open && cut > text.length - SPLIT_LOOKAHEAD_CHARS ? -1 : cut
}

/**
 * Turns one byte stream into whole lines. Chunks arrive at arbitrary byte
 * boundaries, so decoding and line splitting must carry state between them:
 * otherwise a character straddling two chunks becomes U+FFFD, one line is
 * logged as two, and a token split in half escapes redaction.
 */
class LineAssembler {
  private readonly decoder = new StringDecoder('utf8')
  private rest = ''
  /** The current line's remainder belongs to a masked value and is dropped. */
  private masking = false

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk))
  }

  end(): void {
    this.feed(this.decoder.end())
    const rest = this.rest
    this.rest = ''
    this.masking = false
    if (rest) this.emit(rest)
  }

  private feed(text: string): void {
    if (!text) return
    const parts = (this.rest + text).split(/\r?\n/)
    this.rest = parts.pop() ?? ''
    for (const part of parts) {
      if (this.masking) {
        this.masking = false
        continue
      }
      this.emit(part)
    }
    if (this.masking) {
      this.rest = ''
      return
    }
    const left = this.split(this.rest, false)
    this.masking = left === null
    this.rest = left ?? ''
  }

  private emit(line: string): void {
    const left = this.split(line, true)
    if (left !== null) this.onLine(left)
  }

  /**
   * Emits forced pieces of an over-long line and returns what is left, or
   * null once a secret-shaped value too long to cut around masked the rest.
   * An incomplete line keeps a lookahead past the cap before it is cut.
   */
  private split(text: string, complete: boolean): string | null {
    const limit = complete ? MAX_LOG_LINE_CHARS : SPLIT_WINDOW_CHARS
    while (text.length > limit) {
      const window = text.slice(0, SPLIT_WINDOW_CHARS)
      const cut = forcedCut(window, !complete || window.length < text.length)
      if (cut < 0) {
        this.onLine(window)
        return null
      }
      this.onLine(text.slice(0, cut))
      text = text.slice(cut)
    }
    return text
  }
}

export interface LogHubOptions {
  /** Size past which a log is moved to `<file>.1`. */
  maxLogBytes?: number
  /** Wait after a failed rotation before the next write tries again. */
  rotateRetryMs?: number
}

/**
 * Non-empty lines of a log file, or none when it is missing or cannot be read
 * right now (moved by a rotation, briefly held by another process).
 */
function readLogLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

interface LogPump {
  child: ChildProcess
  /** Emits whatever partial output is still buffered. Idempotent. */
  flush(): void
}

/**
 * Pumps `docker logs -f` for running rooms into per-room log files and
 * emits lines for live UI tails. Orchestrator lines are written directly.
 */
export class LogHub extends EventEmitter {
  private pumps = new Map<string, LogPump>()
  private desired = new Set<string>()
  /** Earliest time a log whose rotation failed is tried again, per file. */
  private rotateRetryAt = new Map<string, number>()
  private readonly maxLogBytes: number
  private readonly rotateRetryMs: number

  constructor(
    private readonly userData: string,
    private readonly backend: IsolationBackend,
    opts: LogHubOptions = {}
  ) {
    super()
    this.maxLogBytes = opts.maxLogBytes ?? MAX_LOG_BYTES
    this.rotateRetryMs = opts.rotateRetryMs ?? ROTATE_RETRY_MS
  }

  logDir(roomId: string): string {
    return join(this.userData, 'rooms', roomId, 'logs')
  }

  logFile(roomId: string, kind: LogKind): string {
    return join(this.logDir(roomId), `${kind}.log`)
  }

  attach(roomId: string): void {
    if (this.pumps.has(roomId) || this.desired.has(roomId)) return
    this.desired.add(roomId)
    mkdirSync(this.logDir(roomId), { recursive: true })
    void this.backend
      .followRoomLogs(roomId, 50)
      .then((child) => {
        if (!this.desired.has(roomId)) {
          child.kill()
          return
        }
        const toLog = (raw: string): void => {
          const line = raw.trimEnd()
          if (line) this.write(roomId, 'web', line)
        }
        // Separate state per stream so a partial stdout line never absorbs stderr.
        const out = new LineAssembler(toLog)
        const err = new LineAssembler(toLog)
        let flushed = false
        const pump: LogPump = {
          child,
          flush: () => {
            if (flushed) return
            flushed = true
            out.end()
            err.end()
          }
        }
        this.pumps.set(roomId, pump)
        // Data from a pump that was detached or replaced must not reach the Room's log.
        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.pumps.get(roomId) === pump) out.write(chunk)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (this.pumps.get(roomId) === pump) err.write(chunk)
        })
        const finish = (): void => {
          if (this.pumps.get(roomId) !== pump) return
          pump.flush()
          this.pumps.delete(roomId)
          this.desired.delete(roomId)
        }
        child.on('close', finish)
        child.on('error', finish)
      })
      .catch(() => {
        this.desired.delete(roomId)
      })
  }

  detach(roomId: string): void {
    this.desired.delete(roomId)
    const pump = this.pumps.get(roomId)
    if (pump) {
      pump.flush()
      this.pumps.delete(roomId)
      pump.child.kill()
    }
  }

  orchestrator(roomId: string, line: string): void {
    this.write(roomId, 'orchestrator', `${new Date().toISOString()} ${line}`)
  }

  tail(roomId: string, kind: LogKind, maxLines = 300): string[] {
    const file = this.logFile(roomId, kind)
    let lines = readLogLines(file)
    // Right after a rotation the current file holds only a few lines; the
    // rotated file still has the context leading up to them.
    if (lines.length < maxLines) lines = [...readLogLines(`${file}.1`), ...lines]
    // Also protect logs written by an older build or another local producer.
    return lines.slice(-maxLines).map((line) => redactSecrets(line))
  }

  private write(roomId: string, kind: LogKind, line: string): void {
    const safeLine = redactSecrets(line)
    try {
      mkdirSync(this.logDir(roomId), { recursive: true })
      const file = this.logFile(roomId, kind)
      this.rotateIfFull(file)
      appendFileSync(file, safeLine + '\n', 'utf8')
    } catch {
      // logging must never take the orchestrator down
    }
    this.emit('line', { roomId, kind, line: safeLine } satisfies LogLineEvent)
  }

  /**
   * Moves a full log aside. On Windows a viewer or scanner holding either
   * file makes the rename fail; the line is then still appended to the
   * current file, which runs over the cap until a later write rotates it.
   */
  private rotateIfFull(file: string): void {
    const now = Date.now()
    if ((this.rotateRetryAt.get(file) ?? 0) > now) return
    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      if (size <= this.maxLogBytes) return
      renameSync(file, `${file}.1`)
      this.rotateRetryAt.delete(file)
    } catch {
      this.rotateRetryAt.set(file, now + this.rotateRetryMs)
    }
  }

  dispose(): void {
    this.desired.clear()
    const pumps = [...this.pumps.values()]
    this.pumps.clear()
    for (const pump of pumps) {
      pump.flush()
      pump.child.kill()
    }
  }
}
