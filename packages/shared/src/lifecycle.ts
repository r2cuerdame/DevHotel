import { z } from 'zod'

/**
 * The vocabulary DevHotel uses to talk about the things it owns on a Host.
 *
 * Until now the answer to "what does DevHotel own here" was assembled from
 * Docker's own nouns — a volume list, a container list, a network list — and
 * each one was reasoned about in a different place with a different notion of
 * ownership. That worked while Docker was the only engine. With Rooms running
 * inside the DevHotel-managed runtime (#107) there are two engines, the Host
 * also owns ingress ports that belong to no engine at all, and "ask Docker" has
 * stopped being a complete answer.
 *
 * So the nouns move here. A `HotelArtifact` is one thing DevHotel owns,
 * described in DevHotel's terms: what kind of thing it is, which Room it
 * belongs to, how ownership is *proved*, and whether anything can still reach
 * it. An engine adapter's only job is to report observations in this shape.
 * Nothing in this file knows what a container runtime is.
 */

/** One class of owned thing. Deliberately coarser than any engine's own nouns. */
export type HotelArtifactKind =
  /** A Room's private isolation domain — the reason two Rooms can both serve port 3000. */
  | 'room-network'
  /** Any container a Room owns: its namespace anchor, its web workload, its services. */
  | 'room-container'
  /** A durable Room disk: workspace generation, dependencies, cache, SDK, service data. */
  | 'room-disk'
  /** A Hotel-scoped disk deliberately shared by many Rooms. */
  | 'shared-cache'
  /** A Host port published so the Gateway can reach one Room. */
  | 'ingress-route'

export const zHotelArtifactKind = z.enum([
  'room-network',
  'room-container',
  'room-disk',
  'shared-cache',
  'ingress-route'
])

/** Whether an artifact belongs to one Room or to the Hotel as a whole. */
export type HotelArtifactScope = 'room' | 'hotel'

export const zHotelArtifactScope = z.enum(['room', 'hotel'])

/**
 * How ownership is established.
 *
 * `proved` is the only field GC is allowed to read. The kind exists so a human
 * reading an inventory can see *why* something counted as ours, and so a future
 * proof source can be added without every caller growing a new branch.
 */
export type OwnershipProofKind =
  /** The engine itself reports DevHotel's complete ownership label set. */
  | 'managed-labels'
  /** DevHotel's own durable ledger records creating it (ingress routes, adopted legacy disks). */
  | 'ledger'
  /** The name matches a DevHotel pattern but nothing corroborates it. Never a proof. */
  | 'name-only'
  /** Nothing identifies this as ours. */
  | 'none'

export const zOwnershipProofKind = z.enum(['managed-labels', 'ledger', 'name-only', 'none'])

export interface OwnershipProof {
  kind: OwnershipProofKind
  /** True only for a proof strong enough to authorize destruction. */
  proved: boolean
  detail: string
}

export const zOwnershipProof = z.object({
  kind: zOwnershipProofKind,
  proved: z.boolean(),
  detail: z.string()
})

/**
 * Why something is — or is not — still needed.
 *
 * `known: false` is a first-class answer and it is not the same as
 * `reachable: false`. An engine that could not report attachment state, a Room
 * whose operation history is unavailable, a disk whose size Docker declined to
 * compute: each leaves reachability *undetermined*, and an undetermined
 * artifact is never collected. That distinction is the whole safety property.
 */
export type ReachabilityKind =
  /** A live Room record names this artifact. */
  | 'room-record'
  /** The Room's current published generation. */
  | 'current-generation'
  /** Retained so a recovery or an undo can still reach it. */
  | 'retained-recovery'
  /** An operation running right now depends on it. */
  | 'active-operation'
  /** The engine reports a live attachment. */
  | 'attached'
  /** A recovery or acceptance fence protects the whole Room. */
  | 'fenced'
  /** Hotel-scoped and shared; reachable for as long as the Hotel exists. */
  | 'shared'
  /** Nothing reaches it, and that was established rather than assumed. */
  | 'unreachable'
  /** Reachability could not be established. Fail closed. */
  | 'undetermined'

export const zReachabilityKind = z.enum([
  'room-record',
  'current-generation',
  'retained-recovery',
  'active-operation',
  'attached',
  'fenced',
  'shared',
  'unreachable',
  'undetermined'
])

export interface Reachability {
  kind: ReachabilityKind
  /** Whether anything can still reach the artifact. Meaningless unless `known`. */
  reachable: boolean
  /** Whether reachability was established at all. */
  known: boolean
  detail: string
}

export const zReachability = z.object({
  kind: zReachabilityKind,
  reachable: z.boolean(),
  known: z.boolean(),
  detail: z.string()
})

