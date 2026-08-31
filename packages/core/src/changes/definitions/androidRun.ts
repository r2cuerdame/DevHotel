import { assertLaunchersAreExecutable, lineEndingAttributionInRoom } from './androidLineEndings'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const BUILD_TIMEOUT_MS = 15 * 60_000
const MAX_ANDROID_APPLICATION_ID_LENGTH = 223
const MAX_BUILT_APPS = 64
const MAX_METADATA_PATH_BYTES = 4096
const MAX_DISCOVERY_STDOUT_BYTES = MAX_BUILT_APPS * (MAX_METADATA_PATH_BYTES + 2)
const MAX_METADATA_STDOUT_BYTES = 64 * 1024
const MAX_COMMAND_DIAGNOSTIC_BYTES = 16 * 1024
const CLEAR_DEBUG_APK_OUTPUTS =
  "cd /workspace && find . -xdev -depth \\( -path '*/build/outputs/apk/debug' -o -path '*/build/outputs/apk/debug/*' \\) -delete"
const DISCOVER_DEBUG_APK_METADATA =
  "find /workspace -xdev -type f -path '*/build/outputs/apk/debug/output-metadata.json' -print0"

interface BuiltApp {
  appId: string
  apkPath: string
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

function assertMetadataPath(metaPath: string): string {
  const prefix = '/workspace/'
  const suffix = '/build/outputs/apk/debug/output-metadata.json'
  const segments = metaPath.slice(prefix.length).split('/')
  if (
    metaPath.length > MAX_METADATA_PATH_BYTES ||
    !metaPath.startsWith(prefix) ||
    !metaPath.endsWith(suffix) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._+@ -]+$/.test(segment))
  ) {
    throw new Error('Android build returned an unsafe output-metadata path')
  }
  return metaPath
}

function builtAppFromMetadata(metaPath: string, stdout: string): BuiltApp {
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
  const outputDirectory = metaPath.slice(0, metaPath.lastIndexOf('/') + 1)
  return { appId, apkPath: `${outputDirectory}${outputFile}` }
}

/** Every module's debug APK, resolved strictly from its own output-metadata.json. */
async function builtApps(ctx: ChangeCtx): Promise<BuiltApp[]> {
  const list = await ctx.backend.execInRoom(
    ctx.roomId,
    ['sh', '-lc', DISCOVER_DEBUG_APK_METADATA],
    {
      timeoutMs: 30_000,
      maxStdoutBytes: MAX_DISCOVERY_STDOUT_BYTES,
      maxStderrBytes: MAX_COMMAND_DIAGNOSTIC_BYTES
    }
  )
  if (list.code !== 0 || list.stderr.length > 0 || list.outputLimitExceeded === true) {
    throw new Error('Android build output metadata discovery failed its bounded provenance check')
  }
  if (list.stdout.length > 0 && !list.stdout.endsWith('\0')) {
    throw new Error('Android build returned incomplete output metadata framing')
  }
  const discoveredPaths = list.stdout.length === 0 ? [] : list.stdout.slice(0, -1).split('\0')
  if (discoveredPaths.length > MAX_BUILT_APPS || discoveredPaths.some((path) => path.length === 0)) {
    throw new Error('Android build returned an invalid number of output metadata paths')
  }
  const metadataPaths = discoveredPaths.map(assertMetadataPath)
  if (new Set(metadataPaths).size !== metadataPaths.length) {
    throw new Error('Android build returned duplicate output metadata paths')
  }
  const apps: BuiltApp[] = []
  const applicationIds = new Set<string>()
  const apkPaths = new Set<string>()
  for (const metaPath of metadataPaths) {
    const meta = await ctx.backend.execInRoom(ctx.roomId, ['sh', '-lc', `cat -- ${shellQuote(metaPath)}`], {
      timeoutMs: 30_000,
      maxStdoutBytes: MAX_METADATA_STDOUT_BYTES,
      maxStderrBytes: MAX_COMMAND_DIAGNOSTIC_BYTES
    })
    if (meta.code !== 0 || meta.stderr.length > 0 || meta.outputLimitExceeded === true) {
      throw new Error('Android build output metadata could not be read safely')
    }
    const app = builtAppFromMetadata(metaPath, meta.stdout)
    if (applicationIds.has(app.appId) || apkPaths.has(app.apkPath)) {
      throw new Error('Android build returned ambiguous duplicate app metadata')
    }
    applicationIds.add(app.appId)
    apkPaths.add(app.apkPath)
    apps.push(app)
  }
  return apps
}

