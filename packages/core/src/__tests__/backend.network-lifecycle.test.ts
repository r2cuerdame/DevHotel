import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import {
  DEFAULT_SUBNET_POOL,
  DEFAULT_SUBNET_PREFIX,
  SubnetAllocator,
  classifyNetworkCreateError
} from '../backend/ipam'
import { roomNetworkName } from '../backend/naming'
import { DevHotelError } from '../errors'
import { reconcile } from '../reconcile'
import type { RoomsRepo } from '../store/roomsRepo'
import { setupDockerMock, webSpec } from './fakeDockerEngine'
import { makeRoom } from './fakes'

vi.mock('../backend/cli', () => ({
  getPinnedDockerRuntime: vi.fn(() => ({ context: 'test-context' })),
  runDocker: vi.fn()
}))

const mockedRunDocker = vi.mocked(runDocker)

describe('SubnetAllocator unit tests', () => {
  it('allocates sequential /24 subnets within the default pool', () => {
    const allocator = new SubnetAllocator()
    expect(allocator.pool).toBe(DEFAULT_SUBNET_POOL)
    expect(allocator.subnetPrefix).toBe(DEFAULT_SUBNET_PREFIX)

    const s0 = allocator.allocate('dh-r0-net')
    const s1 = allocator.allocate('dh-r1-net')
    const s2 = allocator.allocate('dh-r2-net')

    expect(s0).toBe('10.214.0.0/24')
    expect(s1).toBe('10.214.1.0/24')
    expect(s2).toBe('10.214.2.0/24')

    // Idempotent allocation for the same network name
    expect(allocator.allocate('dh-r0-net')).toBe('10.214.0.0/24')
  })

  it('releases subnets and reuses them on subsequent allocations', () => {
    const allocator = new SubnetAllocator()
    const s0 = allocator.allocate('dh-r0-net')
    const s1 = allocator.allocate('dh-r1-net')

    expect(s0).toBe('10.214.0.0/24')
    expect(s1).toBe('10.214.1.0/24')

    allocator.release('dh-r0-net')

    // Next allocation should reuse the freed s0 (lowest available index)
    const s2 = allocator.allocate('dh-r2-net')
    expect(s2).toBe('10.214.0.0/24')
  })

  it('skips subnets in use externally by Docker', () => {
    const allocator = new SubnetAllocator()
    const external = new Set(['10.214.0.0/24', '10.214.1.0/24'])

    const s0 = allocator.allocate('dh-r0-net', external)
    expect(s0).toBe('10.214.2.0/24')
  })

  it('throws DevHotelError with NETWORK_POOL_EXHAUSTED when capacity is reached', () => {
    // Small pool: 10.214.0.0/29 with /30 subnets gives exactly 2 subnets
    const allocator = new SubnetAllocator({ pool: '10.214.0.0/29', subnetPrefix: 30 })
    expect(allocator.getCapacity().totalCapacity).toBe(2)

    allocator.allocate('dh-r1-net')
    allocator.allocate('dh-r2-net')

    expect(() => allocator.allocate('dh-r3-net')).toThrowError(DevHotelError)
    try {
      allocator.allocate('dh-r3-net')
    } catch (err) {
      expect(err).toBeInstanceOf(DevHotelError)
      const dhe = err as DevHotelError
      expect(dhe.code).toBe('NETWORK_POOL_EXHAUSTED')
      expect(dhe.httpStatus).toBe(507)
      expect(dhe.recoveryHint).toContain('Delete unused rooms')
      expect(dhe.evidence).toEqual({
        networkName: 'dh-r3-net',
        pool: '10.214.0.0/29',
        subnetSize: 30,
        totalCapacity: 2,
        usedCount: 2,
        availableCount: 0
      })
    }
  })

  it('classifies Docker IPAM exhaustion into stable DevHotelError', () => {
    const dockerErr = new Error('failed to create network: all predefined address pools have been fully subnetted')
    const classified = classifyNetworkCreateError(dockerErr, 'room1', 'dh-room1-net', '10.214.0.0/24')

    expect(classified).toBeInstanceOf(DevHotelError)
    const dhe = classified as DevHotelError
    expect(dhe.code).toBe('NETWORK_POOL_EXHAUSTED')
    expect(dhe.httpStatus).toBe(507)
    expect(dhe.recoveryHint).toContain('free subnet capacity')
  })
})

