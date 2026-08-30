import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Live observation of the three Host resources a Room must never touch: where
 * the real cursor is, which window holds the foreground, and how many physical
 * keys are down. Key identities are deliberately never retained.
 *
 * The static boundary test proves DevHotel has no API that *can* move them.
 * This proves it did not, on the machine the suite actually ran on — the only
 * honest answer to "did running the tests take over my desktop".
 */
export interface HostInputSnapshot {
  cursor: { x: number; y: number }
  /** Foreground window handle as a number; 0 when nothing is focused. */
  foregroundWindow: number
  /** Count only: the probe never retains physical key identities. */
  pressedKeyCount: number
  /**
   * False when the probe ran on a window station with no interactive desktop
   * (a service, a session-0 task runner). Such a sample reads all zeros, so it
   * can never be treated as evidence that nothing moved.
   */
  interactiveDesktop: boolean
}

export type HostInputMonitorSnapshot = HostInputSnapshot

export interface HostInputMonitorReport {
  baseline: HostInputMonitorSnapshot
  final: HostInputMonitorSnapshot
  mouseActivity: boolean
  mouseActivityInjected: boolean
  cursorMoved: boolean
  firstCursor: { x: number; y: number } | null
  foregroundChanged: boolean
  firstForegroundWindow: number | null
  keyboardChanged: boolean
  keyboardActivityInjected: boolean
}

export interface HostInputMonitor {
  readonly baseline: HostInputMonitorSnapshot
  stop(): Promise<HostInputMonitorReport>
}

export const HOST_INPUT_PROBE_SUPPORTED = process.platform === 'win32'

const MOUSE_BUTTON_VIRTUAL_KEYS = [0x01, 0x02, 0x04, 0x05, 0x06] as const

