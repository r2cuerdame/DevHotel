import net from 'node:net'

/**
 * The published anchor port is an implementation detail, not a public Room
 * endpoint.  Docker Desktop makes host-published ports reachable from other
 * bridge networks, so every connection must prove it came through DevHotel's
 * host gateway before the anchor opens the in-Room connection.
 */
export const RELAY_PREAMBLE_PREFIX = 'DEVHOTEL/1 '

export function relayPreamble(token: string): string {
  if (!token || /[\r\n]/.test(token)) throw new Error('invalid DevHotel relay token')
  return `${RELAY_PREAMBLE_PREFIX}${token}\n`
}

/** Opens the loopback TCP connection to a published relay; injectable for tests. */
export type RelayDial = (port: number, host: string) => net.Socket

const dialRelay: RelayDial = (port, host) => net.connect(port, host)

/** Connect to a published relay and queue its authentication preamble first. */
export function connectRelay(port: number, token?: string, dial: RelayDial = dialRelay): net.Socket {
  const socket = dial(port, '127.0.0.1')
  socket.setNoDelay(true)
  // Queue before returning the socket. HTTP's ClientRequest may write as soon
  // as createConnection returns; a connect-event handler would otherwise race
  // the request bytes and let them become the first line seen by the gate.
  if (token) socket.write(relayPreamble(token))
  return socket
}

/**
 * Node's HTTP client needs the socket only after the gate preamble has been
 * flushed. Returning a socket immediately lets ClientRequest race its bytes
 * ahead of the preamble, so HTTP callers use the asynchronous callback form.
 *
 * Aborting `signal` before `oncreate` destroys the dialing socket: nothing is
 * written after the abort and `oncreate` is never called, so the caller must
 * destroy its own ClientRequest.
 */
export function createHttpRelayConnection(
  port: number,
  token: string | undefined,
  oncreate: (err: Error | null, socket: net.Socket) => void,
  opts: { signal?: AbortSignal; dial?: RelayDial } = {}
): undefined {
  const { signal } = opts
  if (signal?.aborted) return undefined
  const socket = (opts.dial ?? dialRelay)(port, '127.0.0.1')
  socket.setNoDelay(true)
  let settled = false
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    socket.removeListener('error', onError)
    signal?.removeEventListener('abort', onAbort)
    return true
  }
  const finish = (err: Error | null): void => {
    if (settle()) oncreate(err, socket)
  }
  const onError = (err: Error): void => finish(err)
  const onAbort = (): void => {
    if (!settle()) return
    socket.on('error', () => {})
    socket.destroy()
  }
  socket.once('error', onError)
  signal?.addEventListener('abort', onAbort, { once: true })
  socket.once('connect', () => {
    if (settled) return
    if (!token) {
      finish(null)
      return
    }
    socket.write(relayPreamble(token), (err) => finish(err ?? null))
  })
  return undefined
}
