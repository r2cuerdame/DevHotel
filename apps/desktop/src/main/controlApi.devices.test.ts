import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
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
      devices: [{ id: 'd0123456789a', nickname: 'Pixel-USB-01', queueDepth: 2, leaseOwner: { project: 'AppDied' } }],
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

  it('surfaces a refused ADB command as an error rather than a silent success', async () => {
    const adbOnDevice = vi.fn(async () => {
      throw new Error('installing an APK needs a device lease. Attach Pixel-USB-01 to Room room1abc first.')
    })

    await withApi({ adbOnDevice } as unknown as Partial<RoomOrchestrator>, async (call) => {
      const result = await call('/v1/rooms/room1abc/device/adb', {
        method: 'POST',
        body: JSON.stringify({ args: ['install', '-r', '/workspace/app.apk'] })
      })

      expect(result.status).toBe(500)
      expect(result.body.error).toMatch(/needs a device lease/)
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
})