const PROBE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct DevHotelPoint { public int X; public int Y; }
public static class DevHotelHostInputProbe {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out DevHotelPoint point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$point = New-Object DevHotelPoint
$cursorOk = [DevHotelHostInputProbe]::GetCursorPos([ref]$point)
$pressedKeyCount = 0
foreach ($key in 1..254) {
  if ($key -in @(${MOUSE_BUTTON_VIRTUAL_KEYS.join(', ')})) { continue }
  if (([DevHotelHostInputProbe]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { $pressedKeyCount++ }
}
$state = @{ x = $point.X; y = $point.Y; fg = [int64][DevHotelHostInputProbe]::GetForegroundWindow(); keyCount = $pressedKeyCount; interactive = $cursorOk }
[Console]::Out.Write((ConvertTo-Json $state -Compress))
`

/**
 * Samples the Host input state. Windows only — the supported Host OS. Throws
 * rather than degrading to a pass, because a probe that cannot observe must
 * never be read as "nothing happened".
 *
 * The script goes through a temporary file: `powershell -Command` re-tokenizes
 * its argument, which shreds the C# here-string this needs.
 */
export async function captureHostInputSnapshot(): Promise<HostInputSnapshot> {
  if (!HOST_INPUT_PROBE_SUPPORTED) {
    throw new Error(`Host input probe is Windows-only; this Host is ${process.platform}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'devhotel-host-input-probe-'))
  try {
    const script = join(dir, 'probe.ps1')
    writeFileSync(script, PROBE_SCRIPT, 'utf8')
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(stdout) as {
      x: number
      y: number
      fg: number
      keyCount: number
      interactive: boolean
    }
    if (!Number.isInteger(parsed.keyCount) || parsed.keyCount < 0 || parsed.keyCount > 254) {
      throw new Error('Host input probe keyCount must be an integer from 0 through 254')
    }
    const cursor = { x: parsed.x, y: parsed.y }
    const foregroundWindow = Number(parsed.fg)
    return {
      cursor,
      foregroundWindow,
      pressedKeyCount: parsed.keyCount,
      interactiveDesktop: parsed.interactive
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Differences between two samples, as human-readable lines. Empty means the
 * Host cursor, foreground window and keyboard were all left alone.
 */
export function hostInputDrift(before: HostInputSnapshot, after: HostInputSnapshot): string[] {
  const drift: string[] = []
  if (before.cursor.x !== after.cursor.x || before.cursor.y !== after.cursor.y) {
    drift.push(`Host cursor moved from (${before.cursor.x}, ${before.cursor.y}) to (${after.cursor.x}, ${after.cursor.y})`)
  }
  if (before.foregroundWindow !== after.foregroundWindow) {
    drift.push(`Host foreground window changed from ${before.foregroundWindow} to ${after.foregroundWindow}`)
  }
  if (before.pressedKeyCount !== after.pressedKeyCount) {
    drift.push(`Host pressed-key count changed from ${before.pressedKeyCount} to ${after.pressedKeyCount}`)
  }
  return drift
}

interface WireSnapshot {
  CursorX: number
  CursorY: number
  ForegroundWindow: number
  PressedKeyCount: number
  InteractiveDesktop: boolean
}

interface WireMonitorReport {
  Baseline: WireSnapshot
  Final: WireSnapshot
  MouseActivity: boolean
  MouseActivityInjected: boolean
  CursorMoved: boolean
  FirstCursorX: number
  FirstCursorY: number
  ForegroundChanged: boolean
  FirstForegroundWindow: number
  KeyboardChanged: boolean
  KeyboardActivityInjected: boolean
}

const MONITOR_START_TIMEOUT_MS = 60_000
const MONITOR_STOP_TIMEOUT_MS = 15_000

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function requireExactKeys(raw: Record<string, unknown>, expected: readonly string[], label: string): void {
  const unexpected = Object.keys(raw).filter((key) => !expected.includes(key))
  if (unexpected.length) {
    throw new Error(`${label} contains unexpected fields: ${unexpected.join(', ')}`)
  }
}

function parseWireSnapshot(value: unknown, label: string): WireSnapshot {
  const raw = asRecord(value, label)
  requireExactKeys(raw, ['CursorX', 'CursorY', 'ForegroundWindow', 'PressedKeyCount', 'InteractiveDesktop'], label)
  const pressedKeyCount = finiteNumber(raw.PressedKeyCount, `${label}.PressedKeyCount`)
  if (!Number.isInteger(pressedKeyCount) || pressedKeyCount < 0 || pressedKeyCount > 254) {
    throw new Error(`${label}.PressedKeyCount must be an integer from 0 through 254`)
  }
  return {
    CursorX: finiteNumber(raw.CursorX, `${label}.CursorX`),
    CursorY: finiteNumber(raw.CursorY, `${label}.CursorY`),
    ForegroundWindow: finiteNumber(raw.ForegroundWindow, `${label}.ForegroundWindow`),
    PressedKeyCount: pressedKeyCount,
    InteractiveDesktop: boolean(raw.InteractiveDesktop, `${label}.InteractiveDesktop`)
  }
}

function parseWireReport(value: unknown): WireMonitorReport {
  const raw = asRecord(value, 'Host input monitor report')
  requireExactKeys(
    raw,
    [
      'Baseline',
      'Final',
      'MouseActivity',
      'MouseActivityInjected',
      'CursorMoved',
      'FirstCursorX',
      'FirstCursorY',
      'ForegroundChanged',
      'FirstForegroundWindow',
      'KeyboardChanged',
      'KeyboardActivityInjected'
    ],
    'Host input monitor report'
  )
  return {
    Baseline: parseWireSnapshot(raw.Baseline, 'Host input monitor report.Baseline'),
    Final: parseWireSnapshot(raw.Final, 'Host input monitor report.Final'),
    MouseActivity: boolean(raw.MouseActivity, 'Host input monitor report.MouseActivity'),
    MouseActivityInjected: boolean(raw.MouseActivityInjected, 'Host input monitor report.MouseActivityInjected'),
    CursorMoved: boolean(raw.CursorMoved, 'Host input monitor report.CursorMoved'),
    FirstCursorX: finiteNumber(raw.FirstCursorX, 'Host input monitor report.FirstCursorX'),
    FirstCursorY: finiteNumber(raw.FirstCursorY, 'Host input monitor report.FirstCursorY'),
    ForegroundChanged: boolean(raw.ForegroundChanged, 'Host input monitor report.ForegroundChanged'),
    FirstForegroundWindow: finiteNumber(
      raw.FirstForegroundWindow,
      'Host input monitor report.FirstForegroundWindow'
    ),
    KeyboardChanged: boolean(raw.KeyboardChanged, 'Host input monitor report.KeyboardChanged'),
    KeyboardActivityInjected: boolean(
      raw.KeyboardActivityInjected,
      'Host input monitor report.KeyboardActivityInjected'
    )
  }
}

function fromWireSnapshot(snapshot: WireSnapshot): HostInputMonitorSnapshot {
  return {
    cursor: { x: snapshot.CursorX, y: snapshot.CursorY },
    foregroundWindow: snapshot.ForegroundWindow,
    pressedKeyCount: snapshot.PressedKeyCount,
    interactiveDesktop: snapshot.InteractiveDesktop
  }
}

function sameSnapshot(left: HostInputMonitorSnapshot, right: HostInputMonitorSnapshot): boolean {
  return (
    left.cursor.x === right.cursor.x &&
    left.cursor.y === right.cursor.y &&
    left.foregroundWindow === right.foregroundWindow &&
    left.interactiveDesktop === right.interactiveDesktop &&
    left.pressedKeyCount === right.pressedKeyCount
  )
}

function fromWireReport(report: WireMonitorReport): HostInputMonitorReport {
  return {
    baseline: fromWireSnapshot(report.Baseline),
    final: fromWireSnapshot(report.Final),
    mouseActivity: report.MouseActivity,
    mouseActivityInjected: report.MouseActivityInjected,
    cursorMoved: report.CursorMoved,
    firstCursor: report.CursorMoved ? { x: report.FirstCursorX, y: report.FirstCursorY } : null,
    foregroundChanged: report.ForegroundChanged,
    firstForegroundWindow: report.ForegroundChanged ? report.FirstForegroundWindow : null,
    keyboardChanged: report.KeyboardChanged,
    keyboardActivityInjected: report.KeyboardActivityInjected
  }
}

function monitorFailure(message: string, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(detail ? `${message}: ${detail}` : message)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

/**
 * Starts one read-only Windows observer and keeps its three system hooks alive
 * until {@link HostInputMonitor.stop}. Unlike two endpoint snapshots, the
 * helper latches any mouse activity, an away-and-back cursor move, foreground
 * takeover, or key transition even when teardown sees the original state
 * again. Its wire report contains counts and generic booleans, not input
 * message or key identities.
 */
export async function startHostInputMonitor(): Promise<HostInputMonitor> {
  if (!HOST_INPUT_PROBE_SUPPORTED) {
    throw new Error(`Host input monitor is Windows-only; this Host is ${process.platform}`)
  }

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(import.meta.dirname, 'hostInputMonitor.ps1')
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stderr = ''
  let stdoutBuffer = ''
  let protocolError: Error | null = null
  let readySnapshot: HostInputMonitorSnapshot | null = null
  let finalReport: HostInputMonitorReport | null = null
  let stopRequested = false
  let stopPromise: Promise<HostInputMonitorReport> | null = null

  let resolveReady!: (snapshot: HostInputMonitorSnapshot) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<HostInputMonitorSnapshot>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve
  })

  const failProtocol = (error: unknown): void => {
    if (protocolError) return
    protocolError = error instanceof Error ? error : new Error(String(error))
    if (!readySnapshot) rejectReady(protocolError)
  }

  const consumeLine = (line: string): void => {
    if (!line) return
    try {
      if (line.startsWith('READY\t')) {
        if (readySnapshot) throw new Error('Host input monitor sent READY more than once')
        const snapshot = fromWireSnapshot(parseWireSnapshot(JSON.parse(line.slice(6)), 'Host input monitor READY'))
        if (!snapshot.interactiveDesktop) throw new Error('Host input monitor did not attach to an interactive desktop')
        readySnapshot = snapshot
        resolveReady(snapshot)
        return
      }
      if (line.startsWith('RESULT\t')) {
        if (!readySnapshot) throw new Error('Host input monitor sent RESULT before READY')
        if (finalReport) throw new Error('Host input monitor sent RESULT more than once')
        finalReport = fromWireReport(parseWireReport(JSON.parse(line.slice(7))))
        return
      }
      throw new Error(`Host input monitor sent an unknown protocol line: ${line}`)
    } catch (error) {
      failProtocol(error)
    }
  }

  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  })
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024)
  })
  child.stdin.on('error', (error) => failProtocol(error))
  child.once('error', (error) => failProtocol(error))
  child.once('close', (code, signal) => {
    if (stdoutBuffer) {
      consumeLine(stdoutBuffer)
      stdoutBuffer = ''
    }
    if (!readySnapshot && !protocolError) {
      rejectReady(monitorFailure(`Host input monitor exited before READY (code ${code}, signal ${signal})`, stderr))
    }
    if (!stopRequested && readySnapshot && !protocolError) {
      protocolError = monitorFailure(`Host input monitor exited before teardown (code ${code}, signal ${signal})`, stderr)
    }
    resolveExit({ code, signal })
  })

  let baseline: HostInputMonitorSnapshot
  try {
    baseline = await withTimeout(ready, MONITOR_START_TIMEOUT_MS, 'Timed out waiting for Host input monitor READY')
  } catch (error) {
    child.kill()
    throw error
  }

  return {
    baseline,
    stop(): Promise<HostInputMonitorReport> {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        stopRequested = true
        if (child.exitCode === null && child.signalCode === null) child.stdin.end('STOP\n')

        let exit: { code: number | null; signal: NodeJS.Signals | null }
        try {
          exit = await withTimeout(exited, MONITOR_STOP_TIMEOUT_MS, 'Timed out stopping Host input monitor')
        } catch (error) {
          child.kill()
          throw error
        }

        if (protocolError) throw protocolError
        if (exit.code !== 0) {
          throw monitorFailure(`Host input monitor failed (code ${exit.code}, signal ${exit.signal})`, stderr)
        }
        if (!finalReport) throw monitorFailure('Host input monitor exited without a final report', stderr)
        if (!finalReport.final.interactiveDesktop) {
          throw new Error('Host input monitor lost access to the interactive desktop before teardown')
        }
        if (!sameSnapshot(baseline, finalReport.baseline)) {
          throw new Error('Host input monitor final report did not match its READY baseline')
        }
        return finalReport
      })()
      return stopPromise
    }
  }
}