export interface HotelArtifact {
  /** Stable identity within its kind: the engine's name, or the route's Room. */
  id: string
  kind: HotelArtifactKind
  scope: HotelArtifactScope
  roomId: string | null
  /** Bytes this artifact costs the Host. Zero for things that cost no storage. */
  sizeBytes: number
  /** False when the size could not be established; blocks bounded collection. */
  sizeKnown: boolean
  ownership: OwnershipProof
  reachability: Reachability
  /**
   * The single GC gate. True only when ownership is proved, reachability is
   * known, nothing reaches it, and its cost is known well enough to bound the
   * collection. Callers must read this rather than re-deriving it.
   */
  collectable: boolean
  /** Why `collectable` came out the way it did, in words a user can act on. */
  reason: string
}

export const zHotelArtifact = z.object({
  id: z.string(),
  kind: zHotelArtifactKind,
  scope: zHotelArtifactScope,
  roomId: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sizeKnown: z.boolean(),
  ownership: zOwnershipProof,
  reachability: zReachability,
  collectable: z.boolean(),
  reason: z.string()
})

export interface FootprintTotals {
  artifactCount: number
  bytes: number
  /** Artifacts whose ownership DevHotel can prove. */
  ownedCount: number
  ownedBytes: number
  collectableCount: number
  collectableBytes: number
  /** Artifacts held back because something about them could not be established. */
  undeterminedCount: number
}

export const zFootprintTotals = z.object({
  artifactCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  ownedCount: z.number().int().nonnegative(),
  ownedBytes: z.number().int().nonnegative(),
  collectableCount: z.number().int().nonnegative(),
  collectableBytes: z.number().int().nonnegative(),
  undeterminedCount: z.number().int().nonnegative()
})

export interface RoomFootprint {
  roomId: string
  /** Null when artifacts carry this Room's identity but no Room record does. */
  exists: boolean
  totals: FootprintTotals
  artifactIds: string[]
}

export const zRoomFootprint = z.object({
  roomId: z.string(),
  exists: z.boolean(),
  totals: zFootprintTotals,
  artifactIds: z.array(z.string())
})

export interface HostFootprint {
  observedAt: string
  /** Which Room executor produced these observations. */
  runtimeMode: 'managed' | 'compatibility' | 'unknown'
  artifacts: HotelArtifact[]
  byKind: Record<HotelArtifactKind, FootprintTotals>
  rooms: RoomFootprint[]
  /** Hotel-scoped artifacts: shared caches and anything not attributable to a Room. */
  hotel: FootprintTotals
  totals: FootprintTotals
  /**
   * Every observation the engine reported appears in `artifacts` exactly once.
   * False means the inventory is partial, and a partial inventory must never
   * authorize collection — you cannot prove a thing is unreachable from a list
   * that does not contain everything that could reach it.
   */
  complete: boolean
  /** Why `complete` is false, when it is. */
  incompleteReasons: string[]
}

export const zHostFootprint = z.object({
  observedAt: z.string(),
  runtimeMode: z.enum(['managed', 'compatibility', 'unknown']),
  artifacts: z.array(zHotelArtifact),
  byKind: z.record(zHotelArtifactKind, zFootprintTotals),
  rooms: z.array(zRoomFootprint),
  hotel: zFootprintTotals,
  totals: zFootprintTotals,
  complete: z.boolean(),
  incompleteReasons: z.array(z.string())
})

/* --------------------------------- quotas -------------------------------- */

/**
 * Limits DevHotel places on itself.
 *
 * Quotas never delete anything. They refuse to *create* — one more workspace
 * generation, one more Room, one more ingress route — and they say which limit
 * refused and by how much. Deleting is GC's job and GC needs proof; a quota has
 * none, so letting a quota delete would be exactly the bug this issue is about.
 */
export interface LifecycleQuotas {
  /** Durable bytes one Room may hold across all its disks. */
  maxRoomBytes: number
  /** Owned artifacts one Room may hold. */
  maxRoomArtifacts: number
  /** Published workspace generations retained for one Room. */
  maxRoomWorkspaceGenerations: number
  /** Durable bytes the whole Hotel may hold. */
  maxHotelBytes: number
  maxHotelArtifacts: number
  /** Concurrent Host ingress ports. */
  maxIngressRoutes: number
}

export const zLifecycleQuotas = z.object({
  maxRoomBytes: z.number().int().positive(),
  maxRoomArtifacts: z.number().int().positive(),
  maxRoomWorkspaceGenerations: z.number().int().positive(),
  maxHotelBytes: z.number().int().positive(),
  maxHotelArtifacts: z.number().int().positive(),
  maxIngressRoutes: z.number().int().positive()
})

export type QuotaLimit = keyof LifecycleQuotas

export const zQuotaLimit = z.enum([
  'maxRoomBytes',
  'maxRoomArtifacts',
  'maxRoomWorkspaceGenerations',
  'maxHotelBytes',
  'maxHotelArtifacts',
  'maxIngressRoutes'
])

export interface QuotaBreach {
  limit: QuotaLimit
  scope: HotelArtifactScope
  /** The Room the limit applies to, or null for a Hotel-wide limit. */
  roomId: string | null
  allowed: number
  observed: number
  detail: string
}

export const zQuotaBreach = z.object({
  limit: zQuotaLimit,
  scope: zHotelArtifactScope,
  roomId: z.string().nullable(),
  allowed: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  detail: z.string()
})

