import { describe, expect, it } from 'vitest'
import { reconcile } from '../reconcile'
import type { RoomsRepo } from '../store/roomsRepo'
import { FakeBackend, makeRoom } from './fakes'

describe('reconcile managed Room networks', () => {
  it('removes orphan networks and adopts networks owned by known Rooms', async () => {
    const known = makeRoom({ id: 'known', status: 'sleeping' })
    const rooms = { list: () => [known] } as RoomsRepo
    const backend = new FakeBackend()
    backend.managedNetworks = [
      { roomId: 'known', name: 'dh-known-net' },
      { roomId: 'orphan', name: 'dh-orphan-net' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result).toEqual({ straysRemoved: [], networksRemoved: ['dh-orphan-net'], roomsSlept: [] })
    expect(backend.calls).toEqual(['adoptManagedNetwork:dh-known-net', 'removeManagedNetwork:dh-orphan-net'])
    expect(backend.managedNetworks).toEqual([{ roomId: 'known', name: 'dh-known-net' }])
    expect(logs[0]).toMatch(/removing stray network dh-orphan-net/)
  })

  it('adopts surviving networks across multiple known rooms on startup', async () => {
    const roomA = makeRoom({ id: 'roomA', status: 'sleeping' })
    const roomB = makeRoom({ id: 'roomB', status: 'sleeping' })
    const rooms = { list: () => [roomA, roomB] } as RoomsRepo
    const backend = new FakeBackend()
    backend.managedNetworks = [
      { roomId: 'roomA', name: 'dh-roomA-net' },
      { roomId: 'roomB', name: 'dh-roomB-net' },
      { roomId: 'roomB', name: 'dh-roomB-android-control-net' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.networksRemoved).toEqual([])
    expect(backend.calls).toEqual([
      'adoptManagedNetwork:dh-roomA-net',
      'adoptManagedNetwork:dh-roomB-net',
      'adoptManagedNetwork:dh-roomB-android-control-net'
    ])
  })

  it('tolerates adoptManagedNetwork failure crash-tolerantly and logs warning', async () => {
    const known = makeRoom({ id: 'known', status: 'sleeping' })
    const rooms = { list: () => [known] } as RoomsRepo
    const backend = new FakeBackend()
    backend.managedNetworks = [{ roomId: 'known', name: 'dh-known-net' }]
    backend.adoptManagedNetwork = async () => {
      throw new Error('Docker inspection timeout')
    }
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.networksRemoved).toEqual([])
    expect(logs.some((l) => l.includes('could not adopt network dh-known-net: Docker inspection timeout'))).toBe(true)
  })
})