/**
 * Formats every state transition latched by the continuous monitor. Endpoint
 * drift remains a final safety net, but a restored final state never erases an
 * earlier violation.
 */
export function hostInputMonitorDrift(report: HostInputMonitorReport): string[] {
  const drift: string[] = []
  if (report.mouseActivity) {
    const injected = report.mouseActivityInjected ? ' (injected)' : ''
    const cursor = report.cursorMoved
      ? `; cursor moved from (${report.baseline.cursor.x}, ${report.baseline.cursor.y})` +
        ` to (${report.firstCursor!.x}, ${report.firstCursor!.y})`
      : ''
    drift.push(`Host mouse activity occurred during the test run${injected}${cursor}`)
  } else if (report.cursorMoved) {
    drift.push(
      `Host cursor moved during the test run from (${report.baseline.cursor.x}, ${report.baseline.cursor.y})` +
        ` to (${report.firstCursor!.x}, ${report.firstCursor!.y})`
    )
  } else if (
    report.baseline.cursor.x !== report.final.cursor.x ||
    report.baseline.cursor.y !== report.final.cursor.y
  ) {
    drift.push(
      `Host cursor moved from (${report.baseline.cursor.x}, ${report.baseline.cursor.y})` +
        ` to (${report.final.cursor.x}, ${report.final.cursor.y})`
    )
  }

  if (report.foregroundChanged) {
    drift.push(
      `Host foreground window changed during the test run from ${report.baseline.foregroundWindow}` +
        ` to ${report.firstForegroundWindow}`
    )
  } else if (report.baseline.foregroundWindow !== report.final.foregroundWindow) {
    drift.push(
      `Host foreground window changed from ${report.baseline.foregroundWindow} to ${report.final.foregroundWindow}`
    )
  }

  if (report.keyboardChanged) {
    const injected = report.keyboardActivityInjected ? ' (injected)' : ''
    drift.push(`Host keyboard state changed during the test run${injected}`)
  } else if (report.baseline.pressedKeyCount !== report.final.pressedKeyCount) {
    drift.push(
      `Host pressed-key count changed from ${report.baseline.pressedKeyCount} to ${report.final.pressedKeyCount}`
    )
  }
  return drift
}
