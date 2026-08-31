import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceLeaseError, zRoomId } from '@devhotel/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevHotelError, type RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function withApi(
  orch: Partial<RoomOrchestrator>,
  run: (call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>) => Promise<void>
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-devices-'))
  roots.push(userData)
  const control = await startControlApi(orch as RoomOrchestrator, userData, 'test')
  try {
    await run(async (path, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${control.info.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${control.info.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {})
        }
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    })
  } finally {
    control.stop()
  }
}

describe('agents reach the shared phone only through the broker', () => {
  it('lists devices, owners and queue without naming a Room', async () => {
    const androidDeviceStatus = vi.fn(() => ({
      available: true,
      detail: 'adb 35.0.0',
      devices: [{ id: 'd0123456789abcdef0123456789abcdef', nickname: 'Pixel-USB-01', queueDepth: 2, leaseOwner: { project: 'AppDied' } }],
      recentEvents: []
    }))

    await withApi({ androidDeviceStatus } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/devices')
      expect(result.status).toBe(200)
      expect(result.body.devices[0]).toMatchObject({ nickname: 'Pixel-USB-01', queueDepth: 2 })
    })
  })

  it('attaches a device to the Room named by the route', async () => {
    const attachAndroidDevice = vi.fn(async () => ({ state: 'granted', lease: { id: 'lease-1' }, device: { nickname: 'Pixel-USB-01' } }))

    await withApi({ attachAndroidDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/attach', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'acceptance', workerId: 'agent-session-1' })
      })

      expect(result.status).toBe(200)
      expect(result.body.state).toBe('granted')
      expect(attachAndroidDevice).toHaveBeenCalledWith('room1abc', { purpose: 'acceptance', workerId: 'agent-session-1' })
    })
  })

  it('refuses an attach that tries to book the phone under another project', async () => {
    const attachAndroidDevice = vi.fn()

    await withApi({ attachAndroidDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      // The lease's project identifies who is holding the phone in everyone
      // else's queue view, so it comes from the Room, never from the caller.
      const result = await call('/v1/rooms/room1abc/device/attach', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'acceptance', workerId: 'agent-session-1', project: 'spoofed' })
      })

      expect(result.status).toBe(500)
      expect(attachAndroidDevice).not.toHaveBeenCalled()
    })
  })

  it('rejects an attach body that is not a valid device request', async () => {
    const attachAndroidDevice = vi.fn()

    await withApi({ attachAndroidDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/attach', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'not-a-purpose', workerId: 'agent-session-1' })
      })

      expect(result.status).toBe(500)
      expect(attachAndroidDevice).not.toHaveBeenCalled()
    })
  })

  it('releases the Room device', async () => {
    const releaseAndroidDevice = vi.fn(async () => ({ id: 'lease-1' }))

    await withApi({ releaseAndroidDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/release', { method: 'POST', body: JSON.stringify({ reason: 'done' }) })

      expect(result.status).toBe(200)
      expect(releaseAndroidDevice).toHaveBeenCalledWith('room1abc', 'done')
    })
  })

  it('passes an ADB command through the Room, so the broker decides whether it runs', async () => {
    const adbOnDevice = vi.fn(async () => ({ code: 0, stdout: 'Success', stderr: '' }))

    await withApi({ adbOnDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/adb', {
        method: 'POST',
        body: JSON.stringify({ args: ['install', '-r', '/workspace/app.apk'] })
      })

      expect(result.status).toBe(200)
      expect(result.body.stdout).toBe('Success')
      expect(adbOnDevice).toHaveBeenCalledWith('room1abc', ['install', '-r', '/workspace/app.apk'], { timeoutMs: undefined })
    })
  })

  it('preserves the broker denial code in a structured conflict response', async () => {
    const adbOnDevice = vi.fn(async () => {
      throw new DeviceLeaseError('no-lease', 'installing an APK needs a device lease. Attach Pixel-USB-01 to Room room1abc first.')
    })

    await withApi({ adbOnDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/adb', {
        method: 'POST',
        body: JSON.stringify({ args: ['install', '-r', '/workspace/app.apk'] })
      })

      expect(result.status).toBe(409)
      expect(result.body.error).toMatch(/needs a device lease/)
      expect(result.body.code).toBe('no-lease')
    })
  })

  it('heartbeats and cancels a queued request', async () => {
    const heartbeatAndroidDevice = vi.fn(() => ({ id: 'lease-1' }))
    const cancelAndroidDeviceRequest = vi.fn(() => ({ id: 'req-1', state: 'cancelled' }))

    await withApi({ heartbeatAndroidDevice, cancelAndroidDeviceRequest } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const beat = await call('/v1/devices/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ leaseId: '2f1b0f9c-1111-4222-8333-444455556666', busy: true })
      })
      const cancel = await call('/v1/devices/cancel', {
        method: 'POST',
        body: JSON.stringify({ requestId: '2f1b0f9c-1111-4222-8333-444455556667' })
      })

      expect(beat.status).toBe(200)
      expect(heartbeatAndroidDevice).toHaveBeenCalledWith('2f1b0f9c-1111-4222-8333-444455556666', { busy: true })
      expect(cancel.status).toBe(200)
      expect(cancelAndroidDeviceRequest).toHaveBeenCalledWith('2f1b0f9c-1111-4222-8333-444455556667')
    })
  })

  it('still refuses every device route without the bearer token', async () => {
    const androidDeviceStatus = vi.fn()
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-devices-auth-'))
    roots.push(userData)
    const control = await startControlApi({ androidDeviceStatus } as unknown as RoomOrchestrator, userData, 'test')
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/devices`)
      expect(response.status).toBe(401)
      expect(androidDeviceStatus).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })

  it('has no agent pairing route and never forwards endpoint or code input', async () => {
    const pairCandidate = vi.fn()

    await withApi({ pairCandidate } as unknown as Partial<RoomOrchestrator>, async (call) => {
      for (const method of ['GET', 'POST'] as const) {
        const result = await call('/v1/devices/pairing', {
          method,
          ...(method === 'POST'
            ? { body: JSON.stringify({ endpoint: '192.0.2.99:38999', pairingCode: '481516' }) }
            : {})
        })
        expect(result.status).toBe(404)
      }
      expect(pairCandidate).not.toHaveBeenCalled()
    })
  })

  it('redacts structured pairing material at the final Control API boundary', async () => {
    const androidDeviceStatus = vi.fn(() => ({
      available: false,
      detail: 'pairing endpoint: 192.0.2.77:37777 pairing code: 112358',
      pairingCode: 112358,
      pairing_endpoint: '192.0.2.77:37777',
      ordinaryPort: 7385,
      devices: [],
      recentEvents: []
    }))

    await withApi({ androidDeviceStatus } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/devices')
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({
        pairingCode: '•••',
        pairing_endpoint: '•••',
        ordinaryPort: 7385
      })
      expect(JSON.stringify(result.body)).not.toMatch(/112358|192\.0\.2\.77|37777/)
    })
  })

  it('preserves opaque screenshot bytes at the final Control API boundary', async () => {
    const encodedPng = 'AKIAABCDEFGHIJKLMNOP'
    const androidScreenshot = vi.fn(async () => ({ png: encodedPng, source: 'adb' as const }))

    await withApi({ androidScreenshot } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/screenshot')
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ png: encodedPng, source: 'adb' })
    })
  })
})

describe('agent Android automation routes', () => {
  it('parses explicit opaque targets and forwards strict high-level operations', async () => {
    const androidAutomationStatus = vi.fn(async () => ({ installedApplicationIds: ['com.example.app'] }))
    const androidLaunchApp = vi.fn(async () => ({ applicationId: 'com.example.app', component: 'com.example.app/.Main' }))
    const androidDumpUi = vi.fn(async () => ({ nodes: [] }))

    await withApi(
      { androidAutomationStatus, androidLaunchApp, androidDumpUi } as unknown as Partial<RoomOrchestrator>,
      async (call) => {
        const deviceId = `d${'a'.repeat(32)}`
        const status = await call(`/v1/rooms/room1abc/android/status?target=physical&deviceId=${deviceId}`)
        const launch = await call('/v1/rooms/room1abc/android/launch', {
          method: 'POST',
          body: JSON.stringify({
            applicationId: 'com.example.app',
            activity: '.MainActivity',
            extras: { retries: 2 },
            target: { kind: 'emulator' }
          })
        })
        const dump = await call('/v1/rooms/room1abc/android/dump-ui', {
          method: 'POST',
          body: JSON.stringify({ applicationId: 'com.example.app', filter: 'Crash', maxNodes: 10 })
        })

        expect(status.status).toBe(200)
        expect(androidAutomationStatus).toHaveBeenCalledWith('room1abc', { kind: 'physical', deviceId })
        expect(launch.status).toBe(200)
        expect(androidLaunchApp).toHaveBeenCalledWith('room1abc', {
          applicationId: 'com.example.app', activity: '.MainActivity', extras: { retries: 2 }, target: { kind: 'emulator' }
        })
        expect(dump.status).toBe(200)
        expect(androidDumpUi).toHaveBeenCalledWith('room1abc', {
          applicationId: 'com.example.app', filter: 'Crash', maxNodes: 10
        })
      }
    )
  })

  it('refuses raw serial fields and oversized automation bodies before Core', async () => {
    const androidTapText = vi.fn()
    const androidAutomationStatus = vi.fn()
    await withApi({ androidTapText, androidAutomationStatus } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const serial = await call('/v1/rooms/room1abc/android/tap-text', {
        method: 'POST',
        body: JSON.stringify({ applicationId: 'com.example.app', text: 'Crash', serial: 'R5CT30ABCDE' })
      })
      const querySerial = await call('/v1/rooms/room1abc/android/status?target=physical&serial=R5CT30ABCDE')
      const oversized = await call('/v1/rooms/room1abc/android/tap-text', {
        method: 'POST',
        body: JSON.stringify({ applicationId: 'com.example.app', text: 'x'.repeat(70_000) })
      })

      expect(serial).toMatchObject({ status: 400, body: { code: 'INVALID_ANDROID_REQUEST' } })
      expect(querySerial).toMatchObject({ status: 400, body: { code: 'INVALID_ANDROID_TARGET' } })
      expect(oversized.status).toBe(413)
      expect(oversized.body).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' })
      expect(androidTapText).not.toHaveBeenCalled()
      expect(androidAutomationStatus).not.toHaveBeenCalled()
    })
  })

  it('returns sanitized 400s for invalid Android path, target and device selectors', async () => {
    const androidAutomationStatus = vi.fn()
    await withApi({ androidAutomationStatus } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const invalidRoom = await call('/v1/rooms/not-a-room/android/status')
      const invalidTarget = await call('/v1/rooms/room1abc/android/status?target=tablet')
      const invalidDevice = await call('/v1/rooms/room1abc/android/status?target=physical&deviceId=R5CT30ABCDE')

      expect(invalidRoom).toMatchObject({ status: 400, body: { code: 'INVALID_ROOM_ID' } })
      expect(invalidTarget).toMatchObject({ status: 400, body: { code: 'INVALID_ANDROID_TARGET' } })
      expect(invalidDevice).toMatchObject({ status: 400, body: { code: 'INVALID_ANDROID_TARGET' } })
      for (const result of [invalidRoom, invalidTarget, invalidDevice]) {
        expect(JSON.stringify(result.body)).not.toMatch(/not-a-room|tablet|R5CT30ABCDE|issues/i)
      }
      expect(androidAutomationStatus).not.toHaveBeenCalled()
    })
  })

  it.each([
    ['launch', { applicationId: 'com.example.app', unknown: 'private-value' }],
    ['force-stop', { applicationId: 'invalid' }],
    ['wait-for-text', { applicationId: 'com.example.app', text: 'Crash', timeoutMs: 249 }],
    ['tap-text', { applicationId: 'com.example.app', text: '' }],
    ['dump-ui', { applicationId: 'com.example.app', maxNodes: 501 }],
    ['logcat', { applicationId: 'com.example.app', maxLines: 0 }],
    ['crash-scenario', { applicationId: 'com.example.app', scenario: 'am-crash', runId: '' }],
    ['locale-matrix', {
      applicationId: 'com.example.app', locales: ['en-US', 'EN-us'], filenamePrefix: 'release'
    }],
    ['locale-recovery-abandon', {
      applicationId: 'com.example.app', acknowledgeOutsideLocale: false
    }]
  ])('returns a sanitized 400 before Core for an invalid %s body', async (action, body) => {
    const orchestratorCalls = {
      androidLaunchApp: vi.fn(),
      androidForceStop: vi.fn(),
      androidWaitForText: vi.fn(),
      androidTapText: vi.fn(),
      androidDumpUi: vi.fn(),
      androidLogcat: vi.fn(),
      androidRunCrashScenario: vi.fn(),
      androidLocaleScreenshotMatrix: vi.fn(),
      abandonAndroidLocaleMatrixRecovery: vi.fn()
    }
    await withApi(orchestratorCalls as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call(`/v1/rooms/room1abc/android/${action}`, {
        method: 'POST',
        body: JSON.stringify(body)
      })

      expect(result).toMatchObject({
        status: 400,
        body: {
          code: 'INVALID_ANDROID_REQUEST',
          error: 'Android automation request fields are invalid.'
        }
      })
      expect(JSON.stringify(result.body)).not.toMatch(/private-value|issues/i)
      expect(Object.values(orchestratorCalls).every((call) => call.mock.calls.length === 0)).toBe(true)
    })
  })

  it('returns a sanitized 400 for malformed JSON without reclassifying internal exceptions', async () => {
    const androidLaunchApp = vi.fn(async () => {
      throw new TypeError('internal launch invariant')
    })
    const androidForceStop = vi.fn(async () => {
      zRoomId.parse('internal-invalid-room')
    })
    await withApi({ androidLaunchApp, androidForceStop } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const malformed = await call('/v1/rooms/room1abc/android/launch', {
        method: 'POST',
        body: '{"applicationId":"secret-value"'
      })
      const internal = await call('/v1/rooms/room1abc/android/launch', {
        method: 'POST',
        body: JSON.stringify({ applicationId: 'com.example.app' })
      })
      const internalZod = await call('/v1/rooms/room1abc/android/force-stop', {
        method: 'POST',
        body: JSON.stringify({ applicationId: 'com.example.app' })
      })

      expect(malformed).toMatchObject({
        status: 400,
        body: { code: 'INVALID_JSON_BODY', error: 'Request body is not valid JSON.' }
      })
      expect(JSON.stringify(malformed.body)).not.toMatch(/secret-value|SyntaxError|position/i)
      expect(internal).toMatchObject({ status: 500, body: { error: 'internal launch invariant' } })
      expect(internalZod.status).toBe(500)
      expect(androidLaunchApp).toHaveBeenCalledTimes(1)
      expect(androidForceStop).toHaveBeenCalledTimes(1)
    })
  })

  it('preserves bounded automation evidence in a structured Core error', async () => {
    const androidForceStop = vi.fn(async () => {
      throw new DevHotelError('ANDROID_FORCE_STOP_FAILED', 'The tracked app could not be stopped.', {
        httpStatus: 409,
        recoveryHint: 'Retry on the selected target.',
        evidence: { code: 1, stdout: '', stderr: 'permission denied', truncated: false }
      })
    })

    await withApi({ androidForceStop } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/android/force-stop', {
        method: 'POST',
        body: JSON.stringify({ applicationId: 'com.example.app' })
      })

      expect(result).toMatchObject({
        status: 409,
        body: {
          code: 'ANDROID_FORCE_STOP_FAILED',
          recoveryHint: 'Retry on the selected target.',
          evidence: { code: 1, stderr: 'permission denied', truncated: false }
        }
      })
    })
  })

  it('forwards one strict canonical locale matrix body to Core', async () => {
    const androidLocaleScreenshotMatrix = vi.fn(async (
      _roomId: string,
      input: { applicationId: string }
    ) => ({
      applicationId: input.applicationId,
      apiLevel: 34,
      scope: 'app',
      entries: [],
      restoration: { localeTags: ['en-US'] }
    }))
    await withApi({ androidLocaleScreenshotMatrix } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/android/locale-matrix', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: 'com.example.app',
          locales: ['ko-kr', 'EN-us'],
          filenamePrefix: 'release-42',
          readinessTimeoutMs: 30_000
        })
      })

      expect(result.status).toBe(200)
      expect(androidLocaleScreenshotMatrix).toHaveBeenCalledWith('room1abc', {
        applicationId: 'com.example.app',
        locales: ['ko-KR', 'en-US'],
        filenamePrefix: 'release-42',
        readinessTimeoutMs: 30_000
      }, 'agent')
    })
  })

  it('forwards only an explicit literal locale-recovery acknowledgement to Core', async () => {
    const abandonAndroidLocaleMatrixRecovery = vi.fn(async (
      _roomId: string,
      input: { applicationId: string }
    ) => ({
      abandoned: true as const,
      applicationId: input.applicationId,
      target: { kind: 'emulator' as const, deviceId: null }
    }))
    await withApi({ abandonAndroidLocaleMatrixRecovery } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/android/locale-recovery-abandon', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: 'com.example.app',
          acknowledgeOutsideLocale: true
        })
      })

      expect(result).toMatchObject({ status: 200, body: { abandoned: true } })
      expect(abandonAndroidLocaleMatrixRecovery).toHaveBeenCalledWith('room1abc', {
        applicationId: 'com.example.app',
        acknowledgeOutsideLocale: true
      })
    })
  })
})
