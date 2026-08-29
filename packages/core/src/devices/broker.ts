import {
  DeviceLeaseError,
  LEASE_DEFAULT_GRACE_MS,
  LEASE_DEFAULT_MAX_DURATION_MS,
  LEASE_DEFAULT_TTL_MS,
  zDeviceRequest,
  type AndroidDevice,
  type DeviceBrokerStatus,
  type DeviceEvent,
  type DeviceInventoryEntry,
  type DeviceLease,
  type DeviceLeaseOwner,
  type DeviceQueueEntry,
  type DeviceRequest,
  type DeviceRequestResult,
  type DeviceWaiter
} from '@devhotel/shared'
import type { AndroidDevicesRepo } from '../store/androidDevicesRepo'
import { classifyAdbCommand } from './adbOperations'
import { connectionForSerial, defaultNickname, deviceIdForSerial, healthForState, readDeviceProps, type AdbHost } from './adbHost'

export interface DeviceBrokerOptions {
  repo: AndroidDevicesRepo
  adb: AdbHost
  now?: () => number
  /**
   * Whether the Room/worker that took a lease is still alive. A silent
   * heartbeat alone must not reclaim a phone from a Room that is merely busy;
   * only a heartbeat gap *and* a dead owner does.
   */
  ownerLiveness?: (lease: DeviceLease) => Promise<boolean> | boolean
  graceMs?: number
}

/** What the broker reclaimed on this sweep, for the operator-visible history. */
export interface ReapResult {
  recovered: { lease: DeviceLease; reason: string; promoted: DeviceLease | null }[]
  warnings: DeviceEvent[]
}

const MAX_DURATION_WARN_RATIO = 0.8

/**
 * The Android Device Broker.
 *
 * One physical phone, many Rooms. The broker is the only writer of the lease
 * table, so "who owns the phone" has a single answer, and every interfering ADB
 * operation has to present a live lease before it runs. A Room-owned emulator
 * never enters this pool — it is already exclusive to its Room, and making it
 * queue would put routine development behind a release gate for no reason.
 */
export class AndroidDeviceBroker {
  private readonly repo: AndroidDevicesRepo
  private readonly adb: AdbHost
  private readonly now: () => number
  private readonly ownerLiveness: (lease: DeviceLease) => Promise<boolean> | boolean
  private readonly graceMs: number
  /** When a dead owner was first observed, so the grace period is real time. */
  private readonly deathObservedAt = new Map<string, number>()
  private lastAvailability: { ok: boolean; detail: string } = { ok: false, detail: 'not probed yet' }

  constructor(opts: DeviceBrokerOptions) {
    this.repo = opts.repo
    this.adb = opts.adb
    this.now = opts.now ?? (() => Date.now())
    this.ownerLiveness = opts.ownerLiveness ?? (() => true)
    this.graceMs = opts.graceMs ?? LEASE_DEFAULT_GRACE_MS
  }

  /** The Host adb, for callers that already passed `authorize` above. */
  get hostAdb(): AdbHost {
    return this.adb
  }

  private at(): string {
    return new Date(this.now()).toISOString()
  }

  /** Only USB/wireless phones are shared; emulators belong to one Room already. */
  private brokered(device: AndroidDevice): boolean {
    return device.connection !== 'emulator'
  }

