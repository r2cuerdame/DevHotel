import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { assertLaunchersAreExecutable } from './androidLineEndings'
import {
  buildSealedAndroidArtifacts,
  cleanupAndroidBuildArtifacts,
  sealedAndroidArtifactRef,
  verifySealedAndroidBuild
} from './androidBuild'
import type { ExportedArtifact } from '../../backend/types'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const MAX_ANDROID_APPLICATION_ID_LENGTH = 223
const MAX_BUILT_APPS = 64
const MAX_METADATA_STDOUT_BYTES = 64 * 1024
const DEBUG_APK_PATH = /^(?:[^/\0]+\/)*build\/outputs\/apk\/debug\/[^/\0]+\.apk$/i

interface BuiltApp {
  appId: string
  artifact: ExportedArtifact
}

interface AndroidRunCapture {
  applicationId: string
}

function assertApplicationId(value: string, source: 'build metadata' | 'request'): string {
  if (
    value.length === 0 ||
    value.length > MAX_ANDROID_APPLICATION_ID_LENGTH ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)
  ) {
    throw new Error(`Invalid Android applicationId in ${source}`)
  }
  return value
}

function builtAppFromMetadata(artifact: ExportedArtifact, stdout: string): BuiltApp {
  let metadata: unknown
  try {
    metadata = JSON.parse(stdout)
  } catch {
    throw new Error('Android build returned invalid output metadata')
  }
  if (!metadata || typeof metadata !== 'object') throw new Error('Android build returned invalid output metadata')
  const record = metadata as { applicationId?: unknown; elements?: unknown }
  const element = Array.isArray(record.elements) && record.elements.length === 1
    ? record.elements[0]
    : null
  if (typeof record.applicationId !== 'string' || !element) {
    throw new Error('Android build output metadata is missing its applicationId or APK')
  }
  if (typeof element !== 'object' || typeof (element as { outputFile?: unknown }).outputFile !== 'string') {
    throw new Error('Android build output metadata is missing its applicationId or APK')
  }
  const appId = assertApplicationId(record.applicationId, 'build metadata')
  const outputFile = (element as { outputFile: string }).outputFile
  const stem = outputFile.slice(0, -4)
  if (
    Buffer.byteLength(outputFile, 'utf8') > 255 ||
    stem.length === 0 ||
    stem === '.' ||
    stem === '..' ||
    !/\.apk$/i.test(outputFile) ||
    /^[A-Za-z]:/.test(outputFile) ||
    /[\\/\p{C}\p{Zl}\p{Zp}]/u.test(outputFile)
  ) {
    throw new Error('Android build output metadata contains an unsafe APK filename')
  }
  if (outputFile !== basename(artifact.relativePath)) {
    throw new Error('Android build output metadata does not match its sealed APK artifact')
  }
  return { appId, artifact }
}

/** Resolve only bounded, verified debug APKs exported from this operation's private snapshot. */
function builtApps(ctx: ChangeCtx, operationId: string, artifacts: ExportedArtifact[]): BuiltApp[] {
  if (artifacts.length > MAX_BUILT_APPS) throw new Error('Android build returned too many APK artifacts')
  const artifactRoot = join(ctx.userData, 'rooms', ctx.roomId, 'artifacts', operationId)
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync.native(artifactRoot)
  } catch {
    throw new Error('sealed Android build metadata is missing or unreadable')
  }
  const debugArtifacts = artifacts.filter((artifact) => DEBUG_APK_PATH.test(artifact.relativePath))
  const apps: BuiltApp[] = []
  const applicationIds = new Set<string>()
  const artifactPaths = new Set<string>()
  const metadataPaths = new Set<string>()
  for (const artifact of debugArtifacts) {
    if (artifactPaths.has(artifact.relativePath)) {
      throw new Error('Android build returned duplicate APK artifacts')
    }
    artifactPaths.add(artifact.relativePath)
    const metadataRelativePath = `${dirname(artifact.relativePath).replaceAll('\\', '/')}/output-metadata.json`
    if (metadataPaths.has(metadataRelativePath)) {
      throw new Error('Android build returned multiple APKs for one tracked application')
    }
    metadataPaths.add(metadataRelativePath)
    const metadataPath = join(artifactRoot, ...metadataRelativePath.split('/'))
    let metadata: ReturnType<typeof lstatSync>
    let canonicalMetadata: string
    try {
      metadata = lstatSync(metadataPath)
      canonicalMetadata = realpathSync.native(metadataPath)
    } catch {
      throw new Error('sealed Android build metadata is missing or unreadable')
    }
    const metadataRelativeToRoot = relative(canonicalRoot, canonicalMetadata)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size < 2 ||
      metadata.size > MAX_METADATA_STDOUT_BYTES ||
      isAbsolute(metadataRelativeToRoot) ||
      metadataRelativeToRoot === '..' ||
      metadataRelativeToRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw new Error('Android build returned unsafe output metadata')
    }
    let metadataText: string
    try {
      metadataText = readFileSync(canonicalMetadata, 'utf8')
    } catch {
      throw new Error('sealed Android build metadata is missing or unreadable')
    }
    const app = builtAppFromMetadata(artifact, metadataText)
    if (applicationIds.has(app.appId)) {
      throw new Error('Android build returned ambiguous duplicate app metadata')
    }
    applicationIds.add(app.appId)
    apps.push(app)
  }
  return apps
}

