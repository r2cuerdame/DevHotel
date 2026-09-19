import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRAY_REBUILD_EVENT_KINDS, createRebuildScheduler } from './trayRebuildScheduler'

describe('tray rebuild scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('collapses a burst of Room events into one rebuild', async () => {
    const rebuild = vi.fn(async () => undefined)
    const scheduler = createRebuildScheduler(rebuild, 250)

    for (let i = 0; i < 5; i++) scheduler.request()
    expect(rebuild).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(250)

    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('runs exactly one more rebuild when an event arrives mid-rebuild', async () => {
    let finish: (() => void) | undefined
    const rebuild = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const scheduler = createRebuildScheduler(rebuild, 250)

    scheduler.request()
    await vi.advanceTimersByTimeAsync(250)
    expect(rebuild).toHaveBeenCalledTimes(1)

    scheduler.request()
    scheduler.request()
    await vi.advanceTimersByTimeAsync(250)
    expect(rebuild).toHaveBeenCalledTimes(1)

    finish!()
    await vi.advanceTimersByTimeAsync(250)
    expect(rebuild).toHaveBeenCalledTimes(2)

    finish!()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rebuild).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight rebuild with an immediate request and survives a failing rebuild', async () => {
    const rebuild = vi.fn(async () => {
      throw new Error('backend unreachable')
    })
    const scheduler = createRebuildScheduler(rebuild, 250)

    await expect(Promise.all([scheduler.now(), scheduler.now()])).resolves.toBeDefined()
    expect(rebuild).toHaveBeenCalledTimes(1)

    scheduler.request()
    await vi.advanceTimersByTimeAsync(250)
    expect(rebuild).toHaveBeenCalledTimes(2)
  })

  it('only status, created and deleted events can change the tray', () => {
    expect([...TRAY_REBUILD_EVENT_KINDS].sort()).toEqual(['created', 'deleted', 'status'])
    expect(TRAY_REBUILD_EVENT_KINDS.has('change')).toBe(false)
    expect(TRAY_REBUILD_EVENT_KINDS.has('check')).toBe(false)
  })
})
