import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChangeEntry, CheckReport, GatewayStatusInfo } from '@devhotel/shared'
import { buildDiagnostic } from '../diagnostics/bundle'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, FakeWindowsVm, makeRoom, tempDir, testDb } from './fakes'

const OFFLINE_GATEWAY: GatewayStatusInfo = { running: false, httpPort: null, httpsPort: null, routes: [] }
const ONLINE_GATEWAY: GatewayStatusInfo = { running: true, httpPort: 80, httpsPort: 443, routes: [] }

function makeChange(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: 'chg-1',
    roomId: 'room1abc',
    seq: 1,
    kind: 'start-command',
    title: 'Updated start command',
    actor: 'user',
    component: 'web',
    before: null,
    after: null,
    captured: null,
    steps: [],
    verify: null,
    undoable: false,
    undoStrategy: 'none',
    status: 'applied',
    rawLogPath: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    undoneAt: null,
    ...overrides
  }
}

describe('buildDiagnostic', () => {
  it('preserves Web Room sections, routing, web logs, and appends orchestrator logs on failure', () => {
    const room = makeRoom({
      provider: 'web',
      project: 'webapp',
      nickname: 'main',
      status: 'broken',
      sourceType: 'linked-folder',
      sourceRef: 'C:\\Users\\owner\\workspace\\webapp',
      workspaceMode: 'hotel',
      stateRevision: 3,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      runtime: { kind: 'node', version: '22' },
      packageManager: { kind: 'pnpm', version: '10' },
      startCommand: 'pnpm dev',
      internalPort: 3000,
      domain: 'webapp-main.localhost',
      https: true
    })
    const report: CheckReport = {
      roomId: room.id,
      ranAt: '2026-11-20T00:00:00.000Z',
      overall: 'broken',
      results: [
        { step: 'backend', status: 'healthy', summary: 'Docker ready' },
        { step: 'process', status: 'broken', summary: 'Web process exited', detail: 'exit code 1' }
      ]
    }

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report,
      recentChanges: [makeChange()],
      gateway: ONLINE_GATEWAY,
      webLogTail: ['Error: EADDRINUSE'],
      orchestratorLogTail: ['2026-11-20T00:00:00.000Z restart attempted'],
      customPatterns: []
    })

    expect(text).toContain('DevHotel Diagnostic Bundle')
    expect(text).toContain('- Provider: Web Room (DevHotel 0.5.4)')
    expect(text).toContain('- Node: 22')
    expect(text).toContain('- Package Manager: pnpm 10')
    expect(text).toContain('- Start Command: pnpm dev')
    expect(text).toContain('- Source: linked-folder (Room-owned; Host sync enabled)')
    expect(text).toContain('Routing')
    expect(text).toContain('- Internal: 3000')
    expect(text).toContain('- URL: https://webapp-main.localhost')
    expect(text).toContain('- Gateway: http :80 / https :443')
    expect(text).toContain('✕ process: Web process exited')
    expect(text).toContain('- Recent web output:\n  Error: EADDRINUSE')
    expect(text).toContain('- Recent orchestrator log:\n  2026-11-20T00:00:00.000Z restart attempted')
    expect(text).toContain('isolated web development environment')
    expect(text).not.toContain(room.sourceRef)
  })

  it('omits orchestrator logs for healthy Web Rooms to preserve existing output', () => {
    const room = makeRoom({ provider: 'web', status: 'ready' })
    const report: CheckReport = {
      roomId: room.id,
      ranAt: '2026-11-20T00:00:00.000Z',
      overall: 'healthy',
      results: [{ step: 'backend', status: 'healthy', summary: 'Docker ready' }]
    }

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report,
      recentChanges: [],
      gateway: OFFLINE_GATEWAY,
      webLogTail: ['listening on :3000'],
      orchestratorLogTail: ['2026-11-20T00:00:00.000Z room started'],
      customPatterns: []
    })

    expect(text).toContain('- Recent web output:\n  listening on :3000')
    expect(text).not.toContain('Recent orchestrator log:')
  })

  it('formats Android Room stack, emulator config, relay routing, and orchestrator logs without web-only text', () => {
    const room = makeRoom({
      provider: 'android',
      project: 'mobile-app',
      nickname: 'qa',
      status: 'attention',
      sourceType: 'linked-folder',
      sourceRef: 'C:\\Users\\owner\\projects\\mobile-app',
      workspaceMode: 'hotel',
      stateRevision: 2,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle', version: '8.10.2' },
      startCommand: 'sh ./gradlew assembleDebug --no-daemon',
      internalPort: 6080,
      domain: 'mobile-app-qa.localhost',
      https: false,
      android: {
        device: 'Pixel 6',
        version: '15.0',
        resolution: 'balanced',
        orientation: 'landscape'
      }
    })
    const report: CheckReport = {
      roomId: room.id,
      ranAt: '2026-11-20T00:00:00.000Z',
      overall: 'warning',
      results: [{ step: 'process', status: 'warning', summary: 'emulator booting slowly' }]
    }

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report,
      recentChanges: [],
      gateway: ONLINE_GATEWAY,
      webLogTail: [],
      orchestratorLogTail: ['2026-11-20T00:00:00.000Z emulator boot waiting for sys.boot_completed'],
      customPatterns: []
    })

    expect(text).toContain('- Provider: Android Room (DevHotel 0.5.4)')
    expect(text).toContain('- JDK: 17')
    expect(text).toContain('- Build Tool: gradle 8.10.2')
    expect(text).toContain('- Build Command: sh ./gradlew assembleDebug --no-daemon')
    expect(text).toContain('- Emulator: Pixel 6 · Android 15.0 · balanced · landscape')
    expect(text).toContain('- Source: linked-folder (Room-owned; Host sync enabled)')
    expect(text).toContain('Emulator Relay')
    expect(text).toContain('- Internal: 6080')
    expect(text).toContain('- Relay URL: http://mobile-app-qa.localhost')
    expect(text).toContain('Recent Logs')
    expect(text).toContain('- Recent orchestrator log:\n  2026-11-20T00:00:00.000Z emulator boot waiting for sys.boot_completed')
    expect(text).toContain('isolated Android build and emulator environment')
    expect(text).not.toContain('Web Room')
    expect(text).not.toContain('- Node:')
    expect(text).not.toContain('Recent web output:')
    expect(text).not.toContain('isolated web development environment')
    expect(text).not.toContain(room.sourceRef)
  })

  it('uses Android emulator defaults when room.android metadata is absent', () => {
    const room = makeRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 0,
      domain: ''
    })

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report: null,
      recentChanges: [],
      gateway: OFFLINE_GATEWAY,
      webLogTail: [],
      orchestratorLogTail: [],
      customPatterns: []
    })

    expect(text).toContain('- Emulator: Samsung Galaxy S10 · Android 14.0 · fast · portrait')
    expect(text).not.toContain('Emulator Relay')
  })

  it('formats Windows Room VMware metadata and orchestrator logs without web routing, web logs, or host paths', () => {
    const templateId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const room = makeRoom({
      provider: 'windows',
      project: 'win-qa',
      nickname: 'clean',
      status: 'broken',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      hostSyncEnabled: false,
      runtime: { kind: 'windows', version: '11' },
      packageManager: { kind: 'none' },
      startCommand: 'VMware guest boot',
      internalPort: 0,
      domain: 'win-qa-clean.localhost',
      https: false,
      windows: {
        backend: 'vmware',
        snapshot: 'devhotel-clean',
        templateId
      }
    })
    const report: CheckReport = {
      roomId: room.id,
      ranAt: '2026-11-20T00:00:00.000Z',
      overall: 'broken',
      results: [
        { step: 'backend', status: 'healthy', summary: 'vmrun ready' },
        { step: 'process', status: 'broken', summary: 'Room record is awake but its VM is stopped' }
      ]
    }

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report,
      recentChanges: [],
      gateway: ONLINE_GATEWAY,
      webLogTail: ['stale web output should never appear'],
      orchestratorLogTail: ['2026-11-20T00:00:00.000Z vmrun start failed'],
      customPatterns: []
    })

    expect(text).toContain('- Provider: Windows Room (DevHotel 0.5.4)')
    expect(text).toContain('Environment')
    expect(text).toContain('- OS: Windows 11')
    expect(text).toContain('- VM Backend: vmware')
    expect(text).toContain('- Clean Snapshot: devhotel-clean')
    expect(text).toContain('- Template Fingerprint: a1b2c3d4e5f6')
    expect(text).not.toContain(templateId)
    expect(text).toContain('✕ process: Room record is awake but its VM is stopped')
    expect(text).toContain('- Recent orchestrator log:\n  2026-11-20T00:00:00.000Z vmrun start failed')
    expect(text).toContain('isolated offline Windows VMware environment')
    expect(text).not.toContain('Routing')
    expect(text).not.toContain('URL:')
    expect(text).not.toContain('win-qa-clean.localhost')
    expect(text).not.toContain('Gateway:')
    expect(text).not.toContain('- Node:')
    expect(text).not.toContain('Package Manager:')
    expect(text).not.toContain('Web Room')
    expect(text).not.toContain('Recent web output:')
    expect(text).not.toContain('stale web output should never appear')
    expect(text).not.toContain('isolated web development environment')
  })

  it('redacts passwords, tokens, pairing codes, custom patterns, and linked host paths in orchestrator logs', () => {
    const hostPath = 'C:\\Users\\alice\\Private\\android-secret'
    const room = makeRoom({
      provider: 'android',
      sourceType: 'linked-folder',
      sourceRef: hostPath,
      workspaceMode: 'hotel',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug'
    })
    const report: CheckReport = {
      roomId: room.id,
      ranAt: '2026-11-20T00:00:00.000Z',
      overall: 'broken',
      results: [
        {
          step: 'source',
          status: 'broken',
          summary: 'sync failed',
          detail: `cannot read ${hostPath} using C:/Users/alice/Private/android-secret`
        }
      ]
    }

    const text = buildDiagnostic({
      room,
      appVersion: '0.5.4',
      report,
      recentChanges: [],
      gateway: OFFLINE_GATEWAY,
      webLogTail: [],
      orchestratorLogTail: [
        'password=super-secret-password',
        'Authorization: Bearer abcdef1234567890',
        'ghp_1234567890abcdefghij123456',
        'pairing code: 482913',
        'adb pair 192.168.1.50:37123 654321',
        `linked folder ${hostPath} custom=MY_CUSTOM_SECRET`
      ],
      customPatterns: ['MY_CUSTOM_SECRET']
    })

    expect(text).not.toContain('super-secret-password')
    expect(text).not.toContain('abcdef1234567890')
    expect(text).not.toContain('ghp_1234567890abcdefghij123456')
    expect(text).not.toContain('482913')
    expect(text).not.toContain('654321')
    expect(text).not.toContain('MY_CUSTOM_SECRET')
    expect(text).not.toContain(hostPath)
    expect(text).not.toContain('C:/Users/alice/Private/android-secret')
    expect(text).toContain('•••')
  })
})