function capturedTarget(captured: unknown, requestedApplicationId?: string): AndroidRunCapture | null {
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null
  const record = captured as { applicationId?: unknown }
  if (Object.keys(record).length !== 1 || typeof record.applicationId !== 'string') return null
  try {
    const applicationId = assertApplicationId(record.applicationId, 'build metadata')
    if (
      requestedApplicationId !== undefined &&
      applicationId !== assertApplicationId(requestedApplicationId, 'request')
    ) return null
    return { applicationId }
  } catch {
    return null
  }
}

function pickTarget(apps: BuiltApp[], applicationId?: string): BuiltApp {
  if (!applicationId) {
    const first = apps[0]
    if (!first) throw new Error('no debug APK metadata produced by the build')
    return first
  }
  const requestedId = assertApplicationId(applicationId, 'request')
  const target = apps.find((app) => app.appId === requestedId)
  if (!target) {
    throw new Error(`Requested applicationId is not among built modules: ${apps.map((app) => app.appId).join(', ') || 'none'}`)
  }
  return target
}

function targetLabel(ctx: ChangeCtx): string {
  return ctx.physicalAndroidDevice?.nickname ?? 'the Room emulator'
}

function androidProbeFailure(ctx: ChangeCtx, appId: string): { ok: false; detail: string } {
  const target = ctx.physicalAndroidDevice ? 'the attached physical device' : 'the Room emulator'
  return {
    ok: false,
    detail: `${appId} could not be verified on ${target}; its bounded probe failed or the target became unavailable`
  }
}

