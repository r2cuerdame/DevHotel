import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectProject } from '../detect/detector'
import { fsSourceReader, type SourceReader } from '../detect/sourceReader'
import { getProvider, providers } from '../providers/index'
import { buildWebSpec } from '../providers/webProvider'
import { WindowsRoomProvider } from '../providers/windowsProvider'
import { makeRoom } from './fakes'

function fixture(name: string): SourceReader {
  return fsSourceReader(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
}

describe('provider registry', () => {
  it('lists every provider and reports VMware availability without inventing a preview', () => {
    const infos = providers()
    expect(infos.map((i) => i.kind)).toEqual(['web', 'android', 'windows'])
    expect(infos.find((i) => i.kind === 'web')!.available).toBe(true)
    expect(infos.find((i) => i.kind === 'android')!.available).toBe(true)
    const windows = infos.find((i) => i.kind === 'windows')!
    expect(windows).toMatchObject({ execution: 'build-only', preview: 'none', requiresKvm: false })
    if (!windows.available) {
      expect(windows.unavailableReason).toMatch(
        process.platform === 'win32' ? /VMware Workstation/ : /Windows host/
      )
    }
  })

  it('refuses to build a container spec for a provider this build cannot serve', async () => {
    const { RoomOrchestrator } = await import('../orchestrator')
    const { FakeBackend, FakeGateway, makeRoom: makeRoomRecord, tempDir, testDb } = await import('./fakes')
    const db = testDb()
    const backend = new FakeBackend()
    try {
      const orch = new RoomOrchestrator({
        userData: tempDir(),
        backend,
        gateway: new FakeGateway().asGateway(),
        db,
        appVersion: 'test'
      })
      // a windows row can only arrive out-of-band; it must never fall through
      // to the Web runtime just because it is not android
      orch.rooms.create(makeRoomRecord({
        provider: 'windows',
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        syncStatus: 'empty',
        runtime: { kind: 'windows', version: '11' },
        packageManager: { kind: 'none' },
        startCommand: 'VMware guest boot',
        internalPort: 0,
        status: 'sleeping',
        hostPort: null,
        windows: { backend: 'vmware', templateId: 'a'.repeat(64), snapshot: 'clean' }
      }))
      await expect(orch.startRoom('room1abc', 'user')).rejects.toThrow(/VMware Workstation backend is not configured/)
      expect(orch.rooms.get('room1abc')?.status).toBe('sleeping')
      expect(backend.calls).toEqual([])
    } finally {
      db.close()
    }
  })

  it('returns the provider matching its kind', () => {
    expect(getProvider('web').info.kind).toBe('web')
    expect(getProvider('android').info.kind).toBe('android')
  })
})

describe('WindowsRoomProvider', () => {
  it('becomes creatable only when VMware is available and plans no fake Web runtime', async () => {
    expect(new WindowsRoomProvider(() => false, 'win32').info).toMatchObject({
      available: false,
      preview: 'none',
      unavailableReason: expect.stringMatching(/Install VMware Workstation Pro/)
    })
    expect(new WindowsRoomProvider(() => true, 'linux').info).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/Windows host/)
    })
    const provider = new WindowsRoomProvider(() => true, 'win32')
    expect(provider.info).toMatchObject({ available: true, label: 'Windows Room (VMware)', preview: 'none' })
    const plan = await provider.detect(fixture('empty'), { project: 'WinApp', nickname: 'dev' })
    expect(plan.runtime).toMatchObject({ kind: 'windows', value: '11' })
    expect(plan.packageManager.value).toBe('none')
    expect(plan.internalPort.value).toBe(0)
    expect(plan.warnings.join(' ')).toMatch(/offline/i)
    expect(() => provider.buildSpec()).toThrow(/not an OCI WebSpec/)
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
      workspaceMode: room.workspaceMode,
      workspaceVolumeRevision: room.workspaceVolumeRevision,
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
  it('detect plans a JDK/gradle build room and warns when no gradle project exists', async () => {
    const plan = await getProvider('android').detect(fixture('empty'), { project: 'MyApp', nickname: 'dev' })
    expect(plan.runtime.kind).toBe('jdk')
    expect(plan.packageManager.value).toBe('gradle')
    expect(plan.startCommand.value).toContain('./gradlew assembleDebug')
    expect(plan.startCommand.value).toContain('else gradle assembleDebug')
    expect(plan.internalPort.value).toBe(6080)
    expect(plan.warnings.some((w) => /No Gradle project/.test(w))).toBe(true)
  })

  it('detect finds a gradle project without warnings', async () => {
    const plan = await getProvider('android').detect(fixture('hello-android'), { project: 'hello', nickname: 'dev' })
    expect(plan.warnings).toEqual([])
    expect(plan.framework).toBe('android')
  })

  it('buildSpec is an sdk container in the anchor netns relaying the emulator screen', () => {
    const room = makeRoom({ provider: 'android', runtime: { kind: 'jdk', version: '17' }, internalPort: 6080 })
    const provider = getProvider('android')
    const spec = provider.buildSpec(room)
    expect(provider.info).toMatchObject({ execution: 'served', preview: 'browser', requiresKvm: true })
    expect(spec.standalone).toBeUndefined()
    expect(spec.internalPort).toBe(6080)
    expect(spec.noDepsVolume).toBe(true)
    expect(spec.imageOverride).toMatch(/android/)
    expect(spec.startCommand).toMatch(/sleep/)
    expect(spec.env?.GRADLE_USER_HOME).toBe('/cache/gradle')
    expect(getProvider('android').components()).toContain('Gradle')
    expect(getProvider('android').components()).not.toContain('Emulator')
  })
})
