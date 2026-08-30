import type { WebSpec } from '../../backend/types'
import {
  LINE_ENDING_SCAN_SCRIPT,
  launcherScanScript,
  lineEndingDiagnostic,
  parseScriptPaths,
  scanCommand
} from '../../checks/lineEndings'
import type { ChangeCtx } from '../types'

/**
 * Refuse Android build entry points whose own launcher cannot execute on Linux.
 * A failed probe remains non-blocking: only a completed scan with named files
 * is strong enough evidence to replace the build with a line-ending diagnosis.
 */
export async function assertLaunchersAreExecutable(ctx: ChangeCtx): Promise<void> {
  const room = ctx.room()
  const res = await ctx.backend.execInRoom(ctx.roomId, scanCommand(launcherScanScript(room.startCommand)), { timeoutMs: 30_000 })
  if (res.code !== 0) return
  const paths = parseScriptPaths(res.stdout)
  if (paths.length > 0) {
    throw new Error(lineEndingDiagnostic(paths, room.workspaceMode !== 'legacy-host-bind'))
  }
}

async function attributionFromScan(
  scan: () => Promise<{ code: number; stdout: string }>,
  canNormalizeInRoom: boolean
): Promise<string> {
  try {
    const result = await scan()
    if (result.code !== 0) return ''
    const paths = parseScriptPaths(result.stdout)
    return paths.length > 0 ? ` ${lineEndingDiagnostic(paths, canNormalizeInRoom)}` : ''
  } catch {
    return ''
  }
}

/** Attribute a failed Build & Run command against the live Room workspace it just used. */
export function lineEndingAttributionInRoom(ctx: ChangeCtx): Promise<string> {
  return attributionFromScan(
    () => ctx.backend.execInRoom(ctx.roomId, scanCommand(LINE_ENDING_SCAN_SCRIPT), { timeoutMs: 60_000 }),
    ctx.room().workspaceMode !== 'legacy-host-bind'
  )
}

/** Attribute a failed clean build against its immutable build-input snapshot. */
export function lineEndingAttributionInSnapshot(ctx: ChangeCtx, spec: WebSpec): Promise<string> {
  return attributionFromScan(
    () => ctx.backend.runOneShot(spec, LINE_ENDING_SCAN_SCRIPT),
    ctx.room().workspaceMode !== 'legacy-host-bind'
  )
}