describe('OciCliBackend Network Lifecycle & Scale Acceptance', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('creates and wakes 40 web Rooms plus 5 Android Rooms without address-pool error', async () => {
    const { dockerNetworks } = setupDockerMock(mockedRunDocker)
    const backend = new OciCliBackend()

    // 1. Create 40 web rooms
    for (let i = 0; i < 40; i++) {
      const rid = `web${i.toString().padStart(3, '0')}`
      await expect(backend.createRoomPod(webSpec(rid))).resolves.toEqual({ hostPort: 40001 })
    }

    // 2. Create 5 Android rooms
    for (let i = 0; i < 5; i++) {
      const rid = `and${i.toString().padStart(3, '0')}`
      await expect(
        backend.createRoomPod(webSpec(rid, { androidRuntimeIsolation: true }))
      ).resolves.toEqual({ hostPort: 40001 })
    }

    // 40 web rooms (1 network each) + 5 android rooms (2 networks each) = 50 networks
    expect(dockerNetworks.size).toBe(50)

    // Every network must have an explicit managed /24 subnet in 10.214.0.0/16
    const usedSubnets = new Set<string>()
    for (const net of dockerNetworks.values()) {
      expect(net.subnet).toBeDefined()
      expect(net.subnet).toMatch(/^10\.214\.\d+\.0\/24$/)
      expect(usedSubnets.has(net.subnet!)).toBe(false)
      usedSubnets.add(net.subnet!)
    }
    expect(usedSubnets.size).toBe(50)

    // 3. Sleep all 45 rooms
    for (let i = 0; i < 40; i++) {
      const rid = `web${i.toString().padStart(3, '0')}`
      await backend.stopRoomPod(rid)
    }
    for (let i = 0; i < 5; i++) {
      const rid = `and${i.toString().padStart(3, '0')}`
      await backend.stopRoomPod(rid)
    }

    // After sleep, networks remain intact (warm wake preservation)
    expect(dockerNetworks.size).toBe(50)

    // 4. Wake all 45 rooms (startRoomPod)
    for (let i = 0; i < 40; i++) {
      const rid = `web${i.toString().padStart(3, '0')}`
      await expect(backend.startRoomPod(rid)).resolves.toEqual({ hostPort: 40001 })
    }
    for (let i = 0; i < 5; i++) {
      const rid = `and${i.toString().padStart(3, '0')}`
      await expect(backend.startRoomPod(rid, { androidRuntimeIsolation: true })).resolves.toEqual({
        hostPort: 40001
      })
    }

    // Waking consumed zero additional subnets
    expect(dockerNetworks.size).toBe(50)
  })

  it('bounds subnet consumption across repeated create/sleep/wake/delete cycles', async () => {
    const { dockerNetworks } = setupDockerMock(mockedRunDocker)
    const backend = new OciCliBackend()

    // Run 50 sequential create -> sleep -> wake -> delete cycles
    for (let cycle = 0; cycle < 50; cycle++) {
      const rid = `cycle${cycle}`
      await backend.createRoomPod(webSpec(rid))
      expect(dockerNetworks.size).toBe(1)
      // Every cycle must reuse 10.214.0.0/24 because previous was deleted!
      expect(dockerNetworks.get(roomNetworkName(rid))?.subnet).toBe('10.214.0.0/24')

      await backend.stopRoomPod(rid)
      expect(dockerNetworks.size).toBe(1)

      await backend.startRoomPod(rid)
      expect(dockerNetworks.size).toBe(1)

      await backend.deleteRoomPod(rid, { volumes: false })
      expect(dockerNetworks.size).toBe(0)
    }

    // Net result: 0 leaked networks, subnet space remained completely bounded
    expect(dockerNetworks.size).toBe(0)
  })

  it('rolls back partial network and containers when web creation fails', async () => {
    const { dockerNetworks, dockerContainers } = setupDockerMock(mockedRunDocker, { webCreateFails: true })
    const backend = new OciCliBackend()

    await expect(backend.createRoomPod(webSpec('failweb'))).rejects.toThrow(/create web container/)

    // Rollback must have cleaned up the anchor container AND the network!
    expect(dockerContainers.has('dh-failweb-anchor')).toBe(false)
    expect(dockerNetworks.has(roomNetworkName('failweb'))).toBe(false)
  })

  it('reclaims stale unattached DevHotel-owned networks when pool capacity is exhausted', async () => {
    const { dockerNetworks } = setupDockerMock(mockedRunDocker)
    const liveRooms = new Set(['live01'])

    // Create a stale network owned by dead room
    dockerNetworks.set('dh-dead01-net', {
      name: 'dh-dead01-net',
      labels: {
        'devhotel.managed': '1',
        'devhotel.role': 'network',
        'devhotel.room': 'dead01'
      },
      subnet: '10.214.0.0/30',
      containers: {}
    })

    // Create a network owned by live room
    dockerNetworks.set('dh-live01-net', {
      name: 'dh-live01-net',
      labels: {
        'devhotel.managed': '1',
        'devhotel.role': 'network',
        'devhotel.room': 'live01'
      },
      subnet: '10.214.0.4/30',
      containers: {}
    })

    // Use a small pool with capacity 2 (/29 with /30 subnets)
    const allocator = new SubnetAllocator({ pool: '10.214.0.0/29', subnetPrefix: 30 })
    const backend = new OciCliBackend({
      subnetAllocator: allocator,
      isRoomActive: (roomId) => liveRooms.has(roomId)
    })

    // Creating new room 'new01' initially finds 2/2 subnets used.
    // Reclaiming stale 'dead01' should remove dh-dead01-net and allocate its subnet!
    await backend.createRoomPod(webSpec('new01', { standalone: true }), { startWeb: false })

    expect(dockerNetworks.has('dh-dead01-net')).toBe(false)
    expect(dockerNetworks.has('dh-live01-net')).toBe(true)
    expect(dockerNetworks.has('dh-new01-net')).toBe(true)
    expect(dockerNetworks.get('dh-new01-net')?.subnet).toBe('10.214.0.0/30')
  })

  it('reconciliation removes orphan networks crash-tolerantly without disturbing known rooms', async () => {
    const known = makeRoom({ id: 'known01', status: 'sleeping' })
    const rooms = { list: () => [known] } as RoomsRepo

    const calls: string[] = []
    const backend = {
      listManagedNetworks: async () => [
        { roomId: 'known01', name: 'dh-known01-net' },
        { roomId: 'dead01', name: 'dh-dead01-net' },
        { roomId: 'dead02', name: 'dh-dead02-net' }
      ],
      removeManagedNetwork: async (name: string) => {
        calls.push(`rm:${name}`)
        if (name === 'dh-dead01-net') {
          throw new Error('Docker network busy')
        }
      },
      listManagedContainers: async () => [],
      removeManagedContainer: async () => {},
      stopRoomPod: async () => {}
    } as any

    const logs: string[] = []
    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    // Reconcile must remove dead02 even after dead01 removal threw!
    expect(calls).toEqual(['rm:dh-dead01-net', 'rm:dh-dead02-net'])
    expect(result.networksRemoved).toEqual(['dh-dead02-net'])
    expect(logs.some((l) => l.includes('could not remove stray network dh-dead01-net'))).toBe(true)
    expect(calls.includes('rm:dh-known01-net')).toBe(false)
  })

  it('preserves cross-room isolation with separate non-overlapping subnets and disabled ICC', async () => {
    const networkCreateArgs = new Map<string, string[]>()
    setupDockerMock(mockedRunDocker)

    const originalImpl = mockedRunDocker.getMockImplementation()!
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'create') {
        networkCreateArgs.set(args.at(-1)!, args)
      }
      return originalImpl(args)
    })

    const backend = new OciCliBackend()
    await backend.createRoomPod(webSpec('roomA'))
    await backend.createRoomPod(webSpec('roomB'))

    const argsA = networkCreateArgs.get(roomNetworkName('roomA'))!
    const argsB = networkCreateArgs.get(roomNetworkName('roomB'))!

    expect(argsA).toBeDefined()
    expect(argsB).toBeDefined()

    // Both networks must enforce disabled inter-container communication
    expect(argsA).toContain('com.docker.network.bridge.enable_icc=false')
    expect(argsB).toContain('com.docker.network.bridge.enable_icc=false')

    // Subnets must be distinct
    const subnetA = argsA[argsA.indexOf('--subnet') + 1]
    const subnetB = argsB[argsB.indexOf('--subnet') + 1]
    expect(subnetA).toBe('10.214.0.0/24')
    expect(subnetB).toBe('10.214.1.0/24')
    expect(subnetA).not.toBe(subnetB)
  })
})
