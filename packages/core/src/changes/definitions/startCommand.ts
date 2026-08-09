import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const startCommandChange: ChangeDefinition<{ command: string }> = {
  kind: 'start-command',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: `Start command changed`,
      component: 'Web process',
      before: { command: room.startCommand },
      after: { command: p.command },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!p.command.trim()) throw new Error('Start command cannot be empty')
    if (p.command === ctx.room().startCommand) throw new Error('Start command is unchanged')
  },
  async capture(ctx) {
    return { prevCommand: ctx.room().startCommand }
  },
  async apply(ctx, p, steps) {
    ctx.rooms.update(ctx.roomId, { startCommand: p.command })
    if (ctx.isAwake()) {
      steps.push(`Restart web process with: ${p.command}`)
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
      (entry.captured as { prevCommand?: string } | null)?.prevCommand ?? (entry.before as { command: string }).command
    ctx.rooms.update(ctx.roomId, { startCommand: prev })
    if (ctx.isAwake()) await ctx.backend.recreateWeb(ctx.webSpec())
  }
}
