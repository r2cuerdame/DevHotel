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
  it('lists web and android as available, windows as an honest roadmap stub', () => {
    const infos = providers()
    expect(infos.map((i) => i.kind)).toEqual(['web', 'android', 'windows'])
    expect(infos.find((i) => i.kind === 'web')!.available).toBe(true)
    expect(infos.find((i) => i.kind === 'android')!.available).toBe(true)
    const windows = infos.find((i) => i.kind === 'windows')!
    expect(windows.available).toBe(false)
    expect(windows.unavailableReason).toBeTruthy()
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

describe('AndroidRoomProvider (build rooms v1)', () => {
  it('detect plans a JDK/gradle build room and warns when no gradle project exists', async () => {
    const plan = await getProvider('android').detect(fixture('empty'), { project: 'MyApp', nickname: 'dev' })
    expect(plan.runtime.kind).toBe('jdk')
    expect(plan.packageManager.value).toBe('gradle')
    expect(plan.startCommand.value).toMatch(/gradle assembleDebug/)
    expect(plan.internalPort.value).toBe(6080)
    expect(plan.warnings.some((w) => /No Gradle project/.test(w))).toBe(true)
  })

  it('detect finds a gradle project without warnings', async () => {
    const plan = await getProvider('android').detect(fixture('hello-android'), { project: 'hello', nickname: 'dev' })
    expect(plan.warnings).toEqual([])
    expect(plan.framework).toBe('android')
  })

  it('buildSpec is a pod-mode sdk container relaying the emulator screen', () => {
    const room = makeRoom({ provider: 'android', runtime: { kind: 'jdk', version: '17' }, internalPort: 6080 })
    const spec = getProvider('android').buildSpec(room)
    expect(spec.standalone).toBeUndefined()
    expect(spec.internalPort).toBe(6080)
    expect(spec.noDepsVolume).toBe(true)
    expect(spec.imageOverride).toMatch(/android/)
    expect(spec.startCommand).toMatch(/sleep/)
    expect(spec.env?.GRADLE_USER_HOME).toBe('/cache/gradle')
    expect(getProvider('android').components()).toContain('Gradle')
  })
})