  async refreshInventory(): Promise<DeviceInventoryEntry[]> {
    this.lastAvailability = await this.adb.available()
    if (!this.lastAvailability.ok) return this.listDevices()

    let lines: Awaited<ReturnType<AdbHost['devices']>>
    try {
      lines = await this.adb.devices()
    } catch (err) {
      this.lastAvailability = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      return this.listDevices()
    }

    const at = this.at()
    const seen = new Set<string>()
    for (const line of lines) {
      const id = deviceIdForSerial(line.serial)
      seen.add(id)
      const connection = connectionForSerial(line.serial)
      const health = healthForState(line.state)
      const known = this.repo.getDevice(id)
      // Properties need an authorized device; an unauthorized phone still
      // belongs in the inventory so the user can see why it is unusable.
      const props =
        health === 'ready' && (!known || known.apiLevel === null)
          ? await readDeviceProps(this.adb, line.serial)
          : { androidVersion: known?.androidVersion ?? null, apiLevel: known?.apiLevel ?? null, model: known?.model ?? null }
      const model = props.model ?? line.model ?? known?.model ?? null
      this.repo.upsertDevice({
        id,
        serial: line.serial,
        nickname: known?.nickname ?? defaultNickname(model, connection, this.repo.listDevices()),
        model,
        androidVersion: props.androidVersion,
        apiLevel: props.apiLevel,
        connection,
        health,
        seenAt: at
      })
      if (!known) {
        this.repo.recordEvent({ deviceId: id, roomId: null, kind: 'discovered', detail: `${model ?? 'Android device'} (${connection})`, at })
      } else if (known.health === 'disconnected' && health !== 'disconnected') {
        this.repo.recordEvent({ deviceId: id, roomId: null, kind: 'reconnected', detail: `back as ${health}`, at })
      }
    }

    for (const device of this.repo.listDevices()) {
      if (seen.has(device.id) || device.health === 'disconnected') continue
      this.repo.markHealth(device.id, 'disconnected', at)
      this.repo.recordEvent({ deviceId: device.id, roomId: null, kind: 'disconnected', detail: `${device.nickname} left the bus`, at })
      // A phone that unplugs cannot keep serving its owner, and a reconnect
      // must never resurrect that owner: drop the lease now and let the queue
      // decide who gets the device when it comes back.
      const lease = this.repo.activeLease(device.id)
      if (lease) {
        this.repo.closeLease(lease.id, 'revoked', at, 'device disconnected')
        this.deathObservedAt.delete(lease.id)
        this.repo.recordEvent({
          deviceId: device.id,
          roomId: lease.roomId,
          kind: 'stale-recovered',
          detail: `lease revoked because ${device.nickname} disconnected`,
          at
        })
      }
    }
    return this.listDevices()
  }

  listDevices(): DeviceInventoryEntry[] {
    return this.repo.listDevices().map((device) => this.describe(device))
  }

  private describe(device: AndroidDevice): DeviceInventoryEntry {
    const lease = this.repo.activeLease(device.id)
    const waiters = this.brokered(device) ? this.repo.waiting(device.id) : []
    return {
      ...device,
      brokered: this.brokered(device),
      leaseOwner: lease ? this.owner(lease) : null,
      queueDepth: waiters.length,
      waiters: waiters.map((entry) => this.waiter(entry))
    }
  }

  private owner(lease: DeviceLease): DeviceLeaseOwner {
    const now = this.now()
    return {
      leaseId: lease.id,
      roomId: lease.roomId,
      project: lease.project,
      purpose: lease.purpose,
      issueRef: lease.issueRef,
      acquiredAt: lease.acquiredAt,
      heartbeatAt: lease.heartbeatAt,
      leaseAgeMs: now - Date.parse(lease.acquiredAt),
      lastHeartbeatAgeMs: now - Date.parse(lease.heartbeatAt)
    }
  }

  private waiter(entry: DeviceQueueEntry): DeviceWaiter {
    return {
      requestId: entry.id,
      roomId: entry.roomId,
      project: entry.project,
      purpose: entry.purpose,
      priority: entry.priority,
      requestedAt: entry.requestedAt,
      waitedMs: this.now() - Date.parse(entry.requestedAt)
    }
  }

  setNickname(deviceId: string, nickname: string): AndroidDevice {
    return this.repo.setNickname(deviceId, nickname)
  }

  private matches(device: AndroidDevice, constraints: DeviceRequest['constraints']): boolean {
    if (!this.brokered(device)) return false
    if (!constraints) return true
    if (constraints.deviceId && constraints.deviceId !== device.id) return false
    if (constraints.nickname && constraints.nickname !== device.nickname) return false
    if (constraints.connection && constraints.connection !== device.connection) return false
    if (constraints.minApiLevel !== undefined && (device.apiLevel ?? 0) < constraints.minApiLevel) return false
    return true
  }

