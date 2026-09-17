import net from 'node:net'
import { OciCliBackend, type OciCliBackendOptions } from './ociCli'
import { ManagedRoomBackend } from './managedRoomBackend'
import { ManagedRuntimeEngine, type ManagedRuntimeChannel } from './managedRuntimeEngine'
import { ManagedRuntimeIngress } from './managedRuntimeIngress'
import { GuestFrameType, encodeGuestFrame, encodeGuestJsonFrame, GuestFrameDecoder } from './managedRuntimeGuestProtocol'
import type { IsolationBackend } from './types'
import type { IngressLedger } from '../lifecycle/ingressLedger'
import type { ManagedHyperVGuestChannel } from './managedHyperVRuntime'

/**
 * How a Room's executor is chosen, and why the choice is made once per launch.
 *
 * A Room's volumes live in exactly one engine. If DevHotel picked the managed
 * runtime for a Room created on the compatibility backend, the Room would come
 * up with an empty workspace — the engine identity pin makes that a refusal
 * rather than data loss, but a refusal the user cannot act on is still a broken
 * Room. So selection happens before any Room work, it is reported, and it never
 * changes underneath a running app.
 */
export type RoomRuntimeMode = 'managed' | 'compatibility'

export interface RoomRuntimeSelection {
  mode: RoomRuntimeMode
  backend: IsolationBackend
  /** Why this mode was selected, for the product-level runtime card. */
  detail: string
  /** Released on shutdown; only the managed mode holds Host ports. */
  dispose: () => Promise<void>
  /**
   * Closes one Room's Host ingress port and forgets its durable record.
   *
   * Present in both modes, and that is deliberate. The compatibility backend
   * opens no Host forwarder of its own, but this install may have run in
   * managed mode last time and left records behind; a machine that switched
   * modes must still be able to settle what the other mode wrote down.
   */
  revokeIngress: (roomId: string) => Promise<void>
}

export interface SelectRoomRuntimeOptions {
  /** The runtime's live channel facts, or null when it is not usable yet. */
  channel: ManagedHyperVGuestChannel | null
  /** Endpoint identity recorded in the durable engine pin for managed Rooms. */
  runtimeId: string | null
  compatibility: OciCliBackendOptions
  /** Test seam for the guest socket. */
  connect?: (channel: ManagedHyperVGuestChannel) => Promise<ManagedRuntimeChannel>
  onIngressError?: (error: Error) => void
  /** Durable record of the Host ingress ports this install opened. */
  ingressLedger?: IngressLedger
}

/**
 * Opens the Room command channel and completes the `hello` handshake.
 *
 * The handshake is not decoration: the guest refuses every other operation
 * until it has seen this boot's token, and the token only ever reaches the Host
 * over the private serial line. That is what makes possession of it proof that
 * the caller is this DevHotel install rather than any other process that can
 * reach the runtime's address.
 */
