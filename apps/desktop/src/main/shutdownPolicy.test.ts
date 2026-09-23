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

describe('shutdown deadline', () => {
  it('reports a terminal bounded failure and exits non-zero when shutdown never settles', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const reportFailure = vi.fn()
      const installUpdate = vi.fn()
      const policy = executeShutdownPolicy('install-update', {
        shutdown: () => new Promise<void>(() => undefined),
        installUpdate,
        relaunch: vi.fn(),
        exit,
        reportFailure,
        deadlineMs: 45_000
      })
      await vi.advanceTimersByTimeAsync(44_999)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await policy
      expect(reportFailure).toHaveBeenCalledWith(
        'install-update',
        expect.objectContaining({ code: 'SHUTDOWN_DEADLINE_EXCEEDED' })
      )
      expect(installUpdate).not.toHaveBeenCalled()
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the deadline after a shutdown that finished in time', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const reportFailure = vi.fn()
      await executeShutdownPolicy('quit', {
        shutdown: async () => undefined,
        installUpdate: vi.fn(),
        relaunch: vi.fn(),
        exit,
        reportFailure,
        deadlineMs: 1_000
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(reportFailure).not.toHaveBeenCalled()
      expect(exit).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