  /** Devices this request could ever run on, healthy or not. */
  private candidates(constraints: DeviceRequest['constraints']): AndroidDevice[] {
    return this.repo.listDevices().filter((device) => this.matches(device, constraints))
  }

  /**
   * Ask for a phone. A busy phone queues rather than fails: a project that
   * cannot see its place in line has no way to tell "taken for 30 seconds"
   * apart from "broken".
   */
  async requestDevice(rawRequest: DeviceRequest): Promise<DeviceRequestResult> {
    const request = zDeviceRequest.parse(rawRequest)
    const at = this.at()
    const ttlMs = request.ttlMs ?? LEASE_DEFAULT_TTL_MS
    const maxDurationMs = request.maxDurationMs ?? LEASE_DEFAULT_MAX_DURATION_MS

    const existingLease = this.repo.activeLeaseForRoom(request.roomId)
    if (existingLease) {
      const device = this.repo.getDevice(existingLease.deviceId)!
      if (this.matches(device, request.constraints)) return { state: 'granted', lease: existingLease, device }
      throw new DeviceLeaseError(
        'lease-held-by-another-room',
        `Room ${request.roomId} already holds ${device.nickname}. Release it before requesting a different device.`
      )
    }

    const candidates = this.candidates(request.constraints)
    if (candidates.length === 0) {
      this.repo.recordEvent({ deviceId: null, roomId: request.roomId, kind: 'denied', detail: 'no device matches the requested constraints', at })
      throw new DeviceLeaseError('device-unknown', 'No connected Android device matches this request.')
    }

    const free = candidates.find((device) => device.health === 'ready' && !this.repo.activeLease(device.id))
    if (free) {
      const lease = this.repo.insertLease({
        deviceId: free.id,
        roomId: request.roomId,
        project: request.project,
        issueRef: request.issueRef ?? null,
        runId: request.runId ?? null,
        workerId: request.workerId,
        purpose: request.purpose,
        at,
        ttlMs,
        maxDurationMs
      })
      this.repo.recordEvent({
        deviceId: free.id,
        roomId: request.roomId,
        kind: 'granted',
        detail: `${request.project} took ${free.nickname} for ${request.purpose}`,
        at
      })
      return { state: 'granted', lease, device: free }
    }

    // Pin the queue to a specific device only when the request named one;
    // otherwise the entry stays free to be promoted by whichever phone frees up.
    const pinned = request.constraints?.deviceId ?? (candidates.length === 1 ? candidates[0]!.id : null)
    const existingEntry = this.repo.waitingForRoom(request.roomId, pinned)
    const entry =
      existingEntry ??
      this.repo.enqueue({
        deviceId: pinned,
        roomId: request.roomId,
        project: request.project,
        purpose: request.purpose,
        workerId: request.workerId,
        issueRef: request.issueRef ?? null,
        runId: request.runId ?? null,
        constraints: request.constraints ?? {},
        priority: request.priority ?? 0,
        at,
        ttlMs,
        maxDurationMs
      })
    if (!existingEntry) {
      this.repo.recordEvent({ deviceId: pinned, roomId: request.roomId, kind: 'queued', detail: `${request.project} is waiting for ${request.purpose}`, at })
    }

    const blocking = candidates.find((device) => this.repo.activeLease(device.id)) ?? candidates[0]!
    const holder = this.repo.activeLease(blocking.id)
    const queue = this.repo.waiting(pinned ?? blocking.id)
    const position = queue.findIndex((candidate) => candidate.id === entry.id) + 1
    return {
      state: 'queued',
      requestId: entry.id,
      deviceId: pinned,
      position,
      owner: holder ? this.owner(holder) : null,
      reason: holder
        ? `${blocking.nickname} is held by ${holder.project} (Room ${holder.roomId}) for ${holder.purpose}`
        : `${blocking.nickname} is ${blocking.health}`
    }
  }

  heartbeat(leaseId: string, opts: { busy?: boolean } = {}): DeviceLease {
    const at = this.at()
    const lease = this.repo.touchLease(leaseId, at, opts.busy ? at : null)
    this.deathObservedAt.delete(leaseId)
    return lease
  }

