import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  SCREENSHOT_ARTIFACT_MAX_BYTES,
  SCREENSHOT_ARTIFACT_MAX_PER_ROOM,
  SCREENSHOT_ARTIFACT_MAX_ROOM_BYTES,
  zAndroidScreenshotArtifactMetadata,
  zArtifactFilename,
  zArtifactId,
  zRoomArtifact,
  type Actor,
  type AndroidScreenshotArtifactMetadata,
  type RoomArtifact
} from '@devhotel/shared'
import { redactStructuredSecrets } from '../diagnostics/redact'
import type { ArtifactsRepo } from '../store/artifactsRepo'
import { validateAndSanitizeScreenshotPng } from './png'

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TEMP_DIR = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeDurableExclusive(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) throw new Error('Artifact write made no progress')
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  // Windows does not permit opening directories this way; its rename is still
  // atomic. POSIX directory fsync closes the crash window for the new entry.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

export interface PublishScreenshotInput {
  roomId: string
  filename: string
  png: Uint8Array
  actor: Actor
  createdAt: string
  metadata: AndroidScreenshotArtifactMetadata
}

/** Immutable, Room-scoped screenshot content and its durable SQLite receipt. */
export class RoomArtifactStore {
  constructor(
    private readonly userData: string,
    private readonly repo: ArtifactsRepo
  ) {}

