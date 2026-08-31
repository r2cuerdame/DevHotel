import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AndroidAutomationTarget } from '@devhotel/shared'
import type {
  AndroidAutomationSession,
  AndroidForegroundInstallEvidence
} from '../devices/androidAutomation'
import { DevHotelError } from '../errors'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'
import { screenshotPng } from './pngFixture'

const ROOM_ID = 'aaaa1111'
const APP_ID = 'com.example.app'
const CHANGE_ID = '11111111-2222-4333-8444-555555555555'
const INSTALLED_AT = '2026-08-30T00:00:00.000Z'
const emulatorTarget: AndroidAutomationTarget = {
  kind: 'emulator',
  deviceId: null,
  nickname: 'Room emulator',
  model: 'Pixel 8',
  androidVersion: '14',
  apiLevel: 34
}

function evidence(
  target: AndroidAutomationTarget = emulatorTarget,
  overrides: Partial<NonNullable<AndroidForegroundInstallEvidence['seal']>> = {}
): AndroidForegroundInstallEvidence {
  const deviceId = target.kind === 'physical' ? target.deviceId : null
  const receipt = {
    roomId: ROOM_ID,
    target: { kind: target.kind, deviceId },
    applicationId: overrides.applicationId ?? APP_ID,
    changeId: overrides.changeId ?? CHANGE_ID,
    apkSha256: overrides.apkSha256 ?? 'a'.repeat(64),
    installedAt: overrides.installedAt ?? INSTALLED_AT
  }
  return {
    context: {
      status: {
        target,
        installedApplicationIds: [receipt.applicationId],
        foregroundApplicationId: receipt.applicationId,
        locale: 'ko_KR'
      },
      receipt
    },
    seal: {
      targetKind: target.kind,
      targetId: target.kind === 'physical' ? deviceId! : ROOM_ID,
      deviceId,
      leaseId: target.kind === 'physical' ? overrides.leaseId ?? 'lease-private' : null,
      roomId: ROOM_ID,
      applicationId: receipt.applicationId,
      changeId: receipt.changeId,
      apkSha256: receipt.apkSha256,
      installedAt: receipt.installedAt,
      packageIncarnation: overrides.packageIncarnation ?? 'b'.repeat(64),
      logFence: overrides.logFence ?? 'devhotel-install-u0-uid10123-11111111-2222-4333-8444-555555555555',
      installUserId: overrides.installUserId ?? 0,
      installUserSerial: overrides.installUserSerial ?? 42
    }
  }
}

function installSession(
  orch: RoomOrchestrator,
  target: AndroidAutomationTarget,
  sequence: AndroidForegroundInstallEvidence[]
): { signals: AbortSignal[]; timeouts: number[] } {
  const signals: AbortSignal[] = []
  const timeouts: number[] = []
  let evidenceIndex = 0
  const session = {
    target,
    async foregroundInstallEvidence(signal?: AbortSignal) {
      if (signal) signals.push(signal)
      return sequence[Math.min(evidenceIndex++, sequence.length - 1)]!
    },
    async withActiveUserScreenWitness<T>(
      action: (signal: AbortSignal) => Promise<T>,
      opts: { actionTimeoutMs?: number } = {}
    ): Promise<T> {
      timeouts.push(opts.actionTimeoutMs ?? 0)
      if ((opts.actionTimeoutMs ?? 0) > 120_000) throw new Error('screen witness timeout exceeds #36 contract')
      return action(new AbortController().signal)
    }
  } as unknown as AndroidAutomationSession
  vi.spyOn(orch, 'openAndroidAutomationSessionLocked').mockResolvedValue(session)
  return { signals, timeouts }
}

