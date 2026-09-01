import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import {
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  NETWORK_AUTHORITY_STARTED_AT_LABEL,
  anchorName,
  roomNetworkName
} from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const SERVICE_NETWORK_ID = '1'.repeat(64)

function row(id: string, name: string, role: string, state: string): string {
  return JSON.stringify({
    ID: id,
    Names: name,
    State: state,
    Labels: `devhotel.room=r1,devhotel.role=${role},devhotel.managed=1`
  })
}

describe('OciCliBackend.stopRoomPod', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('stops the web first, stops remaining owned containers, and verifies their state', async () => {
    let webState = 'running'
    let emulatorState = 'running'
    let runtimeState = 'running'
    let anchorState = 'running'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        return {
          code: 0,
          stdout: `${row('aaa111', 'dh-r1-web', 'web', webState)}\n${row(
            'ccc333',
            'dh-r1-svc-emulator',
            'svc-emulator',
            emulatorState
          )}\n${row(
            'ddd444',
            'dh-r1-android-runtime-anchor',
            'android-runtime-anchor',
            runtimeState
          )}\n${row(
            'bbb222',
            'dh-r1-anchor',
            'anchor',
            anchorState
          )}\n`,
          stderr: ''
        }
      }
      if (args[0] === 'stop' && args.includes('aaa111')) webState = 'exited'
      if (args[0] === 'stop' && args.includes('ccc333')) emulatorState = 'exited'
      if (args[0] === 'stop' && args.includes('ddd444')) runtimeState = 'exited'
      if (args[0] === 'stop' && args.includes('bbb222')) anchorState = 'exited'
      return { code: 0, stdout: '', stderr: '' }
    })

    await new OciCliBackend().stopRoomPod('r1')

    expect(mockedRunDocker).toHaveBeenCalledWith(['stop', '-t', '8', 'aaa111'])
    expect(mockedRunDocker).toHaveBeenCalledWith(['stop', '-t', '5', 'ccc333'])
    expect(mockedRunDocker).toHaveBeenCalledWith(['stop', '-t', '5', 'ddd444'])
    expect(mockedRunDocker).toHaveBeenCalledWith(['stop', '-t', '5', 'bbb222'])
    const stopCalls = mockedRunDocker.mock.calls
      .map(([args]) => args)
      .filter((args) => args[0] === 'stop')
    expect(stopCalls.map((args) => args.at(-1))).toEqual(['aaa111', 'ccc333', 'ddd444', 'bbb222'])
  })

  it('throws when docker stop fails', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        return { code: 0, stdout: `${row('aaa111', 'dh-r1-web', 'web', 'running')}\n`, stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'stop failed' }
    })

    await expect(new OciCliBackend().stopRoomPod('r1')).rejects.toThrow(/stop Room r1 web container failed/)
  })

  it('throws when a container still reports running after successful stop', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        return { code: 0, stdout: `${row('aaa111', 'dh-r1-web', 'web', 'running')}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(new OciCliBackend().stopRoomPod('r1')).rejects.toThrow(/stop incomplete/)
  })
})

const SERVICE_AUTHORITY_ID = 'a'.repeat(64)
const SERVICE_AUTHORITY_SANDBOX_ID = 'b'.repeat(64)
const SERVICE_AUTHORITY_STARTED_AT = '2026-09-02T00:00:00.100000001Z'

function redisInspect(status: string, startedAt = '2026-09-02T00:00:00.200000001Z'): string {
  return JSON.stringify([
    {
      Id: 'c'.repeat(64),
      Name: '/dh-r1-svc-redis',
      Config: {
        Labels: {
          'devhotel.room': 'r1',
          'devhotel.role': 'svc-redis',
          'devhotel.managed': '1',
          [NETWORK_AUTHORITY_SANDBOX_LABEL]: SERVICE_AUTHORITY_SANDBOX_ID,
          [NETWORK_AUTHORITY_STARTED_AT_LABEL]: SERVICE_AUTHORITY_STARTED_AT
        }
      },
      State: { Status: status, StartedAt: startedAt },
      HostConfig: { NetworkMode: `container:${SERVICE_AUTHORITY_ID}` },
      NetworkSettings: { SandboxID: status === 'running' ? '' : undefined }
    }
  ])
}

describe('OciCliBackend service stop/start', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('propagates docker stop failure', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: redisInspect('running'), stderr: '' }
      return { code: 1, stdout: '', stderr: 'stop denied' }
    })
    await expect(new OciCliBackend().stopService('r1', 'redis')).rejects.toThrow(/stop redis failed/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['stop', '-t', '5', 'c'.repeat(64)])
  })

  it('post-verifies that a service really exited', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: redisInspect('running'), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(new OciCliBackend().stopService('r1', 'redis')).rejects.toThrow(/stop incomplete/)
  })

  it('post-verifies that a service really started', async () => {
    let state = 'exited'
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect' && args[1] === 'dh-r1-android-runtime-anchor') {
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'inspect' && (args[1] === anchorName('r1') || args[1] === SERVICE_AUTHORITY_ID)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: SERVICE_AUTHORITY_ID,
            Name: `/${anchorName('r1')}`,
            Config: { Labels: {
              'devhotel.room': 'r1',
              'devhotel.role': 'anchor',
              'devhotel.managed': '1'
            } },
            State: { Status: 'running', StartedAt: SERVICE_AUTHORITY_STARTED_AT },
            HostConfig: { NetworkMode: roomNetworkName('r1') },
            NetworkSettings: {
              SandboxID: SERVICE_AUTHORITY_SANDBOX_ID,
              Networks: {
                [roomNetworkName('r1')]: { NetworkID: SERVICE_NETWORK_ID }
              }
            }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') return { code: 0, stdout: redisInspect(state), stderr: '' }
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args[2] !== roomNetworkName('r1')) {
          return { code: 1, stdout: '', stderr: 'No such network' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: SERVICE_NETWORK_ID,
            Name: roomNetworkName('r1'),
            Driver: 'bridge',
            Labels: { 'devhotel.room': 'r1', 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: { [SERVICE_AUTHORITY_ID]: { Name: anchorName('r1') } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'start') state = 'running'
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(new OciCliBackend().startService('r1', 'redis')).resolves.toBeUndefined()
    expect(mockedRunDocker).toHaveBeenCalledWith(['start', 'c'.repeat(64)])
  })
})
