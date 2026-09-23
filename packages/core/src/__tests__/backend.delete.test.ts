import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ok = { code: 0, stdout: '', stderr: '' }
const ROOM_ID = 'r1'
const VOLUME = 'dh-r1-cache'

function containerRow(id: string, name: string, role: string, state = 'exited'): string {
  return JSON.stringify({
    ID: id,
    Names: name,
    State: state,
    Labels: `devhotel.room=${ROOM_ID},devhotel.role=${role},devhotel.managed=1`
  })
}

function volumeInspect(labels = true): string {
  return JSON.stringify([
    {
      Name: VOLUME,
      Labels: labels
        ? {
            'devhotel.room': ROOM_ID,
            'devhotel.role': 'volume',
            'devhotel.managed': '1'
          }
        : {}
    }
  ])
}

describe('OciCliBackend.deleteRoomPod', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('refuses deletion when container enumeration cannot be trusted', async () => {
    mockedRunDocker.mockResolvedValue({ code: 1, stdout: '', stderr: 'daemon unavailable' })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: false })).rejects.toThrow(
      /list Room r1 containers failed/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
  })

  it('removes an owned standalone Room network after its containers are gone', async () => {
    let networkExists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkExists && args[2] === 'dh-r1-net'
          ? {
              code: 0,
              stdout: JSON.stringify([
                {
                  Name: 'dh-r1-net',
                  Driver: 'bridge',
                  Labels: {
                    'devhotel.room': ROOM_ID,
                    'devhotel.role': 'network',
                    'devhotel.managed': '1'
                  }
                }
              ]),
              stderr: ''
            }
          : { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'network' && args[1] === 'rm') {
        networkExists = false
        return ok
      }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: false })).resolves.toEqual({ reclaimedBytes: 0 })
    expect(mockedRunDocker).toHaveBeenCalledWith(['network', 'rm', 'dh-r1-net'])
  })

  it('throws on container removal failure and never reports a clean deletion', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        return {
          code: 0,
          stdout: `${containerRow('aaa111', 'dh-r1-web', 'web')}\n${containerRow('bbb222', 'dh-r1-anchor', 'anchor')}\n`,
          stderr: ''
        }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'rm') return { code: 1, stdout: '', stderr: 'remove denied' }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: false })).rejects.toThrow(
      /remove Room r1 leaf containers failed/
    )
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', 'aaa111'])
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'rm')).toBe(false)
  })

  it('post-verifies container removal before deleting the network', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        return { code: 0, stdout: `${containerRow('aaa111', 'dh-r1-web', 'web')}\n`, stderr: '' }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: false })).rejects.toThrow(
      /container cleanup incomplete/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'rm')).toBe(false)
  })

  it('stops running services and leaves gracefully before any forced removal', async () => {
    let listed = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') {
        if (listed) return ok
        listed = true
        return {
          code: 0,
          stdout: [
            containerRow('aaa111', 'dh-r1-web', 'web', 'running'),
            containerRow('ccc111', 'dh-r1-svc-postgres', 'svc-postgres', 'running'),
            containerRow('ddd111', 'dh-r1-svc-redis', 'svc-redis', 'exited'),
            containerRow('bbb222', 'dh-r1-anchor', 'anchor', 'running')
          ].join('\n') + '\n',
          stderr: ''
        }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      // A wedged web must not block the delete; the forced boundary follows.
      if (args[0] === 'stop' && args.includes('aaa111')) return { code: 1, stdout: '', stderr: 'web is wedged' }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: false })).resolves.toEqual({
      reclaimedBytes: 0
    })
    const commands = mockedRunDocker.mock.calls.map(([args]) => args)
    const firstRemove = commands.findIndex((args) => args[0] === 'rm')
    const stops = commands.filter((args) => args[0] === 'stop')
    expect(stops).toEqual([
      ['stop', '-t', '8', 'aaa111'],
      ['stop', '-t', '5', 'ccc111'],
      ['stop', '-t', '5', 'bbb222']
    ])
    expect(commands.findLastIndex((args) => args[0] === 'stop')).toBeLessThan(firstRemove)
    expect(commands.filter((args) => args[0] === 'rm')).toEqual([
      ['rm', '-f', 'aaa111', 'ccc111', 'ddd111'],
      ['rm', '-f', 'bbb222']
    ])
  })

  it('throws when an owned volume cannot be removed', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'ps') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: volumeInspect(), stderr: '' }
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        return { code: 1, stdout: '', stderr: 'volume is in use' }
      }
      if (args[0] === 'run') return { code: 0, stdout: '12\t/v\n', stderr: '' }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: true })).rejects.toThrow(
      /remove Room r1 volumes failed/
    )
  })

  it('never deletes a prefix-colliding user or unlabeled legacy volume', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `${VOLUME}\n`, stderr: '' }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return { code: 0, stdout: volumeInspect(false), stderr: '' }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such network' }
      }
      return ok
    })

    await expect(new OciCliBackend().deleteRoomPod(ROOM_ID, { volumes: true })).rejects.toThrow(
      /explicit migration is required/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
  })
})
