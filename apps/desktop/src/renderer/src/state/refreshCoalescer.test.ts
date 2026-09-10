import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRefreshCoalescer } from './refreshCoalescer'

describe('renderer refresh coalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns one status revision announced several times into one refresh of each kind', () => {
    const refreshRooms = vi.fn()
    const refreshInspection = vi.fn()
    const refresh = createRefreshCoalescer({ refreshRooms, refreshInspection }, { delayMs: 25 })

    // What main used to send per status event: a Room event plus a rooms-changed
    // notice, each of which refreshed the list and the open Room again.
    refresh.rooms()
    refresh.inspection('room1abc')
    refresh.rooms()
    refresh.inspection('room1abc')
    expect(refreshRooms).not.toHaveBeenCalled()

    vi.advanceTimersByTime(25)

    expect(refreshRooms).toHaveBeenCalledTimes(1)
    expect(refreshInspection).toHaveBeenCalledTimes(1)
    expect(refreshInspection).toHaveBeenCalledWith('room1abc')
  })

  it('keeps one inspection refresh per distinct Room in a burst', () => {
    const refreshRooms = vi.fn()
    const refreshInspection = vi.fn()
    const refresh = createRefreshCoalescer({ refreshRooms, refreshInspection }, { delayMs: 25 })

    refresh.inspection('room1abc')
    refresh.inspection('room2abc')
    refresh.inspection('room1abc')
    vi.advanceTimersByTime(25)

    expect(refreshRooms).not.toHaveBeenCalled()
    expect(refreshInspection.mock.calls.map(([roomId]) => roomId)).toEqual(['room1abc', 'room2abc'])
  })

  it('starts a fresh batch after flushing', () => {
    const refreshRooms = vi.fn()
    const refreshInspection = vi.fn()
    const refresh = createRefreshCoalescer({ refreshRooms, refreshInspection }, { delayMs: 25 })

    refresh.rooms()
    vi.advanceTimersByTime(25)
    refresh.rooms()
    vi.advanceTimersByTime(25)

    expect(refreshRooms).toHaveBeenCalledTimes(2)
    refresh.flush()
    expect(refreshRooms).toHaveBeenCalledTimes(2)
  })
})
