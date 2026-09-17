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

export class SubnetAllocator {
  readonly pool: string
  readonly subnetPrefix: number
  private readonly poolBaseInt: number
  private readonly poolPrefix: number
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
    this.totalCapacity = 2 ** (this.subnetPrefix - this.poolPrefix)
  }

  isSubnetInPool(subnet: string): boolean {
    const [ip, prefix] = subnet.split('/')
    if (!ip || Number.parseInt(prefix ?? '', 10) !== this.subnetPrefix) return false
    try {
      const parsed = parseIpv4(ip)
      const shift = 32 - this.poolPrefix
      return (parsed >>> shift) === (this.poolBaseInt >>> shift)
    } catch {
      return false
    }
  }

  subnetForIndex(index: number): string {
    if (index < 0 || index >= this.totalCapacity) {
      throw new Error(`Subnet index ${index} out of bounds for capacity ${this.totalCapacity}`)
    }
    const step = 2 ** (32 - this.subnetPrefix)
    const subnetInt = (this.poolBaseInt + index * step) >>> 0
    return `${formatIpv4(subnetInt)}/${this.subnetPrefix}`
  }

  allocate(networkName: string, externalUsedSubnets?: ReadonlySet<string>): string {
    const existing = this.allocatedByNetwork.get(networkName)
    if (existing) return existing

    for (let i = 0; i < this.totalCapacity; i++) {
      const candidate = this.subnetForIndex(i)
      if (this.claimedSubnets.has(candidate)) continue
      if (externalUsedSubnets?.has(candidate)) continue

      this.allocatedByNetwork.set(networkName, candidate)
      this.claimedSubnets.add(candidate)
      return candidate
    }

    const usedCount = this.claimedSubnets.size + (
      externalUsedSubnets
        ? [...externalUsedSubnets].filter((s) => this.isSubnetInPool(s) && !this.claimedSubnets.has(s)).length
        : 0
    )

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
    const externalInPool = externalUsedSubnets
      ? [...externalUsedSubnets].filter((s) => this.isSubnetInPool(s) && !this.claimedSubnets.has(s)).length
      : 0
    const usedCount = Math.min(this.totalCapacity, this.claimedSubnets.size + externalInPool)
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
