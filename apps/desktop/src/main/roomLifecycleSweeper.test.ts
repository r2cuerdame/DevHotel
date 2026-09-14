import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRoomLifecycleSweeper } from './roomLifecycleSweeper'

afterEach(() => vi.useRealTimers())

describe('Room lifecycle sweeper', () => {
  it('runs and awaits the sweep when onSweep is omitted', async () => {
    vi.useFakeTimers()
    let finishSweep!: () => void
    const heldSweep = new Promise<void>((resolve) => {
      finishSweep = resolve
    })
    const result = { slept: [], expired: [], deleted: [], retained: [] }
    const orch = {
      sweepRoomLifecycle: vi.fn(async () => {
        await heldSweep
        return result
      })
    }
    const sweeper = startRoomLifecycleSweeper(orch as never, { intervalMs: 5 })

    expect(orch.sweepRoomLifecycle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(orch.sweepRoomLifecycle).toHaveBeenCalledTimes(1)

    finishSweep()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5)
    sweeper.stop()

    expect(orch.sweepRoomLifecycle).toHaveBeenCalledTimes(2)
  })

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
