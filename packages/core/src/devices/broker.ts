import { randomUUID } from 'node:crypto'
import {
  DeviceLeaseError,
  LEASE_DEFAULT_GRACE_MS,
  LEASE_DEFAULT_MAX_DURATION_MS,
  LEASE_DEFAULT_TTL_MS,
  zDeviceRequest,
  type AndroidDevice,
  type AndroidDeviceSummary,
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
import {
  connectionForSerial,
  defaultNickname,
  healthForState,
  readDeviceProps,
  readPhysicalDeviceIdentity,
  type AdbHost
} from './adbHost'
import { AdbPairingCoordinator, type PairingActionResult, type PairingDiscoveryResult } from './pairing'

export interface DeviceBrokerOptions {
  repo: AndroidDevicesRepo
  adb: AdbHost
  now?: () => number
  /**
   * Whether the Room/worker that took a lease is still alive. A silent
   * heartbeat alone must not reclaim a phone from a Room that is merely busy;
   * only a heartbeat gap *and* a dead owner does.
   */
  ownerLiveness?: (lease: DeviceLease) => Promise<boolean | 'unknown'> | boolean | 'unknown'
  /** Exact durable recovery ownership that must survive sweeps and reconnects. */
  recoveryProtected?: (lease: DeviceLease) => boolean
  /** Synchronous Room lifecycle fence used before a durable waiter is promoted. */
  roomEligible?: (roomId: string) => boolean
  graceMs?: number
  /** Test/internal override; candidates always remain process-local. */
  pairingCandidateTtlMs?: number
}

/** What the broker reclaimed on this sweep, for the operator-visible history. */
export interface ReapResult {
  recovered: { lease: DeviceLease; reason: string; promoted: DeviceLease | null }[]
  warnings: DeviceEvent[]
}

export interface AuthorizedAdbTarget {
  serial: string
  device: AndroidDevice
  /** Null only for a deliberately shared read that did not need a lease. */
  leaseId: string | null
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
  private readonly ownerLiveness: (lease: DeviceLease) => Promise<boolean | 'unknown'> | boolean | 'unknown'
  private readonly recoveryProtected: (lease: DeviceLease) => boolean
  private readonly roomEligible: (roomId: string) => boolean
  private readonly graceMs: number
  private readonly pairing: AdbPairingCoordinator
  /** When a dead owner was first observed, so the grace period is real time. */
  private readonly deathObservedAt = new Map<string, number>()
  private lastAvailability: { ok: boolean; detail: string } = { ok: false, detail: 'not probed yet' }
  /** A cached ready row is grantable only after the entire latest probe settled. */
  private inventoryGrantable = false
  /** Deduplicates refresh callers and lets a concurrent request join the probe. */
  private inventoryRefresh: Promise<DeviceInventoryEntry[]> | null = null

  constructor(opts: DeviceBrokerOptions) {
    this.repo = opts.repo
    this.adb = opts.adb
    this.now = opts.now ?? (() => Date.now())
    this.ownerLiveness = opts.ownerLiveness ?? (() => 'unknown')
    this.recoveryProtected = opts.recoveryProtected ?? (() => false)
    this.roomEligible = opts.roomEligible ?? (() => true)
    this.graceMs = opts.graceMs ?? LEASE_DEFAULT_GRACE_MS
    this.pairing = new AdbPairingCoordinator({
      adb: opts.adb,
      now: this.now,
      candidateTtlMs: opts.pairingCandidateTtlMs
    })
  }

  /** The Host adb, for callers that already passed `authorize` above. */
  get hostAdb(): AdbHost {
    return this.adb
  }

  private at(): string {
    return new Date(this.now()).toISOString()
  }

  private assertHostAdbAvailable(): void {
    if (this.lastAvailability.ok) return
    throw new DeviceLeaseError(
      'device-unhealthy',
      `Host ADB is unavailable, so no physical device can be leased or driven: ${this.lastAvailability.detail}`
    )
  }

  /** Only USB/wireless phones are shared; emulators belong to one Room already. */
  private brokered(device: AndroidDevice): boolean {
    return device.connection !== 'emulator'
  }

  async refreshInventory(): Promise<DeviceInventoryEntry[]> {
    if (this.inventoryRefresh) return this.inventoryRefresh
    this.inventoryGrantable = false
    const refresh = this.refreshInventoryOnce()
    this.inventoryRefresh = refresh
    try {
      return await refresh
    } catch (err) {
      this.inventoryGrantable = false
      this.lastAvailability = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      throw err
    } finally {
      if (this.inventoryRefresh === refresh) this.inventoryRefresh = null
    }
  }

  private async refreshInventoryOnce(): Promise<DeviceInventoryEntry[]> {
    let availability: { ok: boolean; detail: string }
    try {
      availability = await this.adb.available()
    } catch (err) {
      availability = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    if (!availability.ok) {
      this.lastAvailability = availability
      return this.listDevices()
    }

    let lines: Awaited<ReturnType<AdbHost['devices']>>
    try {
      lines = await this.adb.devices()
    } catch (err) {
      this.lastAvailability = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      return this.listDevices()
    }

    const at = this.at()
    const seen = new Set<string>()
    const identified: {
      line: (typeof lines)[number]
      connection: AndroidDevice['connection']
      health: AndroidDevice['health']
      physicalIdentity: string
    }[] = []

    for (const line of lines) {
      const connection = connectionForSerial(line.serial, line.usb)
      const health = healthForState(line.state)
      let physicalIdentity: string | null = null
      if (connection === 'emulator') {
        physicalIdentity = this.repo.physicalIdentity(line.serial, 'transport')
      } else if (health === 'ready') {
        const rawIdentity = await readPhysicalDeviceIdentity(this.adb, line.serial)
        if (!rawIdentity) {
          // A ready transport without a stable identity might be an alternate
          // route to an already-known handset. Fail the whole inventory fence
          // closed rather than minting a second independently leasable row.
          this.lastAvailability = {
            ok: false,
            detail: 'Host ADB could not verify a stable physical-device identity; reconnect the device and retry.'
          }
          return this.listDevices()
        }
        physicalIdentity = this.repo.physicalIdentity(rawIdentity, 'physical')
      } else if (connection === 'usb') {
        // The USB transport serial is the handset serial even when Android is
        // not ready to answer getprop. It uses the same HMAC domain as the
        // property probe, so the row remains stable when the phone becomes ready.
        physicalIdentity = this.repo.physicalIdentity(line.serial, 'physical')
      } else {
        // An unknown unhealthy wireless transport cannot prove whether it is
        // an alternate path to an existing handset. Existing mappings remain
        // visible, but a new one is deliberately not made leasable.
        physicalIdentity = this.repo.getPhysicalIdentityBySerial(line.serial)
      }
      if (physicalIdentity) identified.push({ line, connection, health, physicalIdentity })
    }

    const groups = new Map<string, typeof identified>()
    for (const candidate of identified) {
      const group = groups.get(candidate.physicalIdentity) ?? []
      group.push(candidate)
      groups.set(candidate.physicalIdentity, group)
    }

    const planned: { candidate: (typeof identified)[number]; known: AndroidDevice | null }[] = []
    for (const [physicalIdentity, candidates] of groups) {
      const knownDevices = new Map<string, AndroidDevice>()
      const identityDevice = this.repo.getDeviceByPhysicalIdentity(physicalIdentity)
      if (identityDevice) knownDevices.set(identityDevice.id, identityDevice)
      for (const candidate of candidates) {
        const known = this.repo.getDeviceBySerial(candidate.line.serial)
        if (known) {
          const storedIdentity = this.repo.getPhysicalIdentityBySerial(candidate.line.serial)
          if (storedIdentity !== physicalIdentity && this.repo.activeLease(known.id)) {
            this.lastAvailability = {
              ok: false,
              detail: 'Host ADB reported a changed identity for an actively leased transport; release the lease and retry.'
            }
            return this.listDevices()
          }
          knownDevices.set(known.id, known)
        }
      }
      const activeDevices = [...knownDevices.values()].filter((device) => this.repo.activeLease(device.id))
      if (activeDevices.length > 1) {
        this.lastAvailability = {
          ok: false,
          detail: 'Host ADB found ambiguous transports for an actively leased physical device; release the leases and retry.'
        }
        return this.listDevices()
      }

      let candidate: (typeof identified)[number] | undefined
      const activeDevice = activeDevices[0]
      if (activeDevice) {
        // Never switch the serial underneath an operation that captured this
        // lease. If its exact transport disappeared, the normal missing-device
        // path revokes it; an alternate route can be selected next refresh.
        candidate = candidates.find((entry) => entry.line.serial === activeDevice.serial)
        if (!candidate) continue
      } else {
        candidate = [...candidates].sort((left, right) => {
          const rank = (entry: (typeof identified)[number]): number => {
            if (entry.health === 'ready' && entry.connection === 'usb') return 0
            if (entry.health === 'ready' && entry.connection === 'wireless') return 1
            if (entry.connection === 'usb') return 2
            if (entry.connection === 'wireless') return 3
            return 4
          }
          return rank(left) - rank(right)
        })[0]
      }
      if (candidate) planned.push({ candidate, known: identityDevice ?? this.repo.getDeviceBySerial(candidate.line.serial) })
    }

    for (const { candidate, known } of planned) {
      const { line, connection, health, physicalIdentity } = candidate
      // The public ID is random and the stable physical correlation key is an
      // install-keyed HMAC. Neither raw hardware identity nor transport serial
      // is exposed by any public broker surface.
      const id = known?.id ?? `d${randomUUID().replaceAll('-', '')}`
      // Properties need an authorized device; an unauthorized phone still
      // belongs in the inventory so the user can see why it is unusable.
      const props =
        health === 'ready' && (!known || known.apiLevel === null)
          ? await readDeviceProps(this.adb, line.serial)
          : { androidVersion: known?.androidVersion ?? null, apiLevel: known?.apiLevel ?? null, model: known?.model ?? null }
      const model = props.model ?? line.model ?? known?.model ?? null
      let persisted: AndroidDevice
      try {
        persisted = this.repo.upsertDevice({
          id,
          serial: line.serial,
          physicalIdentity,
          nickname: known?.nickname ?? defaultNickname(model, connection, this.repo.listDevices()),
          model,
          androidVersion: props.androidVersion,
          apiLevel: props.apiLevel,
          connection,
          health,
          seenAt: at
        })
      } catch {
        this.lastAvailability = {
          ok: false,
          detail: 'Host ADB could not safely reconcile physical-device identities; retry after the current lease settles.'
        }
        return this.listDevices()
      }
      // A second broker process may have won the unique-serial insert with a
      // different random ID. Always continue from the row SQLite retained.
      seen.add(persisted.id)
      if (!known) {
        this.repo.recordEvent({ deviceId: persisted.id, roomId: null, kind: 'discovered', detail: `${model ?? 'Android device'} (${connection})`, at })
      } else if (known.health !== 'ready' && health === 'ready') {
        this.repo.recordEvent({ deviceId: persisted.id, roomId: null, kind: 'reconnected', detail: `back as ${health}`, at })
      }
    }

    for (const device of this.repo.listDevices()) {
      if (seen.has(device.id)) continue
      if (device.health !== 'disconnected') {
        this.repo.markHealth(device.id, 'disconnected', at)
        this.repo.recordEvent({ deviceId: device.id, roomId: null, kind: 'disconnected', detail: `${device.nickname} left the bus`, at })
      }
      // A phone that unplugs cannot keep serving its owner, and a reconnect
      // must never resurrect that owner. Closing is deliberately retried even
      // when health was already persisted as disconnected: a process can die
      // between the health update and lease revocation.
      const lease = this.repo.activeLease(device.id)
      if (lease && !this.recoveryProtected(lease)) {
        const closed = this.repo.closeLeaseIf(
          lease.id,
          'revoked',
          at,
          'device disconnected',
          (current) => !this.recoveryProtected(current)
        )
        if (!closed) {
          this.deathObservedAt.delete(lease.id)
          continue
        }
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
    // A request may have queued while its only candidate was offline or before
    // a crash interrupted promotion. Every healthy free phone gets a chance to
    // serve the durable queue; promote() is idempotent while a lease is active.
    this.lastAvailability = availability
    this.inventoryGrantable = true
    for (const device of this.repo.listDevices()) {
      if (device.health === 'ready' && this.brokered(device)) this.promote(device.id)
    }
    return this.listDevices()
  }

  listDevices(): DeviceInventoryEntry[] {
    return this.repo.listDevices().map((device) => this.describe(device))
  }

  private describe(device: AndroidDevice): DeviceInventoryEntry {
    const lease = this.repo.activeLease(device.id)
    const waiters = this.brokered(device) ? this.matchingWaiters(device) : []
    return {
      ...this.publicDevice(device),
      brokered: this.brokered(device),
      leaseOwner: lease ? this.owner(lease) : null,
      queueDepth: waiters.length,
      waiters: waiters.map((entry) => this.waiter(entry))
    }
  }

  private publicDevice(device: AndroidDevice): AndroidDeviceSummary {
    return {
      id: device.id,
      nickname: device.nickname,
      model: device.model,
      androidVersion: device.androidVersion,
      apiLevel: device.apiLevel,
      connection: device.connection,
      health: device.health,
      firstSeenAt: device.firstSeenAt,
      lastSeenAt: device.lastSeenAt
    }
  }

  private owner(lease: DeviceLease): DeviceLeaseOwner {
    const now = this.now()
    return {
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

  // Trusted desktop-only pairing primitives. Room, Control API and MCP layers
  // intentionally have no wrappers for these methods.
  discoverPairingCandidates(): Promise<PairingDiscoveryResult> {
    return this.pairing.discover()
  }

  beginPairingCodeCapture(candidateId: string, generation: number): PairingActionResult {
    return this.pairing.beginCapture(candidateId, generation)
  }

  cancelPairingCodeCapture(candidateId: string, generation: number): PairingActionResult {
    return this.pairing.cancelCapture(candidateId, generation)
  }

  async pairCandidate(candidateId: string, generation: number, pairingCode: string): Promise<PairingActionResult> {
    const result = await this.pairing.pair(candidateId, generation, pairingCode)
    if (result.code === 'paired' || result.code === 'pairing-failed') {
      this.repo.recordEvent({
        deviceId: null,
        roomId: null,
        kind: result.ok ? 'pairing-succeeded' : 'pairing-failed',
        detail: result.ok ? 'Secure wireless Android pairing succeeded' : 'Secure wireless Android pairing failed',
        at: this.at()
      })
    }
    return result
  }

  get sensitivePairingCaptureActive(): boolean {
    return this.pairing.captureActive
  }

  assertCaptureAllowed(): void {
    this.pairing.assertCaptureAllowed()
  }

  beginCapturePermit(): () => void {
    return this.pairing.beginOrdinaryCapture()
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

  /** Unpinned queue rows are visible only on devices they can actually use. */
  private matchingWaiters(device: AndroidDevice): DeviceQueueEntry[] {
    return this.repo
      .waiting(device.id)
      .filter((entry) => this.roomEligible(entry.roomId) && this.matches(device, entry.constraints))
  }

  private sameQueuedRequest(
    entry: DeviceQueueEntry,
    request: DeviceRequest,
    pinned: string | null,
    ttlMs: number,
    maxDurationMs: number
  ): boolean {
    const constraints = request.constraints ?? {}
    return (
      entry.deviceId === pinned &&
      entry.project === request.project &&
      entry.purpose === request.purpose &&
      entry.workerId === request.workerId &&
      entry.issueRef === (request.issueRef ?? null) &&
      entry.runId === (request.runId ?? null) &&
      entry.priority === (request.priority ?? 0) &&
      entry.ttlMs === ttlMs &&
      entry.maxDurationMs === maxDurationMs &&
      entry.constraints.deviceId === constraints.deviceId &&
      entry.constraints.nickname === constraints.nickname &&
      entry.constraints.minApiLevel === constraints.minApiLevel &&
      entry.constraints.connection === constraints.connection
    )
  }

  private cancelRoomWaiters(roomId: string, at: string, reason: string, exceptId?: string): void {
    const cancelled: DeviceQueueEntry[] = []
    for (const entry of this.repo.waiting(null)) {
      if (entry.roomId !== roomId || entry.id === exceptId) continue
      cancelled.push(this.repo.resolveQueueEntry(entry.id, 'cancelled', at))
    }
    this.recordCancelledWaiters(cancelled, at, reason)
  }

  private recordCancelledWaiters(entries: DeviceQueueEntry[], at: string, reason: string): void {
    for (const entry of entries) {
      this.repo.recordEvent({
        deviceId: entry.deviceId,
        roomId: entry.roomId,
        kind: 'cancelled',
        detail: reason,
        at
      })
    }
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
    // Join an inventory probe that already owns the cached-health decision.
    // There is no later await before the SQLite grant, so a new refresh cannot
    // interleave after this fence and lease a stale row underneath us.
    if (this.inventoryRefresh) await this.inventoryRefresh
    // A persisted `ready` row is only a cache. Never grant or rejoin a lease
    // until this process has proved that its Host ADB transport is available.
    this.assertHostAdbAvailable()
    if (!this.inventoryGrantable) {
      throw new DeviceLeaseError('device-unhealthy', 'The physical-device inventory has not completed a healthy probe.')
    }
    const at = this.at()
    const ttlMs = request.ttlMs ?? LEASE_DEFAULT_TTL_MS
    const maxDurationMs = request.maxDurationMs ?? LEASE_DEFAULT_MAX_DURATION_MS

    const existingLease = this.repo.activeLeaseForRoom(request.roomId)
    if (existingLease) {
      const device = this.repo.getDevice(existingLease.deviceId)!
      if (device.health !== 'ready') {
        throw new DeviceLeaseError(
          'device-unhealthy',
          `${device.nickname} is still attached to Room ${request.roomId}, but it is ${device.health}.`
        )
      }
      if (this.matches(device, request.constraints)) {
        return { state: 'granted', lease: existingLease, device: this.publicDevice(device) }
      }
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
      const grant = this.repo.grantLease({
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
      }, null)
      this.recordCancelledWaiters(
        grant.cancelledWaiters,
        at,
        'queued request superseded by an immediate device grant'
      )
      this.repo.recordEvent({
        deviceId: free.id,
        roomId: request.roomId,
        kind: 'granted',
        detail: `${request.project} took ${free.nickname} for ${request.purpose}`,
        at
      })
      return { state: 'granted', lease: grant.lease, device: this.publicDevice(free) }
    }

    // Pin the queue to a specific device only when the request named one;
    // otherwise the entry stays free to be promoted by whichever phone frees up.
    const pinned = request.constraints?.deviceId ?? null
    const existingEntry = this.repo.waitingForRoom(request.roomId)
    let entry: DeviceQueueEntry
    if (existingEntry && this.sameQueuedRequest(existingEntry, request, pinned, ttlMs, maxDurationMs)) {
      // Repair historical duplicate rows while preserving the idempotent token
      // returned for the request the Room is already waiting on.
      this.cancelRoomWaiters(request.roomId, at, 'duplicate queued request cancelled', existingEntry.id)
      entry = existingEntry
    } else {
      if (existingEntry) this.cancelRoomWaiters(request.roomId, at, 'queued request replaced by a newer request')
      entry = this.repo.enqueue({
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
      this.repo.recordEvent({ deviceId: pinned, roomId: request.roomId, kind: 'queued', detail: `${request.project} is waiting for ${request.purpose}`, at })
    }

    const blocking = candidates.find((device) => this.repo.activeLease(device.id)) ?? candidates[0]!
    const holder = this.repo.activeLease(blocking.id)
    const queue = this.matchingWaiters(blocking)
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

  /** Renew only the exact lease retained by a durable recovery fence. */
  renewRecoveryLease(roomId: string, deviceId: string, leaseId: string): DeviceLease {
    const lease = this.repo.activeLease(deviceId)
    if (!lease || lease.id !== leaseId || lease.roomId !== roomId || !this.recoveryProtected(lease)) {
      throw new DeviceLeaseError(
        'lease-expired',
        'The physical-device lease no longer matches the retained recovery authority.'
      )
    }
    return this.heartbeat(leaseId, { busy: true })
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
    if (!lease) {
      // Disconnect revokes exclusivity immediately, but the Room must retain a
      // sticky failed-physical target until it explicitly releases. Otherwise
      // the next android-run could silently fall back to its emulator.
      const latest = this.repo.latestLeaseForRoom(roomId)
      if (latest?.state === 'revoked' && latest.releaseReason === 'device disconnected') {
        const at = this.at()
        const acknowledged = this.repo.acknowledgeRevokedLease(latest.id, at, `device disconnect acknowledged: ${reason}`)
        this.repo.recordEvent({ deviceId: latest.deviceId, roomId, kind: 'released', detail: reason, at })
        return { lease: acknowledged, promoted: null }
      }
      return null
    }
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
    const closed = this.repo.closeLeaseIf(
      lease.id,
      state,
      at,
      reason,
      (current) => !this.recoveryProtected(current)
    )
    if (!closed) {
      throw new DeviceLeaseError(
        'lease-recovery-protected',
        'The exact physical-device lease is retained by an Android locale recovery operation.'
      )
    }
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

  private async closeAutomatically(
    lease: DeviceLease,
    state: 'expired' | 'revoked',
    reason: string
  ): Promise<{ lease: DeviceLease; promoted: DeviceLease | null } | null> {
    try {
      return await this.close(lease, state, reason)
    } catch (error) {
      if (error instanceof DeviceLeaseError && error.code === 'lease-recovery-protected') {
        this.deathObservedAt.delete(lease.id)
        return null
      }
      throw error
    }
  }

  /** Give a just-freed phone to the best waiting request, if any. */
  private promote(deviceId: string): DeviceLease | null {
    if (!this.lastAvailability.ok || !this.inventoryGrantable) return null
    const device = this.repo.getDevice(deviceId)
    if (!device || device.health !== 'ready' || this.repo.activeLease(deviceId)) return null
    const at = this.at()
    for (const entry of this.repo.waiting(deviceId)) {
      if (this.repo.getQueueEntry(entry.id)?.state !== 'waiting') continue
      if (!this.roomEligible(entry.roomId)) {
        this.cancelRoomWaiters(entry.roomId, at, 'queued request cancelled because the Room is no longer eligible')
        continue
      }
      if (!this.matches(device, entry.constraints)) continue
      if (this.repo.activeLeaseForRoom(entry.roomId)) {
        this.cancelRoomWaiters(entry.roomId, at, 'stale queued request cancelled because the Room already owns a device')
        continue
      }
      const grant = this.repo.grantLease({
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
      }, entry.id)
      this.recordCancelledWaiters(
        grant.cancelledWaiters,
        at,
        'duplicate queued request cancelled before promotion'
      )
      this.repo.recordEvent({
        deviceId,
        roomId: entry.roomId,
        kind: 'granted',
        detail: `${entry.project} was promoted from the queue onto ${device.nickname}`,
        at
      })
      return grant.lease
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
    for (const snapshot of this.repo.listActiveLeases()) {
      // Another lease's liveness probe can await for an arbitrary amount of
      // time. Fence every later snapshot before acting on it so a heartbeat or
      // release that wins during that await is never mistaken for stale state.
      let lease = this.repo.getLease(snapshot.id)
      if (!lease || lease.state !== 'active') {
        this.deathObservedAt.delete(snapshot.id)
        continue
      }
      if (this.recoveryProtected(lease)) {
        this.deathObservedAt.delete(lease.id)
        continue
      }
      const heartbeatAgeMs = now - Date.parse(lease.heartbeatAt)

      if (heartbeatAgeMs > lease.ttlMs) {
        const live = await this.ownerLiveness(lease)
        // Liveness probes may be asynchronous. A heartbeat or explicit
        // release that wins while the probe is in flight must fence this stale
        // snapshot off instead of being overwritten by a late reclaim.
        const current = this.repo.getLease(lease.id)
        if (!current || current.state !== 'active') {
          this.deathObservedAt.delete(lease.id)
          continue
        }
        if (now - Date.parse(current.heartbeatAt) <= current.ttlMs) {
          this.deathObservedAt.delete(lease.id)
          continue
        }
        lease = current
        if (live !== true) {
          const firstSeen = this.deathObservedAt.get(lease.id) ?? now
          this.deathObservedAt.set(lease.id, firstSeen)
          if (now - firstSeen >= this.graceMs) {
            const reason = live === false
              ? `owner gone: no heartbeat for ${Math.round((now - Date.parse(lease.heartbeatAt)) / 1000)}s and the Room or worker is not running`
              : `owner silent: no heartbeat for ${Math.round((now - Date.parse(lease.heartbeatAt)) / 1000)}s and worker liveness is unavailable`
            const closed = await this.closeAutomatically(lease, 'expired', reason)
            if (closed) result.recovered.push({ ...closed, reason })
            continue
          }
        } else {
          this.deathObservedAt.delete(lease.id)
        }
      }

      // Re-read immediately before all max-duration decisions. In particular,
      // the current Room can report busy activity or explicitly release while
      // an earlier Room's async liveness probe is still in flight.
      const current = this.repo.getLease(snapshot.id)
      if (!current || current.state !== 'active') {
        this.deathObservedAt.delete(snapshot.id)
        continue
      }
      lease = current
      const leaseAgeMs = now - Date.parse(lease.acquiredAt)
      const activityAgeMs = now - Date.parse(lease.activityAt)

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
        const closed = await this.closeAutomatically(lease, 'expired', reason)
        if (closed) {
          this.repo.recordEvent({ deviceId: lease.deviceId, roomId: lease.roomId, kind: 'max-duration-reclaimed', detail: reason, at })
          result.recovered.push({ ...closed, reason })
        }
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

  /** Internal target lookup; public status intentionally does not choose a serial. */
  deviceForRoom(roomId: string): AndroidDevice | null {
    const active = this.repo.activeLeaseForRoom(roomId)
    const latest = active ?? this.repo.latestLeaseForRoom(roomId)
    const lease = latest?.state === 'active' || (latest?.state === 'revoked' && latest.releaseReason === 'device disconnected')
      ? latest
      : null
    return lease ? this.repo.getDevice(lease.deviceId) : null
  }

  /**
   * The fail-closed gate. An ADB command that can change the phone's state runs
   * only for the Room that holds a live lease on it; everything else gets a
   * structured refusal instead of a silent collision.
   */
  authorize(roomId: string, deviceId: string, argv: string[], expectedLeaseId?: string | null): AuthorizedAdbTarget {
    const device = this.readyDevice(deviceId)

    const classification = classifyAdbCommand(argv)
    if (classification.forbidden) {
      throw new DeviceLeaseError(
        'adb-command-forbidden',
        `${classification.reason} is owned by the Host Device Broker and is refused even with a device lease.`
      )
    }
    if (!this.brokered(device)) return { serial: device.serial, device, leaseId: null }
    if (!classification.interfering) return { serial: device.serial, device, leaseId: null }

    return this.authorizeLeaseHolder(roomId, device, classification.reason, expectedLeaseId)
  }

  /**
   * Lease gate for a high-level primitive whose argv was assembled inside Core.
   * Generic callers cannot select this path; it is what lets android-run and
   * androidScreenshot use narrowly tracked app/screenshot reads while the raw
   * ADB surface refuses process lists, dumps and binary streams altogether.
   */
  authorizeInternalOperation(
    roomId: string,
    deviceId: string,
    reason: string,
    expectedLeaseId?: string | null
  ): AuthorizedAdbTarget {
    const device = this.readyDevice(deviceId)
    if (!this.brokered(device)) return { serial: device.serial, device, leaseId: null }
    return this.authorizeLeaseHolder(roomId, device, reason, expectedLeaseId)
  }

  private readyDevice(deviceId: string): AndroidDevice {
    const device = this.repo.getDevice(deviceId)
    if (!device) throw new DeviceLeaseError('device-unknown', `unknown Android device: ${deviceId}`)
    this.assertHostAdbAvailable()
    if (device.health !== 'ready') {
      throw new DeviceLeaseError('device-unhealthy', `${device.nickname} is ${device.health} and cannot accept ADB commands.`)
    }
    return device
  }

  private authorizeLeaseHolder(
    roomId: string,
    device: AndroidDevice,
    reason: string,
    expectedLeaseId?: string | null
  ): AuthorizedAdbTarget {
    const lease = this.repo.activeLease(device.id)
    if (!lease) {
      if (expectedLeaseId) {
        throw new DeviceLeaseError(
          'lease-expired',
          `The device lease captured for this operation is no longer active before ${reason}.`
        )
      }
      throw new DeviceLeaseError(
        'no-lease',
        `${reason} needs a device lease. Attach ${device.nickname} to Room ${roomId} first.`
      )
    }
    if (lease.roomId !== roomId) {
      throw new DeviceLeaseError(
        'lease-held-by-another-room',
        `${device.nickname} is leased by ${lease.project} (Room ${lease.roomId}) for ${lease.purpose}. ${reason} is refused.`
      )
    }
    if (expectedLeaseId && lease.id !== expectedLeaseId) {
      throw new DeviceLeaseError(
        'lease-expired',
        `The device lease changed while this operation was preparing ${reason}; retry under the new lease.`
      )
    }
    if (this.now() - Date.parse(lease.heartbeatAt) > lease.ttlMs) {
      throw new DeviceLeaseError('lease-expired', `The lease on ${device.nickname} went stale — heartbeat it or take it again before ${reason}.`)
    }
    return { serial: device.serial, device, leaseId: lease.id }
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
