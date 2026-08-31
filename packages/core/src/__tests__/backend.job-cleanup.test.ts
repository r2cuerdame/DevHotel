import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { jobName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ok = { code: 0, stdout: '', stderr: '' }
const roomId = 'room1abc'
const validName = jobName(roomId, '11111111-2222-4333-8444-555555555555')
const originalId = 'a'.repeat(64)
const replacementId = 'b'.repeat(64)

function inspectJob(
  name: string,
  overrides: { id?: string; roomId?: string; role?: string; managed?: string } = {}
): string {
  return JSON.stringify([{
    Id: overrides.id ?? originalId,
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
    let removed = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        if (args[1] === validName && !removed) {
          return { code: 0, stdout: inspectJob(validName), stderr: '' }
        }
        if (args[1] === originalId && removed) {
          return { code: 1, stdout: '', stderr: 'Error: No such container' }
        }
        return { code: 1, stdout: '', stderr: 'Error: unexpected inspect target' }
      }
      if (args[0] === 'rm') {
        removed = args[2] === originalId
        return ok
      }
      return ok
    })

    await expect(new OciCliBackend().removeManagedContainer(validName)).resolves.toBeUndefined()

    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', originalId])
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'inspect').map(([args]) => args[1]))
      .toEqual([validName, originalId])
  })

  it('does not inspect or remove a same-name replacement after deleting the fenced ID', async () => {
    let removed = false
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect' && args[1] === validName) {
        return {
          code: 0,
          stdout: inspectJob(validName, { id: removed ? replacementId : originalId }),
          stderr: ''
        }
      }
      if (args[0] === 'inspect' && args[1] === originalId) {
        return removed
          ? { code: 1, stdout: '', stderr: 'Error: No such container' }
          : { code: 0, stdout: inspectJob(validName), stderr: '' }
      }
      if (args[0] === 'rm') {
        if (args[2] === originalId) removed = true
        return ok
      }
      return { code: 1, stdout: '', stderr: 'unexpected command' }
    })

    await expect(new OciCliBackend().removeManagedContainer(validName)).resolves.toBeUndefined()

    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'rm')).toEqual([
      [['rm', '-f', originalId]]
    ])
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'inspect').map(([args]) => args[1]))
      .toEqual([validName, originalId])
  })

  it('fails closed when the exact removed ID remains after cleanup', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect') {
        return { code: 0, stdout: inspectJob(validName), stderr: '' }
      }
      return ok
    })

    await expect(new OciCliBackend().removeManagedContainer(validName)).rejects.toThrow(
      /container cleanup incomplete/
    )
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', originalId])
  })

  it.each(['not-an-id', 'a'.repeat(12)])(
    'refuses deletion when inspect does not provide one full immutable ID: %s',
    async (id) => {
      mockedRunDocker.mockResolvedValue({
        code: 0,
        stdout: inspectJob(validName, { id }),
        stderr: ''
      })

      await expect(new OciCliBackend().removeManagedContainer(validName)).rejects.toThrow(
        /valid immutable ID/
      )
      expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)
    }
  )

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
