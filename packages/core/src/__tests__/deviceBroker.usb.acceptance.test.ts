import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceLeaseError } from '@devhotel/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SpawnedAdbHost,
  deviceIdForSerial,
  type AdbBinaryResult,
  type AdbDeviceLine,
  type AdbHost,
  type AdbHostAvailability
} from '../devices/adbHost'
import { AndroidDeviceBroker } from '../devices/broker'
import { androidDevicesRepo } from '../store/androidDevicesRepo'
import { openDb } from '../store/db'
import type { ExecResult } from '../backend/types'

/**
 * Opt-in destructive-to-device (install/launch) acceptance proof.
 *
 * It deliberately performs no uninstall, pm clear, file deletion, or data
 * reset. Both verified builds remain installed when the test finishes. The APK
 * paths are trusted operator inputs for this harness; Room-facing installs are
 * separately required to pass through Orchestrator's /workspace staging gate.
 */
const enabled = process.env.DEVHOTEL_USB_ACCEPTANCE === '1'
const acceptanceDescribe = enabled ? describe : describe.skip

class RecordingAdbHost implements AdbHost {
  readonly calls: { args: string[] }[] = []

  constructor(private readonly inner: AdbHost) {}

  available(): Promise<AdbHostAvailability> {
    return this.inner.available()
  }

  devices(): Promise<AdbDeviceLine[]> {
    return this.inner.devices()
  }

  exec(serial: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.calls.push({ args: [...args] })
    return this.inner.exec(serial, args, opts)
  }

  execBinary(serial: string, args: string[], opts?: { timeoutMs?: number }): Promise<AdbBinaryResult> {
    this.calls.push({ args: [...args] })
    return this.inner.execBinary(serial, args, opts)
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required when DEVHOTEL_USB_ACCEPTANCE=1`)
  return value
}

acceptanceDescribe('real USB Device Broker acceptance', () => {
  const dataDir = enabled ? mkdtempSync(join(tmpdir(), 'devhotel-usb-acceptance-')) : null
  const db = dataDir ? openDb(dataDir) : null

  afterAll(() => {
    db?.close()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  it(
    'serializes two real projects, recovers a dead owner, and leaves both final builds installed',
    async () => {
      const serial = requiredEnv('DEVHOTEL_USB_DEVICE_SERIAL')
      const projectA = {
        apk: requiredEnv('DEVHOTEL_USB_PROJECT_A_APK'),
        packageName: requiredEnv('DEVHOTEL_USB_PROJECT_A_PACKAGE'),
        versionName: requiredEnv('DEVHOTEL_USB_PROJECT_A_VERSION')
      }
      const projectB = {
        apk: requiredEnv('DEVHOTEL_USB_PROJECT_B_APK'),
        packageName: requiredEnv('DEVHOTEL_USB_PROJECT_B_PACKAGE'),
        versionName: requiredEnv('DEVHOTEL_USB_PROJECT_B_VERSION')
      }
      expect(existsSync(projectA.apk)).toBe(true)
      expect(existsSync(projectB.apk)).toBe(true)
      expect(projectA.packageName).not.toBe(projectB.packageName)
      if (!db) throw new Error('USB acceptance database was not initialized')

      const adb = new RecordingAdbHost(new SpawnedAdbHost())
      const now = { value: Date.now() }
      const broker = new AndroidDeviceBroker({
        repo: androidDevicesRepo(db),
        adb,
        now: () => now.value,
        ownerLiveness: (lease) => lease.roomId !== 'aaaa1111',
        graceMs: 0
      })
      await broker.refreshInventory()
      const device = broker.listDevices().find((candidate) => candidate.id === deviceIdForSerial(serial))
      expect(device).toMatchObject({ connection: 'usb', health: 'ready', brokered: true })
      if (!device) throw new Error('requested USB device was not found')

      const first = await broker.requestDevice({
        roomId: 'aaaa1111',
        project: 'AppDied',
        issueRef: '#15',
        runId: 'usb-two-project-proof',
        workerId: 'pid:999999999',
        purpose: 'acceptance',
        ttlMs: 5_000,
        constraints: { deviceId: device.id }
      })
      const second = await broker.requestDevice({
        roomId: 'bbbb2222',
        project: 'MiracleKeyboard',
        issueRef: '#15',
        runId: 'usb-two-project-proof',
        workerId: `pid:${process.pid}`,
        purpose: 'keyboard',
        constraints: { deviceId: device.id }
      })
      expect(first.state).toBe('granted')
      expect(second).toMatchObject({ state: 'queued', position: 1, owner: { roomId: 'aaaa1111', project: 'AppDied' } })
      if (first.state !== 'granted' || second.state !== 'queued') throw new Error('unexpected lease state')

      expect(() => broker.authorize('bbbb2222', device.id, ['install', '-r', projectB.apk])).toThrow(DeviceLeaseError)

      const run = async (roomId: string, args: string[], timeoutMs = 180_000): Promise<ExecResult> => {
        const authorized = broker.authorize(roomId, device.id, args)
        const result = await broker.hostAdb.exec(authorized.serial, args, { timeoutMs })
        if (result.code !== 0) {
          throw new Error(`USB acceptance adb ${args[0] ?? 'command'} failed: ${(result.stderr || result.stdout).trim().slice(-300)}`)
        }
        return result
      }
      const verifyInstalled = async (roomId: string, app: typeof projectA): Promise<void> => {
        const path = await run(roomId, ['shell', 'pm', 'path', app.packageName], 30_000)
        expect(path.stdout).toContain('package:')
        const detail = await run(roomId, ['shell', 'dumpsys', 'package', app.packageName], 30_000)
        expect(/versionName=([^\s]+)/.exec(detail.stdout)?.[1]).toBe(app.versionName)
      }
      const launch = async (roomId: string, packageName: string): Promise<void> => {
        const resolved = await run(
          roomId,
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
            packageName
          ],
          30_000
        )
        const component = resolved.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(line))
        expect(component).toBeTruthy()
        await run(roomId, ['shell', 'am', 'start', '-W', '-n', component!], 60_000)
        const pid = await run(roomId, ['shell', 'pidof', packageName], 30_000)
        expect(pid.stdout.trim()).not.toBe('')
      }

      await run('aaaa1111', ['install', '-r', projectA.apk])
      await verifyInstalled('aaaa1111', projectA)
      await launch('aaaa1111', projectA.packageName)

      // Simulate worker A being killed: its heartbeat expires, liveness is
      // false, and the durable queue must move project B onto the same phone.
      now.value += 5_001
      const recovered = await broker.reap()
      expect(recovered.recovered[0]).toMatchObject({ promoted: { roomId: 'bbbb2222' } })

      await run('bbbb2222', ['install', '-r', projectB.apk])
      await verifyInstalled('bbbb2222', projectA)
      await verifyInstalled('bbbb2222', projectB)
      await launch('bbbb2222', projectB.packageName)
      const secondLease = broker.leaseForRoom('bbbb2222')
      if (!secondLease) throw new Error('queued project was not promoted')
      await broker.release(secondLease.id, 'two-project USB proof complete; final builds preserved')

      expect(broker.listDevices().find((candidate) => candidate.id === device.id)?.leaseOwner).toBeNull()
      expect(broker.status().recentEvents.map((event) => event.kind)).toEqual(
        expect.arrayContaining(['granted', 'queued', 'stale-recovered', 'released'])
      )
      expect(adb.calls.map((call) => call.args.join(' ')).some((command) => /\buninstall\b|\bpm clear\b|\bclear data\b|\brm -rf\b/.test(command))).toBe(false)
    },
    10 * 60_000
  )
})
