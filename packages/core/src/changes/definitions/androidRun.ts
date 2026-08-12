import { EMULATOR_ADB_ADDR } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const BUILD_TIMEOUT_MS = 15 * 60_000
const ADB = `adb -s ${EMULATOR_ADB_ADDR}`

interface BuiltApp {
  appId: string
  apkPath: string
}

/** Every module's debug APK, resolved strictly from its own output-metadata.json. */
async function builtApps(ctx: ChangeCtx): Promise<BuiltApp[]> {
  const list = await ctx.backend.execInRoom(
    ctx.roomId,
    ['sh', '-lc', "find /workspace -path '*/build/outputs/apk/debug/output-metadata.json'"],
    { timeoutMs: 30_000 }
  )
  const apps: BuiltApp[] = []
  for (const metaPath of list.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const meta = await ctx.backend.execInRoom(ctx.roomId, ['sh', '-lc', `cat '${metaPath}'`], { timeoutMs: 30_000 })
    const appId = /"applicationId"\s*:\s*"([^"]+)"/.exec(meta.stdout)?.[1]
    const outputFile = /"outputFile"\s*:\s*"([^"]+)"/.exec(meta.stdout)?.[1]
    if (appId && outputFile) apps.push({ appId, apkPath: metaPath.replace(/output-metadata\.json$/, outputFile) })
  }
  return apps
}

function pickTarget(apps: BuiltApp[], applicationId?: string): BuiltApp {
  if (!applicationId) {
    const first = apps[0]
    if (!first) throw new Error('no debug APK metadata produced by the build')
    return first
  }
  const target = apps.find((app) => app.appId === applicationId)
  if (!target) {
    throw new Error(`applicationId ${applicationId} not among built modules: ${apps.map((app) => app.appId).join(', ') || 'none'}`)
  }
  return target
}

export const androidRunChange: ChangeDefinition<{ applicationId?: string }> = {
  kind: 'android-run',
  plan(ctx, p) {
    return {
      title: p.applicationId ? `${p.applicationId} built and launched on the emulator` : 'App built and launched on the emulator',
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
    if (room.provider !== 'android') throw new Error('Only Android rooms can run on the emulator')
    if (!ctx.isAwake()) throw new Error('Wake the room before running')
    if ((await ctx.backend.emulatorState(room.id)) !== 'running') {
      throw new Error('The emulator is not running — restart the room')
    }
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()
    steps.push(`Run ${room.startCommand}`)
    const build = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `cd /workspace && ${room.startCommand}`], {
      timeoutMs: BUILD_TIMEOUT_MS
    })
    if (build.code !== 0) {
      throw new Error(`build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(-500)}`)
    }

    const apps = await builtApps(ctx)
    if (apps.length === 0) throw new Error('no output-metadata.json produced')
    const target = pickTarget(apps, p.applicationId)

    // the emulator boots asynchronously — wait until adb (shared netns)
    // reports the device ready, bounded by wall clock (probes can block)
    steps.push('Wait for the emulator to finish booting')
    let booted = false
    const bootDeadline = Date.now() + 5 * 60_000
    while (Date.now() < bootDeadline) {
      const probe = await ctx.backend.execInRoom(
        room.id,
        ['sh', '-lc', `adb connect ${EMULATOR_ADB_ADDR} >/dev/null 2>&1; ${ADB} shell getprop sys.boot_completed 2>/dev/null`],
        { timeoutMs: 20_000 }
      )
      if (probe.stdout.trim() === '1') {
        booted = true
        break
      }
      await sleep(5000)
    }
    if (!booted) throw new Error('emulator did not finish booting within 5 minutes')

    // multi-module apps (app + companion/crash-lab modules) install together
    for (const app of apps) {
      steps.push(`Install ${app.apkPath.split('/').pop()} (${app.appId})`)
      const install = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `${ADB} install -r '${app.apkPath}'`], {
        timeoutMs: 180_000
      })
      if (install.code !== 0) throw new Error(`adb install ${app.appId} failed: ${(install.stderr || install.stdout).slice(-300)}`)
    }

    steps.push(`Launch ${target.appId}`)
    const launch = await ctx.backend.execInRoom(
      ctx.roomId,
      ['sh', '-lc', `${ADB} shell monkey -p ${target.appId} -c android.intent.category.LAUNCHER 1`],
      { timeoutMs: 60_000 }
    )
    if (launch.code !== 0) throw new Error(`launch failed: ${(launch.stderr || launch.stdout).slice(-300)}`)
  },
  async verify(ctx, p) {
    let appId: string
    try {
      appId = pickTarget(await builtApps(ctx), p.applicationId).appId
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    for (let i = 0; i < 6; i++) {
      const pid = await ctx.backend.execInRoom(ctx.roomId, ['sh', '-lc', `${ADB} shell pidof ${appId}`], {
        timeoutMs: 20_000
      })
      if (pid.stdout.trim()) return { ok: true, detail: `${appId} running on the emulator — watch it on the site view` }
      await sleep(2000)
    }
    return { ok: false, detail: `${appId} installed but not running` }
  }
}
