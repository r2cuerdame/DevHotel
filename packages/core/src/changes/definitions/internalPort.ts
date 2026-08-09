import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const internalPortChange: ChangeDefinition<{ port: number }> = {
  kind: 'internal-port',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: `Internal port ${room.internalPort} → ${p.port}`,
      component: 'Web process',
      before: { port: room.internalPort },
      after: { port: p.port },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error(`Invalid port: ${p.port}`)
    if (p.port === ctx.room().internalPort) throw new Error('Internal port is unchanged')
  },
  async capture(ctx) {
    return { prevPort: ctx.room().internalPort }
  },
  async apply(ctx, p, steps) {
    ctx.rooms.update(ctx.roomId, { internalPort: p.port })
    if (ctx.isAwake()) {
      steps.push(`Rebuild room network relay for port ${p.port}`)
      const { hostPort } = await ctx.backend.recreateAnchor({ roomId: ctx.roomId, internalPort: p.port })
      ctx.rooms.update(ctx.roomId, { hostPort })
      steps.push('Reattach web process')
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
    const prev = (entry.captured as { prevPort?: number } | null)?.prevPort ?? (entry.before as { port: number }).port
    ctx.rooms.update(ctx.roomId, { internalPort: prev })
    if (ctx.isAwake()) {
      const { hostPort } = await ctx.backend.recreateAnchor({ roomId: ctx.roomId, internalPort: prev })
      ctx.rooms.update(ctx.roomId, { hostPort })
      await ctx.backend.recreateWeb(ctx.webSpec())
      await ctx.syncRoute()
    }
  }
}
