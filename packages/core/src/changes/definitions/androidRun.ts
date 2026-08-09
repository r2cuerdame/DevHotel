import { EMULATOR_ADB_ADDR } from '../../backend/naming'
import type { ChangeDefinition } from '../types'
import { sleep } from '../types'

const BUILD_TIMEOUT_MS = 15 * 60_000
const ADB = `adb -s ${EMULATOR_ADB_ADDR}`

export const androidRunChange: ChangeDefinition<Record<string, never>> = {
  kind: 'android-run',
  plan(ctx) {
    return {
      title: 'App built and launched on the emulator',
      component: 'Build',
      before: null,
      after: { command: ctx.room().startCommand },
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
  async apply(ctx, _p, steps) {
    const room = ctx.room()
    steps.push(`Run ${room.startCommand}`)
    const build = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `cd /workspace && ${room.startCommand}`], {
      timeoutMs: BUILD_TIMEOUT_MS
    })
    if (build.code !== 0) {
      throw new Error(`build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(-500)}`)
    }

    const meta = await ctx.backend.execInRoom(
      room.id,
      ['sh', '-lc', "cat $(find /workspace -path '*/build/outputs/apk/debug/output-metadata.json' | head -1)"],
      { timeoutMs: 30_000 }
    )
    const appId = /"applicationId"\s*:\s*"([^"]+)"/.exec(meta.stdout)?.[1]
    if (!appId) throw new Error('could not read applicationId from output-metadata.json')

    const apk = await ctx.backend.execInRoom(
      room.id,
      ['sh', '-lc', "find /workspace -path '*/build/outputs/apk/debug/*.apk' | head -1"],
      { timeoutMs: 30_000 }
    )
    const apkPath = apk.stdout.trim()
    if (!apkPath) throw new Error('no APK produced')

    // the emulator boots asynchronously — wait until adb (shared netns) reports the device ready
    steps.push('Wait for the emulator to finish booting')
    let booted = false
    for (let i = 0; i < 60; i++) {
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

    steps.push(`Install ${apkPath.split('/').pop()} (${appId})`)
    const install = await ctx.backend.execInRoom(room.id, ['sh', '-lc', `${ADB} install -r '${apkPath}'`], {
      timeoutMs: 180_000
    })
    if (install.code !== 0) throw new Error(`adb install failed: ${(install.stderr || install.stdout).slice(-300)}`)

    steps.push('Launch the app')
    const launch = await ctx.backend.execInRoom(
      ctx.roomId,
      ['sh', '-lc', `${ADB} shell monkey -p ${appId} -c android.intent.category.LAUNCHER 1`],
      { timeoutMs: 60_000 }
    )
    if (launch.code !== 0) throw new Error(`launch failed: ${(launch.stderr || launch.stdout).slice(-300)}`)
  },
  async verify(ctx) {
    const meta = await ctx.backend.execInRoom(
      ctx.roomId,
      ['sh', '-lc', "cat $(find /workspace -path '*/build/outputs/apk/debug/output-metadata.json' | head -1)"],
      { timeoutMs: 30_000 }
    )
    const appId = /"applicationId"\s*:\s*"([^"]+)"/.exec(meta.stdout)?.[1]
    if (!appId) return { ok: false, detail: 'applicationId unknown' }
    for (let i = 0; i < 6; i++) {
      const pid = await ctx.backend.execInRoom(ctx.roomId, ['sh', '-lc', `${ADB} shell pidof ${appId}`], {
        timeoutMs: 20_000
      })
      if (pid.stdout.trim()) return { ok: true, detail: `${appId} running on the emulator — watch it on the Site page` }
      await sleep(2000)
    }
    return { ok: false, detail: `${appId} installed but not running` }
  }
}
