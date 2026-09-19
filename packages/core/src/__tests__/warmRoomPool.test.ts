import { describe, expect, it } from 'vitest'
import { WarmRoomPool } from '../lifecycle/warmRoomPool'

const web = {
  provider: 'web' as const,
  runtime: { kind: 'node' as const, version: '22' },
  packageManager: { kind: 'pnpm' as const, version: '10' },
  startCommand: 'pnpm dev',
  internalPort: 3000,
  os: { env: {} }
}

describe('bounded versioned Warm Room pool', () => {
  it('claims only exact ready profiles and replenishes to the per-profile bound', () => {
    const pool = new WarmRoomPool('0.5.4', { slotsPerProfile: 2, maxProfiles: 2, maxIdleMs: 1_000 })
    expect(pool.claim(web)).toBeNull()
    pool.observeReady(web)
    pool.observeReady(web)
    pool.observeReady(web)
    expect(pool.status()).toMatchObject([{ readySlots: 2, strategy: 'oci-layer-cow' }])
    expect(pool.claim(web)).toMatchObject({ strategy: 'oci-layer-cow' })
    expect(pool.claim(web)).not.toBeNull()
    expect(pool.claim(web)).toBeNull()
  })

  it('versions every profile input and DevHotel runtime generation explicitly', () => {
    const current = new WarmRoomPool('0.5.4')
    const upgraded = new WarmRoomPool('0.6.0')
    expect(current.snapshotVersion(web)).not.toBe(upgraded.snapshotVersion(web))
    expect(current.snapshotVersion(web)).not.toBe(current.snapshotVersion({
      ...web,
      runtime: { ...web.runtime, version: '24' }
    }))
    const android = {
      provider: 'android' as const,
      runtime: { kind: 'jdk' as const, version: '17' },
      packageManager: { kind: 'gradle' as const },
      startCommand: 'sleep 2147483647',
      internalPort: 6080,
      os: { env: {} },
      android: { device: 'Pixel 7', version: '14.0', resolution: 'fast' as const, orientation: 'portrait' as const }
    }
    expect(current.observeReady(android)).toMatchObject({ strategy: 'oci-layer-cow+avd-quickboot' })
    expect(current.profileKey(android)).not.toBe(current.profileKey({
      ...android,
      android: { ...android.android, version: '15.0' }
    }))
  })

  it('expires idle snapshots and evicts least-recently-used profiles', () => {
    let now = Date.parse('2026-09-19T00:00:00.000Z')
    const pool = new WarmRoomPool('0.5.4', { slotsPerProfile: 1, maxProfiles: 2, maxIdleMs: 100 }, () => now)
    pool.observeReady(web)
    now += 10
    pool.observeReady({ ...web, runtime: { ...web.runtime, version: '24' } })
    now += 10
    pool.observeReady({ ...web, runtime: { ...web.runtime, version: '20' } })
    expect(pool.status().map((entry) => entry.profile.runtime.version)).toEqual(['20', '24'])
    now += 101
    expect(pool.status()).toEqual([])
  })
})
