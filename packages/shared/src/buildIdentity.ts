import { z } from 'zod'

/** Immutable identity embedded in one DevHotel desktop build. */
export const zSemanticVersion = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)

export const zBuildIdentity = z
  .object({
    version: zSemanticVersion,
    commit: z.string().regex(/^[a-f0-9]{40}$/, 'full lowercase Git commit SHA'),
    buildTime: z.string().datetime({ offset: true })
  })
  .strict()

export type BuildIdentity = z.infer<typeof zBuildIdentity>

/** Public updater projection. Error details may contain local paths, so they never cross this boundary. */
export const zPublicUpdateStatus = z
  .object({
    state: z.enum(['idle', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'error']),
    targetVersion: zSemanticVersion.nullable()
  })
  .strict()

export type PublicUpdateStatus = z.infer<typeof zPublicUpdateStatus>
