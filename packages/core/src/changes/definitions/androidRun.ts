import { EMULATOR_ADB_SERIAL } from '../../backend/naming'
import { assertLaunchersAreExecutable, lineEndingAttributionInRoom } from './androidLineEndings'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const BUILD_TIMEOUT_MS = 15 * 60_000
const ADB = `adb -s ${EMULATOR_ADB_SERIAL}`

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runAdb(ctx: ChangeCtx, args: string[], timeoutMs: number) {
  if (ctx.physicalAndroidDevice) return ctx.physicalAndroidDevice.exec(args, { timeoutMs })
  return ctx.backend.execInRoom(
    ctx.roomId,
    ['sh', '-lc', `${ADB} ${args.map(shellQuote).join(' ')}`],
    { timeoutMs }
  )
}

function targetLabel(ctx: ChangeCtx): string {
  return ctx.physicalAndroidDevice?.nickname ?? 'the Room emulator'
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
      const state = await ctx.physicalAndroidDevice.exec(['get-state'], { timeoutMs: 20_000 })
      if (state.code !== 0 || state.stdout.trim() !== 'device') {
        throw new Error(`${ctx.physicalAndroidDevice.nickname} is not ready: ${(state.stderr || state.stdout).trim() || `adb exited ${state.code}`}`)
      }
    } else if ((await ctx.backend.emulatorState(room.id)) !== 'running') {
      throw new Error('The emulator is not running — restart the room')
    }
    await assertLaunchersAreExecutable(ctx)
  },
  async apply(ctx, p, steps) {
    const apply = async (): Promise<void> => {
      const room = ctx.room()
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

      if (ctx.physicalAndroidDevice) {
        steps.push(`Use the exclusive lease on ${ctx.physicalAndroidDevice.nickname}`)
      } else {
        // the emulator boots asynchronously — wait until adb (shared netns)
        // reports the device ready, bounded by wall clock (probes can block)
        steps.push('Wait for the emulator to finish booting')
        let booted = false
        const bootDeadline = Date.now() + 5 * 60_000
        while (Date.now() < bootDeadline) {
          const probe = await runAdb(ctx, ['shell', 'getprop', 'sys.boot_completed'], 20_000)
          if (probe.stdout.trim() === '1') {
            booted = true
            break
          }
          await sleep(5000)
        }
        if (!booted) throw new Error('emulator did not finish booting within 5 minutes')
      }

      // multi-module apps (app + companion/crash-lab modules) install together
      for (const app of apps) {
        steps.push(`Install ${app.apkPath.split('/').pop()} (${app.appId}) on ${targetLabel(ctx)}`)
        const install = await runAdb(ctx, ['install', '-r', app.apkPath], 180_000)
        if (install.code !== 0) {
          throw new Error(`adb install ${app.appId} failed: ${(install.stderr || install.stdout).slice(-300)}`)
        }
      }

      steps.push(`Resolve and launch ${target.appId}`)
      const resolved = await runAdb(
        ctx,
        [
          'shell',
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '--components',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.LAUNCHER',
          target.appId
        ],
        30_000
      )
      const component = resolved.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(line))
      if (resolved.code !== 0 || !component) {
        throw new Error(`could not resolve launcher for ${target.appId}: ${(resolved.stderr || resolved.stdout).slice(-300)}`)
      }
      const launch = await runAdb(
        ctx,
        ['shell', 'am', 'start', '-W', '-n', component],
        60_000
      )
      if (launch.code !== 0) throw new Error(`launch failed: ${(launch.stderr || launch.stdout).slice(-300)}`)
    }

    if (ctx.physicalAndroidDevice) {
      await ctx.physicalAndroidDevice.keepAlive(apply)
    } else {
      await apply()
    }
  },
  async verify(ctx, p) {
    let appId: string
    try {
      appId = pickTarget(await builtApps(ctx), p.applicationId).appId
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    for (let i = 0; i < 6; i++) {
      const pid = await runAdb(ctx, ['shell', 'pidof', appId], 20_000)
      if (pid.stdout.trim()) return { ok: true, detail: `${appId} running on ${targetLabel(ctx)}` }
      await sleep(2000)
    }
    return { ok: false, detail: `${appId} installed but not running` }
  }
}
