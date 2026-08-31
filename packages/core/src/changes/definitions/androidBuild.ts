import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import { z } from 'zod'
import { srcVolume, workspaceSnapshotVolume } from '../../backend/naming'
import type { ExportedArtifact } from '../../backend/types'
import { ANDROID_IMAGE } from '../../providers/androidProvider'
import { assertLaunchersAreExecutable, lineEndingAttributionInSnapshot } from './androidLineEndings'
import type { ChangeCtx, ChangeDefinition, ChangeOperation, ChangeStep } from '../types'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const MAX_ANDROID_BUILD_ARTIFACTS = 64
const MAX_ANDROID_ARTIFACT_BYTES = 512 * 1024 * 1024
const MAX_ANDROID_ARTIFACT_PATH_BYTES = 4096
const BUILD_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024
const BUILD_STDERR_LIMIT_BYTES = 8 * 1024 * 1024
const BUILD_TIMEOUT_MS = 15 * 60_000
const CLEANUP_OUTPUT_LIMIT_BYTES = 64 * 1024
const ROOM_ID_PATTERN = /^[a-z0-9]{8}$/
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRIVATE_ARTIFACT_CLEANUP_FAILED = 'private Android build artifact cleanup failed'
export const ANDROID_SNAPSHOT_CLEAN_SCRIPT = [
  'set -eu',
  '# devhotel-android-output-clean-v1',
  "find /workspace -xdev -depth \\( -path '*/build/outputs/apk' -o -path '*/build/outputs/apk/*' \\) -delete"
].join('\n')
const artifactSchema = z.object({
  relativePath: z.string().min(1).max(MAX_ANDROID_ARTIFACT_PATH_BYTES),
  size: z.number().int().positive().max(MAX_ANDROID_ARTIFACT_BYTES),
  sha256: sha256Schema
}).strict()
const provenanceSchema = z.object({
  schema: z.literal(1),
  jobId: z.string().uuid(),
  changeId: z.string().uuid(),
  roomId: z.string().regex(/^[a-z0-9]{8}$/),
  executionLifecycle: z.literal('isolated-snapshot'),
  cleanExecution: z.literal(true),
  input: z.object({
    stateRevision: z.number().int().nonnegative(),
    workspaceVolumeRevision: z.number().int().nonnegative(),
    buildInputSha256: sha256Schema,
    environmentRevision: sha256Schema
  }).strict(),
  command: z.string().min(1).max(16 * 1024),
  artifactsDirectory: z.string().regex(/^artifacts\/[0-9a-f-]{36}$/),
  artifacts: z.array(artifactSchema).min(1).max(MAX_ANDROID_BUILD_ARTIFACTS),
  createdAt: z.string().datetime(),
  provenanceSha256: sha256Schema
}).strict()
export type AndroidBuildProvenance = z.infer<typeof provenanceSchema>

export interface SealedAndroidBuild {
  provenance: AndroidBuildProvenance
  artifactHostDirectory: string
  /** Exact transactional Room source copied into the immutable snapshot. */
  sourceFingerprint: string
}

