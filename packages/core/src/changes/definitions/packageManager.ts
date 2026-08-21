import type { PmKind } from '@devhotel/shared'
import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const packageManagerChange: ChangeDefinition<{ pm: Extract<PmKind, 'npm' | 'pnpm'>; version?: string }> = {
  kind: 'package-manager',
  plan(ctx, p) {
    const prev = ctx.room().packageManager
    return {
      title: `Package manager ${prev.kind}${prev.version ? ` ${prev.version}` : ''} → ${p.pm}${p.version ? ` ${p.version}` : ''}`,
      component: 'Package Manager',
      before: prev,
      after: { kind: p.pm, ...(p.version ? { version: p.version } : {}) },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    if (room.provider !== 'web') throw new Error('Package manager changes apply to Web rooms')
    if (room.packageManager.kind === p.pm && room.packageManager.version === p.version) {
      throw new Error('Package manager is unchanged')
    }
  },
  async capture(ctx) {
    return { prev: ctx.room().packageManager }
  },
  async apply(ctx, p, steps) {
    ctx.rooms.update(ctx.roomId, { packageManager: { kind: p.pm, ...(p.version ? { version: p.version } : {}) } })
    if (ctx.isAwake()) {
      steps.push(`Restart the web process with ${p.pm}`)
      await ctx.backend.recreateWeb(ctx.webSpec())
    } else {
      steps.push('Recorded — applies on next wake')
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prev?: { kind: PmKind; version?: string } } | null)?.prev ??
      (entry.before as { kind: PmKind; version?: string })
    ctx.rooms.update(ctx.roomId, { packageManager: prev })
    if (ctx.isAwake()) await ctx.backend.recreateWeb(ctx.webSpec())
  }
}