describe('RoomOrchestrator.getDiagnostic across providers', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const windowsVm = new FakeWindowsVm()
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({
      userData,
      backend,
      windowsVm,
      gateway: gateway.asGateway(),
      db,
      appVersion: '0.5.4'
    })
    return { orch, backend, windowsVm, gateway }
  }

  it('produces an Android diagnostic bundle with orchestrator logs and masked secrets', async () => {
    const { orch } = setup()
    const room = await orch.createRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      project: 'android-diag',
      nickname: 'dev',
      actor: 'user'
    })
    orch.logs.orchestrator(room.id, 'emulator check token=android-secret-token pairing code: 739104')

    const text = await orch.getDiagnostic(room.id)

    expect(text).toContain('- Provider: Android Room (DevHotel 0.5.4)')
    expect(text).toContain('- JDK: 17')
    expect(text).toContain('- Build Tool: gradle')
    expect(text).toContain('- Emulator: Samsung Galaxy S10 · Android 14.0 · fast · portrait')
    expect(text).toContain('Recent orchestrator log:')
    expect(text).toContain('emulator check')
    expect(text).not.toContain('android-secret-token')
    expect(text).not.toContain('739104')
    expect(text).not.toContain('Web Room')
  })

  it('produces a Windows diagnostic bundle with VMware metadata, checks, and orchestrator logs without host paths', async () => {
    const { orch, windowsVm } = setup()
    const baseVmxPath = 'C:\\Users\\owner\\VMs\\Windows11.vmx'
    const room = await orch.createRoom({
      provider: 'windows',
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-diag',
      nickname: 'clean',
      actor: 'user',
      windows: { baseVmxPath, snapshot: 'devhotel-clean' }
    })
    orch.logs.orchestrator(room.id, 'windows check password=win-secret-pass')

    const text = await orch.getDiagnostic(room.id)

    expect(text).toContain('- Provider: Windows Room (DevHotel 0.5.4)')
    expect(text).toContain('- OS: Windows 11')
    expect(text).toContain('- VM Backend: vmware')
    expect(text).toContain('- Clean Snapshot: devhotel-clean')
    expect(text).toContain(`- Template Fingerprint: ${windowsVm.templateId.slice(0, 12)}`)
    expect(text).toContain('✓ backend: fake vmrun')
    expect(text).toContain('✓ process: Windows VM is running')
    expect(text).toContain('Recent orchestrator log:')
    expect(text).toContain('windows check')
    expect(text).not.toContain('win-secret-pass')
    expect(text).not.toContain(baseVmxPath)
    expect(text).not.toContain('Routing')
    expect(text).not.toContain('Web Room')
    expect(text).not.toContain('Recent web output:')
  })
})