async function clearPriorDebugOutputs(ctx: ChangeCtx): Promise<void> {
  // GNU find does not follow symlinks by default. `-xdev` keeps cleanup in the
  // workspace root filesystem and `-delete` avoids a child `rm` crossing a
  // mount inserted between discovery and deletion. A nested mount remains
  // busy/non-empty, so find exits nonzero and the build fails closed.
  const cleared = await ctx.backend.execInRoom(
    ctx.roomId,
    ['sh', '-lc', CLEAR_DEBUG_APK_OUTPUTS],
    {
      timeoutMs: 30_000,
      maxStdoutBytes: MAX_COMMAND_DIAGNOSTIC_BYTES,
      maxStderrBytes: MAX_COMMAND_DIAGNOSTIC_BYTES
    }
  ).catch(() => {
    throw new Error('prior Android debug outputs could not be cleared safely')
  })
  if (
    cleared.code !== 0 ||
    cleared.stdout.length > 0 ||
    cleared.stderr.length > 0 ||
    cleared.outputLimitExceeded === true
  ) {
    throw new Error('prior Android debug outputs could not be cleared safely')
  }
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
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
  async preflight(ctx) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Only Android rooms can run Android apps')
    if (!ctx.isAwake()) throw new Error('Wake the room before running')
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
      steps.push('Clear prior debug APK outputs')
      await clearPriorDebugOutputs(ctx)
      steps.push(`Run ${room.startCommand}`)
      const build = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `cd /workspace && ${room.startCommand}`], {
        timeoutMs: BUILD_TIMEOUT_MS
      })
      if (build.code !== 0) {
        const attribution = await lineEndingAttributionInRoom(ctx)
        throw new Error(`build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(-500)}${attribution}`)
      }

      const apps = await builtApps(ctx)
      if (apps.length === 0) throw new Error('no output-metadata.json produced')
      const target = pickTarget(apps, p.applicationId)
      steps.setCaptured({ applicationId: target.appId } satisfies AndroidRunCapture)

      if (ctx.physicalAndroidDevice) {
        steps.push(`Use the exclusive lease on ${ctx.physicalAndroidDevice.nickname}`)
      } else {
        // the emulator boots asynchronously — wait until adb (shared netns)
        // reports the device ready, bounded by wall clock (probes can block)
        steps.push('Wait for the emulator to finish booting')
        let booted = false
        const bootDeadline = Date.now() + 5 * 60_000
        if (!ctx.execFencedAndroidTarget) throw new Error('The fenced Android target executor is unavailable')
        while (Date.now() < bootDeadline) {
          const probe = await ctx.execFencedAndroidTarget(
            ['shell', 'getprop', 'sys.boot_completed'],
            { timeoutMs: 20_000 }
          )
          if (probe.stdout.trim() === '1') {
            booted = true
            break
          }
          await sleep(5000)
        }
        if (!booted) throw new Error('emulator did not finish booting within 5 minutes')
      }

      // multi-module apps (app + companion/crash-lab modules) install together
      if (!ctx.installTrackedAndroidApp) throw new Error('The tracked Android installer authority is unavailable')
      for (const app of apps) {
        steps.push(`Install ${app.apkPath.split('/').pop()} (${app.appId}) on ${targetLabel(ctx)}`)
        await ctx.installTrackedAndroidApp(app.appId, app.apkPath, operation.id)
      }

      steps.push(`Resolve and launch ${target.appId}`)
      if (!ctx.launchTrackedAndroidApp) {
        throw new Error('tracked Android launcher authority is unavailable')
      }
      await ctx.launchTrackedAndroidApp(target.appId)
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
