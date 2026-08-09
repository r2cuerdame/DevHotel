import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { webName } from './backend/naming'

const MAX_LOG_BYTES = 5 * 1024 * 1024

export type LogKind = 'web' | 'orchestrator'

export interface LogLineEvent {
  roomId: string
  kind: LogKind
  line: string
}

/**
 * Pumps `docker logs -f` for running rooms into per-room log files and
 * emits lines for live UI tails. Orchestrator lines are written directly.
 */
export class LogHub extends EventEmitter {
  private pumps = new Map<string, ChildProcess>()

  constructor(private readonly userData: string) {
    super()
  }

  logDir(roomId: string): string {
    return join(this.userData, 'rooms', roomId, 'logs')
  }

  logFile(roomId: string, kind: LogKind): string {
    return join(this.logDir(roomId), `${kind}.log`)
  }

  attach(roomId: string): void {
    if (this.pumps.has(roomId)) return
    mkdirSync(this.logDir(roomId), { recursive: true })
    const child = spawn('docker', ['logs', '-f', '--tail', '50', webName(roomId)], { windowsHide: true })
    const onChunk = (chunk: Buffer): void => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.trimEnd()
        if (!line) continue
        this.write(roomId, 'web', line)
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('close', () => {
      this.pumps.delete(roomId)
    })
    child.on('error', () => {
      this.pumps.delete(roomId)
    })
    this.pumps.set(roomId, child)
  }

  detach(roomId: string): void {
    const pump = this.pumps.get(roomId)
    if (pump) {
      pump.kill()
      this.pumps.delete(roomId)
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
    return lines.slice(-maxLines)
  }

  private write(roomId: string, kind: LogKind, line: string): void {
    try {
      mkdirSync(this.logDir(roomId), { recursive: true })
      const file = this.logFile(roomId, kind)
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line + '\n', 'utf8')
    } catch {
      // logging must never take the orchestrator down
    }
    this.emit('line', { roomId, kind, line } satisfies LogLineEvent)
  }

  dispose(): void {
    for (const [, pump] of this.pumps) pump.kill()
    this.pumps.clear()
  }
}
