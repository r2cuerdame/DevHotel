import { srcVolume } from '../../backend/naming'
import {
  LINE_ENDING_NORMALIZE_SCRIPT,
  LINE_ENDING_SCAN_SCRIPT,
  parseScriptPaths,
  scanCommand
} from '../../checks/lineEndings'
import { nextWorkspaceVolumeRevision, workspaceGenMaxKey } from '../../workingState'
import { currentDepsGen, depsGenKey } from './deps'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const NOTHING_TO_NORMALIZE =
  'No script in this Room has Windows line endings (CRLF). Nothing to normalize.'

interface NormalizeCapture {
  nodeMajor: string
  depsGeneration: number
  previousWorkspaceGeneration: number
  nextWorkspaceGeneration?: number
  beforeStateRevision: number
  appliedStateRevision?: number
  sourceWorkspaceFingerprint?: string
  appliedWorkspaceFingerprint?: string
  normalized?: string[]
  runtimeSwitchAttempted?: boolean
  published?: boolean
}

function captured(entry: { captured: unknown }): NormalizeCapture {
  const value = entry.captured as Partial<NormalizeCapture> | null
  if (
    !value ||
    typeof value.nodeMajor !== 'string' ||
    !Number.isSafeInteger(value.depsGeneration) ||
    !Number.isSafeInteger(value.previousWorkspaceGeneration) ||
    !Number.isSafeInteger(value.beforeStateRevision)
  ) throw new Error('Line-ending normalization safety state is missing or invalid')
  return value as NormalizeCapture
}

async function scanLive(ctx: ChangeCtx): Promise<string[] | null> {
  const res = await ctx.backend.execInRoom(ctx.roomId, scanCommand(LINE_ENDING_SCAN_SCRIPT), { timeoutMs: 60_000 })
  return res.code === 0 ? parseScriptPaths(res.stdout) : null
}

/**
 * Rewrite CRLF to LF in the Room's executable scripts — the explicit, opt-in
 * half of the CRLF story. Nothing normalizes on its own: a Windows checkout
 * keeps its line endings until a user or agent asks for this Change.
 *
 * The rewrite happens on a *copy* of the workspace, which is published only
 * once it is complete, so this is undoable exactly like a package install: undo
 * republishes the untouched generation. Host files are never written — a Room
 * still bound to its Host folder is refused outright.
 */