  publishScreenshot(input: PublishScreenshotInput): RoomArtifact {
    const filename = zArtifactFilename.parse(input.filename)
    const validated = validateAndSanitizeScreenshotPng(input.png)
    const metadata = zAndroidScreenshotArtifactMetadata.parse(redactStructuredSecrets(input.metadata))
    if (
      metadata.room.id !== input.roomId ||
      metadata.capture.capturedAt !== input.createdAt ||
      metadata.capture.width !== validated.width ||
      metadata.capture.height !== validated.height ||
      metadata.capture.orientation !== validated.orientation
    ) {
      throw new Error('Screenshot metadata does not match the captured PNG or Room')
    }

    const usage = this.repo.usageForRoom(input.roomId)
    if (
      usage.count >= SCREENSHOT_ARTIFACT_MAX_PER_ROOM ||
      usage.bytes + validated.png.byteLength > SCREENSHOT_ARTIFACT_MAX_ROOM_BYTES
    ) {
      throw new Error(
        `Room screenshot artifact quota reached (${SCREENSHOT_ARTIFACT_MAX_PER_ROOM} files / ` +
          `${SCREENSHOT_ARTIFACT_MAX_ROOM_BYTES} bytes)`
      )
    }

    const id = randomUUID()
    const record = zRoomArtifact.parse(
      redactStructuredSecrets({
        id,
        roomId: input.roomId,
        kind: 'android-screenshot',
        filename,
        mediaType: 'image/png',
        sizeBytes: validated.png.byteLength,
        sha256: sha256(validated.png),
        actor: input.actor,
        createdAt: input.createdAt,
        metadata
      })
    )
    const root = this.ensureRoot(input.roomId)
    const temporary = join(root, `.tmp-${id}`)
    const final = join(root, id)
    if (existsSync(temporary) || existsSync(final)) throw new Error('Screenshot artifact ID collision')
    mkdirSync(temporary, { recursive: false, mode: 0o700 })
    let published = false
    try {
      writeDurableExclusive(join(temporary, 'content.png'), validated.png)
      writeDurableExclusive(join(temporary, 'receipt.json'), Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'))
      syncDirectory(temporary)
      renameSync(temporary, final)
      syncDirectory(root)
      published = true
      try {
        return this.repo.insert({
          id: record.id,
          roomId: record.roomId,
          filename: record.filename,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
          actor: record.actor,
          createdAt: record.createdAt,
          metadata: record.metadata
        })
      } catch (error) {
        rmSync(final, { recursive: true, force: true })
        syncDirectory(root)
        throw error
      }
    } finally {
      if (!published && existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
    }
  }

  list(roomId: string, limit = 20): RoomArtifact[] {
    return this.repo.listForRoom(roomId, limit)
  }

  get(roomId: string, artifactId: string): RoomArtifact | null {
    return this.repo.getForRoom(roomId, zArtifactId.parse(artifactId))
  }

  readContent(roomId: string, artifactId: string): { artifact: RoomArtifact; content: Buffer } {
    const id = zArtifactId.parse(artifactId)
    const artifact = this.repo.getForRoom(roomId, id)
    if (!artifact) throw new Error('Screenshot artifact not found in this Room')
    const root = this.ensureRoot(roomId)
    const directory = join(root, id)
    const contentPath = join(directory, 'content.png')
    const receiptPath = join(directory, 'receipt.json')
    let canonicalDirectory: string
    try {
      const directoryStat = lstatSync(directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('artifact directory is not regular')
      canonicalDirectory = realpathSync.native(directory)
      if (!isInside(realpathSync.native(root), canonicalDirectory)) throw new Error('artifact directory escaped its Room root')
    } catch (error) {
      throw new Error(`Screenshot artifact storage is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      for (const path of [contentPath, receiptPath]) {
        const file = lstatSync(path)
        const canonical = realpathSync.native(path)
        if (!file.isFile() || file.isSymbolicLink() || !isInside(canonicalDirectory, canonical)) {
          throw new Error('artifact storage contains an escaped or non-regular file')
        }
      }
    } catch (error) {
      throw new Error(`Screenshot artifact storage is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
    const stats = statSync(contentPath)
    if (stats.size < 1 || stats.size > SCREENSHOT_ARTIFACT_MAX_BYTES || stats.size !== artifact.sizeBytes) {
      throw new Error('Screenshot artifact size does not match its receipt')
    }
    const content = readFileSync(contentPath)
    if (sha256(content) !== artifact.sha256) throw new Error('Screenshot artifact checksum does not match its receipt')
    // Re-parse the immutable receipt instead of trusting local disk text.
    const receiptStats = statSync(receiptPath)
    if (receiptStats.size < 2 || receiptStats.size > 64 * 1024) throw new Error('Screenshot artifact receipt is not bounded')
    let receipt: RoomArtifact
    try {
      receipt = zRoomArtifact.parse(JSON.parse(readFileSync(receiptPath, 'utf8')))
    } catch {
      throw new Error('Screenshot artifact receipt is invalid')
    }
    if (!isDeepStrictEqual(receipt, artifact)) throw new Error('Screenshot artifact receipt does not match the database')
    // Validation on read catches local tampering that preserved size/hash metadata.
    const validated = validateAndSanitizeScreenshotPng(content)
    if (!validated.png.equals(content)) throw new Error('Screenshot artifact is not canonical')
    return { artifact, content }
  }

  /** Remove crash leftovers that were never made visible by a DB receipt. */
  reconcileRoom(roomId: string): void {
    const root = this.ensureRoot(roomId)
    const known = this.repo.idsForRoom(roomId)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (TEMP_DIR.test(entry.name) || (UUID_DIR.test(entry.name) && !known.has(entry.name))) {
        rmSync(join(root, entry.name), { recursive: true, force: true })
      }
    }
  }

  private ensureRoot(roomId: string): string {
    if (!/^[a-z0-9]{8}$/.test(roomId)) throw new Error('invalid Room ID')
    const userDataRoot = resolve(this.userData)
    const roomsRoot = resolve(userDataRoot, 'rooms')
    mkdirSync(roomsRoot, { recursive: true, mode: 0o700 })
    const roomsRootStat = lstatSync(roomsRoot)
    if (!roomsRootStat.isDirectory() || roomsRootStat.isSymbolicLink()) {
      throw new Error('Screenshot artifact storage contains an unsafe directory')
    }
    const roomRoot = resolve(roomsRoot, roomId)
    mkdirSync(roomRoot, { recursive: true, mode: 0o700 })
    const roomRootStat = lstatSync(roomRoot)
    if (!roomRootStat.isDirectory() || roomRootStat.isSymbolicLink()) {
      throw new Error('Screenshot artifact storage contains an unsafe directory')
    }
    const artifactsRoot = resolve(roomRoot, 'artifacts')
    mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 })
    const artifactsRootStat = lstatSync(artifactsRoot)
    if (!artifactsRootStat.isDirectory() || artifactsRootStat.isSymbolicLink()) {
      throw new Error('Screenshot artifact storage contains an unsafe directory')
    }
    const root = resolve(artifactsRoot, 'screenshots')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Screenshot artifact storage contains an unsafe directory')
    }
    const canonicalUserData = realpathSync.native(userDataRoot)
    const canonicalRoomsRoot = realpathSync.native(roomsRoot)
    const canonicalRoomRoot = realpathSync.native(roomRoot)
    const canonicalRoot = realpathSync.native(root)
    if (!isInside(canonicalUserData, canonicalRoomsRoot) || !isInside(canonicalRoomsRoot, canonicalRoomRoot)) {
      throw new Error('Screenshot artifact Room storage escaped Hotel data')
    }
    if (!isInside(canonicalRoomRoot, canonicalRoot)) throw new Error('Screenshot artifact root escaped its Room storage')
    return canonicalRoot
  }
}
