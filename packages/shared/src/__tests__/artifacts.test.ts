import { describe, expect, it } from 'vitest'
import {
  zAndroidScreenshotArtifactMetadata,
  zArtifactExportBody,
  zArtifactFilename,
  zCaptureScreenshotArtifactBody
} from '../artifacts'

const baseMetadata = {
  schema: 1 as const,
  room: { id: 'aaaa1111', stateRevision: 3, workspaceVolumeRevision: 2 },
  capture: {
    source: 'adb' as const,
    capturedAt: '2026-08-31T00:00:00.000Z',
    width: 1080,
    height: 1920,
    orientation: 'portrait' as const
  },
  device: {
    kind: 'emulator' as const,
    deviceId: null,
    model: 'Pixel 8',
    androidVersion: '15',
    apiLevel: 35
  },
  app: { status: 'tracked-active' as const, packageName: 'com.example.app' },
  locale: { tag: 'en-US', scope: 'system' as const },
  build: {
    exact: true as const,
    changeId: '11111111-2222-4333-8444-555555555555',
    apkSha256: 'a'.repeat(64),
    installedAt: '2026-08-30T00:00:00.000Z'
  },
  association: { changeId: null, runId: null }
}

describe('screenshot artifact schemas', () => {
  it('requires an explicit portable PNG filename', () => {
    expect(zCaptureScreenshotArtifactBody.safeParse({}).success).toBe(false)
    expect(zArtifactFilename.parse('login-success.png')).toBe('login-success.png')
    for (const filename of ['../shot.png', 'folder/shot.png', 'CON.png', 'shot.jpg', ' space.png']) {
      expect(zArtifactFilename.safeParse(filename).success).toBe(false)
    }
  })

  it('allows only a safe repo-relative PNG export path', () => {
    expect(zArtifactExportBody.parse({ relativePath: 'docs/evidence/login-success.png' })).toEqual({
      relativePath: 'docs/evidence/login-success.png'
    })
    for (const relativePath of [
      '/workspace/shot.png',
      '../shot.png',
      'docs\\shot.png',
      '.git/evidence.png',
      'CON/evidence.png',
      'docs//shot.png',
      'docs/shot.jpg',
      'docs/.devhotel-artifact-staging/shot.png'
    ]) {
      expect(zArtifactExportBody.safeParse({ relativePath }).success).toBe(false)
    }
  })

  it('requires a complete exact build identity for a tracked package', () => {
    expect(zAndroidScreenshotArtifactMetadata.parse(baseMetadata)).toEqual(baseMetadata)
    expect(
      zAndroidScreenshotArtifactMetadata.safeParse({
        ...baseMetadata,
        app: { status: 'untracked-or-none', packageName: null },
        build: { exact: false, changeId: null, apkSha256: null, installedAt: null }
      }).success
    ).toBe(false)
    expect(
      zAndroidScreenshotArtifactMetadata.safeParse({
        ...baseMetadata,
        build: {
          exact: true,
          changeId: '11111111-2222-4333-8444-555555555555',
          apkSha256: null,
          installedAt: '2026-08-30T00:00:00.000Z'
        }
      }).success
    ).toBe(false)
  })
})
