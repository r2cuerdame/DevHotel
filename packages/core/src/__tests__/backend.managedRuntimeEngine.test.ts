import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GuestFrameDecoder,
  GuestFrameType,
  encodeGuestFrame,
  encodeGuestJsonFrame,
  GUEST_FRAME_MAX_PAYLOAD_BYTES
} from '../backend/managedRuntimeGuestProtocol'
import { ManagedRuntimeEngine, type ManagedRuntimeChannel } from '../backend/managedRuntimeEngine'
import { until } from './timing'

/**
 * A guest agent that runs entirely in this process.
 *
 * It answers the same frames the real agent answers, which is what makes the
 * Host half of #107 provable without a hypervisor: everything above the channel
 * — argv delivery, stdin, interleaved output, output caps, timeouts, file
 * staging — is exercised against a real protocol implementation rather than a
 * mock of the executor.
 */
class FakeGuest {
  readonly requests: { id: number; request: Record<string, unknown> }[] = []
  readonly stdin = new Map<number, Buffer[]>()
  readonly cancelled: number[] = []
  private listener: ((chunk: Buffer) => void) | null = null
  private closeListener: ((error?: Error) => void) | null = null
  private readonly decoder = new GuestFrameDecoder()
  /** What to do when a request arrives; the default is a silent success. */
  handler: (guest: FakeGuest, id: number, request: Record<string, unknown>) => void = (guest, id) =>
    guest.result(id, 0)

  readonly channel: ManagedRuntimeChannel = {
    write: (chunk) => {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.type === GuestFrameType.Request) {
          const request = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>
          this.requests.push({ id: frame.id, request })
          this.handler(this, frame.id, request)
        } else if (frame.type === GuestFrameType.Stdin) {
          this.stdin.set(frame.id, [...(this.stdin.get(frame.id) ?? []), frame.payload])
        } else if (frame.type === GuestFrameType.Cancel) {
          this.cancelled.push(frame.id)
        }
      }
    },
    onData: (listener) => {
      this.listener = listener
    },
    onClose: (listener) => {
      this.closeListener = listener
      // Same contract the real channel honours: a close that already happened
      // is reported to a listener that registers afterwards.
      if (this.closed) listener(this.closed.error)
    },
    close: () => this.drop()
  }

  private closed: { error?: Error } | null = null

  private send(frame: Buffer): void {
    this.listener?.(frame)
  }

  stdout(id: number, text: string | Buffer): void {
    this.send(encodeGuestFrame(GuestFrameType.Stdout, id, Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')))
  }

  stderr(id: number, text: string): void {
    this.send(encodeGuestFrame(GuestFrameType.Stderr, id, Buffer.from(text, 'utf8')))
  }

  result(id: number, code: number, extra: Record<string, unknown> = {}): void {
    this.send(encodeGuestJsonFrame(GuestFrameType.Result, id, { code, ...extra }))
  }

  reject(id: number, message: string): void {
    this.send(encodeGuestJsonFrame(GuestFrameType.Error, id, { message }))
  }

  drop(error?: Error): void {
    this.closed ??= error ? { error } : {}
    this.closeListener?.(error)
  }

  stdinText(id: number): string {
    return Buffer.concat(this.stdin.get(id) ?? []).toString('utf8')
  }
}

function engineFor(guest: FakeGuest, opts: { endpoint?: string } = {}): ManagedRuntimeEngine {
  return new ManagedRuntimeEngine({
    endpoint: opts.endpoint ?? 'managed-linux:test-runtime',
    connect: async () => guest.channel
  })
}

describe('managed runtime frame protocol', () => {
  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const frame = encodeGuestJsonFrame(GuestFrameType.Request, 7, { op: 'exec', argv: ['ps'] })
    const decoder = new GuestFrameDecoder()
    const collected = []
    for (const byte of frame) collected.push(...decoder.push(Buffer.from([byte])))
    expect(collected).toHaveLength(1)
    expect(collected[0]!.id).toBe(7)
    expect(JSON.parse(collected[0]!.payload.toString('utf8'))).toEqual({ op: 'exec', argv: ['ps'] })
    expect(decoder.pending).toBe(0)
  })

  it('returns several frames delivered in one chunk, in order', () => {
    const decoder = new GuestFrameDecoder()
    const frames = decoder.push(
      Buffer.concat([
        encodeGuestFrame(GuestFrameType.Stdout, 1, Buffer.from('a')),
        encodeGuestFrame(GuestFrameType.Stderr, 1, Buffer.from('b')),
        encodeGuestJsonFrame(GuestFrameType.Result, 1, { code: 0 })
      ])
    )
    expect(frames.map((frame) => frame.type)).toEqual([
      GuestFrameType.Stdout,
      GuestFrameType.Stderr,
      GuestFrameType.Result
    ])
  })

  it('refuses a declared payload larger than the cap instead of allocating it', () => {
    const decoder = new GuestFrameDecoder()
    const header = Buffer.alloc(9)
    header.writeUInt32BE(GUEST_FRAME_MAX_PAYLOAD_BYTES + 6, 0)
    header.writeUInt8(GuestFrameType.Stdout, 4)
    expect(() => decoder.push(header)).toThrow(/payload exceeds its limit/)
  })

  it('refuses a frame shorter than its own header and an unknown type', () => {
    const short = Buffer.alloc(4)
    short.writeUInt32BE(2, 0)
    expect(() => new GuestFrameDecoder().push(short)).toThrow(/truncated/)

    const unknown = Buffer.alloc(9)
    unknown.writeUInt32BE(5, 0)
    unknown.writeUInt8(99, 4)
    expect(() => new GuestFrameDecoder().push(unknown)).toThrow(/unknown managed runtime frame type/)
  })
})

