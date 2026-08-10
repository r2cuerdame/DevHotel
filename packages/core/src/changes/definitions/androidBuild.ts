import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join, relative } from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import { z } from 'zod'
import { srcVolume, workspaceSnapshotVolume } from '../../backend/naming'
import { ANDROID_IMAGE } from '../../providers/androidProvider'
import type { ChangeDefinition } from '../types'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const provenanceSchema = z.object({
  schema: z.literal(1),
  jobId: z.string().uuid(),
  changeId: z.string().uuid(),
  roomId: z.string().regex(/^[a-z0-9]{8}$/),
  executionLifecycle: z.literal('in-process-only'),
  cleanExecution: z.literal(true),
  input: z.object({
    stateRevision: z.number().int().nonnegative(),
    workspaceVolumeRevision: z.number().int().nonnegative(),
    buildInputSha256: sha256Schema,
    environmentRevision: sha256Schema
  }).strict(),
  command: z.string().min(1),
  artifactsDirectory: z.string().regex(/^artifacts\/[0-9a-f-]{36}$/),
  artifacts: z.array(z.object({
    relativePath: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: sha256Schema
  }).strict()).min(1),
  createdAt: z.string().datetime(),
  provenanceSha256: sha256Schema
}).strict()
type AndroidBuildProvenance = z.infer<typeof provenanceSchema>

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

