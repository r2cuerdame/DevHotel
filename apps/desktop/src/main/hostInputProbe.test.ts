import { describe, expect, it } from 'vitest'
import {
  captureHostInputSnapshot,
  hostInputDrift,
  HOST_INPUT_PROBE_SUPPORTED,
  type HostInputSnapshot
} from './hostInputProbe'

const LIVE = process.env.DEVHOTEL_HOST_INPUT_PROBE === '1'

function snapshot(overrides: Partial<HostInputSnapshot> = {}): HostInputSnapshot {
  return {
    cursor: { x: 100, y: 200 },
    foregroundWindow: 4242,
    pressedKeys: [],
    interactiveDesktop: true,
    ...overrides
  }
}

describe('Host input drift detection', () => {
  it('reports nothing when the Host was left alone', () => {
    expect(hostInputDrift(snapshot(), snapshot())).toEqual([])
  })

  it('reports a moved cursor, a stolen foreground window and injected keys', () => {
    const drift = hostInputDrift(
      snapshot({ pressedKeys: [16] }),
      snapshot({ cursor: { x: 0, y: 0 }, foregroundWindow: 99, pressedKeys: [17] })
    )
    expect(drift).toHaveLength(4)
    expect(drift[0]).toMatch(/cursor moved from \(100, 200\) to \(0, 0\)/)
    expect(drift[1]).toMatch(/foreground window changed from 4242 to 99/)
    expect(drift[2]).toMatch(/keys became pressed: 17/)
    expect(drift[3]).toMatch(/keys were released: 16/)
  })
})

describe.runIf(LIVE && HOST_INPUT_PROBE_SUPPORTED)('Host input probe (live)', () => {
  it('observes a real interactive desktop, so a clean result means something', async () => {
    const observed = await captureHostInputSnapshot()
    expect(observed.interactiveDesktop).toBe(true)
    expect(Number.isFinite(observed.cursor.x)).toBe(true)
    expect(Number.isFinite(observed.cursor.y)).toBe(true)
    expect(Array.isArray(observed.pressedKeys)).toBe(true)
  })
})
