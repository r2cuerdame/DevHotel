import { createHash } from 'node:crypto'
import type { PmKind, ProviderKind, RuntimeKind } from '@devhotel/shared'

export const WARM_SNAPSHOT_SCHEMA_VERSION = 1

export interface WarmRoomProfile {
  provider: Exclude<ProviderKind, 'windows'>
  runtime: { kind: RuntimeKind; version: string }
  packageManager: { kind: PmKind; version?: string }
  startCommand: string
  internalPort: number
  os: { env: Record<string, string>; cpus?: number; memoryMB?: number; timezone?: string }
  /** Android emulator identity is part of compatibility; it is never replaced by Firecracker. */
  android?: {
    device: string
    version: string
    resolution: 'native' | 'balanced' | 'fast'
    orientation: 'portrait' | 'landscape'
  }
}

export interface WarmRoomPoolPolicy {
  /** Number of ready claims retained for one exact profile. */
  slotsPerProfile: number
  /** Global profile bound. Least-recently-used profiles are invalidated first. */
  maxProfiles: number
  /** A profile must be proved ready again after this idle period. */
  maxIdleMs: number
}

export const DEFAULT_WARM_ROOM_POOL_POLICY: Readonly<WarmRoomPoolPolicy> = {
  slotsPerProfile: 2,
  maxProfiles: 4,
  maxIdleMs: 30 * 60 * 1000
}

export interface WarmSnapshotLease {
  profileKey: string
  snapshotVersion: string
  strategy: 'oci-layer-cow' | 'oci-layer-cow+avd-quickboot'
}

export interface WarmRoomPoolEntry extends WarmSnapshotLease {
  profile: WarmRoomProfile
  readySlots: number
  createdAt: string
  lastUsedAt: string
}

interface MutableWarmRoomPoolEntry extends WarmRoomPoolEntry {
  createdAtMs: number
  lastUsedAtMs: number
}

function stableProfile(profile: WarmRoomProfile): WarmRoomProfile {
  return {
    provider: profile.provider,
    runtime: { ...profile.runtime },
    packageManager: { ...profile.packageManager },
    startCommand: profile.startCommand,
    internalPort: profile.internalPort,
    os: {
      ...profile.os,
      env: Object.fromEntries(Object.entries(profile.os.env).sort(([a], [b]) => a.localeCompare(b)))
    },
    ...(profile.android ? { android: { ...profile.android } } : {})
  }
}

function validatePolicy(policy: WarmRoomPoolPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Warm Room pool ${name} must be a positive integer`)
    }
  }
}

/**
 * Readiness inventory for immutable runtime baselines.
 *
 * A slot does not own mutable Room data. It proves that the profile's immutable
 * OCI image (and, for Android, the image-backed AVD/SDK inputs) reached ready in
 * this process. Docker/managed-containerd then materializes each Room from those
 * layers with its native overlay/reflink snapshotter, while Android continues to
 * use KVM plus its per-Room AVD Quickboot state.
 */
export class WarmRoomPool {
  private readonly entries = new Map<string, MutableWarmRoomPoolEntry>()
  readonly policy: WarmRoomPoolPolicy

  constructor(
    private readonly runtimeVersion: string,
    policy: Partial<WarmRoomPoolPolicy> = {},
    private readonly now: () => number = Date.now
  ) {
    this.policy = { ...DEFAULT_WARM_ROOM_POOL_POLICY, ...policy }
    validatePolicy(this.policy)
  }

  profileKey(profile: WarmRoomProfile): string {
    return createHash('sha256').update(JSON.stringify(stableProfile(profile))).digest('hex').slice(0, 24)
  }

  snapshotVersion(profile: WarmRoomProfile): string {
    return createHash('sha256')
      .update(JSON.stringify({ schema: WARM_SNAPSHOT_SCHEMA_VERSION, runtimeVersion: this.runtimeVersion, profile: stableProfile(profile) }))
      .digest('hex')
  }

  /** Claim before allocation. No compatible slot means the caller takes the cold path. */
  claim(profile: WarmRoomProfile): WarmSnapshotLease | null {
    const now = this.now()
    this.cleanup(now)
    const key = this.profileKey(profile)
    const entry = this.entries.get(key)
    if (!entry || entry.snapshotVersion !== this.snapshotVersion(profile) || entry.readySlots === 0) return null
    entry.readySlots -= 1
    entry.lastUsedAtMs = now
    entry.lastUsedAt = new Date(now).toISOString()
    return {
      profileKey: entry.profileKey,
      snapshotVersion: entry.snapshotVersion,
      strategy: entry.strategy
    }
  }

  /**
   * A successfully app-ready Room proves its immutable baseline and caches.
   * Replenishment is metadata-only: OCI/AVD artifacts remain engine-owned and
   * are shared or cloned by the runtime rather than copied through JavaScript.
   */
  observeReady(profile: WarmRoomProfile): WarmRoomPoolEntry {
    const now = this.now()
    this.cleanup(now)
    const key = this.profileKey(profile)
    const version = this.snapshotVersion(profile)
    let entry = this.entries.get(key)
    if (!entry || entry.snapshotVersion !== version) {
      entry = {
        profileKey: key,
        snapshotVersion: version,
        strategy: profile.provider === 'android' ? 'oci-layer-cow+avd-quickboot' : 'oci-layer-cow',
        profile: stableProfile(profile),
        readySlots: 0,
        createdAt: new Date(now).toISOString(),
        lastUsedAt: new Date(now).toISOString(),
        createdAtMs: now,
        lastUsedAtMs: now
      }
      this.entries.set(key, entry)
    }
    entry.readySlots = Math.min(this.policy.slotsPerProfile, entry.readySlots + 1)
    entry.lastUsedAtMs = now
    entry.lastUsedAt = new Date(now).toISOString()
    this.trimProfiles()
    return this.publicEntry(entry)
  }

  /** Return an unmaterialized claim after allocation failed without invalidating its baseline. */
  release(lease: WarmSnapshotLease): void {
    const entry = this.entries.get(lease.profileKey)
    if (!entry || entry.snapshotVersion !== lease.snapshotVersion) return
    entry.readySlots = Math.min(this.policy.slotsPerProfile, entry.readySlots + 1)
  }

  status(): WarmRoomPoolEntry[] {
    this.cleanup(this.now())
    return [...this.entries.values()]
      .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs || a.profileKey.localeCompare(b.profileKey))
      .map((entry) => this.publicEntry(entry))
  }

  cleanup(now = this.now()): string[] {
    const removed: string[] = []
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAtMs < this.policy.maxIdleMs) continue
      this.entries.delete(key)
      removed.push(key)
    }
    return removed
  }

  private trimProfiles(): void {
    if (this.entries.size <= this.policy.maxProfiles) return
    const oldest = [...this.entries.values()]
      .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs || a.createdAtMs - b.createdAtMs)
    for (const entry of oldest.slice(0, this.entries.size - this.policy.maxProfiles)) {
      this.entries.delete(entry.profileKey)
    }
  }

  private publicEntry(entry: MutableWarmRoomPoolEntry): WarmRoomPoolEntry {
    return {
      profileKey: entry.profileKey,
      snapshotVersion: entry.snapshotVersion,
      strategy: entry.strategy,
      profile: stableProfile(entry.profile),
      readySlots: entry.readySlots,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt
    }
  }
}
