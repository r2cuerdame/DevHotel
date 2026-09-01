import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import {
  androidControlNetworkName,
  androidRuntimeAnchorName,
  anchorName,
  buildAnchorArgs,
  buildRoomNetworkCreateArgs,
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  roomNetworkName,
  webName
} from '../backend/naming'
import type { WebSpec } from '../backend/types'
import { tempDir } from './fakes'

vi.mock('../backend/cli', () => ({
  getPinnedDockerRuntime: vi.fn(() => ({ context: 'test-context' })),
  runDocker: vi.fn()
}))

const mockedRunDocker = vi.mocked(runDocker)
const ok = { code: 0, stdout: '', stderr: '' }
const TOKEN = 'a'.repeat(64)
const VERIFIER = createHash('sha256').update(TOKEN).digest('hex')
const GENERIC_ANCHOR_ID = 'd'.repeat(64)

function backend(tokenFactory: () => string = () => TOKEN): OciCliBackend {
  return new OciCliBackend({ relayTokenFactory: tokenFactory })
}

function networkInspect(
  roomId: string,
  name = roomNetworkName(roomId),
  containers: Record<string, { Name: string }> = {}
) {
  return JSON.stringify([
    {
      Name: name,
      Driver: 'bridge',
      Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'network',
        'devhotel.managed': '1'
      },
      Containers: containers
    }
  ])
}

