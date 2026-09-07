import { z } from 'zod'

export type VolumePurpose =
  | 'workspace'
  | 'workspace-snapshot'
  | 'dependencies'
  | 'cache'
  | 'sdk'
  | 'service-data'
  | 'external'
  | 'unknown'

export const zVolumePurpose = z.enum([
  'workspace',
  'workspace-snapshot',
  'dependencies',
  'cache',
  'sdk',
  'service-data',
  'external',
  'unknown'
])

export type VolumeLivenessClass =
  | 'retained-current'
  | 'retained-active'
  | 'retained-sleeping'
  | 'retained-recovery'
  | 'fenced'
  | 'orphaned-deleted-room'
  | 'orphaned-stale-generation'
  | 'orphaned-stale-snapshot'
  | 'orphaned-stale-deps'
  | 'unowned'

export const zVolumeLivenessClass = z.enum([
  'retained-current',
  'retained-active',
  'retained-sleeping',
  'retained-recovery',
  'fenced',
  'orphaned-deleted-room',
  'orphaned-stale-generation',
  'orphaned-stale-snapshot',
  'orphaned-stale-deps',
  'unowned'
])

export type VolumeOwnership = 'managed-labels' | 'legacy-adoption' | 'unowned'

export const zVolumeOwnership = z.enum(['managed-labels', 'legacy-adoption', 'unowned'])

export interface VolumeRecord {
  name: string
  roomId: string | null
  purpose: VolumePurpose
  revision: number | null
  generation: number | null
  nodeMajor: string | null
  serviceKind: string | null
  snapshotOperationId: string | null
  sizeBytes: number
  sizeKnown: boolean
  ownership: VolumeOwnership
  links: number
  linksKnown: boolean
  labels: Record<string, string>
  class: VolumeLivenessClass
  safeToDelete: boolean
  reason: string
  mountpoint?: string
  driver?: string
}

export const zVolumeRecord = z.object({
  name: z.string(),
  roomId: z.string().nullable(),
  purpose: zVolumePurpose,
  revision: z.number().int().nonnegative().nullable(),
  generation: z.number().int().nonnegative().nullable(),
  nodeMajor: z.string().nullable(),
  serviceKind: z.string().nullable(),
  snapshotOperationId: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sizeKnown: z.boolean(),
  ownership: zVolumeOwnership,
  links: z.number().int().nonnegative(),
  linksKnown: z.boolean(),
  labels: z.record(z.string()),
  class: zVolumeLivenessClass,
  safeToDelete: z.boolean(),
  reason: z.string(),
  mountpoint: z.string().optional(),
  driver: z.string().optional()
})

export interface VolumeClassSummary {
  count: number
  totalBytes: number
  reclaimableBytes: number
}

export const zVolumeClassSummary = z.object({
  count: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative()
})

export interface VolumeReconciliationReport {
  totalDockerVolumes: number
  totalDockerBytes: number
  totalDockerReclaimableBytes: number
  devHotelVolumeCount: number
  devHotelTotalBytes: number
  devHotelReclaimableBytes: number
  safeGcCandidateCount: number
  safeGcCandidateBytes: number
  fencedVolumeCount: number
  fencedVolumeBytes: number
  retainedVolumeCount: number
  retainedVolumeBytes: number
  unownedVolumeCount: number
  unownedVolumeBytes: number
  byClass: Record<VolumeLivenessClass, VolumeClassSummary>
  volumes: VolumeRecord[]
}

export const zVolumeReconciliationReport = z.object({
  totalDockerVolumes: z.number().int().nonnegative(),
  totalDockerBytes: z.number().int().nonnegative(),
  totalDockerReclaimableBytes: z.number().int().nonnegative(),
  devHotelVolumeCount: z.number().int().nonnegative(),
  devHotelTotalBytes: z.number().int().nonnegative(),
  devHotelReclaimableBytes: z.number().int().nonnegative(),
  safeGcCandidateCount: z.number().int().nonnegative(),
  safeGcCandidateBytes: z.number().int().nonnegative(),
  fencedVolumeCount: z.number().int().nonnegative(),
  fencedVolumeBytes: z.number().int().nonnegative(),
  retainedVolumeCount: z.number().int().nonnegative(),
  retainedVolumeBytes: z.number().int().nonnegative(),
  unownedVolumeCount: z.number().int().nonnegative(),
  unownedVolumeBytes: z.number().int().nonnegative(),
  byClass: z.record(zVolumeLivenessClass, zVolumeClassSummary),
  volumes: z.array(zVolumeRecord)
})

export interface VolumeGcResult {
  dryRun: boolean
  report: VolumeReconciliationReport
  deletedCount: number
  reclaimedBytes: number
  deletedVolumes: string[]
  errors: string[]
}

export const zVolumeGcResult = z.object({
  dryRun: z.boolean(),
  report: zVolumeReconciliationReport,
  deletedCount: z.number().int().nonnegative(),
  reclaimedBytes: z.number().int().nonnegative(),
  deletedVolumes: z.array(z.string()),
  errors: z.array(z.string())
})

export const zVolumeGcBody = z.object({
  dryRun: z.boolean().optional(),
  maxVolumes: z.number().int().positive().max(500).optional(),
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).superRefine((value, ctx) => {
  if (value.dryRun !== false) return
  if (value.maxVolumes === undefined) {
    ctx.addIssue({ code: 'custom', path: ['maxVolumes'], message: 'Real volume GC requires an explicit maxVolumes bound' })
  }
  if (value.maxBytes === undefined) {
    ctx.addIssue({ code: 'custom', path: ['maxBytes'], message: 'Real volume GC requires an explicit maxBytes bound' })
  }
}).transform((value) => ({
  dryRun: value.dryRun ?? true,
  maxVolumes: value.maxVolumes ?? 50,
  maxBytes: value.maxBytes
}))
