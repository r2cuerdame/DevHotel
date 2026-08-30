import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureHostInputSnapshot,
  hostInputDrift,
  hostInputMonitorDrift,
  HOST_INPUT_PROBE_SUPPORTED,
  startHostInputMonitor,
  type HostInputMonitorReport,
  type HostInputMonitorSnapshot,
  type HostInputSnapshot
} from './hostInputProbe'

const LIVE = process.env.DEVHOTEL_HOST_INPUT_PROBE === '1'

function snapshot(overrides: Partial<HostInputSnapshot> = {}): HostInputSnapshot {
  return {
    cursor: { x: 100, y: 200 },
    foregroundWindow: 4242,
    pressedKeyCount: 0,
    interactiveDesktop: true,
    ...overrides
  }
}

function monitorSnapshot(overrides: Partial<HostInputMonitorSnapshot> = {}): HostInputMonitorSnapshot {
  return {
    cursor: { x: 100, y: 200 },
    foregroundWindow: 4242,
    pressedKeyCount: 0,
    interactiveDesktop: true,
    ...overrides
  }
}

describe('Host input drift detection', () => {
  it('keeps mouse-button virtual keys out of every keyboard-state sampler', () => {
    const helper = readFileSync(join(import.meta.dirname, 'hostInputMonitor.ps1'), 'utf8')
    expect(helper.match(/if \(IsMouseButtonVirtualKey\(key\)\) continue;/g)).toHaveLength(2)
    for (const virtualKey of ['0x01', '0x02', '0x04', '0x05', '0x06']) {
      expect(helper).toContain(`key == ${virtualKey}`)
    }

    const snapshotSource = readFileSync(join(import.meta.dirname, 'hostInputProbe.ts'), 'utf8')
    expect(snapshotSource).toContain('MOUSE_BUTTON_VIRTUAL_KEYS.join')
  })

  it('reports nothing when the Host was left alone', () => {
    expect(hostInputDrift(snapshot(), snapshot())).toEqual([])
  })

  it('reports a moved cursor, a stolen foreground window and changed keyboard state', () => {
    const drift = hostInputDrift(
      snapshot(),
      snapshot({ cursor: { x: 0, y: 0 }, foregroundWindow: 99, pressedKeyCount: 1 })
    )
    expect(drift).toHaveLength(3)
    expect(drift[0]).toMatch(/cursor moved from \(100, 200\) to \(0, 0\)/)
    expect(drift[1]).toMatch(/foreground window changed from 4242 to 99/)
    expect(drift[2]).toMatch(/pressed-key count changed from 0 to 1/)
  })

  it('retains transient cursor, focus and key changes after every endpoint is restored', () => {
    const baseline = monitorSnapshot()
    const report: HostInputMonitorReport = {
      baseline,
      final: monitorSnapshot(),
      mouseActivity: true,
      mouseActivityInjected: false,
      cursorMoved: true,
      firstCursor: { x: 101, y: 201 },
      foregroundChanged: true,
      firstForegroundWindow: 99,
      keyboardChanged: true,
      keyboardActivityInjected: true
    }

    const drift = hostInputMonitorDrift(report)
    expect(report.final).toEqual(report.baseline)
    expect(drift).toHaveLength(3)
    expect(drift[0]).toMatch(/mouse activity occurred during the test run.*cursor moved.*to \(101, 201\)/)
    expect(drift[1]).toMatch(/foreground window changed during the test run.*to 99/)
    expect(drift[2]).toMatch(/keyboard state changed during the test run.*injected/)
  })

  it('reports a non-move mouse event without retaining message or key identities', () => {
    const report: HostInputMonitorReport = {
      baseline: monitorSnapshot(),
      final: monitorSnapshot(),
      mouseActivity: true,
      mouseActivityInjected: true,
      cursorMoved: false,
      firstCursor: null,
      foregroundChanged: false,
      firstForegroundWindow: null,
      keyboardChanged: false,
      keyboardActivityInjected: false
    }

    expect(hostInputMonitorDrift(report)).toEqual(['Host mouse activity occurred during the test run (injected)'])
    expect(JSON.stringify(report)).not.toMatch(/PressedKeys|VirtualKey|KeyboardMessage|MouseMessage|MouseData/i)
  })

  it('keeps the final snapshot as a fail-closed backstop for every surface', () => {
    const report: HostInputMonitorReport = {
      baseline: monitorSnapshot(),
      final: monitorSnapshot({ cursor: { x: 102, y: 202 }, foregroundWindow: 100, pressedKeyCount: 1 }),
      mouseActivity: false,
      mouseActivityInjected: false,
      cursorMoved: false,
      firstCursor: null,
      foregroundChanged: false,
      firstForegroundWindow: null,
      keyboardChanged: false,
      keyboardActivityInjected: false
    }

    expect(hostInputMonitorDrift(report)).toEqual([
      'Host cursor moved from (100, 200) to (102, 202)',
      'Host foreground window changed from 4242 to 100',
      'Host pressed-key count changed from 0 to 1'
    ])
  })
})

describe.runIf(HOST_INPUT_PROBE_SUPPORTED)('Host input monitor helper (Windows)', () => {
  it('compiles, starts and stops during the normal Windows test run', async () => {
    const monitor = await startHostInputMonitor()
    const report = await monitor.stop()
    expect(report.baseline.interactiveDesktop).toBe(true)
    expect(report.final.interactiveDesktop).toBe(true)
    expect(Number.isInteger(report.baseline.pressedKeyCount)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/PressedKeys|VirtualKey|KeyboardMessage|MouseMessage|MouseData/i)
  }, 90_000)
})

describe.runIf(LIVE && HOST_INPUT_PROBE_SUPPORTED)('Host input probe (live)', () => {
  it('observes a real interactive desktop, so endpoint samples mean something', async () => {
    const observed = await captureHostInputSnapshot()
    expect(observed.interactiveDesktop).toBe(true)
    expect(Number.isFinite(observed.cursor.x)).toBe(true)
    expect(Number.isFinite(observed.cursor.y)).toBe(true)
    expect(Number.isInteger(observed.pressedKeyCount)).toBe(true)
  })

  it('keeps the continuous Windows observer armed until an explicit stop', async () => {
    const monitor = await startHostInputMonitor()
    const report = await monitor.stop()
    expect(report.baseline.interactiveDesktop).toBe(true)
    expect(report.final.interactiveDesktop).toBe(true)
    expect(hostInputMonitorDrift(report)).toEqual([])
  })
})