describe('Android screenshot artifact capture', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    backend.emulatorStateValue = 'running'
    const adb = new FakeAdbHost([
      { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }
    ])
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: new FakeGateway().asGateway(),
      adb,
      appVersion: 'test'
    })
    orch.rooms.create(
      makeRoom({
        id: ROOM_ID,
        provider: 'android',
        sourceType: 'managed-git',
        sourceRef: 'https://example.invalid/app.git',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        stateRevision: 7,
        workspaceVolumeRevision: 3,
        runtime: { kind: 'jdk', version: '17' },
        packageManager: { kind: 'gradle' },
        status: 'ready'
      })
    )
    return { userData, backend, adb, orch }
  }

  it('publishes exact tracked pixels and metadata inside one bounded screen witness', async () => {
    const { backend, orch } = setup()
    const png = screenshotPng(3, 2, { text: 'Bearer must-not-survive' })
    let captureSignal: AbortSignal | undefined
    backend.fencedEmulatorExecHandler = (args, opts) => {
      if (args[0] === 'exec-out') {
        captureSignal = opts?.signal
        return { code: 0, stdout: png.toString('base64'), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const session = installSession(orch, emulatorTarget, [evidence(), evidence()])

    const artifact = await orch.captureAndroidScreenshotArtifact(
      ROOM_ID,
      { filename: 'login-success.png' },
      'agent'
    )

    expect(session.timeouts).toEqual([120_000])
    expect(session.signals).toHaveLength(2)
    expect(session.signals[0]).toBe(session.signals[1])
    expect(captureSignal).toBe(session.signals[0])
    expect(artifact).toMatchObject({
      roomId: ROOM_ID,
      filename: 'login-success.png',
      actor: 'agent',
      metadata: {
        room: { id: ROOM_ID, stateRevision: 7, workspaceVolumeRevision: 3 },
        capture: { source: 'adb', width: 3, height: 2, orientation: 'landscape' },
        device: { kind: 'emulator', deviceId: null, apiLevel: 34 },
        app: { status: 'tracked-active', packageName: APP_ID },
        locale: { tag: 'ko-KR', scope: 'system' },
        build: {
          exact: true,
          changeId: CHANGE_ID,
          apkSha256: 'a'.repeat(64),
          installedAt: INSTALLED_AT
        }
      }
    })
    const stored = orch.readRoomArtifactContent(ROOM_ID, artifact.id).content
    expect(stored.toString('utf8')).not.toContain('must-not-survive')
    expect(JSON.stringify(artifact)).not.toMatch(/serial|leaseId|logFence|packageIncarnation|R5CT30ABCDE/)
  })

  it('validates Room-scoped associations before opening a session or touching pixels', async () => {
    const { backend, adb, orch } = setup()
    const open = vi.spyOn(orch, 'openAndroidAutomationSessionLocked')

    await expect(
      orch.captureAndroidScreenshotArtifact(
        ROOM_ID,
        { filename: 'wrong-association.png', association: { changeId: CHANGE_ID } },
        'agent'
      )
    ).rejects.toMatchObject({ code: 'ARTIFACT_ASSOCIATION_NOT_FOUND' })
    expect(open).not.toHaveBeenCalled()
    expect(backend.fencedEmulatorExecCalls).toEqual([])
    expect(adb.execs).toEqual([])
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('withholds Host storage paths when startup artifact reconciliation fails', async () => {
    const { userData, orch } = setup()
    const privateFailure = `EACCES ${userData}\\rooms\\${ROOM_ID}\\artifacts\\screenshots`
    vi.spyOn(orch.artifacts, 'reconcileRoom').mockImplementation(() => { throw new Error(privateFailure) })

    await orch.init()

    const log = orch.logs.tail(ROOM_ID, 'orchestrator').join('\n')
    expect(log).toContain('screenshot artifact recovery needs attention')
    expect(log).not.toContain(userData)
    expect(log).not.toContain('EACCES')
  })

  it('withholds pixels when private install authority changes across capture', async () => {
    const { backend, orch } = setup()
    backend.fencedEmulatorExecHandler = () => ({
      code: 0,
      stdout: screenshotPng().toString('base64'),
      stderr: ''
    })
    installSession(orch, emulatorTarget, [
      evidence(),
      evidence(emulatorTarget, { packageIncarnation: 'c'.repeat(64) })
    ])

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'changed-context.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_CHANGED' })
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('withholds pixels when the tracked foreground application changes across capture', async () => {
    const { backend, orch } = setup()
    backend.fencedEmulatorExecHandler = () => ({
      code: 0,
      stdout: screenshotPng().toString('base64'),
      stderr: ''
    })
    installSession(orch, emulatorTarget, [
      evidence(),
      evidence(emulatorTarget, { applicationId: 'com.example.other' })
    ])

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'changed-app.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_CHANGED' })
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('withholds pixels when the live screen witness observes an A-B-A user or focus transition', async () => {
    const { backend, orch } = setup()
    backend.fencedEmulatorExecHandler = () => ({
      code: 0,
      stdout: screenshotPng().toString('base64'),
      stderr: ''
    })
    const session = {
      target: emulatorTarget,
      async foregroundInstallEvidence() { return evidence() },
      async withActiveUserScreenWitness<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        await action(new AbortController().signal)
        // androidAutomation.test.ts exercises the real am_switch_user and
        // input_focus transcripts. This boundary regression proves that such
        // a failed witness cannot publish bytes as an artifact.
        throw new DevHotelError(
          'ANDROID_SCREEN_WITNESS_FAILED',
          'The active Android screen changed while evidence was captured.'
        )
      }
    } as unknown as AndroidAutomationSession
    vi.spyOn(orch, 'openAndroidAutomationSessionLocked').mockResolvedValue(session)

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'screen-aba.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    expect(backend.fencedEmulatorExecCalls).toHaveLength(1)
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('rejects durable capture before pixels on API levels without an ordered screen witness', async () => {
    const { backend, orch } = setup()
    const unsupportedTarget = { ...emulatorTarget, androidVersion: '11', apiLevel: 30 }
    const session = {
      target: unsupportedTarget,
      async withActiveUserScreenWitness(): Promise<never> {
        throw new DevHotelError(
          'ANDROID_SCREEN_WITNESS_UNSUPPORTED',
          'This Android target cannot prove a globally ordered active-user screen witness.'
        )
      }
    } as unknown as AndroidAutomationSession
    vi.spyOn(orch, 'openAndroidAutomationSessionLocked').mockResolvedValue(session)

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'api30.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_UNSUPPORTED' })
    expect(backend.fencedEmulatorExecCalls).toEqual([])
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('fails closed when no exact tracked foreground receipt exists', async () => {
    const { backend, orch } = setup()
    backend.fencedEmulatorExecHandler = () => ({
      code: 0,
      stdout: screenshotPng().toString('base64'),
      stderr: ''
    })
    const untracked: AndroidForegroundInstallEvidence = {
      context: {
        status: { ...evidence().context.status, foregroundApplicationId: null },
        receipt: null
      },
      seal: null
    }
    installSession(orch, emulatorTarget, [untracked, untracked])

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'untracked.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'SCREENSHOT_APP_NOT_TRACKED' })
    expect(backend.fencedEmulatorExecCalls).toEqual([])
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('does not publish an over-limit emulator capture or silently fall back', async () => {
    const { backend, orch } = setup()
    backend.fencedEmulatorExecHandler = () => ({
      code: 97,
      stdout: screenshotPng().toString('base64'),
      stderr: '',
      outputLimitExceeded: true
    })
    installSession(orch, emulatorTarget, [evidence(), evidence()])

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'overflow.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID' })
    expect(backend.calls.some((call) => call.startsWith('captureEmulatorScreen:'))).toBe(false)
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('aborts publication when a physical lease is replaced during binary capture', async () => {
    const { adb, orch } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice(ROOM_ID, { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    const physicalTarget: AndroidAutomationTarget = {
      kind: 'physical',
      deviceId: attached.device.id,
      nickname: attached.device.nickname,
      model: attached.device.model,
      androidVersion: attached.device.androidVersion,
      apiLevel: attached.device.apiLevel
    }
    const sealed = evidence(physicalTarget, { leaseId: attached.lease.id })
    installSession(orch, physicalTarget, [sealed, sealed])
    adb.execBinaryResultFor = async (_serial, args) => {
      if (args[0] !== 'exec-out') return null
      await orch.devices.release(attached.lease.id, 'replace during screenshot')
      const next = await orch.devices.requestDevice({
        roomId: ROOM_ID,
        project: 'demo',
        purpose: 'acceptance',
        workerId: 'worker-b',
        constraints: { deviceId: attached.device.id }
      })
      expect(next.state).toBe('granted')
      return { code: 0, stdout: screenshotPng(), stderr: '', outputLimitExceeded: false }
    }

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'lease-race.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'lease-expired' })
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('rejects a replaced physical lease before reading screenshot pixels', async () => {
    const { adb, orch } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice(ROOM_ID, { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    const physicalTarget: AndroidAutomationTarget = {
      kind: 'physical',
      deviceId: attached.device.id,
      nickname: attached.device.nickname,
      model: attached.device.model,
      androidVersion: attached.device.androidVersion,
      apiLevel: attached.device.apiLevel
    }
    const sealed = evidence(physicalTarget, { leaseId: attached.lease.id })
    let evidenceCalls = 0
    const session = {
      target: physicalTarget,
      async foregroundInstallEvidence() {
        evidenceCalls += 1
        if (evidenceCalls === 1) {
          await orch.devices.release(attached.lease.id, 'replace before pixel read')
          const next = await orch.devices.requestDevice({
            roomId: ROOM_ID,
            project: 'demo',
            purpose: 'acceptance',
            workerId: 'worker-b',
            constraints: { deviceId: attached.device.id }
          })
          expect(next.state).toBe('granted')
        }
        return sealed
      },
      async withActiveUserScreenWitness<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return action(new AbortController().signal)
      }
    } as unknown as AndroidAutomationSession
    vi.spyOn(orch, 'openAndroidAutomationSessionLocked').mockResolvedValue(session)
    adb.execs = []

    await expect(
      orch.captureAndroidScreenshotArtifact(ROOM_ID, { filename: 'lease-before-pixels.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'lease-expired' })
    expect(adb.execs).toEqual([])
    expect(orch.listRoomArtifacts(ROOM_ID)).toEqual([])
  })

  it('keeps screen mode on the exact emulator and threads the witness signal into X capture', async () => {
    const { backend, adb, orch } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice(ROOM_ID, { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.emulatorScreenPng = screenshotPng(2, 4).toString('base64')
    const capture = vi.spyOn(backend, 'captureEmulatorScreen')
    const session = installSession(orch, emulatorTarget, [evidence(), evidence()])

    const artifact = await orch.captureAndroidScreenshotArtifact(
      ROOM_ID,
      { filename: 'secure-screen.png', mode: 'screen' },
      'agent'
    )

    expect(artifact.metadata).toMatchObject({
      capture: { source: 'screen', width: 2, height: 4 },
      device: { kind: 'emulator', deviceId: null }
    })
    expect(capture).toHaveBeenCalledWith(ROOM_ID, {
      signal: session.signals[0],
      timeoutMs: 60_000
    })
    expect(adb.execs).toEqual([])
  })
})
