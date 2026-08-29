import { describe, expect, it, vi } from 'vitest'
import { startDeviceSweeper } from './deviceSweeper'

function orchStub(overrides: Record<string, unknown> = {}) {
  return {
    refreshAndroidDevices: vi.fn(async () => []),
    reapAndroidDevices: vi.fn(async () => ({ recovered: [], warnings: [] })),
    ...overrides
  }
}

describe('the device sweeper keeps the shared phone honest while DevHotel runs', () => {
  it('discovers devices and reclaims stale leases on every tick', async () => {
    vi.useFakeTimers()
    const orch = orchStub()
    const sweeper = startDeviceSweeper(orch as never, { intervalMs: 10_000 })

    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    sweeper.stop()

    expect(orch.refreshAndroidDevices).toHaveBeenCalledTimes(2)
    expect(orch.reapAndroidDevices).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps sweeping after a failed discovery instead of giving up', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const orch = orchStub({
      refreshAndroidDevices: vi
        .fn()
        .mockRejectedValueOnce(new Error('adb server died'))
        .mockResolvedValue([])
    })
    const sweeper = startDeviceSweeper(orch as never, { intervalMs: 10_000, onError })

    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    sweeper.stop()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(orch.refreshAndroidDevices).toHaveBeenCalledTimes(2)
    // A phone that failed to enumerate must still not park a dead lease forever.
    expect(orch.reapAndroidDevices).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not overlap sweeps when one runs longer than the interval', async () => {
    vi.useFakeTimers()
    let running = 0
    let overlapped = false
    const orch = orchStub({
      refreshAndroidDevices: vi.fn(async () => {
        running += 1
        if (running > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 25_000))
        running -= 1
        return []
      })
    })
    const sweeper = startDeviceSweeper(orch as never, { intervalMs: 10_000 })

    await vi.advanceTimersByTimeAsync(60_000)
    sweeper.stop()

    expect(overlapped).toBe(false)
    vi.useRealTimers()
  })

  it('stops cleanly so app shutdown is not held open by a timer', async () => {
    vi.useFakeTimers()
    const orch = orchStub()
    const sweeper = startDeviceSweeper(orch as never, { intervalMs: 10_000 })

    sweeper.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(orch.refreshAndroidDevices).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