function environmentRevision(room: RoomRecord): string {
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

function cleanupArtifacts(userData: string, roomId: string, operationId: string): string | null {
  const dir = join(userData, 'rooms', roomId, 'artifacts', operationId)
  try {
    rmSync(dir, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
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
      throw new Error('Android builds require a Room-owned Hotel workspace')
    }
    if (!ctx.isAwake()) throw new Error('Wake the room before building')
  },
  async apply(ctx, _p, steps, operation) {
    const room = ctx.room()
    const snapshot = workspaceSnapshotVolume(room.id, operation.id)
    const artifactRelativeDir = `artifacts/${operation.id}`
    const artifactsRoot = join(ctx.userData, 'rooms', room.id, 'artifacts')
    const artifactHostDir = join(artifactsRoot, operation.id)
    const liveSpec = ctx.webSpec()
    const spec = ctx.webSpec({
      workspaceVolumeOverride: snapshot,
      noCacheVolume: true,
      extraVolumes: []
    })
    let snapshotCreated = false
    let primaryError: unknown

    try {
      steps.push(`Pause Room workspace briefly for build input ${operation.id}`)
      await ctx.backend.pauseWeb(room.id)
      let copyError: unknown
      try {
        await ctx.backend.copyVolume(
          room.id,
          srcVolume(room.id, room.workspaceVolumeRevision),
          room.id,
          snapshot,
          (line) => ctx.log(`  ${line}`)
        )
        snapshotCreated = true
      } catch (error) {
        copyError = error
      }
      try {
        await ctx.backend.unpauseWeb(room.id)
      } catch (unpauseError) {
        try {
          await ctx.backend.recreateWeb(liveSpec)
        } catch (recreateError) {
          throw new AggregateError(
            copyError ? [copyError, unpauseError, recreateError] : [unpauseError, recreateError],
            'Could not resume or recreate the live Android Room after snapshot capture'
          )
        }
        throw unpauseError
      }
      if (copyError) throw copyError
      steps.push('Room resumed; Agent and terminal edits continue against the live workspace')

      const buildInputSha256 = await ctx.backend.fingerprintBuildInput(room.id, snapshot)
      const initial: AndroidBuildProvenance = {
        schema: 1,
        jobId: operation.id,
        changeId: operation.id,
        roomId: room.id,
        executionLifecycle: 'in-process-only',
        cleanExecution: true,
        input: {
          stateRevision: room.stateRevision,
          workspaceVolumeRevision: room.workspaceVolumeRevision,
          buildInputSha256,
          environmentRevision: environmentRevision(room)
        },
        command: room.startCommand,
        artifactsDirectory: artifactRelativeDir,
        artifacts: [],
        createdAt: operation.createdAt,
        provenanceSha256: '0'.repeat(64)
      }
      steps.setCaptured(initial)
      steps.push('Build job is in-process only; daemon restart recovery is not available yet')
      steps.push('Clean build uses the pinned image with disposable SDK/Gradle caches; cold dependency downloads may be slower')
      steps.push(`Run ${room.startCommand} against immutable input ${buildInputSha256.slice(0, 12)}`)
      const result = await ctx.backend.runOneShot(spec, room.startCommand, (line) => ctx.log(`  ${line}`))
      if (result.code !== 0) {
        throw new Error(`build failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-500)}`)
      }

      const artifacts = await ctx.backend.exportAndroidArtifacts(room.id, snapshot, artifactsRoot, operation.id)
      if (artifacts.length === 0) throw new Error('build finished but no APK was produced under build/outputs/apk')
      const { provenanceSha256: _placeholder, ...initialUnsigned } = initial
      const unsigned = { ...initialUnsigned, artifacts }
      const provenance: AndroidBuildProvenance = {
        ...unsigned,
        provenanceSha256: provenanceChecksum(unsigned)
      }
      mkdirSync(artifactHostDir, { recursive: true })
      const manifest = join(artifactHostDir, 'provenance.json')
      const temporary = `${manifest}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
      renameSync(temporary, manifest)
      steps.setCaptured(provenance)
      steps.push(`Export ${artifacts.length} APK artifact${artifacts.length === 1 ? '' : 's'} with SHA-256 provenance`)
    } catch (error) {
      primaryError = error
      if (existsSync(artifactHostDir)) {
        const artifactCleanupError = cleanupArtifacts(ctx.userData, room.id, operation.id)
        if (artifactCleanupError) {
          primaryError = new AggregateError(
            [primaryError, new Error(artifactCleanupError)],
            'Android build failed and its partial artifact directory requires cleanup'
          )
        }
      }
    } finally {
      if (snapshotCreated) {
        try {
          await ctx.backend.removeWorkspaceSnapshot(room.id, operation.id)
          steps.push('Remove immutable build snapshot')
        } catch (cleanupError) {
          if (primaryError) {
            primaryError = new AggregateError([primaryError, cleanupError], 'Android build and snapshot cleanup both failed')
          } else {
            primaryError = cleanupError
          }
        }
      }
    }
    if (primaryError) throw primaryError
  },
  async verify(ctx, _p, captured, operation) {
    const fail = (detail: string): { ok: false; detail: string } => {
      const cleanupError = cleanupArtifacts(ctx.userData, ctx.roomId, operation.id)
      return {
        ok: false,
        detail: cleanupError ? `${detail}; artifact cleanup also failed: ${cleanupError}` : detail
      }
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
    } catch (error) {
      return fail(`build provenance manifest is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isDeepStrictEqual(manifest, captured)) {
      return fail('build provenance manifest does not match the recorded Change')
    }
    if (provenanceChecksum(manifest) !== manifest.provenanceSha256) {
      return fail('build provenance manifest checksum does not match')
    }
    const canonicalArtifactDir = realpathSync.native(artifactDir)
    for (const artifact of manifest.artifacts) {
      const segments = artifact.relativePath.split('/')
      if (
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        artifact.relativePath.startsWith('/') ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      ) {
        return fail('exported APK provenance is invalid')
      }
      const path = join(artifactDir, artifact.relativePath)
      if (!existsSync(path)) return fail(`exported APK is missing: ${artifact.relativePath}`)
      const linkStat = lstatSync(path)
      const canonicalPath = realpathSync.native(path)
      const rel = relative(canonicalArtifactDir, canonicalPath)
      if (linkStat.isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        return fail(`exported APK escaped its Room artifact directory: ${artifact.relativePath}`)
      }
      const stat = statSync(canonicalPath)
      if (!stat.isFile() || stat.size !== artifact.size || await sha256File(canonicalPath) !== artifact.sha256) {
        return fail(`exported APK checksum does not match: ${artifact.relativePath}`)
      }
    }
    const first = manifest.artifacts[0]
    return first
      ? { ok: true, detail: `APK ready: ${captured.artifactsDirectory}/${first.relativePath}` }
      : { ok: false, detail: 'build provenance contains no APK artifacts' }
  }
}
