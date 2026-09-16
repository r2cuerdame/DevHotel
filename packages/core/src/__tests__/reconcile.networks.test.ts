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

    expect(result.straysRemoved).toEqual([])
    expect(result.networksRemoved).toEqual(['dh-orphan-net'])
    expect(result.roomsSlept).toEqual([])
    // Strays go before adoptions: the allocator should never take a surviving
    // subnet back while a stray network still holds an overlapping one.
    expect(backend.calls).toEqual(['removeManagedNetwork:dh-orphan-net', 'adoptManagedNetwork:dh-known-net'])
    expect(backend.managedNetworks).toEqual([{ roomId: 'known', name: 'dh-known-net' }])
    // The plan is logged before anything acts on it, so recovery is inspectable
    // without having to let it happen first.
    expect(logs[0]).toMatch(/^reconcile: plan [a-f0-9]{12} with \d+ action\(s\)$/)
    expect(logs[1]).toMatch(/removing stray network dh-orphan-net/)
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
    // Adoption order follows the network name, not whatever order the engine
    // happened to list them in: the same Host must reconcile the same way twice.
    expect(backend.calls).toEqual([
      'adoptManagedNetwork:dh-roomA-net',
      'adoptManagedNetwork:dh-roomB-android-control-net',
      'adoptManagedNetwork:dh-roomB-net'
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
