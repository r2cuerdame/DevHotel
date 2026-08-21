import { zRegistryPackageName, zRegistryPackageVersion } from '@devhotel/shared'
import { srcVolume } from '../../backend/naming'
import { nextWorkspaceVolumeRevision, workspaceGenMaxKey } from '../../workingState'
import {
  currentDepsGen,
  depsGenKey,
  depsGenMaxKey,
  depsVolumeForGen
} from './deps'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

interface PackageInstallParams {
  name: string
  version: string
  dev: boolean
}

interface PackageInstallCapture {
  nodeMajor: string
  previousWorkspaceGeneration: number
  nextWorkspaceGeneration?: number
  previousDepsGeneration: number
  nextDepsGeneration?: number
  beforeStateRevision: number
  appliedStateRevision?: number
  sourceWorkspaceFingerprint?: string
  appliedWorkspaceFingerprint?: string
  runtimeSwitchAttempted?: boolean
  published?: boolean
}

export function packageInstallCommand(
  pm: 'npm' | 'pnpm',
  input: Pick<PackageInstallParams, 'name' | 'version' | 'dev'>
): string {
  // Validate again at the execution boundary. This function is also used by
  // non-IPC callers and must never turn untrusted text into a shell fragment.
  const name = zRegistryPackageName.parse(input.name)
  const version = zRegistryPackageVersion.parse(input.version)
  const spec = `${name}@${version}`
  if (pm === 'pnpm') return `pnpm add --save-exact${input.dev ? ' --save-dev' : ''} ${spec}`
  return `npm install --save-exact ${input.dev ? '--save-dev' : '--save'} ${spec}`
}

function nextDependencyGeneration(ctx: ChangeCtx, roomId: string, nodeMajor: string, current: number): number {
  const raw = ctx.settings.get(depsGenMaxKey(roomId, nodeMajor))
  const parsed = raw === null ? current : Number.parseInt(raw, 10)
  const highWater = Number.isSafeInteger(parsed) && parsed >= 0 ? Math.max(current, parsed) : current
  return highWater + 1
}

function captured(entry: { captured: unknown }): PackageInstallCapture {
  const value = entry.captured as Partial<PackageInstallCapture> | null
  if (
    !value || typeof value.nodeMajor !== 'string' ||
    !Number.isSafeInteger(value.previousWorkspaceGeneration) ||
    !Number.isSafeInteger(value.previousDepsGeneration) ||
    !Number.isSafeInteger(value.beforeStateRevision)
  ) throw new Error('Package install safety state is missing or invalid')
  return value as PackageInstallCapture
}