describe('OciCliBackend Room networks', () => {
  let networkExists: boolean
  let anchorExists: boolean

  beforeEach(() => {
    networkExists = false
    anchorExists = false
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        if (anchorExists && args[1] === 'dh-r1-anchor') {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: GENERIC_ANCHOR_ID,
              Name: '/dh-r1-anchor',
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'anchor',
                'devhotel.managed': '1'
              } },
              State: { Status: 'running' },
              HostConfig: { NetworkMode: roomNetworkName('r1') }
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'Error: No such object' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkExists && args[2] === roomNetworkName('r1')
          ? {
              code: 0,
              stdout: networkInspect(
                'r1',
                roomNetworkName('r1'),
                anchorExists ? { [GENERIC_ANCHOR_ID]: { Name: 'dh-r1-anchor' } } : {}
              ),
              stderr: ''
            }
          : { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        networkExists = true
        return ok
      }
      if (args[0] === 'network' && args[1] === 'rm') {
        networkExists = false
        return ok
      }
      if (args[0] === 'run' && args.includes('dh-r1-anchor')) {
        anchorExists = true
        return ok
      }
      if (args[0] === 'rm' && args.includes('dh-r1-anchor')) {
        anchorExists = false
        return ok
      }
      if (args[0] === 'port') return { code: 0, stdout: '127.0.0.1:45123\n', stderr: '' }
      return ok
    })
  })

  it('ensures the private bridge before recreating an anchor on it', async () => {
    await expect(backend().recreateAnchor({ roomId: 'r1', internalPort: 3000 })).resolves.toEqual({
      hostPort: 45123
    })

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    const createNetworkAt = calls.findIndex((args) => args[0] === 'network' && args[1] === 'create')
    const runAnchorAt = calls.findIndex((args) => args[0] === 'run')
    expect(calls[createNetworkAt]).toEqual(buildRoomNetworkCreateArgs('r1'))
    expect(calls[runAnchorAt]).toEqual(buildAnchorArgs({ roomId: 'r1', internalPort: 3000 }, VERIFIER))
    expect(createNetworkAt).toBeGreaterThanOrEqual(0)
    expect(runAnchorAt).toBeGreaterThan(createNetworkAt)
  })

  it('creates standalone build containers on an owned network without an anchor', async () => {
    const volumes = new Set<string>()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkExists && args[2] === roomNetworkName('r1')
          ? { code: 0, stdout: networkInspect('r1'), stderr: '' }
          : { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        networkExists = true
        return ok
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        const name = args[2]!
        return volumes.has(name)
          ? {
              code: 0,
              stdout: JSON.stringify([
                {
                  Name: name,
                  Labels: {
                    'devhotel.room': 'r1',
                    'devhotel.role': 'volume',
                    'devhotel.managed': '1'
                  }
                }
              ]),
              stderr: ''
            }
          : { code: 1, stdout: '', stderr: 'Error: No such volume' }
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        volumes.add(args.at(-1)!)
        return ok
      }
      return ok
    })
    const spec: WebSpec = {
      roomId: 'r1',
      internalPort: 6080,
      nodeMajor: '17',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      workspaceVolumeRevision: 0,
      startCommand: 'sleep 1',
      imageOverride: 'android-build@sha256:' + 'a'.repeat(64),
      standalone: true,
      noDepsVolume: true
    }

    await expect(backend().createRoomPod(spec, { startWeb: false })).resolves.toEqual({ hostPort: null })

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    const networkAt = calls.findIndex((args) => args[0] === 'network' && args[1] === 'create')
    const webAt = calls.findIndex((args) => args[0] === 'create' && args.includes('dh-r1-web'))
    expect(networkAt).toBeGreaterThanOrEqual(0)
    expect(webAt).toBeGreaterThan(networkAt)
    expect(calls[webAt]).toEqual(expect.arrayContaining(['--network', 'dh-r1-net']))
    expect(calls.some((args) => args.includes('dh-r1-anchor'))).toBe(false)
    expect(calls.some((args) => args.includes('/dev/kvm'))).toBe(false)
  })

  it('creates Android control and runtime namespaces before placing web on the runtime side', async () => {
    const networks = new Set<string>()
    const containers = new Map<string, Record<string, unknown>>()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        const name = args[2]!
        const members: Record<string, { Name: string }> = {}
        if (name === androidControlNetworkName('r1') && containers.has('dh-r1-anchor')) {
          members['a'.repeat(64)] = { Name: 'dh-r1-anchor' }
        }
        if (name === roomNetworkName('r1') && containers.has(androidRuntimeAnchorName('r1'))) {
          members['b'.repeat(64)] = { Name: androidRuntimeAnchorName('r1') }
        }
        return networks.has(name)
          ? { code: 0, stdout: networkInspect('r1', name, members), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        networks.add(args.at(-1)!)
        return ok
      }
      if (args[0] === 'inspect') {
        const container = containers.get(args[1]!)
        return container
          ? { code: 0, stdout: JSON.stringify([container]), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]!
        const role = args[args.indexOf('-l') + 3]?.split('=')[1] ?? 'anchor'
        containers.set(name, {
          Id: name === androidRuntimeAnchorName('r1') ? 'b'.repeat(64) : 'a'.repeat(64),
          Name: `/${name}`,
          Config: { Labels: {
            'devhotel.room': 'r1',
            'devhotel.role': role,
            'devhotel.managed': '1'
          } },
          State: { Status: 'running' },
          HostConfig: { NetworkMode: args[args.indexOf('--network') + 1] },
          NetworkSettings: { SandboxID: name === androidRuntimeAnchorName('r1') ? 'c'.repeat(64) : 'e'.repeat(64) }
        })
        return ok
      }
      if (args[0] === 'create') return ok
      if (args[0] === 'port') return { code: 0, stdout: '127.0.0.1:45123\n', stderr: '' }
      return ok
    })
    const spec: WebSpec = {
      roomId: 'r1',
      internalPort: 6080,
      nodeMajor: '17',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      workspaceVolumeRevision: 0,
      startCommand: 'sleep 1',
      imageOverride: 'android-build@sha256:' + 'a'.repeat(64),
      androidRuntimeIsolation: true,
      noDepsVolume: true,
      noCacheVolume: true
    }

    await expect(backend().createRoomPod(spec, { startWeb: false })).resolves.toEqual({ hostPort: 45123 })

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    const controlNetworkAt = calls.findIndex((args) => args.at(-1) === androidControlNetworkName('r1'))
    const controlAnchorAt = calls.findIndex((args) =>
      args[0] === 'run' && args.includes('dh-r1-anchor')
    )
    const runtimeAnchorAt = calls.findIndex((args) =>
      args[0] === 'run' && args.includes(androidRuntimeAnchorName('r1'))
    )
    const webAt = calls.findIndex((args) => args[0] === 'create' && args.includes('dh-r1-web'))
    expect(calls[controlAnchorAt]).toEqual(expect.arrayContaining([
      '--network', androidControlNetworkName('r1')
    ]))
    expect(calls[runtimeAnchorAt]).toEqual(expect.arrayContaining([
      '--network', roomNetworkName('r1')
    ]))
    expect(calls[webAt]).toEqual(expect.arrayContaining([
      '--network', `container:${'b'.repeat(64)}`
    ]))
    expect(calls[webAt]).toContain(`${NETWORK_AUTHORITY_SANDBOX_LABEL}=${'c'.repeat(64)}`)
    expect(controlNetworkAt).toBeGreaterThanOrEqual(0)
    expect(controlAnchorAt).toBeGreaterThan(controlNetworkAt)
    expect(runtimeAnchorAt).toBeGreaterThan(controlNetworkAt)
    expect(webAt).toBeGreaterThan(runtimeAnchorAt)
  })

  it('rolls back partial Android topology and leaves no relay authority after web creation fails', async () => {
    const networks = new Set<string>()
    const containers = new Map<string, Record<string, unknown>>()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        const name = args[2]!
        return networks.has(name)
          ? { code: 0, stdout: networkInspect('r1', name), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        networks.add(args.at(-1)!)
        return ok
      }
      if (args[0] === 'network' && args[1] === 'rm') {
        networks.delete(args[2]!)
        return ok
      }
      if (args[0] === 'inspect') {
        const container = containers.get(args[1]!)
        return container
          ? { code: 0, stdout: JSON.stringify([container]), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]!
        const runtime = name === androidRuntimeAnchorName('r1')
        containers.set(name, {
          Id: (runtime ? 'b' : 'a').repeat(64),
          Name: `/${name}`,
          Config: { Labels: {
            'devhotel.room': 'r1',
            'devhotel.role': runtime ? 'android-runtime-anchor' : 'anchor',
            'devhotel.managed': '1'
          } },
          State: { Status: 'running' },
          HostConfig: { NetworkMode: args[args.indexOf('--network') + 1] },
          NetworkSettings: { SandboxID: (runtime ? 'c' : 'd').repeat(64) }
        })
        return ok
      }
      if (args[0] === 'create' && args.includes('dh-r1-web')) {
        return { code: 1, stdout: '', stderr: 'web create denied' }
      }
      if (args[0] === 'rm') {
        containers.delete(args[2]!)
        return ok
      }
      return ok
    })
    const spec: WebSpec = {
      roomId: 'r1',
      internalPort: 6080,
      nodeMajor: '17',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      workspaceVolumeRevision: 0,
      startCommand: 'sleep 1',
      imageOverride: 'android-build@sha256:' + 'a'.repeat(64),
      androidRuntimeIsolation: true,
      noDepsVolume: true,
      noCacheVolume: true
    }
    const instance = backend()

    await expect(instance.createRoomPod(spec, { startWeb: false })).rejects.toThrow(/create web container/)
    await expect(instance.relayToken('r1')).rejects.toThrow(/not available/)
    expect(containers.size).toBe(0)
    expect(networks.has(androidControlNetworkName('r1'))).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'port')).toBe(false)
  })

  it('starts the owned Android runtime namespace before recreating the control relay on wake', async () => {
    const runtimeId = 'b'.repeat(64)
    const anchorId = 'a'.repeat(64)
    let runtimeState = 'exited'
    let anchorExists = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        const name = args[2]!
        const members = name === androidControlNetworkName('r1') && anchorExists
          ? { [anchorId]: { Name: 'dh-r1-anchor' } }
          : name === roomNetworkName('r1')
            ? { [runtimeId]: { Name: androidRuntimeAnchorName('r1') } }
            : {}
        return { code: 0, stdout: networkInspect('r1', name, members), stderr: '' }
      }
      if (args[0] === 'inspect') {
        if (args[1] === androidRuntimeAnchorName('r1') || args[1] === runtimeId) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: runtimeId,
              Name: `/${androidRuntimeAnchorName('r1')}`,
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'android-runtime-anchor',
                'devhotel.managed': '1'
              } },
              State: { Status: runtimeState },
              HostConfig: { NetworkMode: roomNetworkName('r1') }
            }]),
            stderr: ''
          }
        }
        if (args[1] === 'dh-r1-anchor' || args[1] === anchorId) {
          return anchorExists
            ? {
                code: 0,
                stdout: JSON.stringify([{
                  Id: anchorId,
                  Name: '/dh-r1-anchor',
                  Config: { Labels: {
                    'devhotel.room': 'r1',
                    'devhotel.role': 'anchor',
                    'devhotel.managed': '1'
                  } },
                  State: { Status: 'running' },
                  HostConfig: { NetworkMode: androidControlNetworkName('r1') }
                }]),
                stderr: ''
              }
            : { code: 1, stdout: '', stderr: 'No such container' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'start' && args[1] === runtimeId) runtimeState = 'running'
      if (args[0] === 'run' && args.includes('dh-r1-anchor')) anchorExists = true
      if (args[0] === 'rm' && args.includes('dh-r1-anchor')) anchorExists = false
      if (args[0] === 'port') return { code: 0, stdout: '127.0.0.1:45123\n', stderr: '' }
      return ok
    })

    await backend().recreateAnchor({ roomId: 'r1', internalPort: 6080, androidRuntimeIsolation: true })

    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    const runtimeStartAt = calls.findIndex((args) => args[0] === 'start' && args[1] === runtimeId)
    const controlAnchorAt = calls.findIndex((args) => args[0] === 'run' && args.includes('dh-r1-anchor'))
    expect(runtimeStartAt).toBeGreaterThanOrEqual(0)
    expect(controlAnchorAt).toBeGreaterThan(runtimeStartAt)
    expect(calls[controlAnchorAt]).toEqual(expect.arrayContaining([
      '--network', androidControlNetworkName('r1')
    ]))
  })

  it('reuses only a bridge carrying the exact Room ownership labels', async () => {
    networkExists = true
    await backend().recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'create')).toBe(false)

    mockedRunDocker.mockClear()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args[2] !== roomNetworkName('r1')) {
          return { code: 1, stdout: '', stderr: 'Error: No such network' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{ Name: 'dh-r1-net', Driver: 'bridge', Labels: {} }]),
          stderr: ''
        }
      }
      return ok
    })
    await expect(backend().recreateAnchor({ roomId: 'r1', internalPort: 3000 })).rejects.toThrow(
      /ownership metadata/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false)
  })

  it('keeps raw capabilities host-only and rotates them whenever an anchor is recreated', async () => {
    const tokens = ['a'.repeat(64), 'b'.repeat(64)]
    const instance = backend(() => tokens.shift() ?? 'c'.repeat(64))

    await instance.recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    const first = await instance.relayToken('r1')
    await instance.recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    const second = await instance.relayToken('r1')

    expect(first).not.toBe(second)
    const serializedArgs = JSON.stringify(mockedRunDocker.mock.calls.map(([args]) => args))
    expect(serializedArgs).not.toContain(first)
    expect(serializedArgs).not.toContain(second)
    expect(serializedArgs).toContain(createHash('sha256').update(first).digest('hex'))
    expect(serializedArgs).toContain(createHash('sha256').update(second).digest('hex'))
  })

  it('fails closed after host process memory is lost until anchor recreation issues a fresh capability', async () => {
    const beforeRestart = backend(() => 'a'.repeat(64))
    await beforeRestart.recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    expect(await beforeRestart.relayToken('r1')).toBe('a'.repeat(64))

    const afterRestart = backend(() => 'b'.repeat(64))
    await expect(afterRestart.relayToken('r1')).rejects.toThrow(/recreate its anchor/)
    await afterRestart.recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    expect(await afterRestart.relayToken('r1')).toBe('b'.repeat(64))
  })

  it('lists labeled networks and strictly removes a managed orphan', async () => {
    networkExists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return {
          code: 0,
          stdout:
            '{"Name":"dh-r1-net","Labels":"devhotel.managed=1,devhotel.role=network,devhotel.room=r1"}\n',
          stderr: ''
        }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkExists && args[2] === roomNetworkName('r1')
          ? { code: 0, stdout: networkInspect('r1'), stderr: '' }
          : { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'network' && args[1] === 'rm') {
        networkExists = false
        return ok
      }
      return ok
    })

    const backend = new OciCliBackend()
    await expect(backend.listManagedNetworks()).resolves.toEqual([{ roomId: 'r1', name: 'dh-r1-net' }])
    await backend.removeManagedNetwork('dh-r1-net')
    expect(mockedRunDocker).toHaveBeenCalledWith(['network', 'rm', 'dh-r1-net'])
  })

  it('preflights both Android networks before deleting any Room resource', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args[2] === roomNetworkName('r1')) {
          return { code: 0, stdout: networkInspect('r1'), stderr: '' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: androidControlNetworkName('r1'),
            Driver: 'bridge',
            Labels: { 'devhotel.room': 'other', 'devhotel.role': 'network', 'devhotel.managed': '1' }
          }]),
          stderr: ''
        }
      }
      return ok
    })

    await expect(backend().deleteRoomPod('r1', { volumes: false })).rejects.toThrow(/ownership metadata/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'rm')).toBe(false)
  })

  it('deletes both owned Android bridges only after all Room containers are absent', async () => {
    const networks = new Set([roomNetworkName('r1'), androidControlNetworkName('r1')])
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'network' && args[1] === 'inspect') {
        const name = args[2]!
        return networks.has(name)
          ? { code: 0, stdout: networkInspect('r1', name), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'network' && args[1] === 'rm') {
        networks.delete(args[2]!)
        return ok
      }
      return ok
    })

    await expect(backend().deleteRoomPod('r1', { volumes: false })).resolves.toEqual({ reclaimedBytes: 0 })
    expect(networks.size).toBe(0)
    expect(mockedRunDocker).toHaveBeenCalledWith(['network', 'rm', roomNetworkName('r1')])
    expect(mockedRunDocker).toHaveBeenCalledWith(['network', 'rm', androidControlNetworkName('r1')])
  })

  it('refuses an Android service when the control plane exists without its runtime anchor', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'network' && args[1] === 'inspect' && args[2] === androidControlNetworkName('r1')) {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/runtime anchor is missing/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'pull')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'volume' && args[1] === 'create')).toBe(false)
  })

  it('keeps generic services on the generic anchor namespace', async () => {
    const serviceId = 'e'.repeat(64)
    let serviceCreated = false
    let creationToken = ''
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        if (serviceCreated && (args[1] === 'dh-r1-svc-redis' || args[1] === serviceId)) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: serviceId,
              Name: '/dh-r1-svc-redis',
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'svc-redis',
                'devhotel.managed': '1',
                'devhotel.creation-token': creationToken
              } },
              State: { Status: 'running' }
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: 'dh-r1-svc-redis-data',
            Labels: { 'devhotel.room': 'r1', 'devhotel.role': 'volume', 'devhotel.managed': '1' }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'run') {
        creationToken = args.find((arg) => arg.startsWith('devhotel.creation-token='))!.split('=')[1]!
        serviceCreated = true
        return { code: 0, stdout: `${serviceId}\n`, stderr: '' }
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).resolves.toBeUndefined()
    const run = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')?.[0]
    expect(run).toEqual(expect.arrayContaining(['--network', 'container:dh-r1-anchor']))
  })

  it('cleans failed service allocations by exact creation token and never deletes a name replacement', async () => {
    const serviceId = 'e'.repeat(64)
    let service: Record<string, unknown> | null = null
    let launch: 'nonzero' | 'malformed' | 'collision' = 'nonzero'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        const name = args[1]!
        if (service && (name === serviceId || name === 'dh-r1-svc-redis')) {
          return { code: 0, stdout: JSON.stringify([service]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: 'dh-r1-svc-redis-data',
            Labels: { 'devhotel.room': 'r1', 'devhotel.role': 'volume', 'devhotel.managed': '1' }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'run') {
        const token = args.find((arg) => arg.startsWith('devhotel.creation-token='))!.split('=')[1]!
        service = {
          Id: serviceId,
          Name: '/dh-r1-svc-redis',
          Config: { Labels: {
            'devhotel.room': 'r1',
            'devhotel.role': 'svc-redis',
            'devhotel.managed': '1',
            ...(launch === 'collision' ? {} : { 'devhotel.creation-token': token })
          } },
          State: { Status: 'running' }
        }
        if (launch === 'nonzero') return { code: 1, stdout: `${serviceId}\n`, stderr: 'start failed' }
        if (launch === 'malformed') return { code: 0, stdout: 'truncated-id\n', stderr: '' }
        return { code: 1, stdout: '', stderr: 'name already in use' }
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        service = null
        return ok
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/run redis container/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(service).toBe(null)

    mockedRunDocker.mockClear()
    launch = 'malformed'
    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/immutable container ID/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(service).toBe(null)

    mockedRunDocker.mockClear()
    launch = 'collision'
    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/run redis container/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
    expect(service === null).toBe(false)
  })

  it('accepts an empty joined sandbox on the exact runtime ID and removes a non-empty mismatch', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    const runtimeSandboxId = 'c'.repeat(64)
    let serviceExists = false
    let creationToken = ''
    let serviceSandboxId = ''
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect' && args[2] === androidControlNetworkName('r1')) {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === androidRuntimeAnchorName('r1') || args[1] === runtimeId) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: runtimeId,
              Name: `/${androidRuntimeAnchorName('r1')}`,
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'android-runtime-anchor',
                'devhotel.managed': '1'
              } },
              State: { Status: 'running' },
              HostConfig: { NetworkMode: roomNetworkName('r1') },
              NetworkSettings: { SandboxID: runtimeSandboxId }
            }]),
            stderr: ''
          }
        }
        if (serviceExists && args[1] === serviceId) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: serviceId,
              Name: '/dh-r1-svc-redis',
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'svc-redis',
                'devhotel.managed': '1',
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: runtimeSandboxId,
                'devhotel.creation-token': creationToken
              } },
              State: { Status: 'running' },
              HostConfig: { NetworkMode: `container:${runtimeId}` },
              NetworkSettings: { SandboxID: serviceSandboxId }
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: 'dh-r1-svc-redis-data',
            Labels: { 'devhotel.room': 'r1', 'devhotel.role': 'volume', 'devhotel.managed': '1' }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'run') {
        creationToken = args.find((arg) => arg.startsWith('devhotel.creation-token='))!.split('=')[1]!
        serviceExists = true
        return { code: 0, stdout: `${serviceId}\n`, stderr: '' }
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        serviceExists = false
        return ok
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).resolves.toBeUndefined()
    const run = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')?.[0]
    expect(run).toEqual(expect.arrayContaining(['--network', `container:${runtimeId}`]))
    expect(run).toContain(`${NETWORK_AUTHORITY_SANDBOX_LABEL}=${runtimeSandboxId}`)
    expect(serviceExists).toBe(true)

    mockedRunDocker.mockClear()
    serviceExists = false
    serviceSandboxId = 'd'.repeat(64)
    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/outside the exact runtime namespace/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)
  })

  it('removes a created Android service when its runtime anchor is replaced before final validation', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    const runtimeSandboxId = 'c'.repeat(64)
    let serviceExists = false
    let runtimeReplaced = false
    let creationToken = ''
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === androidRuntimeAnchorName('r1') && !runtimeReplaced) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: runtimeId,
              Name: `/${androidRuntimeAnchorName('r1')}`,
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'android-runtime-anchor',
                'devhotel.managed': '1'
              } },
              State: { Status: 'running' },
              HostConfig: { NetworkMode: roomNetworkName('r1') },
              NetworkSettings: { SandboxID: runtimeSandboxId }
            }]),
            stderr: ''
          }
        }
        if (serviceExists && args[1] === serviceId) {
          runtimeReplaced = true
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: serviceId,
              Name: '/dh-r1-svc-redis',
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'svc-redis',
                'devhotel.managed': '1',
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: runtimeSandboxId,
                'devhotel.creation-token': creationToken
              } },
              State: { Status: 'running' },
              HostConfig: { NetworkMode: `container:${runtimeId}` },
              NetworkSettings: { SandboxID: '' }
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: 'dh-r1-svc-redis-data',
            Labels: { 'devhotel.room': 'r1', 'devhotel.role': 'volume', 'devhotel.managed': '1' }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'run') {
        creationToken = args.find((arg) => arg.startsWith('devhotel.creation-token='))!.split('=')[1]!
        serviceExists = true
        return { code: 0, stdout: `${serviceId}\n`, stderr: '' }
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        serviceExists = false
        return ok
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/runtime anchor disappeared/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)
  })

  it('does not revive a stopped Android service bound to a replaced runtime anchor ID', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    let serviceExists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect' && args[2] === androidControlNetworkName('r1')) {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        serviceExists = false
        return ok
      }
      if (args[0] !== 'inspect') return ok
      if (args[1] === androidRuntimeAnchorName('r1')) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: runtimeId,
            Name: `/${androidRuntimeAnchorName('r1')}`,
            Config: { Labels: {
              'devhotel.room': 'r1',
              'devhotel.role': 'android-runtime-anchor',
              'devhotel.managed': '1'
            } },
            State: { Status: 'running' },
            HostConfig: { NetworkMode: roomNetworkName('r1') },
            NetworkSettings: { SandboxID: 'c'.repeat(64) }
          }]),
          stderr: ''
        }
      }
      if (serviceExists && (args[1] === 'dh-r1-svc-redis' || args[1] === serviceId)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: serviceId,
            Name: '/dh-r1-svc-redis',
            Config: { Labels: {
              'devhotel.room': 'r1',
              'devhotel.role': 'svc-redis',
              'devhotel.managed': '1'
            } },
            State: { Status: 'exited' },
            HostConfig: { NetworkMode: `container:${'d'.repeat(64)}` }
          }]),
          stderr: ''
        }
      }
      return { code: 1, stdout: '', stderr: 'No such container' }
    })

    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/exact Android runtime namespace/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)
  })

  it('fails closed when a runtime anchor exists without its Android control network', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    const inspected = (name: string, role: string, id: string, status: string) => ({
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': 'r1',
        'devhotel.role': role,
        'devhotel.managed': '1'
      } },
      State: { Status: status },
      HostConfig: {
        NetworkMode: role === 'android-runtime-anchor'
          ? roomNetworkName('r1')
          : `container:${runtimeId}`
      },
      ...(role === 'android-runtime-anchor'
        ? { NetworkSettings: { SandboxID: 'c'.repeat(64) } }
        : {})
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'No such network' }
      }
      if (args[0] === 'inspect' && args[1] === androidRuntimeAnchorName('r1')) {
        return {
          code: 0,
          stdout: JSON.stringify([
            inspected(androidRuntimeAnchorName('r1'), 'android-runtime-anchor', runtimeId, 'running')
          ]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect' && args[1] === 'dh-r1-svc-redis') {
        return {
          code: 0,
          stdout: JSON.stringify([inspected('dh-r1-svc-redis', 'svc-redis', serviceId, 'exited')]),
          stderr: ''
        }
      }
      return ok
    })

    await expect(backend().createService('r1', 'redis', '8')).rejects.toThrow(/control network is missing/)
    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/control network is missing/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run' || args[0] === 'start')).toBe(false)
  })

  it('persists exact web and service rejoin proofs across an Android wake', async () => {
    const roomId = 'room1abc'
    const ids = {
      anchor: 'a'.repeat(64),
      runtime: 'b'.repeat(64),
      web: 'c'.repeat(64),
      service: 'd'.repeat(64)
    }
    const originalRuntimeSandbox = 'e'.repeat(64)
    const currentRuntimeSandbox = 'f'.repeat(64)
    const root = tempDir()
    const attestationDir = join(root, 'runtime', 'network-recovery-attestations')
    const instance = () => new OciCliBackend({
      identityFile: join(root, 'runtime', 'docker-engine.json'),
      networkRecoveryAttestationDir: attestationDir
    })
    let anchorState = 'exited'
    let runtimeState = 'exited'
    let webState = 'exited'
    let serviceState = 'exited'
    let runtimeSandbox = originalRuntimeSandbox
    let runtimeStartedAt = '2026-09-02T00:00:00.100000001Z'
    let webStartedAt = '2026-09-02T00:00:00.200000001Z'
    let serviceStartedAt = '2026-09-02T00:00:00.300000001Z'
    const owned = (
      name: string,
      role: string,
      id: string,
      state: string,
      startedAt: string,
      networkMode: string,
      sandboxId?: string,
      authorityLabel?: string
    ) => ({
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': roomId,
        'devhotel.role': role,
        'devhotel.managed': '1',
        ...(authorityLabel === undefined
          ? {}
          : { [NETWORK_AUTHORITY_SANDBOX_LABEL]: authorityLabel })
      } },
      State: { Status: state, StartedAt: startedAt },
      HostConfig: { NetworkMode: networkMode },
      ...(sandboxId === undefined ? {} : { NetworkSettings: { SandboxID: sandboxId } })
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: 'engine-network-rejoin' }), stderr: '' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        const name = args[2]!
        const members = name === androidControlNetworkName(roomId) && anchorState === 'running'
          ? { [ids.anchor]: { Name: anchorName(roomId) } }
          : name === roomNetworkName(roomId) && runtimeState === 'running'
            ? { [ids.runtime]: { Name: androidRuntimeAnchorName(roomId) } }
            : {}
        return { code: 0, stdout: networkInspect(roomId, name, members), stderr: '' }
      }
      if (args[0] === 'inspect') {
        if (args[1] === anchorName(roomId) || args[1] === ids.anchor) {
          return {
            code: 0,
            stdout: JSON.stringify([owned(
              anchorName(roomId),
              'anchor',
              ids.anchor,
              anchorState,
              '2026-09-02T00:00:01.000000001Z',
              androidControlNetworkName(roomId),
              '1'.repeat(64)
            )]),
            stderr: ''
          }
        }
        if (args[1] === androidRuntimeAnchorName(roomId) || args[1] === ids.runtime) {
          return {
            code: 0,
            stdout: JSON.stringify([owned(
              androidRuntimeAnchorName(roomId),
              'android-runtime-anchor',
              ids.runtime,
              runtimeState,
              runtimeStartedAt,
              roomNetworkName(roomId),
              runtimeSandbox
            )]),
            stderr: ''
          }
        }
        if (args[1] === webName(roomId) || args[1] === ids.web) {
          return {
            code: 0,
            stdout: JSON.stringify([owned(
              webName(roomId),
              'web',
              ids.web,
              webState,
              webStartedAt,
              `container:${ids.runtime}`,
              webState === 'running' ? '' : undefined,
              originalRuntimeSandbox
            )]),
            stderr: ''
          }
        }
        if (args[1] === `dh-${roomId}-svc-redis` || args[1] === ids.service) {
          return {
            code: 0,
            stdout: JSON.stringify([owned(
              `dh-${roomId}-svc-redis`,
              'svc-redis',
              ids.service,
              serviceState,
              serviceStartedAt,
              `container:${ids.runtime}`,
              serviceState === 'running' ? '' : undefined,
              originalRuntimeSandbox
            )]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'start') {
        if (args[1] === anchorName(roomId)) anchorState = 'running'
        if (args[1] === ids.runtime) {
          runtimeState = 'running'
          runtimeSandbox = currentRuntimeSandbox
          runtimeStartedAt = '2026-09-02T00:00:02.000000001Z'
        }
        if (args[1] === ids.web) {
          webState = 'running'
          webStartedAt = '2026-09-02T00:00:03.000000001Z'
        }
        if (args[1] === ids.service) {
          serviceState = 'running'
          serviceStartedAt = '2026-09-02T00:00:04.000000001Z'
        }
        return ok
      }
      if (args[0] === 'port') return { code: 0, stdout: '127.0.0.1:45123\n', stderr: '' }
      return ok
    })

    await expect(instance().startRoomPod(roomId, { androidRuntimeIsolation: true }))
      .resolves.toEqual({ hostPort: 45123 })
    expect(existsSync(join(attestationDir, `${roomId}-${ids.web}.json`))).toBe(true)

    await expect(instance().startService(roomId, 'redis')).resolves.toBeUndefined()
    expect(existsSync(join(attestationDir, `${roomId}-${ids.service}.json`))).toBe(true)

    mockedRunDocker.mockClear()
    await expect(instance().startWeb(roomId)).resolves.toBeUndefined()
    await expect(instance().startService(roomId, 'redis')).resolves.toBeUndefined()
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
  })

  it('starts an exact-ID service with an empty joined sandbox and removes a non-empty mismatch', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    const runtimeSandboxId = 'c'.repeat(64)
    let serviceExists = true
    let serviceStatus = 'exited'
    let cleanupFails = false
    let startFails = false
    let startedStatus = 'running'
    let corruptOwnership = false
    let runningServiceSandboxId = ''
    let serviceStartedAt = '2026-09-02T00:00:00.100000001Z'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      if (
        args[0] === 'inspect' &&
        (args[1] === androidRuntimeAnchorName('r1') || args[1] === runtimeId)
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: runtimeId,
            Name: `/${androidRuntimeAnchorName('r1')}`,
            Config: { Labels: {
              'devhotel.room': 'r1',
              'devhotel.role': 'android-runtime-anchor',
              'devhotel.managed': '1'
            } },
            State: { Status: 'running', StartedAt: '2026-09-02T00:00:01.000000001Z' },
            HostConfig: { NetworkMode: roomNetworkName('r1') },
            NetworkSettings: { SandboxID: runtimeSandboxId }
          }]),
          stderr: ''
        }
      }
      if (
        args[0] === 'inspect' &&
        serviceExists &&
        (args[1] === 'dh-r1-svc-redis' || args[1] === serviceId)
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: serviceId,
            Name: '/dh-r1-svc-redis',
            Config: { Labels: {
              'devhotel.room': 'r1',
              'devhotel.role': 'svc-redis',
              'devhotel.managed': corruptOwnership && serviceStatus !== 'exited' ? '0' : '1',
              [NETWORK_AUTHORITY_SANDBOX_LABEL]: runtimeSandboxId
            } },
            State: { Status: serviceStatus, StartedAt: serviceStartedAt },
            HostConfig: { NetworkMode: `container:${runtimeId}` },
            ...(serviceStatus === 'running'
              ? { NetworkSettings: { SandboxID: runningServiceSandboxId } }
              : {})
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'start' && args[1] === serviceId) {
        serviceStatus = startedStatus
        serviceStartedAt = '2026-09-02T00:00:02.000000001Z'
        return startFails ? { code: 1, stdout: '', stderr: 'start failed after transition' } : ok
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        if (cleanupFails) return { code: 1, stdout: '', stderr: 'cleanup denied' }
        serviceExists = false
        return ok
      }
      return args[0] === 'inspect'
        ? { code: 1, stdout: '', stderr: 'No such container' }
        : ok
    })

    await expect(backend().startService('r1', 'redis')).resolves.toBeUndefined()
    expect(serviceExists).toBe(true)

    mockedRunDocker.mockClear()
    serviceStatus = 'exited'
    runningServiceSandboxId = 'd'.repeat(64)
    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/outside its exact network authority/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)

    mockedRunDocker.mockClear()
    serviceExists = true
    serviceStatus = 'exited'
    cleanupFails = true
    await expect(backend().startService('r1', 'redis'))
      .rejects.toThrow(/start validation and exact cleanup both failed/)
    expect(serviceExists).toBe(true)

    mockedRunDocker.mockClear()
    cleanupFails = false
    startFails = true
    serviceStatus = 'exited'
    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/start exact Android redis service/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)

    mockedRunDocker.mockClear()
    serviceExists = true
    serviceStatus = 'exited'
    startFails = false
    startedStatus = 'paused'
    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/not running in a live network namespace/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)

    mockedRunDocker.mockClear()
    serviceExists = true
    serviceStatus = 'exited'
    startedStatus = 'running'
    corruptOwnership = true
    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/ownership metadata/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)
  })

  it('removes a started Android service when its runtime anchor is replaced before final validation', async () => {
    const runtimeId = 'a'.repeat(64)
    const serviceId = 'b'.repeat(64)
    const runtimeSandboxId = 'c'.repeat(64)
    let serviceExists = true
    let serviceStatus = 'exited'
    let runtimeReplaced = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: networkInspect('r1', androidControlNetworkName('r1')),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === androidRuntimeAnchorName('r1') && !runtimeReplaced) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: runtimeId,
              Name: `/${androidRuntimeAnchorName('r1')}`,
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'android-runtime-anchor',
                'devhotel.managed': '1'
              } },
              State: { Status: 'running', StartedAt: '2026-09-02T00:00:01.000000001Z' },
              HostConfig: { NetworkMode: roomNetworkName('r1') },
              NetworkSettings: { SandboxID: runtimeSandboxId }
            }]),
            stderr: ''
          }
        }
        if (serviceExists && (args[1] === 'dh-r1-svc-redis' || args[1] === serviceId)) {
          if (args[1] === serviceId && serviceStatus === 'running') runtimeReplaced = true
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: serviceId,
              Name: '/dh-r1-svc-redis',
              Config: { Labels: {
                'devhotel.room': 'r1',
                'devhotel.role': 'svc-redis',
                'devhotel.managed': '1',
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: runtimeSandboxId
              } },
              State: { Status: serviceStatus, StartedAt: serviceStatus === 'running'
                ? '2026-09-02T00:00:02.000000001Z'
                : '2026-09-02T00:00:00.100000001Z' },
            HostConfig: { NetworkMode: `container:${runtimeId}` },
            ...(serviceStatus === 'running'
              ? { NetworkSettings: { SandboxID: '' } }
              : {})
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'start' && args[1] === serviceId) {
        serviceStatus = 'running'
        return ok
      }
      if (args[0] === 'rm' && args[2] === serviceId) {
        serviceExists = false
        return ok
      }
      return ok
    })

    await expect(backend().startService('r1', 'redis')).rejects.toThrow(/network authority disappeared/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', serviceId])
    expect(serviceExists).toBe(false)
  })

  it('migrates a legacy name-joined web through an exact token-fenced recreation', async () => {
    const roomId = 'room1abc'
    const oldWebId = 'a'.repeat(64)
    const newWebId = 'b'.repeat(64)
    const runtimeId = 'c'.repeat(64)
    const runtimeSandboxId = 'd'.repeat(64)
    let webId: string | null = oldWebId
    let webStatus: 'created' | 'running' = 'running'
    let webMode = `container:${androidRuntimeAnchorName(roomId)}`
    let webStartedAt = '2026-09-02T00:00:00.200000001Z'
    let webAuthorityLabel = ''
    let recreationToken = ''
    const spec: WebSpec = {
      roomId,
      internalPort: 6080,
      nodeMajor: '22',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      workspaceVolumeRevision: 0,
      startCommand: 'sleep 1',
      imageOverride: `android-build@sha256:${'e'.repeat(64)}`,
      androidRuntimeIsolation: true,
      noDepsVolume: true,
      noCacheVolume: true
    }
    const runtime = () => ({
      Id: runtimeId,
      Name: `/${androidRuntimeAnchorName(roomId)}`,
      Config: { Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'android-runtime-anchor',
        'devhotel.managed': '1'
      } },
      State: { Status: 'running', StartedAt: '2026-09-02T00:00:00.100000001Z' },
      HostConfig: { NetworkMode: roomNetworkName(roomId) },
      NetworkSettings: { SandboxID: runtimeSandboxId }
    })
    const web = () => ({
      Id: webId,
      Name: `/${webName(roomId)}`,
      Config: { Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'web',
        'devhotel.managed': '1',
        ...(webAuthorityLabel ? { [NETWORK_AUTHORITY_SANDBOX_LABEL]: webAuthorityLabel } : {}),
        ...(recreationToken ? { 'devhotel.artifact-restore-token': recreationToken } : {})
      } },
      State: { Status: webStatus, StartedAt: webStartedAt },
      HostConfig: { NetworkMode: webMode },
      NetworkSettings: { SandboxID: '' }
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 0, stdout: networkInspect(roomId), stderr: '' }
      }
      if (args[0] === 'inspect') {
        if (args[1] === runtimeId || args[1] === androidRuntimeAnchorName(roomId)) {
          return { code: 0, stdout: JSON.stringify([runtime()]), stderr: '' }
        }
        if (webId && (args[1] === webId || args[1] === webName(roomId))) {
          return { code: 0, stdout: JSON.stringify([web()]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'rm' && args[2] === oldWebId) {
        webId = null
        return ok
      }
      if (args[0] === 'create' && args.includes(webName(roomId))) {
        webId = newWebId
        webStatus = 'created'
        webMode = args[args.indexOf('--network') + 1]!
        webAuthorityLabel = args.find((arg) =>
          arg.startsWith(`${NETWORK_AUTHORITY_SANDBOX_LABEL}=`)
        )?.split('=')[1] ?? ''
        recreationToken = args.find((arg) =>
          arg.startsWith('devhotel.artifact-restore-token=')
        )?.split('=')[1] ?? ''
        return { code: 0, stdout: `${newWebId}\n`, stderr: '' }
      }
      if (args[0] === 'start' && args[1] === newWebId) {
        webStatus = 'running'
        webStartedAt = '2026-09-02T00:00:01.200000001Z'
        return ok
      }
      return ok
    })

    await expect(backend().restartWeb(roomId, spec)).resolves.toBeUndefined()
    expect(webId).toBe(newWebId)
    expect(webMode).toBe(`container:${runtimeId}`)
    expect(webAuthorityLabel).toBe(runtimeSandboxId)
    expect(recreationToken).toMatch(/^[a-f0-9]{32}$/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start' && args[1] === oldWebId)).toBe(false)
  })

  it('does not start a same-name web replacement during an exact restart', async () => {
    const roomId = 'room1abc'
    const originalId = 'a'.repeat(64)
    const replacementId = 'b'.repeat(64)
    let stopped = false
    let replacementVisible = false
    const inspected = (id: string, status: string) => ({
      Id: id,
      Name: `/${webName(roomId)}`,
      Config: { Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'web',
        'devhotel.managed': '1'
      } },
      State: { Status: status },
      HostConfig: { NetworkMode: roomNetworkName(roomId) }
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        if (args[1] === originalId) {
          const result = { code: 0, stdout: JSON.stringify([inspected(originalId, 'exited')]), stderr: '' }
          replacementVisible = true
          return result
        }
        if (args[1] === webName(roomId)) {
          return {
            code: 0,
            stdout: JSON.stringify([inspected(replacementVisible ? replacementId : originalId, stopped ? 'exited' : 'running')]),
            stderr: ''
          }
        }
      }
      if (args[0] === 'stop' && args.at(-1) === originalId) {
        stopped = true
        return ok
      }
      return { code: 1, stdout: '', stderr: 'unexpected command' }
    })

    await expect(backend().restartWeb(roomId)).rejects.toThrow(/immutable ID changed before start/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
  })
})
