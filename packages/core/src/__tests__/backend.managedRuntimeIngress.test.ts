import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedRuntimeIngress } from '../backend/managedRuntimeIngress'

/** A stand-in for a Room's relay gate published inside the guest. */
async function guestListener(onLine: (line: string, socket: net.Socket) => void): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        onLine(line, socket)
      }
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  return { port, close: async () => await new Promise<void>((resolve) => server.close(() => resolve())) }
}

function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let reply = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('no reply from the forwarded port'))
    }, 5_000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk: string) => {
      reply += chunk
      if (reply.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(reply)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('ManagedRuntimeIngress', () => {
  const cleanup: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close()
  })

  it('forwards a Host loopback connection to the port the guest published', async () => {
    const guest = await guestListener((line, socket) => socket.write(`echo:${line}\n`))
    cleanup.push(guest.close)
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())

    const hostPort = await ingress.publish('r1', { host: '127.0.0.1', port: guest.port })

    expect(hostPort).not.toBe(guest.port)
    await expect(exchange(hostPort, 'DEVHOTEL-RELAY token\n')).resolves.toBe('echo:DEVHOTEL-RELAY token\n')
  })

  it('passes the relay preamble through untouched, so the gate still decides', async () => {
    // The forwarder must not interpret the stream. If it did, the relay token
    // check would move from the Room's own gate onto the Host, which is exactly
    // the boundary #107 must not quietly relocate.
    const seen: string[] = []
    const guest = await guestListener((line, socket) => {
      seen.push(line)
      socket.write('ok\n')
    })
    cleanup.push(guest.close)
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())
    const hostPort = await ingress.publish('r1', { host: '127.0.0.1', port: guest.port })

    await exchange(hostPort, 'DEVHOTEL-RELAY 0123456789abcdef\n')

    expect(seen).toEqual(['DEVHOTEL-RELAY 0123456789abcdef'])
  })

  it('gives two Rooms two Host ports, which is what lets both serve one internal port', async () => {
    const first = await guestListener((_line, socket) => socket.write('first\n'))
    const second = await guestListener((_line, socket) => socket.write('second\n'))
    cleanup.push(first.close, second.close)
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())

    const onePort = await ingress.publish('r1', { host: '127.0.0.1', port: first.port })
    const twoPort = await ingress.publish('r2', { host: '127.0.0.1', port: second.port })

    expect(onePort).not.toBe(twoPort)
    await expect(exchange(onePort, 'x\n')).resolves.toBe('first\n')
    await expect(exchange(twoPort, 'x\n')).resolves.toBe('second\n')
  })

  it('binds loopback only, never an address the network could reach', async () => {
    const guest = await guestListener((_line, socket) => socket.write('ok\n'))
    cleanup.push(guest.close)
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())
    const connections: { host: string; port: number }[] = []
    const watched = new ManagedRuntimeIngress({
      connect: (target) => {
        connections.push(target)
        return net.connect(guest.port, '127.0.0.1')
      }
    })
    cleanup.push(() => watched.revokeAll())

    const hostPort = await watched.publish('r1', { host: '10.0.0.5', port: 3999 })
    await exchange(hostPort, 'x\n')

    // The guest side is dialled at the guest address; the Host side listens on
    // loopback, so nothing on the LAN can reach a Room.
    expect(connections).toEqual([{ host: '10.0.0.5', port: 3999 }])
    const probe = net.connect({ port: hostPort, host: '127.0.0.1' })
    await new Promise((resolve) => probe.once('connect', resolve))
    probe.destroy()
  })

  it('stops accepting once a Room is revoked', async () => {
    const guest = await guestListener((_line, socket) => socket.write('ok\n'))
    cleanup.push(guest.close)
    const ingress = new ManagedRuntimeIngress()
    const hostPort = await ingress.publish('r1', { host: '127.0.0.1', port: guest.port })

    expect(ingress.portFor('r1')).toBe(hostPort)
    await ingress.revoke('r1')

    expect(ingress.portFor('r1')).toBeNull()
    await expect(exchange(hostPort, 'x\n')).rejects.toThrow()
  })

  it('replaces a Room forwarder on wake rather than leaving the old one behind', async () => {
    const before = await guestListener((_line, socket) => socket.write('before\n'))
    const after = await guestListener((_line, socket) => socket.write('after\n'))
    cleanup.push(before.close, after.close)
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())

    const first = await ingress.publish('r1', { host: '127.0.0.1', port: before.port })
    // A wake re-publishes: the guest reassigned the ephemeral port.
    const second = await ingress.publish('r1', { host: '127.0.0.1', port: after.port })

    await expect(exchange(second, 'x\n')).resolves.toBe('after\n')
    await expect(exchange(first, 'x\n')).rejects.toThrow()
    expect(ingress.portFor('r1')).toBe(second)
  })

  it('releases every Host port on shutdown', async () => {
    const guest = await guestListener((_line, socket) => socket.write('ok\n'))
    cleanup.push(guest.close)
    const ingress = new ManagedRuntimeIngress()
    const one = await ingress.publish('r1', { host: '127.0.0.1', port: guest.port })
    const two = await ingress.publish('r2', { host: '127.0.0.1', port: guest.port })

    await ingress.revokeAll()

    expect(ingress.portFor('r1')).toBeNull()
    await expect(exchange(one, 'x\n')).rejects.toThrow()
    await expect(exchange(two, 'x\n')).rejects.toThrow()
  })

  it('tears down the Host side when the guest side is gone', async () => {
    const ingress = new ManagedRuntimeIngress()
    cleanup.push(() => ingress.revokeAll())
    // Nothing is listening on the guest port: the Host connection must end
    // rather than sit open against a Room that is not there.
    const hostPort = await ingress.publish('r1', { host: '127.0.0.1', port: 1 })

    await expect(exchange(hostPort, 'x\n')).rejects.toThrow()
  })
})
