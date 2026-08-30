import { describe, expect, it } from 'vitest'
import type { RoomRuntimeStatus } from '@devhotel/shared'
import { runtimeCapabilities } from './runtimeCapabilities'

function runtime(overrides: Partial<RoomRuntimeStatus>): RoomRuntimeStatus {
  return {
    state: 'running',
    expected: 'running',
    recordedStatus: 'ready',
    main: 'running',
    emulator: 'running',
    observedAt: '2026-01-01T00:00:00.000Z',
    detail: 'test runtime',
    recoveryHint: null,
    ...overrides
  }
}

describe('runtimeCapabilities', () => {
  it('keeps build and sleep available when only the Android build runtime survives', () => {
    expect(
      runtimeCapabilities({
        provider: 'android',
        runtimeStatus: runtime({ state: 'degraded', emulator: 'exited' })
      })
    ).toEqual({
      fullyRunning: false,
      hasLiveComponent: true,
      androidBuildReady: true,
      androidRunReady: false
    })
  })

  it('keeps sleep available without allowing builds when only the emulator survives', () => {
    expect(
      runtimeCapabilities({
        provider: 'android',
        runtimeStatus: runtime({ state: 'degraded', main: 'exited' })
      })
    ).toEqual({
      fullyRunning: false,
      hasLiveComponent: true,
      androidBuildReady: false,
      androidRunReady: false
    })
  })

  it('enables the full Android workflow only when both components are live', () => {
    expect(runtimeCapabilities({ provider: 'android', runtimeStatus: runtime({}) })).toEqual({
      fullyRunning: true,
      hasLiveComponent: true,
      androidBuildReady: true,
      androidRunReady: true
    })
  })

  it('does not expose live-runtime actions for a dead Room', () => {
    expect(
      runtimeCapabilities({
        provider: 'android',
        runtimeStatus: runtime({ state: 'dead', main: 'missing', emulator: 'missing' })
      })
    ).toEqual({
      fullyRunning: false,
      hasLiveComponent: false,
      androidBuildReady: false,
      androidRunReady: false
    })
  })

  it('fails closed when component liveness is unknown', () => {
    expect(
      runtimeCapabilities({
        provider: 'android',
        runtimeStatus: runtime({ state: 'unknown', main: 'unknown', emulator: 'unknown' })
      })
    ).toEqual({
      fullyRunning: false,
      hasLiveComponent: false,
      androidBuildReady: false,
      androidRunReady: false
    })
  })

  it('never exposes Android actions for another provider', () => {
    expect(runtimeCapabilities({ provider: 'web', runtimeStatus: runtime({ emulator: null }) })).toEqual({
      fullyRunning: true,
      hasLiveComponent: true,
      androidBuildReady: false,
      androidRunReady: false
    })
  })
})
