import { randomUUID } from 'node:crypto'
import type { Actor, ChangeEntry } from '@devhotel/shared'
import type { OperationReporter } from '../operations'
import type { ChangeCtx, ChangeDefinition } from './types'
import { verifyWebUp } from './types'

const VERIFY_EXCEPTION_DETAIL = 'Verification could not complete because its probe failed unexpectedly.'

export class ChangeEngine {
  private defs = new Map<string, ChangeDefinition<any>>()

  register(def: ChangeDefinition<any>): void {
    this.defs.set(def.kind, def)
  }

  async execute<P>(
    ctx: ChangeCtx,
    kind: string,
    params: P,
    actor: Actor,
    operationId?: string,
    reporter?: OperationReporter
  ): Promise<ChangeEntry> {
    const def = this.defs.get(kind)
    if (!def) throw new Error(`Unknown change kind: ${kind}`)

    const operation = { id: operationId ?? randomUUID(), createdAt: new Date().toISOString() }
    const planned = def.plan(ctx, params)
    await def.preflight?.(ctx, params)
    const captured = def.capture ? await def.capture(ctx, params, operation) : null

    const entry = ctx.changes.append({
      id: operation.id,
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
      createdAt: operation.createdAt,
      undoneAt: null
    })
    ctx.log(`change ${entry.seq} [${kind}] ${planned.title} (${actor})`)

    const steps: string[] = []
    let after: unknown = planned.after
    let capturedOverride: { blob: unknown } | null = null
    const stepSink = {
      push: (s: string) => {
        steps.push(s)
        ctx.log(`  · ${s}`)
        if (reporter) {
          if (s.includes('Pause Room workspace') || s.includes('snapshot') || s.includes('Run ') || s.includes('Seal ')) {
            reporter.begin('build', s)
          } else if (s.includes('Wait for the emulator to finish booting')) {
            reporter.begin('emulator-boot', s)
          } else if (s.includes('Install sealed')) {
            reporter.begin('install', s)
          } else if (s.includes('launch') || s.includes('Launch')) {
            reporter.begin('launch', s)
          } else {
            reporter.detail(s)
          }
        }
        // Persist progress while the entry is still pending. A process crash
        // must not sever an already-created safety backup from its operation.
        ctx.changes.setStatus(entry.id, 'pending', { steps: [...steps] })
      },
      setCaptured: (blob: unknown) => {
        capturedOverride = { blob }
        ctx.changes.setStatus(entry.id, 'pending', { captured: blob, steps: [...steps] })
      },
      setResult: (result: Record<string, unknown>) => {
        after = { ...(typeof after === 'object' && after !== null ? after : {}), ...result }
        ctx.changes.setStatus(entry.id, 'pending', { after, steps: [...steps] })
      }
    }

    try {
      await def.apply(ctx, params, stepSink, operation)
      ctx.changes.setStatus(entry.id, 'applied', {
        steps,
        after,
        ...(capturedOverride ? { captured: (capturedOverride as { blob: unknown }).blob } : {})
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.log(`  apply failed: ${detail}`)
      if (reporter) reporter.fail('apply failed', err)
      ctx.changes.setStatus(entry.id, 'failed', { steps, verify: { ok: false, detail: `apply failed: ${detail}` } })
      const failureCapture = capturedOverride ? (capturedOverride as { blob: unknown }).blob : captured
      const canRollback = def.canRollbackApplyFailure?.(ctx, params, failureCapture) ?? true
      if (planned.undoable && def.undo && canRollback) {
        try {
          await def.undo(ctx, { ...entry, captured: failureCapture, steps })
          ctx.changes.setStatus(entry.id, 'rolled-back')
          ctx.log('  rolled back')
        } catch (undoErr) {
          ctx.log(`  rollback also failed: ${String(undoErr)}`)
        }
      } else if (planned.undoable && def.undo && !canRollback) {
        ctx.log('  rollback skipped: required safety capture was not completed')
      }
      return ctx.changes.get(entry.id)!
    }

    const effectiveCaptured = capturedOverride ? (capturedOverride as { blob: unknown }).blob : captured
    let verify: { ok: boolean; detail: string }
    if (reporter) reporter.begin('verify', 'Verify change status')
    try {
      verify = await def.verify(ctx, params, effectiveCaptured, operation)
    } catch {
      // A verifier runs after apply has already been durably recorded. Never
      // let a rejected probe strand that row at applied/verify:null, and never
      // copy a backend/Host error (paths, argv or secrets) into public state.
      verify = { ok: false, detail: VERIFY_EXCEPTION_DETAIL }
    }
    if (verify.ok) {
      if (reporter) reporter.begin('complete', verify.detail)
      ctx.changes.setStatus(entry.id, 'verified', { verify })
      ctx.log(`  verified: ${verify.detail}`)
    } else if (planned.autoRollback && planned.undoable && def.undo) {
      if (reporter) reporter.fail(`verify failed (${verify.detail})`)
      ctx.log(`  verify failed (${verify.detail}) — rolling back`)
      try {
        await def.undo(ctx, { ...entry, captured: capturedOverride ? (capturedOverride as { blob: unknown }).blob : captured, steps })
        ctx.changes.setStatus(entry.id, 'rolled-back', { verify })
        ctx.log('  rolled back')
      } catch (undoErr) {
        ctx.changes.setStatus(entry.id, 'applied', { verify })
        ctx.log(`  rollback failed: ${String(undoErr)}`)
      }
    } else {
      // stays applied with a failed verify — undo remains available to the user
      if (reporter) reporter.fail(`verify failed: ${verify.detail}`)
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

    const verify = await verifyWebUp(ctx)
    if (!verify.ok) ctx.log(`undo verify failed: ${verify.detail}`)
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
      verify,
      undoable: false,
      undoStrategy: 'none',
      status: verify.ok ? 'verified' : 'applied',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
  }
}
