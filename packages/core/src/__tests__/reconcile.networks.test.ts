import { describe, expect, it } from 'vitest'
import { reconcile } from '../reconcile'
import type { RoomsRepo } from '../store/roomsRepo'
import { FakeBackend, makeRoom } from './fakes'

describe('reconcile managed Room networks', () => {
  it('removes orphan networks but preserves networks owned by known Rooms', async () => {
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
    expect(backend.calls).toEqual(['removeManagedNetwork:dh-orphan-net'])
    expect(backend.managedNetworks).toEqual([{ roomId: 'known', name: 'dh-known-net' }])
    expect(logs[0]).toMatch(/removing stray network dh-orphan-net/)
  })
})
