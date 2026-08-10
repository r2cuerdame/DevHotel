import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { jobName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ok = { code: 0, stdout: '', stderr: '' }
const roomId = 'room1abc'
const validName = jobName(roomId, '11111111-2222-4333-8444-555555555555')

function inspectJob(name: string, overrides: { roomId?: string; role?: string; managed?: string } = {}): string {
  return JSON.stringify([{
    Id: 'a'.repeat(64),
    Name: `/${name}`,
    Config: {
      Labels: {
        'devhotel.room': overrides.roomId ?? roomId,
        'devhotel.role': overrides.role ?? 'job',
        'devhotel.managed': overrides.managed ?? '1'
      }
    },
    State: { Status: 'running' }
  }])
}

describe('OciCliBackend managed job cleanup', () => {
  beforeEach(() => {
    mockedRunDocker.mockReset()
  })

  it('removes an exactly owned Room-scoped UUID job and post-verifies deletion', async () => {
    let exists = true
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        return exists
          ? { code: 0, stdout: inspectJob(validName), stderr: '' }
          : { code: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        exists = false
        return ok
      }
      return ok
    })

    await expect(new OciCliBackend().removeManagedContainer(validName)).resolves.toBeUndefined()

    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', validName])
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'inspect')).toHaveLength(2)
  })

  it('refuses a managed job label when its name is not the strict Room UUID form', async () => {
    const malformedName = `dh-${roomId}-job-not-a-uuid`
    mockedRunDocker.mockResolvedValue({ code: 0, stdout: inspectJob(malformedName), stderr: '' })

    await expect(new OciCliBackend().removeManagedContainer(malformedName)).rejects.toThrow(
      /not owned by DevHotel/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
  })

  it('refuses a valid job name with mismatched Room ownership labels', async () => {
    mockedRunDocker.mockResolvedValue({
      code: 0,
      stdout: inspectJob(validName, { roomId: 'anotherroom' }),
      stderr: ''
    })

    await expect(new OciCliBackend().removeManagedContainer(validName)).rejects.toThrow(
      /not owned by DevHotel/
    )
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
  })
})
