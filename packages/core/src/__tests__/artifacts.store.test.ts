import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCREENSHOT_ARTIFACT_MAX_PER_ROOM,
  type AndroidScreenshotArtifactMetadata
} from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomArtifactStore } from '../artifacts/store'
import { artifactsRepo } from '../store/artifactsRepo'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { makeRoom, tempDir } from './fakes'
import { screenshotPng } from './pngFixture'

const roots: string[] = []
const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function metadata(roomId: string, overrides: Partial<AndroidScreenshotArtifactMetadata> = {}): AndroidScreenshotArtifactMetadata {
  return {
    schema: 1,
    room: { id: roomId, stateRevision: 3, workspaceVolumeRevision: 2 },
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
    association: { changeId: null, runId: null },
    ...overrides
  }
}

function setup() {
  const userData = tempDir()
  roots.push(userData)
  const db = openDb(join(userData, 'db'))
  dbs.push(db)
  const rooms = roomsRepo(db)
  for (const id of ['aaaa1111', 'bbbb2222']) {
    rooms.create(
      makeRoom({
        id,
        domain: `${id}.dev.localhost`,
        sourceType: 'managed-git',
        sourceRef: `https://example.invalid/${id}.git`,
        workspaceMode: 'hotel'
      })
    )
  }
  const repo = artifactsRepo(db)
  return { userData, db, rooms, repo, store: new RoomArtifactStore(userData, repo) }
}

describe('Room screenshot artifact store', () => {
  it('publishes immutable content and lists it only in its owning Room', () => {
    const { store, userData } = setup()
    const artifact = store.publishScreenshot({
      roomId: 'aaaa1111',
      filename: 'login-success.png',
      png: screenshotPng(2, 3, { text: 'Bearer super-secret-token-value' }),
      actor: 'agent',
      createdAt: '2026-08-31T00:00:00.000Z',
      metadata: metadata('aaaa1111', {
        device: {
          kind: 'emulator',
          deviceId: null,
          model: 'Bearer super-secret-token-value',
          androidVersion: '15',
          apiLevel: 35
        }
      })
    })

    expect(store.list('aaaa1111')).toEqual([artifact])
    expect(store.list('bbbb2222')).toEqual([])
    expect(store.get('bbbb2222', artifact.id)).toBeNull()
    expect(() => store.readContent('bbbb2222', artifact.id)).toThrow(/not found in this Room/)
    expect(artifact.metadata.device.model).not.toContain('super-secret')

    const { content } = store.readContent('aaaa1111', artifact.id)
    expect(content.toString('utf8')).not.toContain('super-secret')
    expect(readdirSync(join(userData, 'rooms', 'aaaa1111', 'artifacts', 'screenshots', artifact.id)).sort()).toEqual([
      'content.png',
      'receipt.json'
    ])
  })

  it('refuses tampered content instead of serving it', () => {
    const { store, userData } = setup()
    const artifact = store.publishScreenshot({
      roomId: 'aaaa1111',
      filename: 'before-tamper.png',
      png: screenshotPng(),
      actor: 'agent',
      createdAt: '2026-08-31T00:00:00.000Z',
      metadata: metadata('aaaa1111')
    })
    const path = join(userData, 'rooms', 'aaaa1111', 'artifacts', 'screenshots', artifact.id, 'content.png')
    const replacement = Buffer.alloc(artifact.sizeBytes, 0x41)
    writeFileSync(path, replacement)

    expect(() => store.readContent('aaaa1111', artifact.id)).toThrow(/checksum/)
  })

  it('rolls filesystem publication back when the database insert fails', () => {
    const { store, db, userData } = setup()
    db.sqlite.exec(`
      CREATE TRIGGER refuse_artifact_insert BEFORE INSERT ON room_artifacts
      BEGIN SELECT RAISE(ABORT, 'test refusal'); END;
    `)

    expect(() =>
      store.publishScreenshot({
        roomId: 'aaaa1111',
        filename: 'rolled-back.png',
        png: screenshotPng(),
        actor: 'agent',
        createdAt: '2026-08-31T00:00:00.000Z',
        metadata: metadata('aaaa1111')
      })
    ).toThrow(/test refusal/)
    expect(readdirSync(join(userData, 'rooms', 'aaaa1111', 'artifacts', 'screenshots'))).toEqual([])
  })

  it('refuses the Room quota before creating artifact storage', () => {
    const { store, repo, userData } = setup()
    repo.usageForRoom = () => ({ count: SCREENSHOT_ARTIFACT_MAX_PER_ROOM, bytes: 0 })

    expect(() =>
      store.publishScreenshot({
        roomId: 'aaaa1111',
        filename: 'over-quota.png',
        png: screenshotPng(),
        actor: 'agent',
        createdAt: '2026-08-31T00:00:00.000Z',
        metadata: metadata('aaaa1111')
      })
    ).toThrow(/quota reached/)
    expect(existsSync(join(userData, 'rooms', 'aaaa1111', 'artifacts'))).toBe(false)
  })

  it('cleans crash leftovers but never traverses into other artifact families', () => {
    const { store, userData } = setup()
    const artifact = store.publishScreenshot({
      roomId: 'aaaa1111',
      filename: 'kept.png',
      png: screenshotPng(),
      actor: 'agent',
      createdAt: '2026-08-31T00:00:00.000Z',
      metadata: metadata('aaaa1111')
    })
    const screenshotRoot = join(userData, 'rooms', 'aaaa1111', 'artifacts', 'screenshots')
    const orphan = '11111111-2222-4333-8444-555555555555'
    mkdirSync(join(screenshotRoot, orphan))
    mkdirSync(join(screenshotRoot, `.tmp-${orphan}`))
    const buildArtifact = join(userData, 'rooms', 'aaaa1111', 'artifacts', 'android-build-change')
    mkdirSync(buildArtifact)

    store.reconcileRoom('aaaa1111')

    expect(readdirSync(screenshotRoot)).toEqual([artifact.id])
    expect(readdirSync(join(userData, 'rooms', 'aaaa1111', 'artifacts'))).toContain('android-build-change')
  })

  it('refuses a tampered Room storage link instead of writing outside Hotel data', () => {
    const { store, userData } = setup()
    const outside = tempDir()
    roots.push(outside)
    const roomRoot = join(userData, 'rooms', 'aaaa1111')
    mkdirSync(join(userData, 'rooms'), { recursive: true })
    rmSync(roomRoot, { recursive: true, force: true })
    symlinkSync(outside, roomRoot, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() =>
      store.publishScreenshot({
        roomId: 'aaaa1111',
        filename: 'escaped.png',
        png: screenshotPng(),
        actor: 'agent',
        createdAt: '2026-08-31T00:00:00.000Z',
        metadata: metadata('aaaa1111')
      })
    ).toThrow(/unsafe directory|escaped Hotel data/)
    expect(existsSync(join(outside, 'artifacts'))).toBe(false)
  })
})