export const androidRunChange: ChangeDefinition<{ applicationId?: string }> = {
  kind: 'android-run',
  plan(ctx, p) {
    const target = targetLabel(ctx)
    return {
      title: p.applicationId ? `${p.applicationId} built and launched on ${target}` : `App built and launched on ${target}`,
      component: 'Build',
      before: null,
      after: { command: ctx.room().startCommand, applicationId: p.applicationId ?? null },
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Only Android rooms can run Android apps')
    if (!ctx.isAwake()) throw new Error('Wake the room before running')
    if (room.workspaceMode !== 'hotel') {
      throw new Error('Android Build & Run requires a Room-owned Hotel workspace; move this Room into Hotel first')
    }
    if (p.applicationId) assertApplicationId(p.applicationId, 'request')
    if (ctx.physicalAndroidDevice) {
      if (!ctx.execFencedAndroidTarget) throw new Error('The fenced Android target executor is unavailable')
      const state = await ctx.execFencedAndroidTarget(['get-state'], { timeoutMs: 20_000 })
      if (state.code !== 0 || state.stdout.trim() !== 'device') {
        throw new Error(`${ctx.physicalAndroidDevice.nickname} is not ready: ${(state.stderr || state.stdout).trim() || `adb exited ${state.code}`}`)
      }
    } else if ((await ctx.backend.emulatorState(room.id)) !== 'running') {
      throw new Error('The emulator is not running — restart the room')
    }
    await assertLaunchersAreExecutable(ctx)
  },
  async apply(ctx, p, steps, operation) {
    const apply = async (): Promise<void> => {
      const room = ctx.room()
      const committed: string[] = []
      let primaryError: unknown
      try {
        const sealed = await buildSealedAndroidArtifacts(ctx, steps, operation)
        const verified = await verifySealedAndroidBuild(ctx, sealed.provenance, operation)
        if (!verified.ok) throw new Error(verified.detail)
        const apps = builtApps(ctx, operation.id, sealed.provenance.artifacts)
        if (apps.length === 0) throw new Error('no sealed debug APK metadata was produced')
        const target = pickTarget(apps, p.applicationId)
        // Android-run owns only its validated target capture. Build provenance
        // remains an operation-local capability and is never persisted here.
        steps.setCaptured({ applicationId: target.appId } satisfies AndroidRunCapture)

        if (ctx.physicalAndroidDevice) {
          steps.push(`Use the exclusive lease on ${ctx.physicalAndroidDevice.nickname}`)
        } else {
          steps.push('Wait for the emulator to finish booting')
          let booted = false
          const bootDeadline = Date.now() + 5 * 60_000
          if (!ctx.execFencedAndroidTarget) throw new Error('The fenced Android target executor is unavailable')
          while (Date.now() < bootDeadline) {
            const probe = await ctx.execFencedAndroidTarget(
              ['shell', 'getprop', 'sys.boot_completed'],
              { timeoutMs: 20_000 }
            )
            if (probe.code === 0 && probe.stdout.trim() === '1') {
              booted = true
              break
            }
            await sleep(5000)
          }
          if (!booted) throw new Error('emulator did not finish booting within 5 minutes')
        }

        for (const app of apps) {
          steps.push(`Install sealed ${app.artifact.relativePath.split('/').pop()} (${app.appId}) on ${targetLabel(ctx)}`)
          // Register before awaiting: the installer may commit its receipt and
          // then fail while cleaning the private stage.
          committed.push(app.appId)
          await ctx.installTrackedAndroidArtifact(
            app.appId,
            sealedAndroidArtifactRef(sealed, app.artifact),
            operation.id
          )
        }

        steps.push(`Resolve and launch ${target.appId}`)
        if (!ctx.launchTrackedAndroidApp) throw new Error('tracked Android launcher authority is unavailable')
        await ctx.launchTrackedAndroidApp(target.appId)
      } catch (error) {
        primaryError = error
      }

      const cleanupError = cleanupAndroidBuildArtifacts(ctx.userData, room.id, operation.id)
      if (cleanupError) {
        primaryError = primaryError
          ? new AggregateError(
              [primaryError, new Error(cleanupError)],
              'Android run failed and its private build artifact cleanup also failed'
            )
          : new Error(`Android run private build artifact cleanup failed: ${cleanupError}`)
      }
      if (primaryError) {
        for (const applicationId of committed) {
          try {
            ctx.removeTrackedAndroidInstall(applicationId, operation.id)
          } catch {
            // The exact target/lease may already be gone. The operation-wide
            // repository cleanup below is the authoritative revocation.
          }
        }
        try {
          ctx.removeTrackedAndroidInstalls(operation.id)
        } catch {
          throw new AggregateError(
            [primaryError, new Error('tracked Android receipt cleanup failed')],
            'Android run failed and one or more tracked install receipts could not be revoked'
          )
        }
        throw primaryError
      }
    }

    if (ctx.physicalAndroidDevice) {
      await ctx.physicalAndroidDevice.keepAlive(apply)
    } else {
      await apply()
    }
  },
  async verify(ctx, p, captured) {
    const target = capturedTarget(captured, p.applicationId)
    if (!target) {
      return { ok: false, detail: 'Android run verification could not read validated build metadata' }
    }
    const appId = target.applicationId
    try {
      if (!ctx.isTrackedAndroidAppForeground) return androidProbeFailure(ctx, appId)
      for (let i = 0; i < 6; i++) {
        if (await ctx.isTrackedAndroidAppForeground(appId)) {
          return { ok: true, detail: `${appId} running on ${targetLabel(ctx)}` }
        }
        await sleep(2000)
      }
    } catch {
      // The physical lease or transport can disappear after launch succeeds.
      // Its raw Host/ADB error is private; durable verification gets only this
      // bounded, structured result and follows the normal ChangeEngine path.
      return androidProbeFailure(ctx, appId)
    }
    return { ok: false, detail: `${appId} installed but not running` }
  }
}
