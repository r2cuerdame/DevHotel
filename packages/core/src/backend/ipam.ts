import { DevHotelError } from '../errors'

export const DEFAULT_SUBNET_POOL = '10.214.0.0/16'
export const DEFAULT_SUBNET_PREFIX = 24

export interface SubnetAllocatorOptions {
  pool?: string
  subnetPrefix?: number
}

export interface PoolCapacity {
  pool: string
  subnetSize: number
  totalCapacity: number
  usedCount: number
  availableCount: number
}

function parseIpv4(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`)
  }
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0)
}

function formatIpv4(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255
  ].join('.')
}

interface CidrRange {
  /** First address of the block as an unsigned 32-bit integer. */
  start: number
  /** Last address of the block (inclusive) as an unsigned 32-bit integer. */
  end: number
}

/**
 * Parse an IPv4 CIDR into its inclusive address range. Host bits below the
 * prefix are masked off. Returns null for anything that is not a valid IPv4
 * CIDR (IPv6 blocks reported by Docker, malformed strings, prefix > 32) so
 * callers can skip unusable entries instead of aborting an allocation.
 */
function parseCidrRange(cidr: string): CidrRange | null {
  const [ip, prefixStr, ...rest] = cidr.trim().split('/')
  if (!ip || rest.length > 0) return null
  const prefix = prefixStr === undefined ? 32 : Number.parseInt(prefixStr, 10)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || (prefixStr !== undefined && String(prefix) !== prefixStr)) {
    return null
  }
  let base: number
  try {
    base = parseIpv4(ip)
  } catch {
    return null
  }
  // `x >>> 32` is a no-op in JS, so /0 needs an explicit all-zero mask.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (base & mask) >>> 0
  const end = (start | (~mask >>> 0)) >>> 0
  return { start, end }
}

function rangesOverlap(a: CidrRange, b: CidrRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/**
 * True when two IPv4 CIDR blocks share at least one address, regardless of
 * prefix length (a /20 supernet overlaps every /24 inside it; a /25 overlaps
 * the /24 that contains it). Unparsable input never overlaps and never throws.
 */
export function cidrsOverlap(a: string, b: string): boolean {
  const ra = parseCidrRange(a)
  const rb = parseCidrRange(b)
  if (!ra || !rb) return false
  return rangesOverlap(ra, rb)
}

export class SubnetAllocator {
  readonly pool: string
  readonly subnetPrefix: number
  private readonly poolBaseInt: number
  private readonly poolPrefix: number
  private readonly poolRange: CidrRange
  private readonly subnetStep: number
  private readonly totalCapacity: number
  private readonly allocatedByNetwork = new Map<string, string>()
  private readonly claimedSubnets = new Set<string>()

  constructor(options: SubnetAllocatorOptions = {}) {
    const rawPool = options.pool ?? process.env.DEVHOTEL_SUBNET_POOL ?? DEFAULT_SUBNET_POOL
    const [baseIp, prefixStr] = rawPool.split('/')
    if (!baseIp || !prefixStr) {
      throw new Error(`Invalid subnet pool CIDR: ${rawPool}`)
    }
    this.poolPrefix = Number.parseInt(prefixStr, 10)
    if (Number.isNaN(this.poolPrefix) || this.poolPrefix < 8 || this.poolPrefix > 30) {
      throw new Error(`Invalid subnet pool prefix length: ${prefixStr}`)
    }
    this.poolBaseInt = parseIpv4(baseIp)
    this.subnetPrefix = options.subnetPrefix ?? DEFAULT_SUBNET_PREFIX
    if (this.subnetPrefix <= this.poolPrefix || this.subnetPrefix > 30) {
      throw new Error(`Subnet prefix length (/${this.subnetPrefix}) must be greater than pool prefix (/${this.poolPrefix})`)
    }
    this.pool = `${formatIpv4(this.poolBaseInt)}/${this.poolPrefix}`
    this.poolRange = parseCidrRange(this.pool)!
    this.subnetStep = 2 ** (32 - this.subnetPrefix)
    this.totalCapacity = 2 ** (this.subnetPrefix - this.poolPrefix)
  }

  /**
   * True when the CIDR shares address space with the pool, whatever its prefix
   * length. Docker rejects any new subnet that overlaps an existing one, so a
   * /20 supernet or a /25 sub-network inside the pool consumes pool capacity
   * exactly like a managed /24 does.
   */
  isSubnetInPool(subnet: string): boolean {
    const range = parseCidrRange(subnet)
    return range !== null && rangesOverlap(range, this.poolRange)
  }

  subnetForIndex(index: number): string {
    if (index < 0 || index >= this.totalCapacity) {
      throw new Error(`Subnet index ${index} out of bounds for capacity ${this.totalCapacity}`)
    }
    const subnetInt = (this.poolBaseInt + index * this.subnetStep) >>> 0
    return `${formatIpv4(subnetInt)}/${this.subnetPrefix}`
  }

  /**
   * Indices of every managed subnet slot that overlaps any of the given CIDRs.
   * Unparsable entries (IPv6, garbage) and CIDRs outside the pool contribute
   * nothing; nested or duplicate CIDRs are naturally deduplicated by the Set.
   */
  private occupiedIndices(cidrs: Iterable<string>): Set<number> {
    const occupied = new Set<number>()
    for (const cidr of cidrs) {
      const range = parseCidrRange(cidr)
      if (!range || !rangesOverlap(range, this.poolRange)) continue
      const first = Math.max(range.start, this.poolRange.start)
      const last = Math.min(range.end, this.poolRange.end)
      const firstIndex = Math.floor((first - this.poolBaseInt) / this.subnetStep)
      const lastIndex = Math.floor((last - this.poolBaseInt) / this.subnetStep)
      for (let i = firstIndex; i <= lastIndex; i++) occupied.add(i)
    }
    return occupied
  }

  private usedIndices(externalUsedSubnets?: ReadonlySet<string>): Set<number> {
    const occupied = this.occupiedIndices(this.claimedSubnets)
    if (externalUsedSubnets) {
      for (const i of this.occupiedIndices(externalUsedSubnets)) occupied.add(i)
    }
    return occupied
  }

  allocate(networkName: string, externalUsedSubnets?: ReadonlySet<string>): string {
    const existing = this.allocatedByNetwork.get(networkName)
    if (existing) return existing

    const used = this.usedIndices(externalUsedSubnets)
    for (let i = 0; i < this.totalCapacity; i++) {
      if (used.has(i)) continue

      const candidate = this.subnetForIndex(i)
      this.allocatedByNetwork.set(networkName, candidate)
      this.claimedSubnets.add(candidate)
      return candidate
    }

    const usedCount = Math.min(this.totalCapacity, used.size)

    throw new DevHotelError(
      'NETWORK_POOL_EXHAUSTED',
      `DevHotel network address pool exhausted: all ${this.totalCapacity} managed subnets in ${this.pool} (/${this.subnetPrefix}) are currently in use. Cannot allocate network ${networkName}.`,
      {
        recoveryHint: 'Delete unused rooms or clean up unattached networks to free subnet capacity before creating new rooms.',
        httpStatus: 507,
        evidence: {
          networkName,
          pool: this.pool,
          subnetSize: this.subnetPrefix,
          totalCapacity: this.totalCapacity,
          usedCount,
          availableCount: 0
        }
      }
    )
  }

  release(networkName: string): void {
    const subnet = this.allocatedByNetwork.get(networkName)
    if (subnet) {
      this.claimedSubnets.delete(subnet)
      this.allocatedByNetwork.delete(networkName)
    }
  }

  adopt(networkName: string, subnet: string): void {
    if (this.isSubnetInPool(subnet)) {
      this.allocatedByNetwork.set(networkName, subnet)
      this.claimedSubnets.add(subnet)
    }
  }

  getCapacity(externalUsedSubnets?: ReadonlySet<string>): PoolCapacity {
    const usedCount = Math.min(this.totalCapacity, this.usedIndices(externalUsedSubnets).size)
    return {
      pool: this.pool,
      subnetSize: this.subnetPrefix,
      totalCapacity: this.totalCapacity,
      usedCount,
      availableCount: Math.max(0, this.totalCapacity - usedCount)
    }
  }
}

export function classifyNetworkCreateError(
  err: unknown,
  roomId: string,
  networkName: string,
  subnet?: string
): Error {
  if (err instanceof DevHotelError) return err
  const detail = `${(err as { stderr?: string })?.stderr ?? ''} ${(err as Error)?.message ?? String(err)}`
  if (
    /all predefined address pools have been fully subnetted|could not find an available, non-overlapping IPv4 address pool|Pool overlaps with other one on this address space|invalid pool request/i.test(
      detail
    )
  ) {
    return new DevHotelError(
      'NETWORK_POOL_EXHAUSTED',
      `DevHotel network address pool exhausted: Docker reported address pools fully subnetted or overlapping when creating network ${networkName}.`,
      {
        recoveryHint: 'Delete unused rooms or clean up unattached networks to free subnet capacity before creating new rooms.',
        httpStatus: 507,
        evidence: { roomId, networkName, subnet },
        cause: err
      }
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}
