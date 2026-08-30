import { z } from 'zod'

export const SCREENSHOT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
export const SCREENSHOT_ARTIFACT_MAX_PER_ROOM = 500
export const SCREENSHOT_ARTIFACT_MAX_ROOM_BYTES = 1024 * 1024 * 1024

export const zArtifactId = z.string().uuid()
export const zArtifactKind = z.literal('android-screenshot')

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** Portable basename used for download and export; storage never trusts it as a path. */
export const zArtifactFilename = z
  .string()
  .min(5)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i, 'portable .png filename')
  .refine((value) => !WINDOWS_RESERVED_BASENAME.test(value), 'filename is reserved on Windows')

export const zArtifactAssociation = z
  .object({
    changeId: z.string().uuid().optional(),
    runId: z.string().uuid().optional()
  })
  .strict()
  .refine((value) => value.changeId !== undefined || value.runId !== undefined, 'association cannot be empty')

export const zCaptureScreenshotArtifactBody = z
  .object({
    filename: zArtifactFilename,
    mode: z.enum(['auto', 'screen']).optional(),
    association: zArtifactAssociation.optional()
  })
  .strict()

export type CaptureScreenshotArtifactBody = z.infer<typeof zCaptureScreenshotArtifactBody>

/** GitHub-friendly path inside a Room-owned project. Host paths are never accepted. */
export const zArtifactExportBody = z
  .object({
    relativePath: z
      .string()
      .min(5)
      .max(1024)
      .refine((value) => {
        if (value.startsWith('/') || value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) return false
        const segments = value.split('/')
        if (
          segments.some(
            (segment) =>
              segment.length === 0 ||
              segment.length > 128 ||
              segment === '.' ||
              segment === '..' ||
              !/^[A-Za-z0-9._-]+$/.test(segment) ||
              WINDOWS_RESERVED_BASENAME.test(segment) ||
              segment.toLowerCase() === '.git' ||
              segment.toLowerCase().startsWith('.devhotel-artifact-')
          )
        ) return false
        return /\.png$/i.test(segments.at(-1) ?? '')
      }, 'safe repo-relative .png path')
  })
  .strict()

export type ArtifactExportBody = z.infer<typeof zArtifactExportBody>

export const zArtifactListLimit = z.number().int().min(1).max(100)

const zSha256 = z.string().regex(/^[a-f0-9]{64}$/)
const zAndroidApplicationId = z
  .string()
  .max(223)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)

export const zAndroidScreenshotArtifactMetadata = z
  .object({
    schema: z.literal(1),
    room: z
      .object({
        id: z.string().regex(/^[a-z0-9]{8}$/),
        stateRevision: z.number().int().nonnegative(),
        workspaceVolumeRevision: z.number().int().nonnegative()
      })
      .strict(),
    capture: z
      .object({
        source: z.enum(['adb', 'screen']),
        capturedAt: z.string().datetime(),
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
        orientation: z.enum(['portrait', 'landscape', 'square'])
      })
      .strict(),
    device: z
      .object({
        kind: z.enum(['emulator', 'physical']),
        deviceId: z.string().regex(/^d[a-f0-9]{32}$/).nullable(),
        model: z.string().min(1).max(200).nullable(),
        androidVersion: z.string().min(1).max(64).nullable(),
        apiLevel: z.number().int().min(1).max(100).nullable()
      })
      .strict(),
    app: z
      .object({
        status: z.enum(['tracked-active', 'untracked-or-none']),
        packageName: zAndroidApplicationId.nullable()
      })
      .strict(),
    locale: z
      .object({
        tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/).nullable(),
        scope: z.enum(['app', 'system', 'unknown'])
      })
      .strict(),
    build: z
      .object({
        exact: z.boolean(),
        changeId: z.string().uuid().nullable(),
        apkSha256: zSha256.nullable(),
        installedAt: z.string().datetime().nullable()
      })
      .strict(),
    association: z
      .object({
        changeId: z.string().uuid().nullable(),
        runId: z.string().uuid().nullable()
      })
      .strict()
  })
  .strict()
  .refine(
    (value) => (value.device.kind === 'physical') === (value.device.deviceId !== null),
    'only physical artifacts may carry an opaque device ID'
  )
  .refine(
    (value) => (value.app.status === 'untracked-or-none') === (value.app.packageName === null),
    'only a tracked app may expose a package name'
  )
  .refine(
    (value) =>
      value.build.exact
        ? value.app.packageName !== null &&
          value.build.changeId !== null &&
          value.build.apkSha256 !== null &&
          value.build.installedAt !== null
        : value.build.changeId === null && value.build.apkSha256 === null && value.build.installedAt === null,
    'build identity must be complete and belong to a tracked app'
  )

export type AndroidScreenshotArtifactMetadata = z.infer<typeof zAndroidScreenshotArtifactMetadata>

export const zRoomArtifact = z
  .object({
    id: zArtifactId,
    roomId: z.string().regex(/^[a-z0-9]{8}$/),
    kind: zArtifactKind,
    filename: zArtifactFilename,
    mediaType: z.literal('image/png'),
    sizeBytes: z.number().int().positive().max(SCREENSHOT_ARTIFACT_MAX_BYTES),
    sha256: zSha256,
    actor: z.enum(['user', 'devhotel', 'agent']),
    createdAt: z.string().datetime(),
    metadata: zAndroidScreenshotArtifactMetadata
  })
  .strict()

export type RoomArtifact = z.infer<typeof zRoomArtifact>

export interface ArtifactExportResult {
  artifactId: string
  path: string
  relativePath: string
  sizeBytes: number
  sha256: string
  markdown: string
}
