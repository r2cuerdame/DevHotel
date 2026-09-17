import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IngressLedger } from '../lifecycle/ingressLedger'
import { ManagedRuntimeIngress } from '../backend/managedRuntimeIngress'
import { tempDir } from './fakes'

describe('the durable ingress ledger', () => {
  it('survives the process that wrote it', () => {
    const userData = tempDir()
    const writer = new IngressLedger({ userData, now: () => new Date('2026-09-17T00:00:00.000Z') })
    writer.record({ roomId: 'room1abc', hostPort: 51000, target: '192.168.0.2:41000', runtimeId: 'rt-1' })

    const reader = new IngressLedger({ userData })
    expect(reader.list()).toEqual([
      {
        roomId: 'room1abc',
        hostPort: 51000,
        target: '192.168.0.2:41000',
        runtimeId: 'rt-1',
        createdAt: '2026-09-17T00:00:00.000Z'
      }
    ])
  })

  it('keeps one route per Room', () => {
    const ledger = new IngressLedger({ userData: tempDir() })
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: 'a:1', runtimeId: 'rt-1' })
    ledger.record({ roomId: 'room1abc', hostPort: 51001, target: 'a:2', runtimeId: 'rt-1' })
    expect(ledger.list().map((route) => route.hostPort)).toEqual([51001])
  })

  it('forgets one Room without disturbing the others', () => {
    const ledger = new IngressLedger({ userData: tempDir() })
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: 'a:1', runtimeId: 'rt-1' })
    ledger.record({ roomId: 'room2abc', hostPort: 51001, target: 'a:2', runtimeId: 'rt-1' })
    ledger.forget('room1abc')
    expect(ledger.list().map((route) => route.roomId)).toEqual(['room2abc'])
  })

  it('reports damage instead of throwing, so a lost inventory does not take the app down', () => {
    const userData = tempDir()
    mkdirSync(join(userData, 'runtime'), { recursive: true })
    writeFileSync(join(userData, 'runtime', 'ingress.json'), '{ not json', 'utf8')
    const ledger = new IngressLedger({ userData })
    expect(ledger.list()).toEqual([])
    expect(ledger.isDamaged()).toBe(true)
  })

  it('drops an entry that does not describe a Room port', () => {
    const userData = tempDir()
    mkdirSync(join(userData, 'runtime'), { recursive: true })
    writeFileSync(
      join(userData, 'runtime', 'ingress.json'),
      JSON.stringify({
        schema: 1,
        owner: 'devhotel',
        routes: [
          { roomId: 'BADROOM', hostPort: 51000, target: 'a:1', runtimeId: null, createdAt: '' },
          { roomId: 'room1abc', hostPort: 70000, target: 'a:1', runtimeId: null, createdAt: '' },
          { roomId: 'room2abc', hostPort: 51002, target: 'a:1', runtimeId: null, createdAt: '' }
        ]
      }),
      'utf8'
    )
    expect(new IngressLedger({ userData }).list().map((route) => route.roomId)).toEqual(['room2abc'])
  })

  it('writes atomically, leaving no partial file behind', () => {
    const userData = tempDir()
    const ledger = new IngressLedger({ userData })
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: 'a:1', runtimeId: null })
    const raw = readFileSync(join(userData, 'runtime', 'ingress.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

describe('the managed ingress forwarder records what it opened', () => {
  it('writes the port to the ledger as it publishes, and clears it on revoke', async () => {
    const userData = tempDir()
    const ledger = new IngressLedger({ userData })
    const ingress = new ManagedRuntimeIngress({
      ledger,
      runtimeId: 'rt-1',
      connect: () => new net.Socket()
    })

    const hostPort = await ingress.publish('room1abc', { host: '192.168.0.2', port: 41000 })
    expect(ledger.list()).toEqual([
      {
        roomId: 'room1abc',
        hostPort,
        target: '192.168.0.2:41000',
        runtimeId: 'rt-1',
        createdAt: expect.any(String)
      }
    ])

    await ingress.revoke('room1abc')
    expect(ledger.list()).toEqual([])
  })

  it('forgets a route this process never opened, which is exactly what a crash leaves', async () => {
    const userData = tempDir()
    const ledger = new IngressLedger({ userData })
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: '192.168.0.2:41000', runtimeId: 'rt-0' })

    // A fresh process: the socket died with the last one, only the record survived.
    const ingress = new ManagedRuntimeIngress({ ledger, runtimeId: 'rt-1' })
    expect(ingress.portFor('room1abc')).toBeNull()
    await ingress.revoke('room1abc')
    expect(ledger.list()).toEqual([])
  })

  it('clears every inherited record on revokeAll', async () => {
    const userData = tempDir()
    const ledger = new IngressLedger({ userData })
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: 'a:1', runtimeId: 'rt-0' })
    ledger.record({ roomId: 'room2abc', hostPort: 51001, target: 'a:2', runtimeId: 'rt-0' })

    await new ManagedRuntimeIngress({ ledger, runtimeId: 'rt-1' }).revokeAll()
    expect(ledger.list()).toEqual([])
  })
})
