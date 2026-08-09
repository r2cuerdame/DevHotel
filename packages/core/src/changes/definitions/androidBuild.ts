import type { ChangeDefinition } from '../types'

const BUILD_TIMEOUT_MS = 15 * 60_000

export const androidBuildChange: ChangeDefinition<Record<string, never>> = {
  kind: 'android-build',
  plan(ctx) {
    return {
      title: 'Debug APK built',
      component: 'Build',
      before: null,
      after: { command: ctx.room().startCommand },
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Builds are only available in Android rooms')
    if (!ctx.isAwake()) throw new Error('Wake the room before building')
  },
  async apply(ctx, _p, steps) {
    const room = ctx.room()
    steps.push(`Run ${room.startCommand}`)
    const result = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `cd /workspace && ${room.startCommand}`], {
      timeoutMs: BUILD_TIMEOUT_MS
    })
    for (const line of result.stdout.split(/\r?\n/).slice(-15)) if (line.trim()) ctx.log(`  ${line}`)
    if (result.code !== 0) {
      throw new Error(`build failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-500)}`)
    }
  },
  async verify(ctx) {
    const result = await ctx.backend.execInRoom(
      ctx.roomId,
      ['sh', '-lc', "find /workspace -path '*/build/outputs/apk/*' -name '*.apk' 2>/dev/null | head -5"],
      { timeoutMs: 30_000 }
    )
    const apks = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return apks.length > 0
      ? { ok: true, detail: `APK ready: ${apks[0]}` }
      : { ok: false, detail: 'build finished but no APK found under build/outputs/apk' }
  }
}