export const normalizeLineEndingsChange: ChangeDefinition<Record<string, never>> = {
  kind: 'normalize-line-endings',
  plan(ctx) {
    const room = ctx.room()
    return {
      title: 'Script line endings normalized to LF',
      component: 'Working State',
      before: { workspaceGeneration: room.workspaceVolumeRevision, stateRevision: room.stateRevision },
      after: { lineEndings: 'lf', scope: 'gradlew, mvnw, *.sh and other shebang scripts' },
      undoable: true,
      undoStrategy: 'workspace-generation-swap',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    const room = ctx.room()
    if (room.workspaceMode === 'legacy-host-bind') {
      throw new Error(
        'Line-ending normalization is blocked for legacy Host binds to protect Host files. Move the Room into the Hotel first, or fix the line endings on the Host.'
      )
    }
    if (room.workspaceMode === 'empty' || room.sourceType === 'empty') {
      throw new Error('This Empty Room has no scripts to normalize.')
    }
    // A live scan turns "nothing to do" into a plain sentence instead of a
    // whole workspace generation copied for no change. When the Room is asleep
    // there is nothing to scan through, and apply makes the same call.
    if (ctx.isAwake() && (await ctx.backend.webState(room.id)) === 'running') {
      const paths = await scanLive(ctx)
      if (paths?.length === 0) throw new Error(NOTHING_TO_NORMALIZE)
    }
  },
  async capture(ctx) {
    const room = ctx.room()
    return {
      nodeMajor: room.runtime.version,
      depsGeneration: currentDepsGen(ctx),
      previousWorkspaceGeneration: room.workspaceVolumeRevision,
      beforeStateRevision: room.stateRevision,
      published: false,
      runtimeSwitchAttempted: false
    } satisfies NormalizeCapture
  },
  async apply(ctx, _p, steps) {
    const room = ctx.room()
    const nextWorkspaceGeneration = nextWorkspaceVolumeRevision(
      room.workspaceVolumeRevision,
      ctx.settings.get(workspaceGenMaxKey(room.id))
    )
    const state: NormalizeCapture = {
      nodeMajor: room.runtime.version,
      depsGeneration: currentDepsGen(ctx),
      previousWorkspaceGeneration: room.workspaceVolumeRevision,
      nextWorkspaceGeneration,
      beforeStateRevision: room.stateRevision,
      appliedStateRevision: room.stateRevision + 1,
      published: false,
      runtimeSwitchAttempted: false
    }
    // Reserve the name before touching the volume: a failed or undone
    // generation stays above the high-water mark and is never recycled.
    ctx.settings.set(workspaceGenMaxKey(room.id), String(nextWorkspaceGeneration))
    steps.setCaptured(state)

    const previousSpec = ctx.webSpec({ workspaceVolumeRevision: state.previousWorkspaceGeneration })
    const stagedSpec = ctx.webSpec({ workspaceVolumeRevision: nextWorkspaceGeneration })
    const awake = ctx.isAwake()
    let paused = false
    let copyFailed = false
    let copyError: unknown

    try {
      if (awake) {
        steps.push('Pause the Room briefly for a consistent workspace generation')
        await ctx.backend.pauseWeb(room.id)
        paused = true
      }
      steps.push(`Copy workspace generation r${room.workspaceVolumeRevision} to r${nextWorkspaceGeneration}`)
      await ctx.backend.copyVolume(
        room.id,
        srcVolume(room.id, room.workspaceVolumeRevision),
        room.id,
        srcVolume(room.id, nextWorkspaceGeneration),
        ctx.log
      )
      state.sourceWorkspaceFingerprint = await ctx.backend.fingerprintWorkspace(
        room.id,
        state.previousWorkspaceGeneration
      )
      steps.setCaptured(state)
    } catch (error) {
      copyFailed = true
      copyError = error
    }
    if (paused) {
      try {
        await ctx.backend.unpauseWeb(room.id)
      } catch (unpauseError) {
        // A failed unpause must not leave the published Room suspended.
        try {
          await ctx.backend.recreateWeb(previousSpec)
        } catch (recreateError) {
          throw new AggregateError(
            copyFailed ? [copyError, unpauseError, recreateError] : [unpauseError, recreateError],
            'Could not resume or recreate the previously published Room runtime'
          )
        }
        throw unpauseError
      }
    }
    if (copyFailed) throw copyError
    if (!state.sourceWorkspaceFingerprint) throw new Error('Copied workspace fingerprint is missing')

    steps.push('Rewrite CRLF to LF in the staged generation (gradlew, mvnw, *.sh and other shebang scripts)')
    const result = await ctx.backend.runOneShot(stagedSpec, LINE_ENDING_NORMALIZE_SCRIPT, ctx.log)
    if (result.code !== 0) {
      throw new Error(`Line-ending normalization failed: ${(result.stderr || result.stdout).slice(-400) || `exit ${result.code}`}`)
    }
    const normalized = parseScriptPaths(result.stdout)
    if (normalized.length === 0) throw new Error(NOTHING_TO_NORMALIZE)
    state.normalized = normalized
    steps.setCaptured(state)
    steps.push(`Normalize ${normalized.length} script${normalized.length === 1 ? '' : 's'}: ${normalized.slice(0, 10).join(', ')}${normalized.length > 10 ? `, and ${normalized.length - 10} more` : ''}`)

    state.appliedWorkspaceFingerprint = await ctx.backend.fingerprintWorkspace(room.id, nextWorkspaceGeneration)
    steps.setCaptured(state)

    let finalPauseAttempted = false
    try {
      if (awake) {
        finalPauseAttempted = true
        steps.push('Pause the Room to validate and publish the staged generation')
        await ctx.backend.pauseWeb(room.id)
      }
      // Anything edited in the live Room after staging was copied is not in the
      // staged generation, so publishing it would silently discard that edit.
      const finalSourceFingerprint = await ctx.backend.fingerprintWorkspace(
        room.id,
        state.previousWorkspaceGeneration
      )
      if (finalSourceFingerprint !== state.sourceWorkspaceFingerprint) {
        const current = ctx.room()
        ctx.rooms.update(room.id, { stateRevision: current.stateRevision + 1, syncStatus: 'modified' })
        throw new Error('Room workspace changed while line endings were being normalized; nothing was published. Retry the change.')
      }

      if (awake) {
        state.runtimeSwitchAttempted = true
        steps.setCaptured(state)
        steps.push('Switch the web process to the staged workspace')
        await ctx.backend.recreateWeb(stagedSpec)
      }

      ctx.rooms.publishWorkingState({
        roomId: room.id,
        expectedWorkspaceVolumeRevision: state.previousWorkspaceGeneration,
        expectedStateRevision: state.beforeStateRevision,
        workspaceVolumeRevision: nextWorkspaceGeneration,
        stateRevision: state.appliedStateRevision!,
        syncStatus: 'modified',
        depsKey: depsGenKey(room.id, state.nodeMajor),
        legacyDepsKey: `depsGen:${room.id}`,
        expectedDepsGeneration: state.depsGeneration,
        depsGeneration: state.depsGeneration
      })
      state.published = true
      steps.setCaptured(state)
      steps.push('Publish the normalized workspace generation')
    } catch (error) {
      if (finalPauseAttempted && !state.runtimeSwitchAttempted) {
        try {
          await ctx.backend.unpauseWeb(room.id)
        } catch (unpauseError) {
          try {
            await ctx.backend.recreateWeb(previousSpec)
          } catch (recreateError) {
            throw new AggregateError(
              [error, unpauseError, recreateError],
              'Line-ending publish failed and the previously published Room runtime could not be resumed or recreated'
            )
          }
        }
      }
      throw error
    }
  },
  async verify(ctx, _p, capturedState) {
    const state = capturedState as NormalizeCapture | null
    if (!state?.published || state.nextWorkspaceGeneration === undefined) {
      return { ok: false, detail: 'normalized workspace generation was not published' }
    }
    // Independent re-scan of what was actually published, rather than trusting
    // the same run that did the rewriting.
    const spec = ctx.webSpec({ workspaceVolumeRevision: state.nextWorkspaceGeneration })
    const res = await ctx.backend.runOneShot(spec, LINE_ENDING_SCAN_SCRIPT, ctx.log)
    if (res.code !== 0) return { ok: false, detail: 'could not re-scan the normalized workspace' }
    const left = parseScriptPaths(res.stdout)
    if (left.length > 0) return { ok: false, detail: `still CRLF after normalization: ${left.slice(0, 5).join(', ')}` }
    // The Room also has to still be up: publishing swapped the volume the web
    // process runs on, and a clean scan over a dead Room is not a success.
    const up = await verifyWebUp(ctx)
    if (!up.ok) return up
    const count = state.normalized?.length ?? 0
    return { ok: true, detail: `${count} script${count === 1 ? '' : 's'} now use LF line endings` }
  },
  async undo(ctx, entry) {
    const state = captured(entry)
    if (state.nextWorkspaceGeneration === undefined) return
    const room = ctx.room()
    const stagedIsPublished = room.workspaceVolumeRevision === state.nextWorkspaceGeneration
    const previousIsPublished = room.workspaceVolumeRevision === state.previousWorkspaceGeneration
    if (!stagedIsPublished && !previousIsPublished) {
      throw new Error('Room working state no longer matches either side of this line-ending normalization')
    }

    if (!stagedIsPublished) {
      // Never published (or already reverted): only the staged copy is ours to remove.
      if (state.runtimeSwitchAttempted && ctx.isAwake()) {
        await ctx.backend.recreateWeb(ctx.webSpec({ workspaceVolumeRevision: state.previousWorkspaceGeneration }))
      }
      await ctx.backend.removeWorkspaceVolume(ctx.roomId, state.nextWorkspaceGeneration)
      return
    }

    if (room.stateRevision !== state.appliedStateRevision) {
      throw new Error(
        `Room state advanced from revision ${state.appliedStateRevision} to ${room.stateRevision}; undo would discard later workspace edits.`
      )
    }
    if (!state.appliedWorkspaceFingerprint) throw new Error('Normalized workspace fingerprint is missing')
    const currentFingerprint = await ctx.backend.fingerprintWorkspace(room.id, state.nextWorkspaceGeneration)
    if (currentFingerprint !== state.appliedWorkspaceFingerprint) {
      throw new Error('Room workspace files changed after this normalization; undo would discard later workspace edits.')
    }

    const previousSpec = ctx.webSpec({ workspaceVolumeRevision: state.previousWorkspaceGeneration })
    const stagedSpec = ctx.webSpec({ workspaceVolumeRevision: state.nextWorkspaceGeneration })
    if (ctx.isAwake()) await ctx.backend.recreateWeb(previousSpec)
    try {
      ctx.rooms.publishWorkingState({
        roomId: room.id,
        expectedWorkspaceVolumeRevision: state.nextWorkspaceGeneration,
        expectedStateRevision: state.appliedStateRevision,
        workspaceVolumeRevision: state.previousWorkspaceGeneration,
        stateRevision: room.stateRevision + 1,
        syncStatus: 'modified',
        depsKey: depsGenKey(room.id, state.nodeMajor),
        legacyDepsKey: `depsGen:${room.id}`,
        expectedDepsGeneration: state.depsGeneration,
        depsGeneration: state.depsGeneration
      })
    } catch (error) {
      if (ctx.isAwake()) await ctx.backend.recreateWeb(stagedSpec).catch(() => undefined)
      throw error
    }
    try {
      await ctx.backend.removeWorkspaceVolume(ctx.roomId, state.nextWorkspaceGeneration)
    } catch (error) {
      ctx.log(`Line-ending undo completed; staged generation cleanup deferred: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
