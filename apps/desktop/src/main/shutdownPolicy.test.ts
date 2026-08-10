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
      exit,
      reportFailure
    })

    expect(installUpdate).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith('install-update', expect.any(AggregateError))
    expect(exit).toHaveBeenCalledWith(1)
  })
})
