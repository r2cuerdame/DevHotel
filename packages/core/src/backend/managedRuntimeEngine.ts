import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OciEngineExecutor, RunDockerOpts } from './cli'
import type { ExecResult } from './types'
import {
  GuestFrameDecoder,
  GuestFrameType,
  encodeGuestFrame,
  encodeGuestJsonFrame,
  parseGuestError,
  parseGuestResult,
  type GuestFrame,
  type GuestRequest
} from './managedRuntimeGuestProtocol'
import { createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'

/**
 * A bidirectional byte channel to the guest agent.
 *
 * Kept abstract on purpose. The concrete carrier is a Host-side decision that
 * has changed once already (#106 wired a serial named pipe) and will change
 * again when the runtime grows a private network; everything above this
 * interface is indifferent to which one it is, and all of it is therefore
 * testable without a hypervisor.
 */
export interface ManagedRuntimeChannel {
  write(chunk: Buffer): void
  onData(listener: (chunk: Buffer) => void): void
  /**
   * Registers a close listener, and invokes it immediately when the channel is
   * *already* closed.
   *
   * That second half is load-bearing rather than defensive. A guest can drop the
   * line in the window between the socket connecting and this connection object
   * registering its listener — a saved VM resumed, an agent restarted — and a
   * close delivered to nobody is a close that never happened. Every Room
   * operation on that connection would then wait out its full timeout instead of
   * failing at once, which is the difference between a Room that reports a
   * broken runtime and a Lobby that appears to hang.
   */
  onClose(listener: (error?: Error) => void): void
  close(): void
}

export interface ManagedRuntimeEngineOptions {
  /** Opens a channel to the live guest agent, proving this boot's token. */
  connect: () => Promise<ManagedRuntimeChannel>
  /**
   * Endpoint identity recorded in the durable engine pin. It must name this
   * install's runtime, so Room volumes can never be silently attributed to a
   * different runtime that happens to answer on the same channel.
   */
  endpoint: string
  /** Default deadline for a guest command; mirrors the Host CLI's 120s. */
  defaultTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
/** Bytes per stdin/put frame. Small enough to interleave, large enough to move a volume. */
const CHUNK_BYTES = 256 * 1024

interface PendingRequest {
  onStdout: (chunk: Buffer) => void
  onStderr: (chunk: Buffer) => void
  settle: (result: { result?: ExecResult; error?: Error }) => void
}

/**
 * One multiplexed conversation with the guest agent.
 *
 * A connection is established lazily and reused: every Room operation shares
 * it, so the Host pays one handshake rather than one per `docker` invocation —
 * the opposite of the Host CLI, where each call is a process.
 */
class ManagedRuntimeConnection {
  private readonly decoder = new GuestFrameDecoder()
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed: Error | null = null

  constructor(private readonly channel: ManagedRuntimeChannel) {
    channel.onData((chunk) => {
      let frames: GuestFrame[]
      try {
        frames = this.decoder.push(chunk)
      } catch (error) {
        // A frame we cannot parse means the stream is no longer trustworthy;
        // continuing would attribute the guest's bytes to the wrong request.
        this.fail(error instanceof Error ? error : new Error('managed runtime stream is corrupt'))
        return
      }
      for (const frame of frames) this.dispatch(frame)
    })
    channel.onClose((error) => this.fail(error ?? new Error('the managed runtime closed the connection')))
  }

  get failure(): Error | null {
    return this.closed
  }

  private dispatch(frame: GuestFrame): void {
    const request = this.pending.get(frame.id)
    if (!request) return
    switch (frame.type) {
      case GuestFrameType.Stdout:
        request.onStdout(frame.payload)
        return
      case GuestFrameType.Stderr:
        request.onStderr(frame.payload)
        return
      case GuestFrameType.Result: {
        this.pending.delete(frame.id)
        try {
          const parsed = parseGuestResult(frame.payload)
          request.settle({
            result: {
              code: parsed.code,
              stdout: '',
              stderr: parsed.timedOut ? 'the managed runtime stopped the command at its deadline' : ''
            }
          })
        } catch (error) {
          request.settle({ error: error instanceof Error ? error : new Error(String(error)) })
        }
        return
      }
      case GuestFrameType.Error:
        this.pending.delete(frame.id)
        request.settle({ error: new Error(parseGuestError(frame.payload)) })
        return
      default:
        // Host-to-guest frame types coming back the other way are a protocol
        // violation, and silently ignoring them would hide a broken agent.
        this.pending.delete(frame.id)
        request.settle({ error: new Error('the managed runtime sent an unexpected frame') })
    }
  }

  private fail(error: Error): void {
    this.closed ??= error
    for (const [id, request] of [...this.pending]) {
      this.pending.delete(id)
      request.settle({ error })
    }
  }

  /**
   * Sends one request and resolves when the guest reports a terminal result.
   *
   * Stdout and stderr are handed to the caller as they arrive, so a Room log
   * follow never accumulates in the Host's heap.
   */
  async request(
    payload: GuestRequest,
    handlers: {
      onStdout?: (chunk: Buffer) => void
      onStderr?: (chunk: Buffer) => void
      stdin?: () => AsyncIterable<Buffer> | Iterable<Buffer>
      timeoutMs?: number | null
      signal?: AbortSignal
      onAbort?: () => Promise<void>
    } = {}
  ): Promise<ExecResult> {
    if (this.closed) throw this.closed
    const id = this.nextId
    // Ids wrap rather than grow without bound; a long-lived app can outlive
    // 2^32 short commands and an id must never be reused while in flight.
    this.nextId = this.nextId === 0xffffffff ? 1 : this.nextId + 1
    if (this.pending.has(id)) throw new Error('managed runtime request ids exhausted')

    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        if (handlers.signal && abortListener) handlers.signal.removeEventListener('abort', abortListener)
      }

      const settle = ({ result, error }: { result?: ExecResult; error?: Error }): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(result!)
      }

      const cancel = (error: Error): void => {
        if (settled) return
        this.pending.delete(id)
        try {
          this.channel.write(encodeGuestFrame(GuestFrameType.Cancel, id))
        } catch {
          /* the channel is already gone; the guest reaps the request itself */
        }
        const finish = (): void => settle({ error })
        if (handlers.onAbort) void Promise.resolve(handlers.onAbort()).then(finish, finish)
        else finish()
      }

      this.pending.set(id, {
        onStdout: handlers.onStdout ?? (() => {}),
        onStderr: handlers.onStderr ?? (() => {}),
        settle
      })

      try {
        this.channel.write(encodeGuestJsonFrame(GuestFrameType.Request, id, payload))
      } catch (error) {
        this.pending.delete(id)
        settle({ error: error instanceof Error ? error : new Error(String(error)) })
        return
      }

      const stdin = handlers.stdin
      if (stdin) {
        void (async () => {
          try {
            for await (const chunk of stdin()) {
              if (settled) return
              for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
                this.channel.write(
                  encodeGuestFrame(GuestFrameType.Stdin, id, chunk.subarray(offset, offset + CHUNK_BYTES))
                )
              }
            }
            if (!settled) this.channel.write(encodeGuestFrame(GuestFrameType.StdinEnd, id))
          } catch (error) {
            cancel(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      }

      if (handlers.timeoutMs !== null) {
        const ms = handlers.timeoutMs ?? DEFAULT_TIMEOUT_MS
        timer = setTimeout(() => {
          const error = new Error(`the managed runtime command timed out after ${ms}ms`)
          cancel(error)
        }, ms)
      }

      if (handlers.signal) {
        abortListener = () => {
          const reason = handlers.signal!.reason
          const error = reason instanceof Error ? reason : new Error('the managed runtime command was aborted')
          if (!(reason instanceof Error)) error.name = 'AbortError'
          cancel(error)
        }
        handlers.signal.addEventListener('abort', abortListener, { once: true })
        if (handlers.signal.aborted) abortListener()
      }
    })
  }
}

/**
 * Runs Room work inside the DevHotel-managed Linux runtime.
 *
 * It is an `OciEngineExecutor` and nothing more, which is the point: the Room
 * semantics, ownership labels, network model and volume generations above it do
 * not change when the engine moves inside a hypervisor. What changes is only
 * how argv gets to the engine and how its bytes come back.
 */
export class ManagedRuntimeEngine implements OciEngineExecutor {
  readonly endpoint: string
  private readonly connectChannel: () => Promise<ManagedRuntimeChannel>
  private readonly defaultTimeoutMs: number
  private connection: Promise<ManagedRuntimeConnection> | null = null

  constructor(opts: ManagedRuntimeEngineOptions) {
    this.endpoint = opts.endpoint
    this.connectChannel = opts.connect
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async connected(): Promise<ManagedRuntimeConnection> {
    const existing = this.connection ? await this.connection.catch(() => null) : null
    if (existing && !existing.failure) return existing
    // A dropped guest (a saved VM resumed, an agent restart) must not strand
    // every later Room operation, so a failed connection is replaced rather
    // than remembered.
    this.connection = this.connectChannel()
      .then((channel) => new ManagedRuntimeConnection(channel))
      .catch((error) => {
        this.connection = null
        throw error instanceof Error ? error : new Error(String(error))
      })
    return await this.connection
  }

  async run(args: string[], opts: RunDockerOpts = {}): Promise<ExecResult> {
    if (opts.input !== undefined && opts.inputFile) {
      throw new Error('the managed runtime accepts either input or inputFile, not both')
    }
    if (opts.outputFile && opts.onLine) {
      throw new Error('the managed runtime accepts either outputFile or onLine, not both')
    }
    if ((opts.onStdout || opts.onStderr) && (opts.outputFile || opts.onLine)) {
      throw new Error('the managed runtime accepts either chunk sinks or outputFile/onLine, not both')
    }
    const connection = await this.connected()

    const sinks = createOutputSinks(args, opts)
    try {
      const result = await connection.request(
        { op: 'exec', argv: args, ...(opts.input !== undefined || opts.inputFile ? { stdin: true } : {}) },
        {
          onStdout: sinks.onStdout,
          onStderr: sinks.onStderr,
          ...(opts.input !== undefined || opts.inputFile
            ? { stdin: () => inputStream(opts) }
            : {}),
          timeoutMs: opts.timeoutMs === null ? null : (opts.timeoutMs ?? this.defaultTimeoutMs),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onAbort ? { onAbort: opts.onAbort } : {})
        }
      )
      return sinks.finish(result)
    } finally {
      await sinks.dispose()
    }
  }

  /**
   * A long-lived guest command presented as a child process.
   *
   * `IsolationBackend` hands interactive exec and log follow to callers as a
   * `ChildProcessWithoutNullStreams`, and there is no process here — the work
   * runs on the other side of the hypervisor. Rather than widen that contract
   * across every caller, the streams are real and the control surface is
   * honest: `kill` cancels the guest request, `exitCode` and `close` report
   * what the guest reported.
   */
  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const proxy = new GuestProcess(stdin, stdout, stderr)

    void (async () => {
      try {
        const connection = await this.connected()
        const result = await connection.request(
          { op: 'exec', argv: args, stdin: true },
          {
            onStdout: (chunk) => stdout.write(chunk),
            onStderr: (chunk) => stderr.write(chunk),
            stdin: () => stdin,
            timeoutMs: null,
            signal: proxy.abortSignal
          }
        )
        proxy.finish(result.code)
      } catch (error) {
        proxy.failWith(error instanceof Error ? error : new Error(String(error)))
      }
    })()

    return proxy as unknown as ChildProcessWithoutNullStreams
  }

  /** Copy a Host file into the guest, for the paths a Room mount cannot cross. */
  async putFile(hostPath: string, guestPath: string, mode?: number): Promise<void> {
    const connection = await this.connected()
    const handle = await open(hostPath, 'r')
    try {
      const result = await connection.request(
        { op: 'put', path: guestPath, ...(mode === undefined ? {} : { mode }) },
        { stdin: () => handle.createReadStream({ autoClose: false }) as unknown as AsyncIterable<Buffer>, timeoutMs: null }
      )
      if (result.code !== 0) throw new Error(`the managed runtime refused to write ${guestPath}`)
    } finally {
      await handle.close()
    }
  }

  /** Copy a guest file out to the Host, the other half of Room file transfer. */
  async getFile(guestPath: string, hostPath: string): Promise<void> {
    const connection = await this.connected()
    const output = createWriteStream(hostPath)
    try {
      const result = await connection.request(
        { op: 'get', path: guestPath },
        { onStdout: (chunk) => output.write(chunk), timeoutMs: null }
      )
      if (result.code !== 0) throw new Error(`the managed runtime could not read ${guestPath}`)
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve())
        output.once('error', reject)
      })
    } catch (error) {
      output.destroy()
      throw error
    }
  }
}