  async release(leaseId: string, reason = 'released'): Promise<{ lease: DeviceLease; promoted: DeviceLease | null }> {
    const lease = this.repo.getLease(leaseId)
    if (!lease) throw new DeviceLeaseError('device-unknown', `unknown lease: ${leaseId}`)
    if (lease.state !== 'active') return { lease, promoted: null }
    return this.close(lease, 'released', reason)
  }

  /** Releasing by Room is what Room stop/delete needs — it has no lease ID. */
  async releaseRoom(roomId: string, reason = 'room released the device'): Promise<{ lease: DeviceLease; promoted: DeviceLease | null } | null> {
    const lease = this.repo.activeLeaseForRoom(roomId)
    // A Room that goes away should not keep its place in line either.
    for (const entry of this.repo.waiting(null)) {
      if (entry.roomId === roomId) this.repo.resolveQueueEntry(entry.id, 'cancelled', this.at())
    }
    if (!lease) return null
    return this.close(lease, 'released', reason)
  }

  private async close(
    lease: DeviceLease,
    state: 'released' | 'expired' | 'revoked',
    reason: string
  ): Promise<{ lease: DeviceLease; promoted: DeviceLease | null }> {
    const at = this.at()
    // Deliberately no `pm clear`, `uninstall`, or data wipe here. What the
    // previous project verified stays installed so a human can open it, and the
    // next lease inherits the phone as it was left.
    const closed = this.repo.closeLease(lease.id, state, at, reason)
    this.deathObservedAt.delete(lease.id)
    this.repo.recordEvent({
      deviceId: lease.deviceId,
      roomId: lease.roomId,
      kind: state === 'released' ? 'released' : 'stale-recovered',
      detail: reason,
      at
    })
    return { lease: closed, promoted: this.promote(lease.deviceId) }
  }

  /** Give a just-freed phone to the best waiting request, if any. */
  private promote(deviceId: string): DeviceLease | null {
    const device = this.repo.getDevice(deviceId)
    if (!device || device.health !== 'ready' || this.repo.activeLease(deviceId)) return null
    const at = this.at()
    for (const entry of this.repo.waiting(deviceId)) {
      if (!this.matches(device, entry.constraints)) continue
      if (this.repo.activeLeaseForRoom(entry.roomId)) continue
      this.repo.resolveQueueEntry(entry.id, 'granted', at)
      const lease = this.repo.insertLease({
        deviceId,
        roomId: entry.roomId,
        project: entry.project,
        issueRef: entry.issueRef,
        runId: entry.runId,
        workerId: entry.workerId,
        purpose: entry.purpose,
        at,
        ttlMs: entry.ttlMs,
        maxDurationMs: entry.maxDurationMs
      })
      this.repo.recordEvent({
        deviceId,
        roomId: entry.roomId,
        kind: 'granted',
        detail: `${entry.project} was promoted from the queue onto ${device.nickname}`,
        at
      })
      return lease
    }
    return null
  }

  cancelRequest(requestId: string): DeviceQueueEntry {
    return this.repo.resolveQueueEntry(requestId, 'cancelled', this.at())
  }

