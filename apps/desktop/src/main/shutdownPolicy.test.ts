import { describe, expect, it, vi } from 'vitest'
import { executeShutdownPolicy } from './shutdownPolicy'

describe('update shutdown policy', () => {
  it('never installs an update when Room shutdown rejects', async () => {
    const installUpdate = vi.fn()
    const exit = vi.fn()
    const reportFailure = vi.fn()

    await executeShutdownPolicy('install-update', {
      shutdown: async () => {
        throw new AggregateError([new Error('Room stop failed')], 'shutdown incomplete')
      },
      installUpdate,
      relaunch: vi.fn(),
      exit,
      reportFailure
    })

    expect(installUpdate).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith('install-update', expect.any(AggregateError))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('schedules a relaunch only after every Room shuts down successfully', async () => {
    const order: string[] = []
    await executeShutdownPolicy('relaunch', {
      shutdown: async () => {
        order.push('shutdown')
      },
      installUpdate: vi.fn(),
      relaunch: () => order.push('relaunch'),
      exit: (code) => order.push(`exit:${code}`),
      reportFailure: vi.fn()
    })

    expect(order).toEqual(['shutdown', 'relaunch', 'exit:0'])
  })

  it('never schedules a relaunch when Room shutdown fails', async () => {
    const relaunch = vi.fn()
    const exit = vi.fn()
    await executeShutdownPolicy('relaunch', {
      shutdown: async () => {
        throw new Error('Room stop failed')
      },
      installUpdate: vi.fn(),
      relaunch,
      exit,
      reportFailure: vi.fn()
    })

    expect(relaunch).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })
})
