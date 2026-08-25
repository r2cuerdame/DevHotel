import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Live observation of the three Host resources a Room must never touch: where
 * the real cursor is, which window holds the foreground, and which physical
 * keys are down.
 *
 * The static boundary test proves DevHotel has no API that *can* move them.
 * This proves it did not, on the machine the suite actually ran on — the only
 * honest answer to "did running the tests take over my desktop".
 */
export interface HostInputSnapshot {
  cursor: { x: number; y: number }
  /** Foreground window handle as a number; 0 when nothing is focused. */
  foregroundWindow: number
  /** Virtual-key codes physically down at sample time. */
  pressedKeys: number[]
  /**
   * False when the probe ran on a window station with no interactive desktop
   * (a service, a session-0 task runner). Such a sample reads all zeros, so it
   * can never be treated as evidence that nothing moved.
   */
  interactiveDesktop: boolean
}

export const HOST_INPUT_PROBE_SUPPORTED = process.platform === 'win32'

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
[void][DevHotelHostInputProbe]::GetCursorPos([ref]$point)
$down = New-Object System.Collections.ArrayList
foreach ($key in 1..254) {
  if (([DevHotelHostInputProbe]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { [void]$down.Add($key) }
}
$state = @{ x = $point.X; y = $point.Y; fg = [int64][DevHotelHostInputProbe]::GetForegroundWindow(); keys = @($down) }
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
    const parsed = JSON.parse(stdout) as { x: number; y: number; fg: number; keys: number[] | number | null }
    const pressedKeys = parsed.keys === null ? [] : Array.isArray(parsed.keys) ? parsed.keys : [parsed.keys]
    const cursor = { x: parsed.x, y: parsed.y }
    const foregroundWindow = Number(parsed.fg)
    return {
      cursor,
      foregroundWindow,
      pressedKeys,
      interactiveDesktop: foregroundWindow !== 0 || cursor.x !== 0 || cursor.y !== 0
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
  const pressed = after.pressedKeys.filter((key) => !before.pressedKeys.includes(key))
  const released = before.pressedKeys.filter((key) => !after.pressedKeys.includes(key))
  if (pressed.length) drift.push(`Host keys became pressed: ${pressed.join(', ')}`)
  if (released.length) drift.push(`Host keys were released: ${released.join(', ')}`)
  return drift
}