describe('ManagedRuntimeEngine', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-managed-engine-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('delivers argv unchanged and returns the guest exit code and output', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stdout(id, 'container-id\n')
      self.result(id, 0)
    }

    const result = await engineFor(guest).run(['ps', '-a', '--filter', 'label=devhotel.managed=1'])

    expect(guest.requests[0]!.request).toMatchObject({
      op: 'exec',
      argv: ['ps', '-a', '--filter', 'label=devhotel.managed=1']
    })
    expect(result).toMatchObject({ code: 0, stdout: 'container-id\n' })
  })

  it('reports a non-zero exit code rather than throwing, as the Host CLI does', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stderr(id, 'no such container')
      self.result(id, 1)
    }

    await expect(engineFor(guest).run(['inspect', 'dh-r1-web'])).resolves.toMatchObject({
      code: 1,
      stderr: 'no such container'
    })
  })

  it('sends caller input as stdin frames without putting it in argv', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => setTimeout(() => self.result(id, 0), 5)

    await engineFor(guest).run(['run', '--rm', '-i', 'alpine/git'], { input: 'octocat\nsecret-token\n' })

    const { id, request } = guest.requests[0]!
    expect(request).toMatchObject({ stdin: true })
    expect(JSON.stringify(request.argv)).not.toContain('secret-token')
    expect(guest.stdinText(id)).toBe('octocat\nsecret-token\n')
  })

  it('streams output to a chunk sink instead of accumulating it', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stdout(id, 'first\n')
      self.stdout(id, 'second\n')
      self.result(id, 0)
    }
    const chunks: string[] = []

    const result = await engineFor(guest).run(['logs', '-f', 'dh-r1-web'], {
      onStdout: (chunk) => chunks.push(chunk.toString())
    })

    expect(chunks.join('')).toBe('first\nsecond\n')
    expect(result.stdout).toBe('')
  })

  it('honours a stdout byte cap the way the Host CLI does', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stdout(id, 'x'.repeat(50))
      self.result(id, 0)
    }

    const result = await engineFor(guest).run(['logs', 'dh-r1-web'], { maxStdoutBytes: 10 })

    expect(result.outputLimitExceeded).toBe(true)
    expect(result.code).toBe(-1)
    expect(result.stdout).toBe('x'.repeat(10))
  })

  it('reports lines to onLine, including a trailing partial line', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stdout(id, 'pulling\nextracting\nno-newline')
      self.result(id, 0)
    }
    const lines: string[] = []

    await engineFor(guest).run(['pull', 'node:22'], { onLine: (line) => lines.push(line) })

    expect(lines).toEqual(['pulling', 'extracting', 'no-newline'])
  })

  it('streams to a Host file without accumulating it in memory', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => {
      self.stdout(id, 'exported-bytes')
      self.result(id, 0)
    }
    const target = join(dir, 'export.tar')

    const result = await engineFor(guest).run(['save', 'node:22'], { outputFile: target })

    expect(result.stdout).toBe('')
    expect(readFileSync(target, 'utf8')).toBe('exported-bytes')
  })

  it('cancels the guest request at its deadline and reports the timeout', async () => {
    const guest = new FakeGuest()
    guest.handler = () => {} // never answers

    await expect(engineFor(guest).run(['stop', 'dh-r1-web'], { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/)
    expect(guest.cancelled).toEqual([guest.requests[0]!.id])
  })

  it('cancels on an abort signal and runs the ownership-safe cleanup the caller gave', async () => {
    const guest = new FakeGuest()
    guest.handler = () => {}
    const controller = new AbortController()
    let cleaned = false

    const pending = engineFor(guest).run(['run', '--rm', 'node:22'], {
      signal: controller.signal,
      onAbort: async () => {
        cleaned = true
      }
    })
    controller.abort()

    await expect(pending).rejects.toThrow(/aborted/)
    expect(cleaned).toBe(true)
    expect(guest.cancelled).toHaveLength(1)
  })

  it('never leaves a caller hanging when the runtime drops the connection', async () => {
    const guest = new FakeGuest()
    guest.handler = () => {}

    const pending = engineFor(guest).run(['ps'], { timeoutMs: 5_000 })
    guest.drop()

    await expect(pending).rejects.toThrow(/closed the connection/)
  })

  it('reconnects after a dropped connection instead of failing every later Room operation', async () => {
    const first = new FakeGuest()
    first.handler = () => {}
    const second = new FakeGuest()
    second.handler = (self, id) => self.result(id, 0)
    const channels = [first.channel, second.channel]
    const engine = new ManagedRuntimeEngine({
      endpoint: 'managed-linux:test-runtime',
      connect: async () => channels.shift()!
    })

    const failing = engine.run(['ps'], { timeoutMs: 5_000 })
    first.drop()
    await expect(failing).rejects.toThrow()

    await expect(engine.run(['ps'])).resolves.toMatchObject({ code: 0 })
  })

  it('surfaces a guest rejection as an error rather than a successful exit code', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => self.reject(id, 'unauthorized')

    await expect(engineFor(guest).run(['ps'])).rejects.toThrow(/unauthorized/)
  })

  it('keeps concurrent Room operations on their own streams', async () => {
    const guest = new FakeGuest()
    const seen: number[] = []
    guest.handler = (self, id) => {
      seen.push(id)
      // Answer in reverse order, so a queue rather than a demultiplexer fails.
      if (seen.length === 2) {
        self.stdout(seen[1]!, 'second')
        self.result(seen[1]!, 0)
        self.stdout(seen[0]!, 'first')
        self.result(seen[0]!, 0)
      }
    }
    const engine = engineFor(guest)

    const [one, two] = await Promise.all([engine.run(['inspect', 'a']), engine.run(['inspect', 'b'])])

    expect(one.stdout).toBe('first')
    expect(two.stdout).toBe('second')
  })

  it('presents a long-lived guest command as a process whose kill cancels it', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => self.stdout(id, 'log line\n')
    const engine = engineFor(guest)

    const child = engine.spawn(['logs', '-f', 'dh-r1-web'])
    const chunks: string[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    await until(() => chunks.join('') === 'log line\n', { what: 'the streamed log line' })
    expect(chunks.join('')).toBe('log line\n')

    expect(child.kill()).toBe(true)
    await until(() => guest.cancelled.length === 1, { what: 'the guest cancel frame' })
    expect(guest.cancelled).toHaveLength(1)
  })

  it('stages a Host file into the guest and brings a guest file back', async () => {
    const guest = new FakeGuest()
    const source = join(dir, 'input.txt')
    writeFileSync(source, 'host bytes')
    guest.handler = (self, id, request) => {
      if (request.op === 'put') {
        setTimeout(() => self.result(id, 0), 5)
        return
      }
      self.stdout(id, 'guest bytes')
      self.result(id, 0)
    }
    const engine = engineFor(guest)

    await engine.putFile(source, 'staged-input')
    expect(guest.requests[0]!.request).toMatchObject({ op: 'put', path: 'staged-input' })
    expect(guest.stdinText(guest.requests[0]!.id)).toBe('host bytes')

    const target = join(dir, 'output.txt')
    await engine.getFile('staged-output', target)
    expect(guest.requests[1]!.request).toMatchObject({ op: 'get', path: 'staged-output' })
    expect(readFileSync(target, 'utf8')).toBe('guest bytes')
  })

  it('refuses a transfer the guest rejected rather than leaving a truncated file', async () => {
    const guest = new FakeGuest()
    guest.handler = (self, id) => self.reject(id, 'path escapes the DevHotel staging root')
    const source = join(dir, 'input.txt')
    writeFileSync(source, 'host bytes')

    await expect(engineFor(guest).putFile(source, '../escape')).rejects.toThrow(/staging root/)
  })

  it('names its endpoint after the runtime, so a Room pin cannot follow the wrong one', () => {
    expect(engineFor(new FakeGuest(), { endpoint: 'managed-linux:abc' }).endpoint).toBe('managed-linux:abc')
  })
})
