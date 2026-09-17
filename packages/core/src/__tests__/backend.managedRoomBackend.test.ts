import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { ManagedRoomBackend } from '../backend/managedRoomBackend'
import { ManagedRuntimeIngress } from '../backend/managedRuntimeIngress'
import { MANAGED_RUNTIME_GUEST_STAGE_ROOT } from '../backend/managedRuntimeGuestAgent'
import { RELAY_PORT, anchorName, buildAnchorArgs, roomNetworkName, webName } from '../backend/naming'
import type { ManagedRuntimeEngine } from '../backend/managedRuntimeEngine'
import type { ExecResult } from '../backend/types'
import type { RunDockerOpts } from '../backend/cli'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn(), spawnDockerProcess: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)
const roomId = 'r1'
const webId = 'a'.repeat(64)
const anchorId = 'b'.repeat(64)

/**
 * A guest engine that answers the inspect/port questions the Room rules ask,
 * and records everything else. It is deliberately a recorder rather than a
 * behavioural double: what these tests are about is which argv the Room rules
 * sent and which side of the boundary each path landed on.
 */
function guestEngine(overrides: (args: string[]) => ExecResult | null = () => null) {
  const runs: { args: string[]; opts?: RunDockerOpts }[] = []
  const puts: { hostPath: string; guestPath: string }[] = []
  const gets: { guestPath: string; hostPath: string }[] = []
  const engine = {
    endpoint: 'managed-linux:test-runtime',
    runs,
    puts,
    gets,
    run: async (args: string[], opts?: RunDockerOpts): Promise<ExecResult> => {
      runs.push({ args, ...(opts === undefined ? {} : { opts }) })
      const override = overrides(args)
      if (override) return override
      if (args[0] === 'version') {
        return {
          code: 0,
          stdout: JSON.stringify({ Client: { Version: '28.0.0' }, Server: { Version: '28.0.0' } }),
          stderr: ''
        }
      }
      if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ID: 'guest-engine' }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn: () => {
      throw new Error('not used')
    },
    putFile: async (hostPath: string, guestPath: string) => {
      puts.push({ hostPath, guestPath })
    },
    getFile: async (guestPath: string, hostPath: string) => {
      gets.push({ guestPath, hostPath })
    }
  }
  return engine as unknown as ManagedRuntimeEngine & typeof engine
}

function inspectJson(id: string, name: string, role: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Id: id,
      Name: `/${name}`,
      State: { Status: 'running', Running: true, Paused: false },
      Config: { Labels: { 'devhotel.managed': '1', 'devhotel.room': roomId, 'devhotel.role': role } },
      ...extra
    }
  ])
}

