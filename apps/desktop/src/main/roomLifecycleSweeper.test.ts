import { describe, expect, it, vi } from 'vitest'
import { startRoomLifecycleSweeper } from './roomLifecycleSweeper'

describe('Room lifecycle sweeper', () => {
  it('runs immediately, repeats without overlap, and stops cleanly', async () => {
    const orch = {
      sweepRoomLifecycle: vi.fn(async () => ({ slept: [], expired: [], deleted: [], retained: [] }))
    }
    const onError = vi.fn()
    const sweeper = startRoomLifecycleSweeper(orch as never, { intervalMs: 5, onError })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onError).not.toHaveBeenCalled()
    expect(orch.sweepRoomLifecycle.mock.calls.length).toBeGreaterThan(1)

    sweeper.stop()
    const callsAtStop = orch.sweepRoomLifecycle.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(orch.sweepRoomLifecycle).toHaveBeenCalledTimes(callsAtStop)
  })
})
