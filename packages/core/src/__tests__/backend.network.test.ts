import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'
import { buildAnchorArgs, buildRoomNetworkCreateArgs } from '../backend/naming'
import type { WebSpec } from '../backend/types'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ok = { code: 0, stdout: '', stderr: '' }
const TOKEN = 'a'.repeat(64)
const VERIFIER = createHash('sha256').update(TOKEN).digest('hex')

function backend(tokenFactory: () => string = () => TOKEN): OciCliBackend {
  return new OciCliBackend({ relayTokenFactory: tokenFactory })
}

function networkInspect(roomId: string) {
  return JSON.stringify([
    {
      Name: `dh-${roomId}-net`,
      Driver: 'bridge',
      Labels: {
        'devhotel.room': roomId,
        'devhotel.role': 'network',
        'devhotel.managed': '1'
      }
    }
  ])
}

describe('OciCliBackend Room networks', () => {
  let networkExists: boolean

  beforeEach(() => {
    networkExists = false
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'Error: No such object' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkExists
          ? { code: 0, stdout: networkInspect('r1'), stderr: '' }
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
        return networkExists
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

  it('reuses only a bridge carrying the exact Room ownership labels', async () => {
    networkExists = true
    await backend().recreateAnchor({ roomId: 'r1', internalPort: 3000 })
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'create')).toBe(false)

    mockedRunDocker.mockClear()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
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
        return networkExists
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
})