export async function connectGuestChannel(channel: ManagedHyperVGuestChannel): Promise<ManagedRuntimeChannel> {
  const socket = net.connect({ host: channel.address, port: channel.port })
  socket.setNoDelay(true)
  const decoder = new GuestFrameDecoder()
  const listeners: ((chunk: Buffer) => void)[] = []
  const closeListeners: ((error?: Error) => void)[] = []
  /**
   * Bytes that arrived before a listener was attached.
   *
   * The guest may answer the handshake and the first Room request in the same
   * TCP segment, and it will certainly answer faster than the caller can
   * register a listener. Anything not for the handshake is therefore held and
   * replayed, because a dropped frame here is a Room operation that never
   * completes.
   */
  const buffered: Buffer[] = []
  const deliver = (chunk: Buffer): void => {
    if (listeners.length === 0) {
      buffered.push(chunk)
      return
    }
    for (const listener of listeners) listener(chunk)
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('the managed runtime did not accept the Room command channel')), 30_000)
    socket.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    socket.once('connect', () => {
      socket.write(encodeGuestJsonFrame(GuestFrameType.Request, 1, { op: 'hello', token: channel.token }))
    })
    const onData = (chunk: Buffer): void => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        clearTimeout(timer)
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      for (const [index, frame] of frames.entries()) {
        if (frame.id !== 1) continue
        clearTimeout(timer)
        socket.removeListener('data', onData)
        if (frame.type !== GuestFrameType.Result) {
          fail(new Error('the managed runtime rejected the Room command channel'))
          return
        }
        // Frames that shared the handshake's chunk are already decoded, so they
        // are re-encoded and held rather than lost with the rest of the chunk.
        for (const trailing of frames.slice(index + 1)) {
          deliver(encodeGuestFrame(trailing.type, trailing.id, trailing.payload))
        }
        socket.on('data', deliver)
        resolve()
        return
      }
    }
    socket.on('data', onData)
  })

  // A close that arrives before the connection registers its listener must not
  // be lost, so it is remembered and replayed to a late listener.
  let closed: { error?: Error } | null = null
  const reportClosed = (error?: Error): void => {
    closed ??= error ? { error } : {}
    for (const listener of closeListeners) listener(error)
  }
  socket.on('close', () => reportClosed())
  socket.on('error', (error) => reportClosed(error))

  return {
    write: (chunk) => socket.write(chunk),
    onData: (listener) => {
      listeners.push(listener)
      // Whatever arrived before anyone was listening is delivered now, in order.
      for (const chunk of buffered.splice(0)) listener(chunk)
    },
    onClose: (listener) => {
      closeListeners.push(listener)
      if (closed) listener(closed.error)
    },
    close: () => socket.destroy()
  }
}

/**
 * Chooses the Room executor for this launch.
 *
 * The managed runtime is preferred and the compatibility backend is the
 * fallback, not the other way round — but the fallback is unconditional and
 * silent about nothing: a Host whose runtime is still preparing, or whose
 * Hyper-V gate has not been passed, keeps working on the external engine and is
 * told which one it got.
 */
export async function selectRoomRuntime(opts: SelectRoomRuntimeOptions): Promise<RoomRuntimeSelection> {
  const compatibility = (detail: string): RoomRuntimeSelection => ({
    mode: 'compatibility',
    backend: new OciCliBackend(opts.compatibility),
    detail,
    dispose: async () => {},
    // Nothing is listening in this mode, so revoking is exactly forgetting.
    revokeIngress: async (roomId: string) => {
      opts.ingressLedger?.forget(roomId)
    }
  })

  if (!opts.channel || !opts.runtimeId) {
    return compatibility('Rooms are running on the external compatibility engine; the DevHotel runtime is not ready.')
  }

  const ingress = new ManagedRuntimeIngress({
    ...(opts.onIngressError ? { onError: opts.onIngressError } : {}),
    ...(opts.ingressLedger ? { ledger: opts.ingressLedger } : {}),
    runtimeId: opts.runtimeId
  })
  const connect = opts.connect ?? connectGuestChannel
  const channel = opts.channel
  const engine = new ManagedRuntimeEngine({
    // The endpoint names this install's runtime, so a Room's volumes can never
    // be attributed to a different runtime that happens to answer the address.
    endpoint: `managed-linux:${opts.runtimeId}`,
    connect: () => connect(channel)
  })

  const backend = new ManagedRoomBackend({
    ...opts.compatibility,
    engine,
    ingress,
    guestAddress: channel.address
  })

  // Selection is only real once the guest engine answers. A managed mode that
  // reported itself selected and then failed every Room create would be worse
  // than the compatibility backend it replaced.
  const health = await backend.health().catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error)
  }))
  if (!health.ok) {
    await ingress.revokeAll()
    return compatibility(`Rooms are running on the external compatibility engine; the DevHotel runtime reported: ${health.detail}`)
  }

  return {
    mode: 'managed',
    backend,
    detail: 'Rooms are running on the DevHotel-managed Linux runtime.',
    dispose: async () => {
      await ingress.revokeAll()
    },
    revokeIngress: async (roomId: string) => {
      await ingress.revoke(roomId)
    }
  }
}