describe('ManagedRoomBackend', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-managed-room-'))
    mockedRunDocker.mockReset()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function backendWith(engine: ReturnType<typeof guestEngine>, ingress: ManagedRuntimeIngress) {
    return new ManagedRoomBackend({
      engine,
      ingress,
      guestAddress: '172.30.1.5',
      identityFile: join(dir, 'engine.json')
    })
  }

  it('drives every Room operation through the guest engine, never the Host Docker CLI', async () => {
    const engine = guestEngine()
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)

    await expect(backend.health()).resolves.toMatchObject({ ok: true })
    await backend.listManagedContainers()

    expect(engine.runs.map(({ args }) => args[0])).toContain('ps')
    expect(mockedRunDocker).not.toHaveBeenCalled()
    await ingress.revokeAll()
  })

  it('publishes the relay gate on an address the Host can reach, not the guest loopback', () => {
    const engine = guestEngine()
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)

    // The anchor args are what actually bind the port inside the engine, so the
    // subclass's publish address has to reach them.
    const managed = buildAnchorArgs(
      { roomId, internalPort: 3000 },
      'c'.repeat(64),
      roomNetworkName(roomId),
      // Reading a protected member is the point: this is the seam the subclass
      // overrides, and the anchor args are where it has to take effect.
      (backend as unknown as { relayPublishAddress: string }).relayPublishAddress
    )
    const compatibility = buildAnchorArgs({ roomId, internalPort: 3000 }, 'c'.repeat(64))

    expect(managed).toContain(`0.0.0.0:0:${RELAY_PORT}`)
    expect(compatibility).toContain(`127.0.0.1:0:${RELAY_PORT}`)
    // Everything else about the gate, above all the token verifier, is identical.
    expect(managed.filter((arg) => !arg.includes(`:0:${RELAY_PORT}`))).toEqual(
      compatibility.filter((arg) => !arg.includes(`:0:${RELAY_PORT}`))
    )
  })

  it('hands the Gateway a Host loopback port that forwards to the guest published port', async () => {
    const guest = net.createServer((socket) => socket.end('guest\n'))
    await new Promise<void>((resolve) => guest.listen(0, '127.0.0.1', () => resolve()))
    const guestPort = (guest.address() as net.AddressInfo).port

    const engine = guestEngine((args) => {
      if (args[0] === 'inspect') {
        const target = args[args.length - 1]
        if (target === anchorName(roomId) || target === anchorId) {
          return {
            code: 0,
            stdout: inspectJson(anchorId, anchorName(roomId), 'anchor', {
              HostConfig: { NetworkMode: roomNetworkName(roomId) }
            }),
            stderr: ''
          }
        }
        if (target === webName(roomId) || target === webId) {
          return { code: 0, stdout: inspectJson(webId, webName(roomId), 'web'), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'no such object' }
      }
      if (args[0] === 'network') {
        // The Android control network does not exist; the Room's own bridge does,
        // and it contains exactly the anchor endpoint.
        if (args[args.length - 1] !== roomNetworkName(roomId)) {
          return { code: 1, stdout: '', stderr: 'no such network' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              Name: roomNetworkName(roomId),
              Driver: 'bridge',
              Labels: { 'devhotel.managed': '1', 'devhotel.room': roomId, 'devhotel.role': 'network' },
              Containers: { [anchorId]: { Name: anchorName(roomId) } }
            }
          ]),
          stderr: ''
        }
      }
      if (args[0] === 'port') return { code: 0, stdout: `0.0.0.0:${guestPort}\n`, stderr: '' }
      return null
    })
    const connections: { host: string; port: number }[] = []
    const ingress = new ManagedRuntimeIngress({
      connect: (target) => {
        connections.push(target)
        return net.connect(guestPort, '127.0.0.1')
      }
    })
    const backend = backendWith(engine, ingress)

    const { hostPort } = await backend.startRoomPod(roomId)

    expect(hostPort).not.toBe(guestPort)
    expect(ingress.portFor(roomId)).toBe(hostPort)

    // And it really carries bytes to the guest side.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(hostPort!, '127.0.0.1')
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => (text += chunk))
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    expect(reply).toBe('guest\n')
    expect(connections).toEqual([{ host: '172.30.1.5', port: guestPort }])

    await ingress.revokeAll()
    await new Promise<void>((resolve) => guest.close(() => resolve()))
  })

  it('revokes the Host port when a Room sleeps, so an asleep Room does not look up', async () => {
    const engine = guestEngine((args) =>
      args[0] === 'ps' ? { code: 0, stdout: '', stderr: '' } : args[0] === 'network' ? { code: 1, stdout: '', stderr: '' } : null
    )
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)
    const hostPort = await ingress.publish(roomId, { host: '127.0.0.1', port: 1 })
    expect(ingress.portFor(roomId)).toBe(hostPort)

    await backend.stopRoomPod(roomId)

    expect(ingress.portFor(roomId)).toBeNull()
  })

  it('stages a Host file into the guest before copying it into a Room', async () => {
    const engine = guestEngine((args) =>
      args[0] === 'inspect' ? { code: 0, stdout: inspectJson(webId, webName(roomId), 'web'), stderr: '' } : null
    )
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)

    await backend.copyIntoRoom(roomId, join(dir, 'secret.env'), '/workspace/.env')

    // A `docker cp <host path>` against a guest engine would have resolved the
    // path inside the guest and copied nothing — or the wrong thing.
    expect(engine.puts).toHaveLength(1)
    expect(engine.puts[0]!.hostPath).toBe(join(dir, 'secret.env'))
    const copy = engine.runs.find(({ args }) => args[0] === 'cp')!
    expect(copy.args[1]).toBe(`${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${engine.puts[0]!.guestPath}`)
    expect(copy.args[2]).toBe(`${webId}:/workspace/.env`)
    await ingress.revokeAll()
  })

  it('copies a Room file out through the staging root and then removes the staged copy', async () => {
    const engine = guestEngine((args) =>
      args[0] === 'inspect' ? { code: 0, stdout: inspectJson(webId, webName(roomId), 'web'), stderr: '' } : null
    )
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)
    const target = join(dir, 'pulled.txt')

    await backend.copyFromRoom(roomId, '/workspace/out.txt', target)

    const copy = engine.runs.find(({ args }) => args[0] === 'cp')!
    expect(copy.args[1]).toBe(`${webId}:/workspace/out.txt`)
    expect(copy.args[2]).toContain(MANAGED_RUNTIME_GUEST_STAGE_ROOT)
    expect(engine.gets).toHaveLength(1)
    expect(engine.gets[0]!.hostPath).toBe(target)
    // Staged bytes are Room input or output and do not outlive the operation.
    expect(engine.runs.some(({ args }) => args.includes('rm') && args.includes('-rf'))).toBe(true)
    await ingress.revokeAll()
  })

  it('never puts a Host path where the guest engine would resolve it', async () => {
    const engine = guestEngine((args) =>
      args[0] === 'inspect' ? { code: 0, stdout: inspectJson(webId, webName(roomId), 'web'), stderr: '' } : null
    )
    const ingress = new ManagedRuntimeIngress()
    const backend = backendWith(engine, ingress)
    const hostPath = join(dir, 'host-only.txt')

    await backend.copyIntoRoom(roomId, hostPath, '/workspace/.env')
    await backend.copyFromRoom(roomId, '/workspace/out.txt', join(dir, 'out.txt'))

    for (const { args } of engine.runs) {
      expect(args.join(' ')).not.toContain(hostPath)
      expect(args.join(' ')).not.toContain(dir)
    }
    await ingress.revokeAll()
  })
})
