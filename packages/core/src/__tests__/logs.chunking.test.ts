import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REDACTED_SECRET } from '../diagnostics/redact'
import type { LogLineEvent } from '../logs'
import { LogHub, MAX_LOG_LINE_CHARS } from '../logs'
import { FakeBackend } from './fakes'

interface FakeLogChild {
  stdout: EventEmitter
  stderr: EventEmitter
  out(bytes: Buffer | string): void
  err(bytes: Buffer | string): void
  close(): void
  kill: ReturnType<typeof vi.fn>
}

function logChild(): FakeLogChild & EventEmitter {
  const child = new EventEmitter() as FakeLogChild & EventEmitter
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.out = (bytes) => child.stdout.emit('data', Buffer.from(bytes))
  child.err = (bytes) => child.stderr.emit('data', Buffer.from(bytes))
  child.close = () => child.emit('close', 0)
  child.kill = vi.fn(() => true)
  return child
}

class StreamingBackend extends FakeBackend {
  readonly children: (FakeLogChild & EventEmitter)[] = []
  override async followRoomLogs(): Promise<ChildProcessWithoutNullStreams> {
    const child = logChild()
    this.children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function attached(roomId = 'room1abc') {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-log-chunks-'))
  dirs.push(userData)
  const backend = new StreamingBackend()
  const logs = new LogHub(userData, backend)
  const emitted: string[] = []
  logs.on('line', (event: LogLineEvent) => {
    if (event.kind === 'web') emitted.push(event.line)
  })
  logs.attach(roomId)
  await vi.waitFor(() => expect(backend.children).toHaveLength(1))
  // followRoomLogs resolves first; the pump registers on the next microtask.
  await new Promise((resolve) => setImmediate(resolve))
  const child = backend.children[0]!
  const file = (): string[] => {
    try {
      return readFileSync(logs.logFile(roomId, 'web'), 'utf8').split('\n').filter((l) => l.length > 0)
    } catch {
      return []
    }
  }
  return { logs, backend, child, emitted, file }
}

describe('LogHub chunked Room output', () => {
  it('keeps a multi-byte character intact when its bytes straddle two chunks', async () => {
    const { logs, child, emitted, file } = await attached()
    const bytes = Buffer.from('방 기록 한글\n', 'utf8')
    // Split inside the three-byte encoding of '한'.
    const at = Buffer.from('방 기록 ', 'utf8').length + 1
    child.out(bytes.subarray(0, at))
    child.out(bytes.subarray(at))

    expect(emitted).toEqual(['방 기록 한글'])
    expect(file()).toEqual(['방 기록 한글'])
    expect(file().join('')).not.toContain('�')
    logs.dispose()
  })

  it('logs a line split across chunks once and never joins partial stdout and stderr lines', async () => {
    const { logs, child, emitted, file } = await attached()
    child.out('server listen')
    child.err('warn: depre')
    child.out('ing on :3000\nready')
    child.err('cated option\r\n')
    child.out(' in 12ms\n')

    expect(emitted).toEqual(['server listening on :3000', 'warn: deprecated option', 'ready in 12ms'])
    expect(file()).toEqual(emitted)
    logs.dispose()
  })

  it('redacts a GitHub token whose prefix and body arrive in different chunks', async () => {
    const { logs, child, emitted, file } = await attached()
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
    child.out(`clone with ${token.slice(0, 6)}`)
    child.out(`${token.slice(6, 20)}`)
    child.out(`${token.slice(20)} done\n`)

    expect(emitted).toEqual([`clone with ${REDACTED_SECRET} done`])
    expect(file()).toEqual(emitted)
    for (const sink of [emitted.join('\n'), file().join('\n')]) {
      expect(sink).not.toContain(token)
      expect(sink).not.toContain(token.slice(6, 20))
    }
    logs.dispose()
  })

  it('flushes an unterminated last line exactly once when the stream closes', async () => {
    const { logs, child, emitted, file } = await attached()
    child.out('first\nlast line without newline')
    child.err(Buffer.from([0xed, 0x95])) // first two bytes of '한'
    child.err(Buffer.from([0x9c]))
    child.close()
    child.close()
    logs.detach('room1abc')
    logs.dispose()

    expect(emitted).toEqual(['first', 'last line without newline', '한'])
    expect(file()).toEqual(emitted)
  })

  it('flushes buffered output on detach and ignores data the detached pump delivers later', async () => {
    const { logs, child, emitted, file } = await attached()
    child.out('partial before detach')
    logs.detach('room1abc')
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.out(' tail after detach\nlate line\n')
    child.close()
    logs.dispose()

    expect(emitted).toEqual(['partial before detach'])
    expect(file()).toEqual(['partial before detach'])
  })

  it('flushes buffered output on dispose', async () => {
    const { logs, child, emitted } = await attached()
    child.err('shutting down')
    logs.dispose()
    child.err(' later\n')

    expect(emitted).toEqual(['shutting down'])
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('splits endless output without a newline at the line cap instead of buffering it forever', async () => {
    const { logs, child, emitted } = await attached()
    const piece = 'x'.repeat(4096)
    const pieces = Math.ceil((MAX_LOG_LINE_CHARS * 2.5) / piece.length)
    for (let i = 0; i < pieces; i++) child.out(piece)

    expect(emitted).toHaveLength(2)
    for (const line of emitted) expect(line.length).toBe(MAX_LOG_LINE_CHARS)
    logs.dispose()
    expect(emitted).toHaveLength(3)
    expect(emitted.join('').length).toBe(pieces * piece.length)
  })

  it('prefers whitespace when forcing a split so a token near the cap stays whole', async () => {
    const { logs, child, emitted } = await attached()
    const token = `ghp_${'Z9y8X7w6V5'.repeat(4)}`
    const filler = 'a'.repeat(MAX_LOG_LINE_CHARS - 20)
    child.out(`${filler} ${token} `)
    child.out('b'.repeat(MAX_LOG_LINE_CHARS))
    logs.dispose()

    // A plain cut at the cap would leave the token's tail on a line of its own,
    // where the prefixed pattern can no longer recognise it.
    const sinks = emitted.join('\n')
    expect(sinks).not.toContain(token.slice(4, 19))
    expect(sinks).not.toContain(token.slice(-20))
    expect(emitted.some((line) => line.includes(REDACTED_SECRET))).toBe(true)
  })

  function fill(child: FakeLogChild, char: string, length: number): void {
    for (let sent = 0; sent < length; sent += 4096) child.out(char.repeat(Math.min(4096, length - sent)))
  }

  for (const ending of ['newline', 'more output', 'stream end'] as const) {
    it(`redacts a compact token straddling the line cap with no whitespace nearby (${ending})`, async () => {
      const { logs, child, emitted, file } = await attached()
      const token = `ghp_${'Q1w2E3r4T5'.repeat(4)}`
      fill(child, 'x', MAX_LOG_LINE_CHARS - 10)
      child.out(`:${token}`)
      if (ending === 'newline') child.out('\n')
      if (ending === 'more output') fill(child, 'y', MAX_LOG_LINE_CHARS)
      logs.dispose()

      for (const sink of [emitted.join('\n'), file().join('\n')]) {
        expect(sink).not.toContain(token.slice(4, 14))
        expect(sink).not.toContain(token.slice(-20))
      }
      expect(emitted.some((line) => line.startsWith(REDACTED_SECRET))).toBe(true)
      expect(emitted.every((line) => line.length <= MAX_LOG_LINE_CHARS)).toBe(true)
    })
  }

  it('cuts compact key=value output before a keyed secret that straddles the line cap', async () => {
    const { logs, child, emitted } = await attached()
    const secret = 'hunter2-Sup3rS3cretValue-0123456789'
    fill(child, 'q', MAX_LOG_LINE_CHARS - 30)
    child.out(`&user=dev&password=${secret}&next=1\n`)
    logs.dispose()

    expect(emitted.join('\n')).not.toContain(secret.slice(0, 12))
    expect(emitted.join('\n')).not.toContain(secret.slice(-12))
    expect(emitted.some((line) => line.includes(`password=${REDACTED_SECRET}`))).toBe(true)
  })

  it('masks the rest of a line whose secret-shaped value is longer than the cap', async () => {
    const { logs, child, emitted, file } = await attached()
    child.out('token=')
    fill(child, 'v', MAX_LOG_LINE_CHARS * 2)
    child.out(' trailing\nnext line\n')
    logs.dispose()

    expect(emitted).toEqual([`token=${REDACTED_SECRET}`, 'next line'])
    expect(file()).toEqual(emitted)
  })
})
