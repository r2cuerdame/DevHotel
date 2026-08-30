import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevHotelError, type RoomOrchestrator } from '@devhotel/core'
import type { RoomArtifact } from '@devhotel/shared'
import { startControlApi } from './controlApi'

const roots: string[] = []
const artifactId = '11111111-2222-4333-8444-555555555555'
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const artifact: RoomArtifact = {
  id: artifactId,
  roomId: 'aaaa1111',
  kind: 'android-screenshot',
  filename: 'login-success.png',
  mediaType: 'image/png',
  sizeBytes: png.byteLength,
  sha256: 'a'.repeat(64),
  actor: 'agent',
  createdAt: '2026-08-31T00:00:00.000Z',
  metadata: {
    schema: 1,
    room: { id: 'aaaa1111', stateRevision: 3, workspaceVolumeRevision: 2 },
    capture: {
      source: 'adb',
      capturedAt: '2026-08-31T00:00:00.000Z',
      width: 2,
      height: 3,
      orientation: 'portrait'
    },
    device: { kind: 'emulator', deviceId: null, model: 'Pixel 8', androidVersion: '15', apiLevel: 35 },
    app: { status: 'untracked-or-none', packageName: null },
    locale: { tag: 'en-US', scope: 'system' },
    build: { exact: false, changeId: null, apkSha256: null, installedAt: null },
    association: { changeId: null, runId: null }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('screenshot artifact control API', () => {
  it('captures, lists, retrieves and exports without a JSON base64 payload', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-artifacts-'))
    roots.push(userData)
    const captureAndroidScreenshotArtifact = vi.fn(async () => artifact)
    const listRoomArtifacts = vi.fn(() => [artifact])
    const getRoomArtifact = vi.fn(() => artifact)
    const readRoomArtifactContent = vi.fn(() => ({ artifact, content: png }))
    const exportRoomArtifact = vi.fn(async () => ({
      artifactId,
      path: '/workspace/docs/login-success.png',
      relativePath: 'docs/login-success.png',
      sizeBytes: png.byteLength,
      sha256: artifact.sha256,
      markdown: '![login-success.png](docs/login-success.png)'
    }))
    const control = await startControlApi(
      {
        captureAndroidScreenshotArtifact,
        listRoomArtifacts,
        getRoomArtifact,
        readRoomArtifactContent,
        exportRoomArtifact
      } as unknown as RoomOrchestrator,
      userData,
      'test'
    )
    const headers = {
      authorization: `Bearer ${control.info.token}`,
      'content-type': 'application/json'
    }
    const base = `http://127.0.0.1:${control.info.port}/v1/rooms/aaaa1111/artifacts`
    try {
      const captured = await fetch(`${base}/screenshots`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: 'login-success.png', mode: 'auto' })
      })
      expect(captured.status).toBe(201)
      await expect(captured.json()).resolves.toMatchObject({ id: artifactId, filename: 'login-success.png' })
      expect(captureAndroidScreenshotArtifact).toHaveBeenCalledWith(
        'aaaa1111',
        { filename: 'login-success.png', mode: 'auto' },
        'agent'
      )

      await expect((await fetch(`${base}?limit=5`, { headers })).json()).resolves.toEqual({ artifacts: [artifact] })
      expect(listRoomArtifacts).toHaveBeenCalledWith('aaaa1111', 5)

      const content = await fetch(`${base}/${artifactId}/content`, { headers })
      expect(content.status).toBe(200)
      expect(content.headers.get('content-type')).toBe('image/png')
      expect(content.headers.get('cache-control')).toBe('private, no-store')
      expect(content.headers.get('x-content-type-options')).toBe('nosniff')
      expect(content.headers.get('x-devhotel-sha256')).toBe(artifact.sha256)
      expect(Buffer.from(await content.arrayBuffer())).toEqual(png)

      const exported = await fetch(`${base}/${artifactId}/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ relativePath: 'docs/login-success.png' })
      })
      await expect(exported.json()).resolves.toMatchObject({
        markdown: '![login-success.png](docs/login-success.png)'
      })
      expect(exportRoomArtifact).toHaveBeenCalledWith(
        'aaaa1111',
        artifactId,
        { relativePath: 'docs/login-success.png' },
        'agent'
      )
    } finally {
      control.stop()
    }
  })

  it('keeps artifact IDs Room-scoped and rejects oversized JSON before capture', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-artifact-isolation-'))
    roots.push(userData)
    const captureAndroidScreenshotArtifact = vi.fn()
    const getRoomArtifact = vi.fn((roomId: string) => {
      if (roomId !== artifact.roomId) {
        throw new DevHotelError('ARTIFACT_NOT_FOUND', 'Screenshot artifact not found in this Room.', {
          httpStatus: 404
        })
      }
      return artifact
    })
    const control = await startControlApi(
      { captureAndroidScreenshotArtifact, getRoomArtifact } as unknown as RoomOrchestrator,
      userData,
      'test'
    )
    const headers = {
      authorization: `Bearer ${control.info.token}`,
      'content-type': 'application/json'
    }
    try {
      const crossed = await fetch(
        `http://127.0.0.1:${control.info.port}/v1/rooms/bbbb2222/artifacts/${artifactId}`,
        { headers }
      )
      expect(crossed.status).toBe(404)
      expect(getRoomArtifact).toHaveBeenCalledWith('bbbb2222', artifactId)

      const oversized = await fetch(
        `http://127.0.0.1:${control.info.port}/v1/rooms/aaaa1111/artifacts/screenshots`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: 'shot.png', padding: 'x'.repeat(70 * 1024) })
        }
      )
      expect(oversized.status).toBe(413)
      await expect(oversized.json()).resolves.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' })
      expect(captureAndroidScreenshotArtifact).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })
})