function inputStream(opts: RunDockerOpts): AsyncIterable<Buffer> {
  if (opts.input !== undefined) {
    const value = Buffer.from(opts.input, 'utf8')
    return (async function* () {
      yield value
    })()
  }
  return (async function* () {
    const handle = await open(opts.inputFile!, 'r')
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      }
    } finally {
      await handle.close()
    }
  })()
}

/**
 * Reproduces `runDocker`'s output contract over guest frames.
 *
 * The Host CLI's caller options are not decoration — `outputFile` exists so a
 * multi-gigabyte export never enters the heap, `maxStdoutBytes` so a runaway
 * build cannot exhaust it, `onLine` so progress can be journaled. A managed
 * engine that honoured only the simple case would silently withdraw those
 * guarantees from every caller, so they are honoured here instead.
 */
function createOutputSinks(
  args: string[],
  opts: RunDockerOpts
): {
  onStdout: (chunk: Buffer) => void
  onStderr: (chunk: Buffer) => void
  finish: (result: ExecResult) => ExecResult
  dispose: () => Promise<void>
} {
  let stdout = ''
  let stderr = ''
  let outRest = ''
  let errRest = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputLimitExceeded = false
  const output = opts.outputFile ? createWriteStream(opts.outputFile) : null

  const feed = (rest: string, chunk: string): string => {
    const parts = (rest + chunk).split(/\r?\n/)
    const next = parts.pop() ?? ''
    if (opts.onLine) {
      for (const line of parts) if (line.length > 0) opts.onLine(line)
    }
    return next
  }

  const bounded = (chunk: Buffer, stream: 'stdout' | 'stderr'): Buffer | null => {
    if (outputLimitExceeded) return null
    const limit = stream === 'stdout' ? opts.maxStdoutBytes : opts.maxStderrBytes
    if (limit === undefined) return chunk
    const used = stream === 'stdout' ? stdoutBytes : stderrBytes
    const remaining = Math.max(0, limit - used)
    const captured = chunk.subarray(0, remaining)
    if (stream === 'stdout') stdoutBytes += captured.byteLength
    else stderrBytes += captured.byteLength
    if (chunk.byteLength > remaining) outputLimitExceeded = true
    return captured
  }

  return {
    onStdout: (chunk) => {
      const kept = bounded(chunk, 'stdout')
      if (!kept || kept.byteLength === 0) return
      if (output) {
        output.write(kept)
        return
      }
      if (opts.onStdout) {
        opts.onStdout(kept)
        return
      }
      const text = kept.toString('utf8')
      stdout += text
      outRest = feed(outRest, text)
    },
    onStderr: (chunk) => {
      const kept = bounded(chunk, 'stderr')
      if (!kept || kept.byteLength === 0) return
      if (opts.onStderr) {
        opts.onStderr(kept)
        return
      }
      const text = kept.toString('utf8')
      stderr += text
      errRest = feed(errRest, text)
    },
    finish: (result) => {
      if (opts.onLine) {
        if (outRest.length > 0) opts.onLine(outRest)
        if (errRest.length > 0) opts.onLine(errRest)
      }
      if (outputLimitExceeded) {
        if (opts.onStderr) opts.onStderr('\nthe managed runtime command exceeded its configured safety limit')
        else stderr += '\nthe managed runtime command exceeded its configured safety limit'
        return { code: -1, stdout, stderr, outputLimitExceeded: true }
      }
      if (result.stderr.length > 0) {
        const notice = `\n${args[0] ?? 'command'}: ${result.stderr}`
        if (opts.onStderr) opts.onStderr(notice)
        else stderr += notice
      }
      return { code: result.code, stdout, stderr }
    },
    dispose: async () => {
      if (!output) return
      await new Promise<void>((resolve) => output.end(() => resolve()))
    }
  }
}

/** The `ChildProcess` surface `IsolationBackend`'s streaming callers actually use. */
class GuestProcess {
  readonly pid = -1
  exitCode: number | null = null
  killed = false
  private readonly controller = new AbortController()
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  constructor(
    readonly stdin: PassThrough,
    readonly stdout: PassThrough,
    readonly stderr: PassThrough
  ) {}

  get abortSignal(): AbortSignal {
    return this.controller.signal
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener))
    return this
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.controller.abort()
    return true
  }

  finish(code: number): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
    this.emit('close', code, null)
  }

  failWith(error: Error): void {
    this.emit('error', error)
    this.stdout.destroy()
    this.stderr.destroy()
    this.emit('close', -1, null)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}