async function removeStagedGenerations(ctx: ChangeCtx, state: PackageInstallCapture): Promise<void> {
  const failures: string[] = []
  if (state.nextWorkspaceGeneration !== undefined) {
    try { await ctx.backend.removeWorkspaceVolume(ctx.roomId, state.nextWorkspaceGeneration) }
    catch (error) { failures.push(`workspace: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (state.nextDepsGeneration !== undefined) {
    try { await ctx.backend.removeDependencyVolume(ctx.roomId, state.nodeMajor, state.nextDepsGeneration) }
    catch (error) { failures.push(`dependencies: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (failures.length > 0) throw new Error(`Staged package generations require cleanup (${failures.join('; ')})`)
}

export const packageInstallChange: ChangeDefinition<PackageInstallParams> = {
  kind: 'package-install',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: `Install ${p.name}@${p.version}`,
      component: 'Packages',
      before: {
        workspaceGeneration: room.workspaceVolumeRevision,
        depsGeneration: currentDepsGen(ctx),
        stateRevision: room.stateRevision
      },
      after: { name: p.name, version: p.version, dev: p.dev },
      undoable: true,
      undoStrategy: 'workspace-and-dependency-generation-swap',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    zRegistryPackageName.parse(p.name)
    zRegistryPackageVersion.parse(p.version)
    if (ctx.room().workspaceMode === 'legacy-host-bind') {
      throw new Error('Package Store installs are blocked for legacy Host binds to protect Host files. Move the Room into the Hotel first.')
    }
    if (ctx.room().workspaceMode === 'empty') {
      throw new Error('This Empty Room has no persistent project working state. Add or import a project first.')
    }
    if (!['npm', 'pnpm'].includes(ctx.room().packageManager.kind)) {
      throw new Error('npm packages are only available in Web Rooms')
    }
  },
  async capture(ctx) {
    const room = ctx.room()
    return {
      nodeMajor: room.runtime.version,
      previousWorkspaceGeneration: room.workspaceVolumeRevision,
      previousDepsGeneration: currentDepsGen(ctx),
      beforeStateRevision: room.stateRevision,
      published: false,
      runtimeSwitchAttempted: false
    } satisfies PackageInstallCapture
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()
    if (room.packageManager.kind !== 'npm' && room.packageManager.kind !== 'pnpm') {
      throw new Error('npm packages are only available in Web Rooms')
    }
    const command = packageInstallCommand(room.packageManager.kind, p)
    const previousDepsGeneration = currentDepsGen(ctx)
    const nextWorkspaceGeneration = nextWorkspaceVolumeRevision(
      room.workspaceVolumeRevision,
      ctx.settings.get(workspaceGenMaxKey(room.id))
    )
    const nextDepsGeneration = nextDependencyGeneration(ctx, room.id, room.runtime.version, previousDepsGeneration)
    const state: PackageInstallCapture = {
      nodeMajor: room.runtime.version,
      previousWorkspaceGeneration: room.workspaceVolumeRevision,
      nextWorkspaceGeneration,
      previousDepsGeneration,
      nextDepsGeneration,
      beforeStateRevision: room.stateRevision,
      appliedStateRevision: room.stateRevision + 1,
      published: false,
      runtimeSwitchAttempted: false
    }

    // Reserve names before touching either volume. Failed/undone generations
    // remain above the durable high-water mark and can never be recycled.
    ctx.settings.set(workspaceGenMaxKey(room.id), String(nextWorkspaceGeneration))
    ctx.settings.set(depsGenMaxKey(room.id, room.runtime.version), String(nextDepsGeneration))
    steps.setCaptured(state)

    const previousSpec = ctx.webSpec({
      workspaceVolumeRevision: state.previousWorkspaceGeneration,
      depsVolumeOverride: state.previousDepsGeneration > 0
        ? depsVolumeForGen(room.id, state.nodeMajor, state.previousDepsGeneration)
        : undefined
    })

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
      // This fingerprint is taken while the live container is paused, so it
      // represents the exact old generation from which staging was copied.
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
        // A failed unpause must not leave the previously published Room
        // suspended. Recreate it from the still-current pointers before the
        // change engine rolls back and removes the staged generations.
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

    // Close the small pause→unpause hand-off window before doing the slower
    // package install. Any edit here was made against the old live generation
    // and is not present in staging, so publishing must be rejected.
    if (awake) {
      const resumedFingerprint = await ctx.backend.fingerprintWorkspace(
        room.id,
        state.previousWorkspaceGeneration
      )
      if (resumedFingerprint !== state.sourceWorkspaceFingerprint) {
        const current = ctx.room()
        ctx.rooms.update(room.id, { stateRevision: current.stateRevision + 1, syncStatus: 'modified' })
        throw new Error('Room workspace changed while package installation was being staged; no package changes were published. Retry the install.')
      }
    }

    const freshDepsVolume = depsVolumeForGen(room.id, room.runtime.version, nextDepsGeneration)
    steps.push(`Create dependency generation g${nextDepsGeneration}`)
    await ctx.backend.resetVolume(room.id, freshDepsVolume)
    steps.push(`Run ${command} against the staged Room generation`)
    const stagedSpec = ctx.webSpec({
      workspaceVolumeRevision: nextWorkspaceGeneration,
      depsVolumeOverride: freshDepsVolume
    })
    const result = await ctx.backend.runOneShot(stagedSpec, command, ctx.log)
    if (result.code !== 0) {
      throw new Error(`${room.packageManager.kind} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
    }
    state.appliedWorkspaceFingerprint = await ctx.backend.fingerprintWorkspace(room.id, nextWorkspaceGeneration)
    steps.setCaptured(state)

    let finalPauseAttempted = false
    try {
      if (awake) {
        finalPauseAttempted = true
        steps.push('Pause the Room to validate and publish the staged generations')
        await ctx.backend.pauseWeb(room.id)
      }
      const finalSourceFingerprint = await ctx.backend.fingerprintWorkspace(
        room.id,
        state.previousWorkspaceGeneration
      )
      if (finalSourceFingerprint !== state.sourceWorkspaceFingerprint) {
        const current = ctx.room()
        ctx.rooms.update(room.id, { stateRevision: current.stateRevision + 1, syncStatus: 'modified' })
        throw new Error('Room workspace changed while package installation was being staged; no package changes were published. Retry the install.')
      }

      if (awake) {
        state.runtimeSwitchAttempted = true
        steps.setCaptured(state)
        steps.push('Switch the web process to the staged workspace and dependencies')
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
        expectedDepsGeneration: state.previousDepsGeneration,
        depsGeneration: nextDepsGeneration
      })
      state.published = true
      steps.setCaptured(state)
      steps.push('Publish the workspace and dependency generations together')
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
              'Package publish failed and the previously published Room runtime could not be resumed or recreated'
            )
          }
        }
      }
      throw error
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  },
  async undo(ctx, entry) {
    const state = captured(entry)
    if (state.nextWorkspaceGeneration === undefined || state.nextDepsGeneration === undefined) return
    const room = ctx.room()
    if (room.runtime.version !== state.nodeMajor) {
      throw new Error(`This package install belongs to Node ${state.nodeMajor}; switch the Room back before undoing it.`)
    }
    const currentDepsGeneration = currentDepsGen(ctx)
    const stagedIsPublished =
      room.workspaceVolumeRevision === state.nextWorkspaceGeneration &&
      currentDepsGeneration === state.nextDepsGeneration
    const previousIsPublished =
      room.workspaceVolumeRevision === state.previousWorkspaceGeneration &&
      currentDepsGeneration === state.previousDepsGeneration

    if (!stagedIsPublished && !previousIsPublished) {
      throw new Error('Room working state no longer matches either side of this package install')
    }

    if (!stagedIsPublished) {
      if (state.runtimeSwitchAttempted && ctx.isAwake()) {
        await ctx.backend.recreateWeb(ctx.webSpec({
          workspaceVolumeRevision: state.previousWorkspaceGeneration,
          depsVolumeOverride: state.previousDepsGeneration > 0
            ? depsVolumeForGen(room.id, state.nodeMajor, state.previousDepsGeneration)
            : undefined
        }))
      }
      await removeStagedGenerations(ctx, state)
      return
    }

    if (room.stateRevision !== state.appliedStateRevision) {
      throw new Error(
        `Room state advanced from revision ${state.appliedStateRevision} to ${room.stateRevision}; undo would discard later workspace edits.`
      )
    }
    if (!state.appliedWorkspaceFingerprint) throw new Error('Package install workspace fingerprint is missing')
    const currentFingerprint = await ctx.backend.fingerprintWorkspace(room.id, state.nextWorkspaceGeneration)
    if (currentFingerprint !== state.appliedWorkspaceFingerprint) {
      throw new Error('Room workspace files changed after this package install; undo would discard later workspace edits.')
    }

    const previousSpec = ctx.webSpec({
      workspaceVolumeRevision: state.previousWorkspaceGeneration,
      depsVolumeOverride: state.previousDepsGeneration > 0
        ? depsVolumeForGen(room.id, state.nodeMajor, state.previousDepsGeneration)
        : undefined
    })
    const stagedSpec = ctx.webSpec({
      workspaceVolumeRevision: state.nextWorkspaceGeneration,
      depsVolumeOverride: depsVolumeForGen(room.id, state.nodeMajor, state.nextDepsGeneration)
    })
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
        expectedDepsGeneration: state.nextDepsGeneration,
        depsGeneration: state.previousDepsGeneration
      })
    } catch (error) {
      if (ctx.isAwake()) await ctx.backend.recreateWeb(stagedSpec).catch(() => undefined)
      throw error
    }
    try { await removeStagedGenerations(ctx, state) }
    catch (error) { ctx.log(`Package undo completed; staged generation cleanup deferred: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
