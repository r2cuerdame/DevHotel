import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import type { IsolationBackend } from './backend/types'
import { redactSecrets } from './diagnostics/redact'

const MAX_LOG_BYTES = 5 * 1024 * 1024
/**
 * Longest line kept in memory while waiting for its newline. Far above any
 * secret shape `redactSecrets` recognises, so a forced split only happens on
 * output that is not a credential line anyway.
 */
export const MAX_LOG_LINE_CHARS = 64 * 1024
/** How far back from the cap a forced split looks for whitespace. */
const SPLIT_LOOKBACK_CHARS = 1024

export type LogKind = 'web' | 'orchestrator'

export interface LogLineEvent {
  roomId: string
  kind: LogKind
  line: string
}

/** Cut point for an over-long line: prefer whitespace, never split a surrogate pair. */
function forcedCut(text: string): number {
  for (let i = MAX_LOG_LINE_CHARS; i > MAX_LOG_LINE_CHARS - SPLIT_LOOKBACK_CHARS; i--) {
    if (/\s/.test(text[i - 1] ?? '')) return i
  }
  const code = text.charCodeAt(MAX_LOG_LINE_CHARS - 1)
  return code >= 0xd800 && code <= 0xdbff ? MAX_LOG_LINE_CHARS - 1 : MAX_LOG_LINE_CHARS
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

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk))
  }

  end(): void {
    this.feed(this.decoder.end())
    const rest = this.rest
    this.rest = ''
    if (rest) this.onLine(rest)
  }

  private feed(text: string): void {
    if (!text) return
    const parts = (this.rest + text).split(/\r?\n/)
    this.rest = parts.pop() ?? ''
    for (let part of parts) {
      while (part.length > MAX_LOG_LINE_CHARS) {
        const cut = forcedCut(part)
        this.onLine(part.slice(0, cut))
        part = part.slice(cut)
      }
      this.onLine(part)
    }
    while (this.rest.length > MAX_LOG_LINE_CHARS) {
      const cut = forcedCut(this.rest)
      this.onLine(this.rest.slice(0, cut))
      this.rest = this.rest.slice(cut)
    }
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

  constructor(private readonly userData: string, private readonly backend: IsolationBackend) {
    super()
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
    if (!existsSync(file)) return []
    const content = readFileSync(file, 'utf8')
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0)
    // Also protect logs written by an older build or another local producer.
    return lines.slice(-maxLines).map((line) => redactSecrets(line))
  }

  private write(roomId: string, kind: LogKind, line: string): void {
    const safeLine = redactSecrets(line)
    try {
      mkdirSync(this.logDir(roomId), { recursive: true })
      const file = this.logFile(roomId, kind)
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, safeLine + '\n', 'utf8')
    } catch {
      // logging must never take the orchestrator down
    }
    this.emit('line', { roomId, kind, line: safeLine } satisfies LogLineEvent)
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
