import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectProject } from '../detect/detector'
import { fsSourceReader, type SourceReader } from '../detect/sourceReader'
import { getProvider, providers } from '../providers/index'
import { buildWebSpec } from '../providers/webProvider'
import { makeRoom } from './fakes'

function fixture(name: string): SourceReader {
  return fsSourceReader(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
}

describe('provider registry', () => {
  it('lists web as available and android as honestly unavailable', () => {
    const infos = providers()
    expect(infos.map((i) => i.kind)).toEqual(['web', 'android'])
    const web = infos.find((i) => i.kind === 'web')!
    expect(web.available).toBe(true)
    expect(web.unavailableReason).toBeUndefined()
    const android = infos.find((i) => i.kind === 'android')!
    expect(android.available).toBe(false)
    expect(android.unavailableReason).toMatch(/goal\.md §21\.4/)
  })

  it('returns the provider matching its kind', () => {
    expect(getProvider('web').info.kind).toBe('web')
    expect(getProvider('android').info.kind).toBe('android')
  })
})

describe('WebRoomProvider', () => {
  it('detect delegates to detectProject unchanged', async () => {
    const opts = { project: 'Loop Office', nickname: 'dev' }
    const viaProvider = await getProvider('web').detect(fixture('next-pnpm'), opts)
    expect(viaProvider).toEqual(await detectProject(fixture('next-pnpm'), opts))
    expect(viaProvider.framework).toBe('next')
  })

  it('passes detect overrides through', async () => {
    const plan = await getProvider('web').detect(fixture('next-pnpm'), {
      project: 'Loop Office',
      nickname: 'dev',
      overrides: { runtimeVersion: '24.1.0' }
    })
    expect(plan.runtime).toEqual({ kind: 'node', value: '24', source: 'user override' })
  })

  it('buildSpec mirrors the room record and lets overrides win', () => {
    const room = makeRoom()
    expect(getProvider('web').buildSpec(room)).toEqual({
      roomId: room.id,
      internalPort: room.internalPort,
      nodeMajor: room.runtime.version,
      sourceType: room.sourceType,
      sourceRef: room.sourceRef,
      startCommand: room.startCommand,
      env: {}
    })
    const overridden = buildWebSpec(room, { depsVolumeOverride: 'dh-room1abc-deps-node22-g2', startCommand: 'pnpm start' })
    expect(overridden.depsVolumeOverride).toBe('dh-room1abc-deps-node22-g2')
    expect(overridden.startCommand).toBe('pnpm start')
    expect(overridden.roomId).toBe(room.id)
  })

  it('lists the components it manages today', () => {
    const components = getProvider('web').components()
    expect(components).toContain('Node.js')
    expect(components).toContain('Web process')
    expect(components).not.toContain('PostgreSQL')
  })
})

describe('AndroidRoomProvider', () => {
  it('detect rejects with a clear not-available error', async () => {
    await expect(getProvider('android').detect(fixture('empty'), { project: 'x', nickname: 'dev' })).rejects.toThrow(
      /not available yet/
    )
  })

  it('buildSpec throws and no components are claimed', () => {
    expect(() => getProvider('android').buildSpec(makeRoom())).toThrow(/not available yet/)
    expect(getProvider('android').components()).toEqual([])
  })
})
