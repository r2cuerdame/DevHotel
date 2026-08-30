import { z } from 'zod'

/**
 * Shared Android Device Broker contract.
 *
 * A physical Android phone on the Host is a scarce Hotel resource, not a Room
 * resource: several Rooms want the same USB phone and `adb` has no notion of
 * ownership, so two projects installing at once silently overwrite each other's
 * app, focus and logs. The broker gives that phone to exactly one Room at a
 * time and makes everyone else wait in a visible queue.
 *
 * A Room-owned emulator is deliberately NOT part of this contract. Each Android
 * Room runs its own emulator sidecar inside its own network namespace, so it is
 * already exclusive and must never consume the physical queue.
 */

export const zAdbSerial = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'valid adb serial')
export const zDeviceId = z.string().regex(/^d[a-f0-9]{32}$/, 'valid opaque device ID')
export const zDeviceNickname = z.string().trim().min(1).max(60).regex(/^[^\p{C}]+$/u, 'printable nickname')

/** How the device is attached. Only `usb` and `wireless` are brokered. */
export const zDeviceConnection = z.enum(['usb', 'wireless', 'emulator'])
export const zDeviceHealth = z.enum(['ready', 'unauthorized', 'offline', 'disconnected'])

/**
 * Why a Room wants the phone. Recorded on the lease so a waiting project can
 * see whether it is blocked behind a release gate or a routine smoke run.
 */
export const zLeasePurpose = z.enum([
  'smoke',
  'acceptance',
  'notification',
  'keyboard',
  'background',
  'sensor',
  'battery',
  'other'
])

export const zLeaseState = z.enum(['active', 'released', 'expired', 'revoked'])
export const zQueueState = z.enum(['waiting', 'granted', 'cancelled'])

export const zDeviceConstraints = z
  .object({
    deviceId: zDeviceId.optional(),
    nickname: zDeviceNickname.optional(),
    minApiLevel: z.number().int().min(1).max(100).optional(),
    connection: z.enum(['usb', 'wireless']).optional()
  })
  .strict()

/** Ceiling values keep a runaway lease from parking the phone for a whole day. */
export const LEASE_DEFAULT_TTL_MS = 90_000
export const LEASE_MAX_TTL_MS = 15 * 60_000
export const LEASE_DEFAULT_MAX_DURATION_MS = 30 * 60_000
export const LEASE_ABSOLUTE_MAX_DURATION_MS = 4 * 60 * 60_000
/** How long a dead owner's lease is held before the phone is reclaimed. */
export const LEASE_DEFAULT_GRACE_MS = 30_000

export const zDeviceRequest = z
  .object({
    roomId: z.string().regex(/^[a-z0-9]{8}$/, 'valid Room ID'),
    project: z.string().trim().min(1).max(100),
    purpose: zLeasePurpose,
    workerId: z.string().trim().min(1).max(200),
    issueRef: z.string().trim().min(1).max(120).nullable().optional(),
    runId: z.string().trim().min(1).max(200).nullable().optional(),
    constraints: zDeviceConstraints.optional(),
    priority: z.number().int().min(0).max(100).optional(),
    ttlMs: z.number().int().min(5_000).max(LEASE_MAX_TTL_MS).optional(),
    maxDurationMs: z.number().int().min(60_000).max(LEASE_ABSOLUTE_MAX_DURATION_MS).optional()
  })
  .strict()
export type DeviceRequest = z.infer<typeof zDeviceRequest>

export type DeviceConnection = z.infer<typeof zDeviceConnection>
export type DeviceHealth = z.infer<typeof zDeviceHealth>
export type LeasePurpose = z.infer<typeof zLeasePurpose>
export type LeaseState = z.infer<typeof zLeaseState>
export type QueueState = z.infer<typeof zQueueState>
export type DeviceConstraints = z.infer<typeof zDeviceConstraints>

export interface AndroidDevice {
  id: string
  serial: string
  nickname: string
  model: string | null
  androidVersion: string | null
  apiLevel: number | null
  connection: DeviceConnection
  health: DeviceHealth
  firstSeenAt: string
  lastSeenAt: string
}

/** Public device identity. The raw adb serial stays inside the Host broker. */
export type AndroidDeviceSummary = Omit<AndroidDevice, 'serial'>

