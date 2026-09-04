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

/** Connect to a published relay and queue its authentication preamble first. */
export function connectRelay(port: number, token?: string): net.Socket {
  const socket = net.connect(port, '127.0.0.1')
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
 */
export function createHttpRelayConnection(
  port: number,
  token: string | undefined,
  oncreate: (err: Error | null, socket: net.Socket) => void
): undefined {
  const socket = net.connect(port, '127.0.0.1')
  socket.setNoDelay(true)
  let settled = false
  const finish = (err: Error | null): void => {
    if (settled) return
    settled = true
    socket.removeListener('error', onError)
    oncreate(err, socket)
  }
  const onError = (err: Error): void => finish(err)
  socket.once('error', onError)
  socket.once('connect', () => {
    if (!token) {
      finish(null)
      return
    }
    socket.write(relayPreamble(token), (err) => finish(err ?? null))
  })
  return undefined
}