  /**
   * Reclaim phones whose owner died or overran, then hand them to the queue.
   *
   * A missed heartbeat alone is not death: a Room can be mid-`gradlew
   * connectedAndroidTest` with the process very much alive. The phone is taken
   * back only when the owner is gone and stays gone through the grace period,
   * or when the lease overran its maximum with no reported activity.
   */
  async reap(): Promise<ReapResult> {
    const now = this.now()
    const at = this.at()
    const result: ReapResult = { recovered: [], warnings: [] }
    for (const lease of this.repo.listActiveLeases()) {
      const heartbeatAgeMs = now - Date.parse(lease.heartbeatAt)
      const leaseAgeMs = now - Date.parse(lease.acquiredAt)
      const activityAgeMs = now - Date.parse(lease.activityAt)

      if (heartbeatAgeMs > lease.ttlMs) {
        const live = await this.ownerLiveness(lease)
        if (!live) {
          const firstSeen = this.deathObservedAt.get(lease.id) ?? now
          this.deathObservedAt.set(lease.id, firstSeen)
          if (now - firstSeen >= this.graceMs) {
            const reason = `owner gone: no heartbeat for ${Math.round(heartbeatAgeMs / 1000)}s and the worker is not running`
            result.recovered.push({ ...(await this.close(lease, 'expired', reason)), reason })
            continue
          }
        } else {
          this.deathObservedAt.delete(lease.id)
        }
      }

      if (leaseAgeMs > lease.maxDurationMs) {
        // Still reporting real device work? Warn instead of cutting an
        // instrumentation run or an OS dialog off at the knees.
        if (activityAgeMs <= lease.ttlMs) {
          result.warnings.push(
            this.repo.recordEvent({
              deviceId: lease.deviceId,
              roomId: lease.roomId,
              kind: 'max-duration-warning',
              detail: `${lease.project} passed its ${Math.round(lease.maxDurationMs / 60_000)}min maximum but is still active`,
              at
            })
          )
          continue
        }
        const reason = `maximum lease time of ${Math.round(lease.maxDurationMs / 60_000)}min exceeded with no device activity`
        this.repo.recordEvent({ deviceId: lease.deviceId, roomId: lease.roomId, kind: 'max-duration-reclaimed', detail: reason, at })
        result.recovered.push({ ...(await this.close(lease, 'expired', reason)), reason })
        continue
      }

      if (leaseAgeMs > lease.maxDurationMs * MAX_DURATION_WARN_RATIO && leaseAgeMs - 60_000 <= lease.maxDurationMs * MAX_DURATION_WARN_RATIO) {
        result.warnings.push(
          this.repo.recordEvent({
            deviceId: lease.deviceId,
            roomId: lease.roomId,
            kind: 'max-duration-warning',
            detail: `${lease.project} is approaching its maximum lease time`,
            at
          })
        )
      }
    }
    return result
  }

  leaseForRoom(roomId: string): DeviceLease | null {
    return this.repo.activeLeaseForRoom(roomId)
  }

  /**
   * The fail-closed gate. An ADB command that can change the phone's state runs
   * only for the Room that holds a live lease on it; everything else gets a
   * structured refusal instead of a silent collision.
   */
  authorize(roomId: string, deviceId: string, argv: string[]): { serial: string; device: AndroidDevice } {
    const device = this.repo.getDevice(deviceId)
    if (!device) throw new DeviceLeaseError('device-unknown', `unknown Android device: ${deviceId}`)

    const classification = classifyAdbCommand(argv)
    if (!this.brokered(device)) return { serial: device.serial, device }
    if (!classification.interfering) return { serial: device.serial, device }

    if (device.health !== 'ready') {
      throw new DeviceLeaseError('device-unhealthy', `${device.nickname} is ${device.health} — it cannot accept ${classification.reason}.`)
    }
    const lease = this.repo.activeLease(deviceId)
    if (!lease) {
      throw new DeviceLeaseError(
        'no-lease',
        `${classification.reason} needs a device lease. Attach ${device.nickname} to Room ${roomId} first.`
      )
    }
    if (lease.roomId !== roomId) {
      throw new DeviceLeaseError(
        'lease-held-by-another-room',
        `${device.nickname} is leased by ${lease.project} (Room ${lease.roomId}) for ${lease.purpose}. ${classification.reason} is refused.`
      )
    }
    if (this.now() - Date.parse(lease.heartbeatAt) > lease.ttlMs) {
      throw new DeviceLeaseError('lease-expired', `The lease on ${device.nickname} went stale — heartbeat it or take it again before ${classification.reason}.`)
    }
    return { serial: device.serial, device }
  }

  status(): DeviceBrokerStatus {
    return {
      available: this.lastAvailability.ok,
      detail: this.lastAvailability.detail,
      devices: this.listDevices(),
      recentEvents: this.repo.recentEvents(25)
    }
  }
}