export interface DeviceLease {
  id: string
  deviceId: string
  roomId: string
  project: string
  issueRef: string | null
  runId: string | null
  workerId: string
  purpose: LeasePurpose
  state: LeaseState
  acquiredAt: string
  heartbeatAt: string
  /** Last time the owner reported real device work, so a long instrumentation
   * run is not cut off by a plain wall-clock timeout. */
  activityAt: string
  ttlMs: number
  maxDurationMs: number
  releasedAt: string | null
  releaseReason: string | null
}

/** Non-capability lease facts safe for Room inspection and UI surfaces. */
export interface RoomDeviceLeaseSummary {
  deviceId: string
  project: string
  purpose: LeasePurpose
  state: LeaseState
  acquiredAt: string
}

export interface DeviceQueueEntry {
  id: string
  deviceId: string | null
  roomId: string
  project: string
  purpose: LeasePurpose
  workerId: string
  issueRef: string | null
  runId: string | null
  constraints: DeviceConstraints
  priority: number
  state: QueueState
  requestedAt: string
  resolvedAt: string | null
  ttlMs: number
  maxDurationMs: number
}

export type DeviceEventKind =
  | 'discovered'
  | 'disconnected'
  | 'reconnected'
  | 'granted'
  | 'queued'
  | 'released'
  | 'cancelled'
  | 'stale-recovered'
  | 'max-duration-warning'
  | 'max-duration-reclaimed'
  | 'pairing-succeeded'
  | 'pairing-failed'
  | 'denied'

export interface DeviceEvent {
  id: string
  deviceId: string | null
  roomId: string | null
  kind: DeviceEventKind
  detail: string
  at: string
}

/** Who currently holds the phone, in the form a waiting project needs to see. */
export interface DeviceLeaseOwner {
  roomId: string
  project: string
  purpose: LeasePurpose
  issueRef: string | null
  acquiredAt: string
  heartbeatAt: string
  leaseAgeMs: number
  lastHeartbeatAgeMs: number
}

export interface DeviceWaiter {
  roomId: string
  project: string
  purpose: LeasePurpose
  priority: number
  requestedAt: string
  waitedMs: number
}

export interface DeviceInventoryEntry extends AndroidDeviceSummary {
  brokered: boolean
  leaseOwner: DeviceLeaseOwner | null
  queueDepth: number
  waiters: DeviceWaiter[]
}

export type DeviceRequestResult =
  | { state: 'granted'; lease: DeviceLease; device: AndroidDeviceSummary }
  | {
      state: 'queued'
      requestId: string
      deviceId: string | null
      position: number
      owner: DeviceLeaseOwner | null
      reason: string
    }

export interface DeviceBrokerStatus {
  available: boolean
  detail: string
  devices: DeviceInventoryEntry[]
  recentEvents: DeviceEvent[]
}

/** Structured reasons an ADB operation was refused, so callers can branch. */
export type DeviceDenialCode =
  | 'no-lease'
  | 'lease-held-by-another-room'
  | 'lease-expired'
  | 'device-unknown'
  | 'device-unhealthy'
  | 'adb-command-forbidden'

export class DeviceLeaseError extends Error {
  constructor(
    readonly code: DeviceDenialCode,
    message: string
  ) {
    super(message)
    this.name = 'DeviceLeaseError'
  }
}

/**
 * What a Room may send when it asks for a phone. oomId comes from the route
 * and project from the Room record — a caller must not be able to book the
 * phone under someone else's project name.
 */
export const zAttachDeviceBody = zDeviceRequest.omit({ roomId: true, project: true }).strict()
export const zReleaseDeviceBody = z.object({ reason: z.string().trim().min(1).max(200).optional() }).strict()
export const zHeartbeatBody = z
  .object({ leaseId: z.string().uuid(), busy: z.boolean().optional() })
  .strict()
export const zDeviceNicknameBody = z.object({ nickname: zDeviceNickname }).strict()
export const zCancelRequestBody = z.object({ requestId: z.string().uuid() }).strict()
/** An ADB argv a Room may submit; the broker still decides whether it runs. */
export const zAgentAdbBody = z
  .object({
    args: z.array(z.string().max(4096)).min(1).max(64),
    timeoutMs: z.number().int().positive().max(600_000).optional()
  })
  .strict()
