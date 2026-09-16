import net from 'node:net'

/**
 * Host loopback forwarders for Rooms whose published ports live inside the
 * managed runtime.
 *
 * A Room's ingress contract is already settled and #107 must not disturb it:
 * the anchor container publishes the relay gate on an ephemeral port, the
 * Gateway proxies `https://<room>.localhost` to `127.0.0.1:<port>` and crosses
 * the gate with the Room's relay token. Two Rooms can therefore both serve
 * internal port 3000, because each one has its own network namespace and its
 * own Host port.
 *
 * With the engine inside a hypervisor, `-p 127.0.0.1:0:3999` publishes on the
 * *guest's* loopback, which the Host cannot reach. The alternative to this
 * forwarder would be rewriting the Gateway to speak to guest addresses — which
 * would mean the ingress path, the relay token check and the TLS terminator all
 * grow a second mode, and every Room route would then depend on a guest IP that
 * changes when the runtime reboots.
 *
 * Instead the Host keeps offering exactly what it offered before: a loopback
 * port per Room. The forwarder is the only thing that knows there is a VM, and
 * the relay token still gates the connection end to end, because the forwarder
 * copies bytes and never interprets them.
 */
export interface ManagedIngressTarget {
  /** Where the guest published this Room's relay gate. */
  host: string
  port: number
}

export interface ManagedIngressRoute {
  /** The loopback port the Gateway already has in the Room record. */
  hostPort: number
  close: () => Promise<void>
}

export interface ManagedRuntimeIngressOptions {
  /**
   * Opens a connection to the guest-side published port. Injected so the
   * forwarder is testable, and so a later carrier (a private switch today, a
   * hypervisor socket tomorrow) does not change this file.
   */
  connect?: (target: ManagedIngressTarget) => net.Socket
  onError?: (error: Error) => void
}

export class ManagedRuntimeIngress {
  private readonly routes = new Map<string, ManagedIngressRoute>()
  private readonly connect: (target: ManagedIngressTarget) => net.Socket
  private readonly onError: (error: Error) => void

  constructor(opts: ManagedRuntimeIngressOptions = {}) {
    this.connect = opts.connect ?? ((target) => net.connect(target.port, target.host))
    this.onError = opts.onError ?? (() => {})
  }

  /**
   * Publishes one Room on Host loopback and returns the port the Gateway should
   * route to. Re-publishing a Room replaces its forwarder, which is what a wake
   * after the guest reassigned ports needs.
   */
  async publish(roomId: string, target: ManagedIngressTarget): Promise<number> {
    await this.revoke(roomId)
    const server = net.createServer({ allowHalfOpen: false }, (client) => {
      client.setNoDelay(true)
      const upstream = this.connect(target)
      upstream.setNoDelay(true)
      // A half-closed pair leaks a socket per request under keep-alive, so both
      // directions are torn down together rather than piped and forgotten.
      const destroy = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', destroy)
      upstream.on('error', destroy)
      client.on('close', destroy)
      upstream.on('close', destroy)
      upstream.once('connect', () => {
        client.pipe(upstream)
        upstream.pipe(client)
      })
    })
    server.on('error', (error) => this.onError(error))

    const hostPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      // Loopback only. A Room reachable from the LAN would be a wider exposure
      // than the compatibility backend ever offered.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('the managed runtime ingress forwarder did not bind a port'))
          return
        }
        resolve(address.port)
      })
    })

    this.routes.set(roomId, {
      hostPort,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
    return hostPort
  }

  /** The Host port currently forwarding this Room, if any. */
  portFor(roomId: string): number | null {
    return this.routes.get(roomId)?.hostPort ?? null
  }

  async revoke(roomId: string): Promise<void> {
    const route = this.routes.get(roomId)
    if (!route) return
    this.routes.delete(roomId)
    await route.close()
  }

  /** Every forwarder, closed. Used on shutdown so no Host port outlives the app. */
  async revokeAll(): Promise<void> {
    for (const roomId of [...this.routes.keys()]) await this.revoke(roomId)
  }
}
