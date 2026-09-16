/**
 * The wire protocol between DevHotel on Windows and its private Linux runtime.
 *
 * #106 gave the guest one channel: a serial line that answers a health nonce.
 * That is enough to prove a runtime is alive and is deliberately not enough to
 * run Rooms on it — a Room needs to start containers, stream a dev server's log
 * for hours, and move files both ways. So the runtime gains a second channel,
 * and this module is the only thing on the Host that knows its shape.
 *
 * Design constraints that produced this framing rather than something smaller:
 *
 * - **Binary has to survive.** Room file transfer moves archives, not text, so
 *   a line-oriented protocol would need escaping on the hot path. Frames are
 *   length-prefixed and carry raw bytes.
 * - **Streams must interleave.** A build writes stdout while the Host is still
 *   writing stdin, and several Room operations run at once, so every frame
 *   carries a request id and the reader is a demultiplexer, not a queue.
 * - **A partial read is normal.** A serial line or a socket delivers arbitrary
 *   chunk boundaries, so decoding is incremental and holds back a partial frame
 *   instead of assuming a frame per chunk.
 * - **The Host must never trust a length.** A hostile or broken guest could
 *   claim a 4 GiB frame; the decoder refuses anything over the cap rather than
 *   allocating it.
 *
 * Frame layout, big-endian:
 *
 * ```text
 *   0      4      5      9
 *   +------+------+------+-------------------+
 *   | len  | type | id   | payload (len - 5) |
 *   +------+------+------+-------------------+
 * ```
 *
 * `len` counts everything after itself, so the minimum frame is 5 bytes.
 */

export const GUEST_FRAME_HEADER_BYTES = 9
/**
 * 8 MiB. Log and file-transfer payloads are chunked by the sender well below
 * this; the cap exists so one bad length cannot become one bad allocation.
 */
export const GUEST_FRAME_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

export const GuestFrameType = {
  /** Host → guest: a JSON request. The id is the caller's correlation handle. */
  Request: 1,
  /** Host → guest: raw stdin bytes for an in-flight request. */
  Stdin: 2,
  /** Host → guest: no more stdin for this request. */
  StdinEnd: 3,
  /** Guest → host: raw stdout bytes. */
  Stdout: 4,
  /** Guest → host: raw stderr bytes. */
  Stderr: 5,
  /** Guest → host: the terminal JSON result for a request. */
  Result: 6,
  /** Guest → host: the request failed before producing a result. */
  Error: 7,
  /** Host → guest: abandon this request and clean up. */
  Cancel: 8
} as const

export type GuestFrameTypeValue = (typeof GuestFrameType)[keyof typeof GuestFrameType]

const KNOWN_TYPES = new Set<number>(Object.values(GuestFrameType))

export interface GuestFrame {
  type: GuestFrameTypeValue
  id: number
  payload: Buffer
}

export function encodeGuestFrame(type: GuestFrameTypeValue, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (!KNOWN_TYPES.has(type)) throw new Error('unknown managed runtime frame type')
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error('managed runtime frame id is out of range')
  if (payload.byteLength > GUEST_FRAME_MAX_PAYLOAD_BYTES) {
    throw new Error('managed runtime frame payload exceeds its limit')
  }
  const frame = Buffer.allocUnsafe(GUEST_FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength + 5, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(id, 5)
  payload.copy(frame, GUEST_FRAME_HEADER_BYTES)
  return frame
}

export function encodeGuestJsonFrame(type: GuestFrameTypeValue, id: number, value: unknown): Buffer {
  return encodeGuestFrame(type, id, Buffer.from(JSON.stringify(value), 'utf8'))
}

/**
 * Incremental frame decoder.
 *
 * It is a class rather than a generator because the caller is a socket `data`
 * handler: bytes arrive whenever they arrive, and the leftover has to survive
 * between calls.
 */
export class GuestFrameDecoder {
  private buffered: Buffer = Buffer.alloc(0)

  /** Every complete frame the new bytes finished, in order. */
  push(chunk: Buffer): GuestFrame[] {
    this.buffered = this.buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk])
    const frames: GuestFrame[] = []
    for (;;) {
      if (this.buffered.byteLength < 4) break
      const declared = this.buffered.readUInt32BE(0)
      if (declared < 5) throw new Error('managed runtime frame is truncated')
      if (declared - 5 > GUEST_FRAME_MAX_PAYLOAD_BYTES) {
        throw new Error('managed runtime frame payload exceeds its limit')
      }
      const total = 4 + declared
      if (this.buffered.byteLength < total) break
      const type = this.buffered.readUInt8(4)
      if (!KNOWN_TYPES.has(type)) throw new Error('unknown managed runtime frame type')
      frames.push({
        type: type as GuestFrameTypeValue,
        id: this.buffered.readUInt32BE(5),
        payload: Buffer.from(this.buffered.subarray(GUEST_FRAME_HEADER_BYTES, total))
      })
      this.buffered = Buffer.from(this.buffered.subarray(total))
    }
    return frames
  }

  /** Bytes held back as an incomplete frame; a clean stream ends at zero. */
  get pending(): number {
    return this.buffered.byteLength
  }
}

/** The guest refuses every request until one `hello` proves this boot's token. */
export interface GuestHelloRequest {
  op: 'hello'
  token: string
}

/**
 * Run the guest's container-engine CLI. `argv` is passed through exactly, which
 * is what lets the Room code above keep speaking one CLI dialect regardless of
 * which side of the hypervisor boundary the engine is on.
 */
export interface GuestExecRequest {
  op: 'exec'
  argv: string[]
  timeoutMs?: number
  /** Stdin will follow as `Stdin` frames, terminated by `StdinEnd`. */
  stdin?: boolean
}

/** Write bytes the Host sends into a guest path, replacing it atomically. */
export interface GuestPutRequest {
  op: 'put'
  path: string
  mode?: number
}

/** Stream a guest path back as `Stdout` frames. */
export interface GuestGetRequest {
  op: 'get'
  path: string
}

export type GuestRequest = GuestHelloRequest | GuestExecRequest | GuestPutRequest | GuestGetRequest

export interface GuestExecResult {
  code: number
  /** Set when the guest killed the command at its deadline. */
  timedOut?: boolean
}

export function parseGuestResult(payload: Buffer): GuestExecResult {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw new Error('managed runtime returned an unreadable result')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('managed runtime returned an unreadable result')
  }
  const record = value as Record<string, unknown>
  const code = record['code']
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    throw new Error('managed runtime returned a result without an exit code')
  }
  return { code, ...(record['timedOut'] === true ? { timedOut: true } : {}) }
}

export function parseGuestError(payload: Buffer): string {
  try {
    const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    const message = value['message']
    // The guest's own text is data, never a Host diagnostic to be trusted or
    // echoed at length, so it is bounded here rather than wherever it surfaces.
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 500)
  } catch {
    /* fall through to the generic form */
  }
  return 'the managed runtime rejected the request'
}