export interface SealedAndroidArtifactRef {
  operationId: string
  relativePath: string
  sizeBytes: number
  apkSha256: string
  /** Core-only material authenticated at install time; never enters the public install receipt. */
  acceptance: {
    stateRevision: number
    workspaceVolumeRevision: number
    sourceFingerprint: string
    environmentRevision: string
    imageReference: string
    imageSha256: string
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

export function androidBuildEnvironmentRevision(room: RoomRecord): string {
  const env = Object.fromEntries(Object.entries(room.os.env).sort(([a], [b]) => a.localeCompare(b)))
  return sha256(JSON.stringify({
    provider: 'android',
    image: ANDROID_IMAGE,
    runtime: room.runtime,
    packageManager: room.packageManager,
    command: room.startCommand,
    cleanExecution: true,
    persistentCacheVolumes: false,
    os: { ...room.os, env }
  }))
}

function provenanceChecksum(provenance: Omit<AndroidBuildProvenance, 'provenanceSha256'> | AndroidBuildProvenance): string {
  const { provenanceSha256: _ignored, ...unsigned } = provenance as AndroidBuildProvenance
  return sha256(JSON.stringify(unsigned))
}

function isProvenance(value: unknown): value is AndroidBuildProvenance {
  const parsed = provenanceSchema.safeParse(value)
  return parsed.success && parsed.data.jobId === parsed.data.changeId
}

export function isSafeAndroidArtifactRelativePath(relativePath: string): boolean {
  const segments = relativePath.split('/')
  return (
    Buffer.byteLength(relativePath, 'utf8') <= MAX_ANDROID_ARTIFACT_PATH_BYTES &&
    !relativePath.startsWith('/') &&
    !/^[A-Za-z]:/.test(relativePath) &&
    !relativePath.includes('\\') &&
    !/[\p{C}\p{Zl}\p{Zp}]/u.test(relativePath) &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    relativePath.toLowerCase().endsWith('.apk') &&
    (relativePath.startsWith('build/outputs/apk/') || relativePath.includes('/build/outputs/apk/'))
  )
}

export function cleanupAndroidBuildArtifacts(userData: string, roomId: string, operationId: string): string | null {
  if (!ROOM_ID_PATTERN.test(roomId) || !OPERATION_ID_PATTERN.test(operationId)) {
    return PRIVATE_ARTIFACT_CLEANUP_FAILED
  }
  try {
    const artifactsRoot = resolve(userData, 'rooms', roomId, 'artifacts')
    if (!existsSync(artifactsRoot)) return null
    const rootStat = lstatSync(artifactsRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return PRIVATE_ARTIFACT_CLEANUP_FAILED
    const canonicalRoot = realpathSync.native(artifactsRoot)
    const candidate = resolve(canonicalRoot, operationId)
    if (relative(canonicalRoot, candidate) !== operationId) return PRIVATE_ARTIFACT_CLEANUP_FAILED
    if (!existsSync(candidate)) return null
    const candidateStat = lstatSync(candidate)
    const canonicalCandidate = realpathSync.native(candidate)
    if (
      candidateStat.isSymbolicLink() ||
      !candidateStat.isDirectory() ||
      relative(canonicalRoot, canonicalCandidate) !== operationId
    ) return PRIVATE_ARTIFACT_CLEANUP_FAILED
    rmSync(canonicalCandidate, { recursive: true, force: true })
    return null
  } catch {
    return PRIVATE_ARTIFACT_CLEANUP_FAILED
  }
}

function uniqueSafeArtifacts(value: ExportedArtifact[]): AndroidBuildProvenance['artifacts'] {
  if (value.length < 1 || value.length > MAX_ANDROID_BUILD_ARTIFACTS) {
    throw new Error('Android build produced an unsupported number of APK artifacts')
  }
  const parsed: AndroidBuildProvenance['artifacts'] = []
  for (const artifact of value) {
    const candidate = artifactSchema.safeParse(artifact)
    if (!candidate.success) throw new Error('Android build exporter returned invalid APK artifact evidence')
    parsed.push(candidate.data)
  }
  if (
    parsed.some((artifact) => !isSafeAndroidArtifactRelativePath(artifact.relativePath)) ||
    new Set(parsed.map((artifact) => artifact.relativePath)).size !== parsed.length
  ) {
    throw new Error('Android build exporter returned unsafe or duplicate APK artifact paths')
  }
  return parsed
}

async function resumePausedRoom(ctx: ChangeCtx, liveSpec: ReturnType<ChangeCtx['webSpec']>): Promise<unknown | null> {
  try {
    await ctx.backend.unpauseWeb(ctx.roomId)
    return null
  } catch (unpauseError) {
    try {
      await ctx.backend.recreateWeb(liveSpec)
    } catch (recreateError) {
      throw new AggregateError([unpauseError, recreateError], 'Could not resume or recreate the live Android Room')
    }
    return unpauseError
  }
}

export async function buildSealedAndroidArtifacts(
  ctx: ChangeCtx,
  steps: Pick<ChangeStep, 'push'>,
  operation: ChangeOperation
): Promise<SealedAndroidBuild> {
  const room = ctx.room()
  if (room.provider !== 'android' || room.workspaceMode !== 'hotel') {
    throw new Error('Android builds require a Room-owned Hotel workspace')
  }
  const snapshot = workspaceSnapshotVolume(room.id, operation.id)
  const artifactRelativeDir = `artifacts/${operation.id}`
  const artifactsRoot = join(ctx.userData, 'rooms', room.id, 'artifacts')
  const artifactHostDir = join(artifactsRoot, operation.id)
  const liveSpec = ctx.webSpec()
  const spec = ctx.webSpec({ workspaceVolumeOverride: snapshot, noCacheVolume: true, extraVolumes: [] })
  let snapshotCreated = false
  let paused = false
  let primaryError: unknown
  let sealed: SealedAndroidBuild | undefined

  try {
    steps.push(`Pause Room workspace briefly for immutable build input ${operation.id}`)
    paused = true
    await ctx.backend.pauseWeb(room.id)
    if (!await ctx.backend.webPaused(room.id)) throw new Error('Android build could not prove the Room execution pause')
    const fencedRoom = ctx.room()
    if (
      fencedRoom.stateRevision !== room.stateRevision ||
      fencedRoom.workspaceVolumeRevision !== room.workspaceVolumeRevision
    ) throw new Error('Room generation changed before immutable build capture')
    const sourceFingerprint = await ctx.backend.fingerprintWorkspace(room.id, room.workspaceVolumeRevision)
    // A rejected copy may still have allocated a partial target volume.
    snapshotCreated = true
    await ctx.backend.copyVolume(
      room.id,
      srcVolume(room.id, room.workspaceVolumeRevision),
      room.id,
      snapshot,
      (line) => ctx.log(`  ${line}`)
    )
    const snapshotFingerprint = await ctx.backend.fingerprintWorkspace(room.id, room.workspaceVolumeRevision, snapshot)
    const sourceFingerprintAfterCopy = await ctx.backend.fingerprintWorkspace(room.id, room.workspaceVolumeRevision)
    if (snapshotFingerprint !== sourceFingerprint || sourceFingerprintAfterCopy !== sourceFingerprint) {
      throw new Error('Immutable Android snapshot did not match one stable paused Room source')
    }
    const resumeError = await resumePausedRoom(ctx, liveSpec)
    paused = false
    if (resumeError) throw resumeError
    steps.push('Room resumed; cleanup and build continue only against the immutable snapshot')

    steps.push('Remove prior APK outputs only from the disposable snapshot')
    const cleaned = await ctx.backend.runOneShot(
      spec,
      ANDROID_SNAPSHOT_CLEAN_SCRIPT,
      (line) => ctx.log(`  ${line}`),
      { maxStdoutBytes: CLEANUP_OUTPUT_LIMIT_BYTES, maxStderrBytes: CLEANUP_OUTPUT_LIMIT_BYTES }
    )
    if (cleaned.code !== 0 || cleaned.outputLimitExceeded === true || cleaned.stderr.trim() !== '') {
      throw new Error('isolated Android build cleanup failed')
    }
    // Provenance describes exactly the cleaned snapshot the build will consume.
    const buildInputSha256 = await ctx.backend.fingerprintBuildInput(room.id, snapshot)

    steps.push(`Run ${room.startCommand} against immutable input ${buildInputSha256.slice(0, 12)}`)
    const result = await ctx.backend.runOneShot(
      spec,
      room.startCommand,
      (line) => ctx.log(`  ${line}`),
      {
        timeoutMs: BUILD_TIMEOUT_MS,
        maxStdoutBytes: BUILD_STDOUT_LIMIT_BYTES,
        maxStderrBytes: BUILD_STDERR_LIMIT_BYTES
      }
    )
    if (result.outputLimitExceeded === true) {
      throw new Error('Android build output exceeded its bounded safety limit')
    }
    if (result.code !== 0) {
      const attribution = await lineEndingAttributionInSnapshot(ctx, spec)
      throw new Error(`build failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-500)}${attribution}`)
    }

    let exportedArtifacts: ExportedArtifact[]
    try {
      exportedArtifacts = await ctx.backend.exportAndroidArtifacts(room.id, snapshot, artifactsRoot, operation.id)
    } catch {
      throw new Error('Android build artifact export failed')
    }
    const artifacts = uniqueSafeArtifacts(exportedArtifacts)
    const unsigned: Omit<AndroidBuildProvenance, 'provenanceSha256'> = {
      schema: 1,
      jobId: operation.id,
      changeId: operation.id,
      roomId: room.id,
      executionLifecycle: 'isolated-snapshot',
      cleanExecution: true,
      input: {
        stateRevision: room.stateRevision,
        workspaceVolumeRevision: room.workspaceVolumeRevision,
        buildInputSha256,
        environmentRevision: androidBuildEnvironmentRevision(room)
      },
      command: room.startCommand,
      artifactsDirectory: artifactRelativeDir,
      artifacts,
      createdAt: operation.createdAt
    }
    const provenance: AndroidBuildProvenance = {
      ...unsigned,
      provenanceSha256: provenanceChecksum(unsigned)
    }
    try {
      mkdirSync(artifactHostDir, { recursive: true })
      const manifest = join(artifactHostDir, 'provenance.json')
      const temporary = `${manifest}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, manifest)
    } catch {
      throw new Error('Android build provenance could not be sealed')
    }
    steps.push(`Seal ${artifacts.length} Host-private APK artifact${artifacts.length === 1 ? '' : 's'} with SHA-256 provenance`)
    sealed = { provenance, artifactHostDirectory: artifactHostDir, sourceFingerprint }
  } catch (error) {
    primaryError = error
    const artifactCleanupError = cleanupAndroidBuildArtifacts(ctx.userData, room.id, operation.id)
    if (artifactCleanupError) {
      primaryError = new AggregateError(
        [primaryError, new Error(artifactCleanupError)],
        'Android build failed and its private artifact cleanup also failed'
      )
    }
  }

  if (paused) {
    try {
      const resumeError = await resumePausedRoom(ctx, liveSpec)
      paused = false
      if (resumeError) throw resumeError
    } catch (resumeError) {
      primaryError = primaryError
        ? new AggregateError([primaryError, resumeError], 'Android build and Room resume both failed')
        : resumeError
    }
  }
  if (snapshotCreated) {
    try {
      await ctx.backend.removeWorkspaceSnapshot(room.id, operation.id)
      steps.push('Remove immutable build snapshot')
    } catch (cleanupError) {
      if (!primaryError) {
        const artifactCleanupError = cleanupAndroidBuildArtifacts(ctx.userData, room.id, operation.id)
        const errors = artifactCleanupError
          ? [cleanupError, new Error(artifactCleanupError)]
          : [cleanupError]
        primaryError = new AggregateError(errors, 'Android build snapshot cleanup failed; sealed artifacts were withheld')
      } else {
        primaryError = new AggregateError([primaryError, cleanupError], 'Android build and snapshot cleanup both failed')
      }
    }
  }
  if (primaryError) throw primaryError
  if (!sealed) throw new Error('Android build completed without a sealed artifact result')
  return sealed
}

export async function verifySealedAndroidBuild(
  ctx: ChangeCtx,
  captured: unknown,
  operation: ChangeOperation,
  cleanupOnFailure = false
): Promise<{ ok: boolean; detail: string; provenance?: AndroidBuildProvenance }> {
  const fail = (detail: string): { ok: false; detail: string } => {
    if (!cleanupOnFailure) return { ok: false, detail }
    const cleanupError = cleanupAndroidBuildArtifacts(ctx.userData, ctx.roomId, operation.id)
    return { ok: false, detail: cleanupError ? `${detail}; artifact cleanup also failed: ${cleanupError}` : detail }
  }
  if (!isProvenance(captured) || captured.changeId !== operation.id || captured.roomId !== ctx.roomId) {
    return fail('build provenance is missing or belongs to another operation')
  }
  if (provenanceChecksum(captured) !== captured.provenanceSha256) {
    return fail('build provenance checksum does not match')
  }
  const artifactsRoot = join(ctx.userData, 'rooms', ctx.roomId, 'artifacts')
  const artifactDir = join(artifactsRoot, operation.id)
  const manifestPath = join(artifactDir, 'provenance.json')
  let manifest: AndroidBuildProvenance
  try {
    const dirStat = lstatSync(artifactDir)
    const canonicalRoot = realpathSync.native(artifactsRoot)
    const canonicalDir = realpathSync.native(artifactDir)
    if (dirStat.isSymbolicLink() || relative(canonicalRoot, canonicalDir) !== operation.id) {
      return fail('build artifact directory escaped its Room-owned root')
    }
    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 256 * 1024) {
      return fail('build provenance manifest is not a bounded regular file')
    }
    const parsed = provenanceSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (!parsed.success || parsed.data.jobId !== parsed.data.changeId) {
      return fail('build provenance manifest has an invalid schema')
    }
    manifest = parsed.data
  } catch {
    return fail('build provenance manifest is missing or unreadable')
  }
  if (!isDeepStrictEqual(manifest, captured)) return fail('build provenance manifest does not match the recorded Change')
  if (provenanceChecksum(manifest) !== manifest.provenanceSha256) {
    return fail('build provenance manifest checksum does not match')
  }
  if (new Set(manifest.artifacts.map((artifact) => artifact.relativePath)).size !== manifest.artifacts.length) {
    return fail('build provenance manifest contains duplicate APK artifact paths')
  }
  let canonicalArtifactDir: string
  try {
    canonicalArtifactDir = realpathSync.native(artifactDir)
  } catch {
    return fail('exported APK is missing or unreadable')
  }
  for (const artifact of manifest.artifacts) {
    if (!isSafeAndroidArtifactRelativePath(artifact.relativePath)) return fail('exported APK provenance is invalid')
    try {
      const path = join(artifactDir, ...artifact.relativePath.split('/'))
      if (!existsSync(path)) return fail(`exported APK is missing: ${artifact.relativePath}`)
      const linkStat = lstatSync(path)
      const canonicalPath = realpathSync.native(path)
      const rel = relative(canonicalArtifactDir, canonicalPath)
      if (
        linkStat.isSymbolicLink() ||
        isAbsolute(rel) ||
        rel === '..' ||
        rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      ) return fail(`exported APK escaped its Room artifact directory: ${artifact.relativePath}`)
      const stat = statSync(canonicalPath)
      if (!stat.isFile() || stat.size !== artifact.size || await sha256File(canonicalPath) !== artifact.sha256) {
        return fail(`exported APK checksum does not match: ${artifact.relativePath}`)
      }
    } catch {
      return fail('exported APK is missing or unreadable')
    }
  }
  const first = manifest.artifacts[0]
  return first
    ? { ok: true, detail: `APK ready: ${captured.artifactsDirectory}/${first.relativePath}`, provenance: manifest }
    : fail('build provenance contains no APK artifacts')
}

export function sealedAndroidArtifactRef(
  build: SealedAndroidBuild,
  artifact: AndroidBuildProvenance['artifacts'][number]
): SealedAndroidArtifactRef {
  if (!build.provenance.artifacts.some((candidate) => isDeepStrictEqual(candidate, artifact))) {
    throw new Error('Android artifact is not part of the sealed build')
  }
  const imageSha256 = /@sha256:([a-f0-9]{64})$/.exec(ANDROID_IMAGE)?.[1]
  if (!imageSha256) throw new Error('Android build image is not digest-pinned')
  return {
    operationId: build.provenance.changeId,
    relativePath: artifact.relativePath,
    sizeBytes: artifact.size,
    apkSha256: artifact.sha256,
    acceptance: {
      stateRevision: build.provenance.input.stateRevision,
      workspaceVolumeRevision: build.provenance.input.workspaceVolumeRevision,
      sourceFingerprint: build.sourceFingerprint,
      environmentRevision: build.provenance.input.environmentRevision,
      imageReference: ANDROID_IMAGE,
      imageSha256
    }
  }
}

export const androidBuildChange: ChangeDefinition<Record<string, never>> = {
  kind: 'android-build',
  plan(ctx) {
    return {
      title: 'Debug APK built',
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
    if (room.provider !== 'android') throw new Error('Builds are only available in Android rooms')
    if (room.workspaceMode !== 'hotel') {
      throw new Error('Android builds require a Room-owned Hotel workspace; move this Room into Hotel first')
    }
    if (!ctx.isAwake()) throw new Error('Wake the room before building')
    await assertLaunchersAreExecutable(ctx)
  },
  async apply(ctx, _p, steps, operation) {
    const sealed = await buildSealedAndroidArtifacts(ctx, steps, operation)
    steps.setCaptured(sealed.provenance)
  },
  async verify(ctx, _p, captured, operation) {
    return verifySealedAndroidBuild(ctx, captured, operation, true)
  }
}
