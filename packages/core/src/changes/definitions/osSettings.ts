import type { RoomOsSettings } from '@devhotel/shared'
import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const osSettingsChange: ChangeDefinition<{ os: RoomOsSettings }> = {
  kind: 'os-settings',
  plan(ctx, p) {
    return {
      title: 'System settings changed',
      component: 'System',
      before: ctx.room().os,
      after: p.os,
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(_ctx, p) {
    for (const key of Object.keys(p.os.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`)
    }
  },
  async capture(ctx) {
    return { prev: ctx.room().os }
  },
  async apply(ctx, p, steps) {
    ctx.rooms.update(ctx.roomId, { os: p.os })
    if (ctx.isAwake()) {
      steps.push('Restart the room process with the new system settings')
      await ctx.backend.recreateWeb(ctx.webSpec())
      await ctx.syncRoute()
    } else {
      steps.push('Recorded — applies on next wake')
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  },
  async undo(ctx, entry) {
    const prev = (entry.captured as { prev?: RoomOsSettings } | null)?.prev ?? (entry.before as RoomOsSettings)
    ctx.rooms.update(ctx.roomId, { os: prev })
    if (ctx.isAwake()) {
      await ctx.backend.recreateWeb(ctx.webSpec())
      await ctx.syncRoute()
    }
  }
}