export interface QuotaVerdict {
  ok: boolean
  breaches: QuotaBreach[]
  /**
   * False when the footprint the verdict was computed from was incomplete. An
   * incomplete footprint can only *understate* usage, so a clean verdict from
   * one is not evidence of headroom.
   */
  conclusive: boolean
}

export const zQuotaVerdict = z.object({
  ok: z.boolean(),
  breaches: z.array(zQuotaBreach),
  conclusive: z.boolean()
})

/* ----------------------------- reconciliation ---------------------------- */

/**
 * What a reboot or a crash leaves to settle.
 *
 * Reconciliation used to be a walk through the Rooms that acted as it went, so
 * "what will DevHotel do to my Rooms at startup" could only be answered by
 * letting it happen. Here the decision and the doing are separated: planning is
 * a pure function of an observed snapshot, so the plan can be shown, logged,
 * diffed between two versions, and asserted against in a test without an engine
 * anywhere near it.
 */
export type ReconcileActionKind =
  /** Finish a delete that was interrupted part-way. */
  | 'resume-delete'
  /** Remove a container that no live Room can claim. */
  | 'remove-container'
  /** Remove a network that no live Room can claim. */
  | 'remove-network'
  /** Take a surviving Room network back under allocator tracking. */
  | 'adopt-network'
  /** Close a Host port whose Room is not awake. */
  | 'revoke-ingress'
  /** Stop every workload of a Room and record it asleep. */
  | 'sleep-room'
  /** Stop a Room's workloads without claiming it is healthy. */
  | 'stop-room'
  /** Record a Room as broken: it was interrupted somewhere unresumable. */
  | 'mark-broken'
  /** Deliberately leave something alone, and say why. */
  | 'preserve'

export const zReconcileActionKind = z.enum([
  'resume-delete',
  'remove-container',
  'remove-network',
  'adopt-network',
  'revoke-ingress',
  'sleep-room',
  'stop-room',
  'mark-broken',
  'preserve'
])

export interface ReconcileAction {
  kind: ReconcileActionKind
  /** What the action acts on: an artifact id, or the Room id for Room-level actions. */
  target: string
  roomId: string | null
  reason: string
}

export const zReconcileAction = z.object({
  kind: zReconcileActionKind,
  target: z.string(),
  roomId: z.string().nullable(),
  reason: z.string()
})

export interface ReconcilePlan {
  actions: ReconcileAction[]
  /**
   * Digest of the ordered actions. Two planners that agree produce the same
   * digest, and a plan replayed against the state it produced yields a plan
   * whose only actions are `preserve` — which is what "deterministic" has to
   * mean to be worth asserting.
   */
  digest: string
}

export const zReconcilePlan = z.object({
  actions: z.array(zReconcileAction),
  digest: z.string()
})

/* --------------------------------- GC ------------------------------------ */

export interface HostGcBounds {
  /** Hard cap on artifacts removed in one pass. */
  maxArtifacts: number
  /** Hard cap on bytes reclaimed in one pass. */
  maxBytes: number
}

export const zHostGcBounds = z.object({
  maxArtifacts: z.number().int().positive().max(500),
  maxBytes: z.number().int().positive()
})

export interface HostGcRefusal {
  artifactId: string
  reason: string
}

export const zHostGcRefusal = z.object({
  artifactId: z.string(),
  reason: z.string()
})

export interface HostGcPlan {
  /** Only artifacts that carry both proofs and fit inside the bounds. */
  collect: HotelArtifact[]
  /** Everything considered and declined, with the proof that was missing. */
  refused: HostGcRefusal[]
  plannedBytes: number
  /** False when the footprint was incomplete; a refusal to plan at all. */
  authorized: boolean
  authorizationDetail: string
}

export const zHostGcPlan = z.object({
  collect: z.array(zHotelArtifact),
  refused: z.array(zHostGcRefusal),
  plannedBytes: z.number().int().nonnegative(),
  authorized: z.boolean(),
  authorizationDetail: z.string()
})

export interface HostGcResult {
  dryRun: boolean
  plan: HostGcPlan
  collectedIds: string[]
  reclaimedBytes: number
  errors: string[]
}

export const zHostGcResult = z.object({
  dryRun: z.boolean(),
  plan: zHostGcPlan,
  collectedIds: z.array(z.string()),
  reclaimedBytes: z.number().int().nonnegative(),
  errors: z.array(z.string())
})

export const zHostGcBody = z
  .object({
    dryRun: z.boolean().optional(),
    maxArtifacts: z.number().int().positive().max(500).optional(),
    maxBytes: z.number().int().positive().optional()
  })
  .superRefine((value, ctx) => {
    if (value.dryRun !== false) return
    if (value.maxArtifacts === undefined) {
      ctx.addIssue({ code: 'custom', path: ['maxArtifacts'], message: 'Real Host GC requires an explicit maxArtifacts bound' })
    }
    if (value.maxBytes === undefined) {
      ctx.addIssue({ code: 'custom', path: ['maxBytes'], message: 'Real Host GC requires an explicit maxBytes bound' })
    }
  })
