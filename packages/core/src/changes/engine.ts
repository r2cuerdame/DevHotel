import { randomUUID } from 'node:crypto'
import type { Actor, ChangeEntry } from '@devhotel/shared'
import type { ChangeCtx, ChangeDefinition } from './types'

export class ChangeEngine {
  private defs = new Map<string, ChangeDefinition<any>>()

  register(def: ChangeDefinition<any>): void {
    this.defs.set(def.kind, def)
  }

  async execute<P>(ctx: ChangeCtx, kind: string, params: P, actor: Actor): Promise<ChangeEntry> {
    const def = this.defs.get(kind)
    if (!def) throw new Error(`Unknown change kind: ${kind}`)

    const planned = def.plan(ctx, params)
    await def.preflight?.(ctx, params)
    const captured = def.capture ? await def.capture(ctx, params) : null

    const entry = ctx.changes.append({
      id: randomUUID(),
      roomId: ctx.roomId,
      kind,
      title: planned.title,
      actor,
      component: planned.component,
      before: planned.before,
      after: planned.after,
      captured,
      steps: [],
      verify: null,
      undoable: planned.undoable,
      undoStrategy: planned.undoStrategy,
      status: 'pending',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
    ctx.log(`change ${entry.seq} [${kind}] ${planned.title} (${actor})`)

    const steps: string[] = []
    const stepSink = {
      push: (s: string) => {
        steps.push(s)
        ctx.log(`  · ${s}`)
      }
    }

    try {
      await def.apply(ctx, params, stepSink)
      ctx.changes.setStatus(entry.id, 'applied', { steps })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.log(`  apply failed: ${detail}`)
      ctx.changes.setStatus(entry.id, 'failed', { steps, verify: { ok: false, detail: `apply failed: ${detail}` } })
      if (planned.undoable && def.undo) {
        try {
          await def.undo(ctx, { ...entry, captured, steps })
          ctx.changes.setStatus(entry.id, 'rolled-back')
          ctx.log('  rolled back')
        } catch (undoErr) {
          ctx.log(`  rollback also failed: ${String(undoErr)}`)
        }
      }
      return ctx.changes.get(entry.id)!
    }

    const verify = await def.verify(ctx, params)
    if (verify.ok) {
      ctx.changes.setStatus(entry.id, 'verified', { verify })
      ctx.log(`  verified: ${verify.detail}`)
    } else if (planned.autoRollback && planned.undoable && def.undo) {
      ctx.log(`  verify failed (${verify.detail}) — rolling back`)
      try {
        await def.undo(ctx, { ...entry, captured, steps })
        ctx.changes.setStatus(entry.id, 'rolled-back', { verify })
        ctx.log('  rolled back')
      } catch (undoErr) {
        ctx.changes.setStatus(entry.id, 'applied', { verify })
        ctx.log(`  rollback failed: ${String(undoErr)}`)
      }
    } else {
      // stays applied with a failed verify — undo remains available to the user
      ctx.changes.setStatus(entry.id, 'applied', { verify })
      ctx.log(`  verify failed: ${verify.detail}`)
    }
    return ctx.changes.get(entry.id)!
  }

  async undo(ctx: ChangeCtx, changeId: string, actor: Actor): Promise<ChangeEntry> {
    const entry = ctx.changes.get(changeId)
    if (!entry) throw new Error(`Change not found: ${changeId}`)
    if (entry.roomId !== ctx.roomId) throw new Error('Change belongs to a different room')
    if (!entry.undoable) throw new Error(`"${entry.title}" cannot be undone (${entry.undoStrategy})`)
    if (entry.status === 'undone') throw new Error(`"${entry.title}" is already undone`)
    if (entry.status !== 'verified' && entry.status !== 'applied') {
      throw new Error(`"${entry.title}" is ${entry.status} and cannot be undone`)
    }
    const def = this.defs.get(entry.kind)
    if (!def?.undo) throw new Error(`No undo available for change kind ${entry.kind}`)

    ctx.log(`undo [${entry.kind}] ${entry.title} (${actor})`)
    await def.undo(ctx, entry)
    ctx.changes.setStatus(entry.id, 'undone', { undoneAt: new Date().toISOString() })

    return ctx.changes.append({
      id: randomUUID(),
      roomId: ctx.roomId,
      kind: 'undo',
      title: `Undo: ${entry.title}`,
      actor,
      component: entry.component,
      before: entry.after,
      after: entry.before,
      captured: null,
      steps: [`reverted change #${entry.seq} via ${entry.undoStrategy}`],
      verify: { ok: true, detail: 'previous state restored' },
      undoable: false,
      undoStrategy: 'none',
      status: 'verified',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
  }
}
