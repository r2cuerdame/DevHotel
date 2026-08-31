import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AndroidAutomationTarget,
  AndroidLocaleScreenshotMatrixInput,
  AndroidTargetSelector
} from '@devhotel/shared'
import { canonicalAndroidLocaleTags } from '@devhotel/shared'
import type {
  AndroidAppLocaleRestoreFence,
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
const OWNERSHIP_TAG = /^[a-z]{2,8}-x-dh-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{8}-[0-9a-f]{4}$/

function expectMarkedLocaleList(localeTags: readonly string[] | undefined, requested: string): void {
  expect(localeTags).toHaveLength(2)
  expect(localeTags?.[0]).toBe(requested)
  expect(localeTags?.[1]).toMatch(OWNERSHIP_TAG)
}
const target: AndroidAutomationTarget = {
  kind: 'emulator',
  deviceId: null,
  nickname: 'Room emulator',
  model: 'Pixel 8',
  androidVersion: '14',
  apiLevel: 34
}

function installEvidence(): AndroidForegroundInstallEvidence {
  const receipt = {
    roomId: ROOM_ID,
    target: { kind: 'emulator' as const, deviceId: null },
    applicationId: APP_ID,
    changeId: CHANGE_ID,
    apkSha256: 'a'.repeat(64),
    installedAt: '2026-08-30T00:00:00.000Z'
  }
  return {
    context: {
      status: {
        target,
        installedApplicationIds: [APP_ID],
        foregroundApplicationId: APP_ID,
        locale: 'en-US'
      },
      receipt
    },
    seal: {
      targetKind: 'emulator',
      targetId: ROOM_ID,
      deviceId: null,
      leaseId: null,
      roomId: ROOM_ID,
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: receipt.apkSha256,
      installedAt: receipt.installedAt,
      packageIncarnation: 'b'.repeat(64),
      logFence: 'devhotel-install-u0-uid10123-11111111-2222-4333-8444-555555555555',
      installUserId: 0,
      installUserSerial: 42
    }
  }
}

function localeRestoreFence(): AndroidAppLocaleRestoreFence {
  const seal = installEvidence().seal!
  return {
    targetKind: seal.targetKind,
    targetId: seal.targetId,
    deviceId: seal.deviceId,
    leaseId: seal.leaseId,
    roomId: seal.roomId,
    applicationId: seal.applicationId,
    changeId: seal.changeId,
    apkSha256: seal.apkSha256,
    installedAt: seal.installedAt,
    packageIncarnation: seal.packageIncarnation,
    installUserId: seal.installUserId,
    installUserSerial: seal.installUserSerial,
    apiLevel: 34
  }
}

describe('Android locale screenshot matrix', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(options: {
    failCapture?: boolean
    failRestore?: boolean
    externalBeforeFirstMutation?: string[]
    externalPlainTargetAfterPrecondition?: boolean
    failReadinessAfterAcceptedMutation?: boolean
    crashBeforeAcceptedCallback?: boolean
    driftAfterRestore?: string[]
    finalPidsAfterRestore?: number[]
  } = {}) {
    const controls = { ...options }
    const userData = tempDir()
    roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    backend.emulatorStateValue = 'running'
    backend.fencedEmulatorExecHandler = (args) => args[0] === 'exec-out'
      ? { code: 0, stdout: screenshotPng(3, 2, { text: 'locale-matrix' }).toString('base64'), stderr: '' }
      : { code: 0, stdout: '', stderr: '' }
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: new FakeGateway().asGateway(),
      adb: new FakeAdbHost(),
      appVersion: 'test'
    })
    orch.rooms.create(makeRoom({
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
    }))

    const applied: string[][] = []
    const expectedPrevious: string[][] = []
    const pendingAtMutation: Array<string | null> = []
    const pendingAtRestore: Array<string | null> = []
    const events: string[] = []
    const witnessOptions: Array<{ actionTimeoutMs?: number; allowApplicationIdTransitions?: string }> = []
    const localeSeals: string[][] = []
    let captureSealCalls = 0
    let currentLocaleTags = ['en-US']
    let restoredOnce = false
    let nextPid = 101
    const restoreFence = localeRestoreFence()
    const transition = (localeTags: readonly string[], previousLocaleTags: readonly string[]) => {
      const afterPids = [nextPid++]
      return {
        target,
        applicationId: APP_ID,
        apiLevel: 34,
        localeTags: [...localeTags],
        previousLocaleTags: [...previousLocaleTags],
        pids: afterPids,
        restoreFence,
        process: { beforePids: [100], afterPids, restarted: true },
        readiness: {
          adb: 'device' as const,
          localeService: 'ready' as const,
          application: 'foreground' as const,
          process: 'running' as const,
          attempts: 2,
          consecutiveReadyChecks: 2,
          elapsedMs: 500,
          pids: afterPids
        }
      }
    }
    const session = {
      target,
      async appLocaleSnapshot() {
        if (restoredOnce && controls.driftAfterRestore) {
          currentLocaleTags = [...controls.driftAfterRestore]
          controls.driftAfterRestore = undefined
        }
        return {
          apiLevel: 34,
          localeTags: [...currentLocaleTags],
          pids: restoredOnce && controls.finalPidsAfterRestore
            ? [...controls.finalPidsAfterRestore]
            : [100],
          restoreFence
        }
      },
      async proveAppLocaleFinalState(
        applicationId: string,
        expectedFence: AndroidAppLocaleRestoreFence
      ) {
        const before = await session.appLocaleSnapshot(applicationId)
        const after = await session.appLocaleSnapshot(applicationId)
        if (
          JSON.stringify(before.localeTags) !== JSON.stringify(after.localeTags) ||
          JSON.stringify(before.pids) !== JSON.stringify(after.pids) ||
          JSON.stringify(before.restoreFence) !== JSON.stringify(expectedFence) ||
          JSON.stringify(after.restoreFence) !== JSON.stringify(expectedFence)
        ) {
          throw new DevHotelError('ANDROID_LOCALE_TARGET_CHANGED', 'final locale proof changed')
        }
        return after
      },
      async applyAppLocalesAndWait(
        _applicationId: string,
        localeTags: readonly string[],
        applyOptions: {
          expectedPreviousLocaleTags?: readonly string[]
          onMutationAccepted?: () => void
        } = {}
      ) {
        pendingAtMutation.push((orch as unknown as { settings: { get(key: string): string | null } })
          .settings.get(`androidLocaleRestorePending:${ROOM_ID}`))
        expectedPrevious.push([...(applyOptions.expectedPreviousLocaleTags ?? [])])
        if (applied.length === 0 && controls.externalBeforeFirstMutation) {
          currentLocaleTags = [...controls.externalBeforeFirstMutation]
          throw new DevHotelError('ANDROID_LOCALE_PRECONDITION_CHANGED', 'external locale won')
        }
        const previous = [...(applyOptions.expectedPreviousLocaleTags ?? currentLocaleTags)]
        if (applied.length === 0 && controls.externalPlainTargetAfterPrecondition) {
          currentLocaleTags = [localeTags[0]!]
          controls.externalPlainTargetAfterPrecondition = false
        }
        applied.push([...localeTags])
        currentLocaleTags = [...localeTags]
        if (controls.crashBeforeAcceptedCallback) {
          controls.crashBeforeAcceptedCallback = false
          throw new Error('simulated process loss before accepted callback')
        }
        applyOptions.onMutationAccepted?.()
        if (controls.failReadinessAfterAcceptedMutation) {
          controls.failReadinessAfterAcceptedMutation = false
          throw new DevHotelError('ANDROID_LOCALE_READINESS_TIMEOUT', 'readiness timed out after setter acceptance')
        }
        return transition(localeTags, previous)
      },
      async restoreAppLocalesFromFence(
        _applicationId: string,
        localeTags: readonly string[],
        _restoreFence: AndroidAppLocaleRestoreFence,
        expectedLocaleTags: readonly string[],
        attemptedLocaleTags: readonly string[],
        restoreOptions: { onMutationAccepted?: () => void } = {}
      ) {
        events.push('restore')
        pendingAtRestore.push((orch as unknown as { settings: { get(key: string): string | null } })
          .settings.get(`androidLocaleRestorePending:${ROOM_ID}`))
        if (controls.failRestore) {
          applied.push([...localeTags])
          throw new DevHotelError('ANDROID_LOCALE_MUTATION_REJECTED', 'restore rejected')
        }
        if (
          ![expectedLocaleTags, attemptedLocaleTags].some((candidate) =>
            candidate.length === currentLocaleTags.length &&
            candidate.every((value, index) => value === currentLocaleTags[index])
          )
        ) {
          throw new DevHotelError('ANDROID_LOCALE_PRECONDITION_CHANGED', 'restore stage does not own locale')
        }
        const previous = [...currentLocaleTags]
        if (JSON.stringify(currentLocaleTags) !== JSON.stringify(localeTags)) {
          applied.push([...localeTags])
          currentLocaleTags = [...localeTags]
          restoreOptions.onMutationAccepted?.()
        }
        restoredOnce = true
        return transition(localeTags, previous)
      },
      async foregroundInstallEvidence() {
        return installEvidence()
      },
      async assertAppLocaleCaptureState(_applicationId: string, localeTags: readonly string[]) {
        localeSeals.push([...localeTags])
        captureSealCalls += 1
        if (controls.failCapture && captureSealCalls === 1) throw new Error('capture locale drift')
      },
      async withActiveUserScreenWitness<T>(
        action: (signal: AbortSignal) => Promise<T>,
        opts: { actionTimeoutMs?: number; allowApplicationIdTransitions?: string } = {}
      ): Promise<T> {
        witnessOptions.push(opts)
        return action(new AbortController().signal)
      }
    } as unknown as AndroidAutomationSession
    const sessionHost = orch as unknown as {
      openAndroidAutomationSessionLocked(
        roomId: string,
        selector: AndroidTargetSelector,
        options?: { allowPendingRecovery?: boolean }
      ): Promise<AndroidAutomationSession>
    }
    const open = vi.spyOn(sessionHost, 'openAndroidAutomationSessionLocked').mockImplementation(async () => {
      events.push('open')
      return session
    })
    return {
      applied,
      backend,
      controls,
      currentLocaleTags: () => [...currentLocaleTags],
      setCurrentLocaleTags: (localeTags: readonly string[]) => {
        currentLocaleTags = [...localeTags]
      },
      expectedPrevious,
      events,
      localeSeals,
      open,
      orch,
      pendingAtMutation,
      pendingAtRestore,
      restoreFence,
      session,
      witnessOptions
    }
  }

  it('uses one session, captures exact app-locale receipts, and restores the original locale', async () => {
    const { applied, expectedPrevious, localeSeals, open, orch, pendingAtMutation, witnessOptions } = setup()
    const result = await orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR', 'en-US'],
      filenamePrefix: 'release-42'
    }, 'agent')

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(ROOM_ID, { kind: 'emulator' })
    expect(applied).toHaveLength(3)
    expect(applied[0]?.[0]).toBe('ko-KR')
    expect(applied[0]?.[1]).toMatch(OWNERSHIP_TAG)
    expect(applied[1]?.[0]).toBe('en-US')
    expect(applied[1]?.[1]).toMatch(OWNERSHIP_TAG)
    expect(applied[1]?.[1]).not.toBe(applied[0]?.[1])
    for (const marker of [applied[0]?.[1], applied[1]?.[1]]) {
      expect(marker?.length).toBeLessThanOrEqual(63)
      expect(canonicalAndroidLocaleTags([marker!])).toEqual([marker])
    }
    expect(applied[2]).toEqual(['en-US'])
    expect(expectedPrevious).toEqual([['en-US'], applied[0]])
    expect(pendingAtMutation).toHaveLength(2)
    expect(pendingAtMutation.every((value) => value !== null)).toBe(true)
    const mutationStages = pendingAtMutation.map((value) => JSON.parse(value!) as {
      operationId: string
      stage: number
      expectedLocaleTags: string[]
      attemptedLocaleTags: string[]
    })
    expect(mutationStages[0]).toMatchObject({
      stage: 0,
      expectedLocaleTags: ['en-US'],
      attemptedLocaleTags: applied[0]
    })
    expect(mutationStages[1]).toMatchObject({
      stage: 1,
      expectedLocaleTags: applied[0],
      attemptedLocaleTags: applied[1]
    })
    expect(new Set(mutationStages.map(({ operationId }) => operationId)).size).toBe(2)
    expect((orch as unknown as { settings: { get(key: string): string | null } }).settings
      .get(`androidLocaleRestorePending:${ROOM_ID}`)).toBeNull()
    expect(localeSeals).toEqual([applied[0], applied[0], applied[1], applied[1]])
    expect(witnessOptions.filter((entry) => entry.allowApplicationIdTransitions === APP_ID)).toHaveLength(3)
    expect(result.entries.map((entry) => entry.artifact.filename)).toEqual([
      'release-42-ko-kr.png',
      'release-42-en-us.png'
    ])
    expect(result.entries.map((entry) => entry.artifact.metadata.locale)).toEqual([
      { tag: 'ko-KR', scope: 'app' },
      { tag: 'en-US', scope: 'app' }
    ])
    expect(result.entries.map((entry) => entry.appliedLocaleTags)).toEqual([applied[0], applied[1]])
    expect(result).toMatchObject({
      applicationId: APP_ID,
      apiLevel: 34,
      scope: 'app',
      restoration: { localeTags: ['en-US'], readiness: { consecutiveReadyChecks: 2 } }
    })
  })

  it('restores after a capture failure and lets an unproven restoration dominate', async () => {
    const failedCapture = setup({ failCapture: true })
    await expect(failedCapture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'failed'
    }, 'agent')).rejects.toThrow('capture locale drift')
    expectMarkedLocaleList(failedCapture.applied[0], 'ko-KR')
    expect(failedCapture.applied[1]).toEqual(['en-US'])

    const failedRestore = setup({ failCapture: true, failRestore: true })
    await expect(failedRestore.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'failed-restore'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    expectMarkedLocaleList(failedRestore.applied[0], 'ko-KR')
    expect(failedRestore.applied[1]).toEqual(['en-US'])
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const settings = (failedRestore.orch as unknown as { settings: { get(key: string): string | null } }).settings
    expect(settings.get(pendingKey)).not.toBeNull()
    expect((failedRestore.orch as unknown as { rooms: { get(id: string): { status: string } | null } })
      .rooms.get(ROOM_ID)?.status).toBe('attention')
    await expect(failedRestore.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['en-US'],
      filenamePrefix: 'blocked'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })

    failedRestore.controls.failRestore = false
    await failedRestore.orch.init()
    expect(settings.get(pendingKey)).toBeNull()
    expect(failedRestore.applied.at(-1)).toEqual(['en-US'])
  })

  it('never treats a locale from a future unattempted step as DevHotel-owned', async () => {
    const fixture = setup({ externalBeforeFirstMutation: ['fr-FR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR', 'fr-FR'],
      filenamePrefix: 'external-future'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })

    expect(fixture.applied).toEqual([])
    expect(fixture.currentLocaleTags()).toEqual(['fr-FR'])
    const raw = (fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)
    expect(raw).not.toBeNull()
    const pending = JSON.parse(raw!) as {
      stage: number
      expectedLocaleTags: string[]
      attemptedLocaleTags: string[]
    }
    expect(pending).toMatchObject({
      stage: 0,
      expectedLocaleTags: ['en-US']
    })
    expectMarkedLocaleList(pending.attemptedLocaleTags, 'ko-KR')
  })

  it('never restores an attempted locale that an external actor reached before the setter', async () => {
    const fixture = setup({ externalBeforeFirstMutation: ['ko-KR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'external-attempted'
    }, 'agent')).rejects.toMatchObject({
      code: 'ANDROID_LOCALE_RECOVERY_REQUIRED',
      evidence: {
        stage: 'precondition',
        primaryFailureCode: 'ANDROID_LOCALE_PRECONDITION_CHANGED'
      }
    })

    // The forward setter rejected its exact previous-locale precondition, and
    // the retained attempted value is not evidence that DevHotel owns the
    // external actor's coincidentally matching locale. Neither setter runs.
    expect(fixture.applied).toEqual([])
    expect(fixture.pendingAtRestore).toEqual([])
    expect(fixture.events).not.toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['ko-KR'])
    expect((fixture.orch as unknown as { rooms: { get(id: string): { status: string } | null } })
      .rooms.get(ROOM_ID)?.status).toBe('attention')
    const raw = (fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)
    expect(raw).not.toBeNull()
    const pending = JSON.parse(raw!) as {
      stage: number
      expectedLocaleTags: string[]
      attemptedLocaleTags: string[]
      attemptedLocaleOwned: boolean
    }
    expect(pending).toMatchObject({
      stage: 0,
      expectedLocaleTags: ['en-US'],
      attemptedLocaleOwned: false
    })
    expectMarkedLocaleList(pending.attemptedLocaleTags, 'ko-KR')

    await fixture.orch.init()
    expect(fixture.applied).toEqual([])
    expect(fixture.pendingAtRestore).toEqual([])
    expect(fixture.events).not.toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['ko-KR'])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
  })

  it('adds an operation-bound marker when an external actor selects the plain target after the final read', async () => {
    const fixture = setup({ externalPlainTargetAfterPrecondition: true })

    const result = await fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'external-plain-race'
    }, 'agent')

    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(fixture.applied[1]).toEqual(['en-US'])
    expect(result.entries[0]?.appliedLocaleTags).toEqual(fixture.applied[0])
    expect(result.entries[0]?.locale).toBe('ko-KR')
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
  })

  it('persists accepted ownership before readiness timeout and restores the exact marker', async () => {
    const fixture = setup({ failReadinessAfterAcceptedMutation: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'accepted-before-timeout'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_READINESS_TIMEOUT' })

    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(fixture.applied[1]).toEqual(['en-US'])
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).toBeNull()
  })

  it('recovers after the setter lands and the process dies before the accepted callback', async () => {
    const fixture = setup({ crashBeforeAcceptedCallback: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const settings = (fixture.orch as unknown as {
      settings: {
        get(key: string): string | null
        setIfValue(key: string, expected: string, next: string): boolean
      }
    }).settings
    const setIfValue = settings.setIfValue.bind(settings)
    let failedStageAdvance = false
    settings.setIfValue = (key, expected, next) => {
      if (key === pendingKey && !failedStageAdvance) {
        failedStageAdvance = true
        return false
      }
      return setIfValue(key, expected, next)
    }

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'accepted-callback-crash'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    const pending = JSON.parse(settings.get(pendingKey)!) as {
      attemptedLocaleTags: string[]
      attemptedLocaleOwnershipTag: string | null
      attemptedLocaleOwned: boolean
    }
    expectMarkedLocaleList(pending.attemptedLocaleTags, 'ko-KR')
    expect(pending.attemptedLocaleOwnershipTag).toBe(pending.attemptedLocaleTags[1])
    expect(pending.attemptedLocaleOwned).toBe(false)

    await fixture.orch.init()

    expect(fixture.applied.at(-1)).toEqual(['en-US'])
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
    expect(settings.get(pendingKey)).toBeNull()
  })

  it.each([1, 2])('treats a legacy v%s plain attempted locale as unowned during startup recovery', async (version) => {
    const fixture = setup({ externalBeforeFirstMutation: ['ko-KR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'legacy-unconfirmed'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; set(key: string, value: string): void }
    }).settings
    const legacy = JSON.parse(settings.get(pendingKey)!) as Record<string, unknown>
    delete legacy.attemptedLocaleOwnershipTag
    if (version === 1) delete legacy.attemptedLocaleOwned
    settings.set(pendingKey, JSON.stringify({
      ...legacy,
      version,
      attemptedLocaleTags: ['ko-KR']
    }))
    fixture.events.length = 0

    await fixture.orch.init()

    expect(fixture.applied).toEqual([])
    expect(fixture.events).not.toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['ko-KR'])
    expect(settings.get(pendingKey)).not.toBeNull()
  })

  it('does not accept an arbitrary canonical secondary tag as an operation-bound marker', async () => {
    const fixture = setup({ externalBeforeFirstMutation: ['ko-KR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'forged-marker'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; set(key: string, value: string): void }
    }).settings
    const pending = JSON.parse(settings.get(pendingKey)!) as Record<string, unknown>
    const forged = 'ko-x-dh-00000000-0000-0000-0000-00000000-0000'
    settings.set(pendingKey, JSON.stringify({
      ...pending,
      attemptedLocaleTags: ['ko-KR', forged],
      attemptedLocaleOwnershipTag: forged
    }))
    fixture.setCurrentLocaleTags(['ko-KR', forged])
    fixture.events.length = 0

    await fixture.orch.init()

    expect(fixture.events).not.toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['ko-KR', forged])
    expect(settings.get(pendingKey)).not.toBeNull()
  })

  it('retains a confirmed stage when an external actor drifts back to its non-original expected locale', async () => {
    const fixture = setup({ externalBeforeFirstMutation: ['ko-KR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'confirmed-expected-drift'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; set(key: string, value: string): void }
    }).settings
    const pending = JSON.parse(settings.get(pendingKey)!) as Record<string, unknown>
    const drifted = JSON.stringify({
      ...pending,
      expectedLocaleTags: ['fr-FR'],
      attemptedLocaleTags: ['ko-KR'],
      attemptedLocaleOwnershipTag: null,
      attemptedLocaleOwned: true
    })
    settings.set(pendingKey, drifted)
    fixture.setCurrentLocaleTags(['fr-FR'])
    fixture.events.length = 0

    await fixture.orch.init()

    expect(fixture.applied).toEqual([])
    expect(fixture.events).not.toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['fr-FR'])
    expect(settings.get(pendingKey)).toBe(drifted)
  })

  it('releases an unconfirmed intent without a setter when the exact original locale is already present', async () => {
    const fixture = setup({ externalBeforeFirstMutation: ['en-US'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'original-already-present'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })
    fixture.events.length = 0

    await fixture.orch.init()

    expect(fixture.applied).toEqual([])
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).toBeNull()
  })

  it('recovers an exact marker after ownership confirmation CAS fails before any later await', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const settings = (fixture.orch as unknown as {
      settings: {
        get(key: string): string | null
        setIfValue(key: string, expected: string, next: string): boolean
      }
    }).settings
    const setIfValue = settings.setIfValue.bind(settings)
    let confirmationAttempts = 0
    settings.setIfValue = (key, expected, next) => {
      if (key === pendingKey && confirmationAttempts++ < 2) return false
      return setIfValue(key, expected, next)
    }

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'confirmation-cas-failed'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(fixture.applied).toHaveLength(1)
    const pending = JSON.parse(settings.get(pendingKey)!) as {
      attemptedLocaleTags: string[]
      attemptedLocaleOwned: boolean
      attemptedLocaleOwnershipTag: string | null
    }
    expectMarkedLocaleList(pending.attemptedLocaleTags, 'ko-KR')
    expect(pending.attemptedLocaleOwned).toBe(false)
    expect(pending.attemptedLocaleOwnershipTag).toBe(pending.attemptedLocaleTags[1])

    fixture.controls.failRestore = false
    fixture.events.length = 0
    await fixture.orch.init()

    expect(fixture.events).toContain('restore')
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
    expect(settings.get(pendingKey)).toBeNull()
  })

  it('retains recovery ownership when locale drifts after the screen witness closes', async () => {
    const fixture = setup({ driftAfterRestore: ['fr-FR'] })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'stale-restore-proof'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })

    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(fixture.applied[1]).toEqual(['en-US'])
    expect(fixture.currentLocaleTags()).toEqual(['fr-FR'])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
  })

  it('returns the final proven process set instead of stale restore-helper readiness PIDs', async () => {
    const fixture = setup({ finalPidsAfterRestore: [901, 902] })

    const result = await fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'fresh-restoration-pids'
    }, 'agent')

    expect(result.restoration.readiness.pids).toEqual([901, 902])
  })

  it('keeps a failed startup recovery awake, gated, and retryable', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'startup-retry'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.backend.calls.length = 0

    await fixture.orch.init()

    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
    expect(fixture.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
    expect((fixture.orch as unknown as { rooms: { get(id: string): { status: string } | null } })
      .rooms.get(ROOM_ID)?.status).toBe('attention')
  })

  it('does not release startup recovery from a stale post-witness result', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'startup-stale'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.controls.failRestore = false
    fixture.events.length = 0
    fixture.controls.driftAfterRestore = ['fr-FR']
    fixture.backend.calls.length = 0

    await fixture.orch.init()

    expect(fixture.currentLocaleTags()).toEqual(['fr-FR'])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
    expect(fixture.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
  })

  it('retries safely after crashing between a successful startup restore and intent release', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'startup-release-crash'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.controls.failRestore = false
    fixture.open.mockClear()
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; deleteIfValue(key: string, value: string): boolean }
    }).settings
    const release = settings.deleteIfValue.bind(settings)
    let releaseAttempts = 0
    settings.deleteIfValue = (key, value) => {
      if (key === pendingKey && releaseAttempts++ === 0) return false
      return release(key, value)
    }

    await fixture.orch.init()
    const afterCrash = JSON.parse(settings.get(pendingKey)!) as {
      stage: number
      expectedLocaleTags: string[]
      attemptedLocaleTags: string[]
    }
    expectMarkedLocaleList(afterCrash.expectedLocaleTags, 'ko-KR')
    expect(afterCrash.attemptedLocaleTags).toEqual(['en-US'])
    expect(afterCrash.stage).toBeGreaterThan(0)
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])

    await fixture.orch.init()
    expect(settings.get(pendingKey)).toBeNull()
    expect(fixture.currentLocaleTags()).toEqual(['en-US'])
  })

  it.each([64, Number.MAX_SAFE_INTEGER])(
    'recovers a retained stage %s record instead of permanently refusing it',
    async (retainedStage) => {
      const fixture = setup({ failRestore: true })
      const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
      await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
        applicationId: APP_ID,
        locales: ['ko-KR'],
        filenamePrefix: 'stage-64'
      }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
      const settings = (fixture.orch as unknown as {
        settings: { get(key: string): string | null; set(key: string, value: string): void }
      }).settings
      const pending = JSON.parse(settings.get(pendingKey)!) as Record<string, unknown>
      settings.set(pendingKey, JSON.stringify({ ...pending, stage: retainedStage }))
      fixture.controls.failRestore = false

      await fixture.orch.init()

      expect(settings.get(pendingKey)).toBeNull()
      expect(fixture.currentLocaleTags()).toEqual(['en-US'])
    }
  )

  it('removes stale one-shot jobs and proves their absence before startup locale recovery', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'stale-job'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.controls.failRestore = false
    fixture.events.length = 0
    fixture.backend.managedContainers = [{
      roomId: ROOM_ID,
      role: 'job',
      state: 'exited',
      name: 'dh-aaaa1111-stale-job'
    }]
    const remove = fixture.backend.removeManagedContainer.bind(fixture.backend)
    vi.spyOn(fixture.backend, 'listManagedContainers').mockImplementation(async () => {
      fixture.events.push(fixture.backend.managedContainers.length > 0 ? 'jobs-present' : 'jobs-absent')
      return fixture.backend.managedContainers
    })
    vi.spyOn(fixture.backend, 'removeManagedContainer').mockImplementation(async (name) => {
      fixture.events.push('remove-job')
      await remove(name)
    })

    await fixture.orch.init()

    expect(fixture.events.indexOf('remove-job')).toBeLessThan(fixture.events.indexOf('jobs-absent'))
    expect(fixture.events.indexOf('jobs-absent')).toBeLessThan(fixture.events.indexOf('open'))
    expect(fixture.events.indexOf('open')).toBeLessThan(fixture.events.indexOf('restore'))
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).toBeNull()
  })

  it('retains startup recovery when the post-cleanup stale-job absence proof fails', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'stale-job-unknown'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.controls.failRestore = false
    fixture.open.mockClear()
    fixture.backend.managedContainers = [{
      roomId: ROOM_ID,
      role: 'job',
      state: 'exited',
      name: 'dh-aaaa1111-stale-job'
    }]
    const inventory = fixture.backend.listManagedContainers.bind(fixture.backend)
    let inventoryReads = 0
    vi.spyOn(fixture.backend, 'listManagedContainers').mockImplementation(async () => {
      inventoryReads += 1
      if (inventoryReads === 2) throw new Error('inventory unavailable after cleanup')
      return inventory()
    })

    await fixture.orch.init()

    expect(fixture.open).not.toHaveBeenCalled()
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
    expect(fixture.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
  })

  it('wakes the retained emulator for recovery and returns an originally sleeping Room to sleep', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'sleeping-recovery'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    fixture.controls.failRestore = false
    fixture.orch.rooms.update(ROOM_ID, { status: 'sleeping' })
    fixture.backend.emulatorStateValue = 'exited'
    fixture.backend.calls.length = 0

    await fixture.orch.init()

    expect(fixture.backend.calls).toContain(`startExistingEmulatorForRecovery:${ROOM_ID}`)
    expect(fixture.open).toHaveBeenLastCalledWith(
      ROOM_ID,
      { kind: 'emulator' },
      { allowPendingRecovery: true }
    )
    expect(fixture.backend.calls).toContain(`stopRoomPod:${ROOM_ID}`)
    expect(fixture.orch.rooms.get(ROOM_ID)?.status).toBe('sleeping')
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).toBeNull()
  })

  it('blocks shutdown and delete-all before either can destroy locale recovery authority', async () => {
    const shutdownFixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(shutdownFixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'shutdown-fence'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    shutdownFixture.backend.calls.length = 0

    await expect(shutdownFixture.orch.shutdown()).rejects.toBeInstanceOf(AggregateError)
    expect(shutdownFixture.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
    expect((shutdownFixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()

    const deleteFixture = setup({ failRestore: true })
    await expect(deleteFixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'delete-fence'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    deleteFixture.backend.calls.length = 0

    await expect(deleteFixture.orch.deleteAllRooms('user')).rejects.toThrow(/locale restoration/i)
    expect(deleteFixture.backend.calls).not.toContain(`deleteRoomPod:${ROOM_ID}`)
    expect(deleteFixture.orch.rooms.get(ROOM_ID)).not.toBeNull()
    expect((deleteFixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).not.toBeNull()
  })

  it('retains a replacement recovery owner when final intent release loses its CAS', async () => {
    const fixture = setup()
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const replacement = '{"replacement":true}'
    const settings = (fixture.orch as unknown as {
      settings: {
        get(key: string): string | null
        set(key: string, value: string): void
        deleteIfValue(key: string, value: string): boolean
      }
    }).settings
    const release = settings.deleteIfValue.bind(settings)
    settings.deleteIfValue = (key, value) => {
      if (key !== pendingKey) return release(key, value)
      settings.set(key, replacement)
      return false
    }

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'cas-lost'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(fixture.applied[1]).toEqual(['en-US'])
    expect(settings.get(pendingKey)).toBe(replacement)
  })

  it('stops before the next locale when durable stage advancement loses its CAS', async () => {
    const fixture = setup()
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const replacement = '{"replacement":true}'
    const settings = (fixture.orch as unknown as {
      settings: {
        get(key: string): string | null
        set(key: string, value: string): void
        setIfValue(key: string, expected: string, next: string): boolean
      }
    }).settings
    const advance = settings.setIfValue.bind(settings)
    let advances = 0
    settings.setIfValue = (key, expected, next) => {
      if (key !== pendingKey) return advance(key, expected, next)
      advances += 1
      if (advances === 2) {
        settings.set(key, replacement)
        return false
      }
      return advance(key, expected, next)
    }

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR', 'fr-FR'],
      filenamePrefix: 'stage-cas-lost'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })

    expectMarkedLocaleList(fixture.applied[0], 'ko-KR')
    expect(settings.get(pendingKey)).toBe(replacement)
  })

  it('keeps malformed startup recovery data as a hard gate without touching a target', async () => {
    const fixture = setup()
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; set(key: string, value: string): void }
    }).settings
    settings.set(pendingKey, '{"version":1,"unexpected":"private"}')

    await fixture.orch.init()

    expect(settings.get(pendingKey)).not.toBeNull()
    expect(fixture.open).not.toHaveBeenCalled()
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'blocked-malformed'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RECOVERY_REQUIRED' })
  })

  it.each([
    { kind: 'auto' },
    { kind: 'physical', deviceId: `d${'a'.repeat(32)}` }
  ])('rejects a $kind matrix target before opening a session or recording intent', async (invalidTarget) => {
    const fixture = setup()
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`

    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'unsupported-target',
      target: invalidTarget
    } as unknown as AndroidLocaleScreenshotMatrixInput, 'agent')).rejects.toBeDefined()

    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.applied).toEqual([])
    expect((fixture.orch as unknown as { settings: { get(key: string): string | null } })
      .settings.get(pendingKey)).toBeNull()
  })

  it('keeps a legacy physical pending record and lease as a startup hard gate', async () => {
    const fixture = setup({ failRestore: true })
    const pendingKey = `androidLocaleRestorePending:${ROOM_ID}`
    await expect(fixture.orch.androidLocaleScreenshotMatrix(ROOM_ID, {
      applicationId: APP_ID,
      locales: ['ko-KR'],
      filenamePrefix: 'physical-startup'
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_LOCALE_RESTORE_FAILED' })
    const settings = (fixture.orch as unknown as {
      settings: { get(key: string): string | null; set(key: string, value: string): void }
    }).settings
    const pending = JSON.parse(settings.get(pendingKey)!) as {
      fence: Record<string, unknown>
    }
    const deviceId = `d${'a'.repeat(32)}`
    pending.fence = {
      ...pending.fence,
      targetKind: 'physical',
      targetId: deviceId,
      deviceId,
      leaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    }
    settings.set(pendingKey, JSON.stringify(pending))
    const refreshInventory = vi.spyOn(fixture.orch.devices, 'refreshInventory')
    const renewRecoveryLease = vi.spyOn(fixture.orch.devices, 'renewRecoveryLease')
    fixture.open.mockClear()

    await fixture.orch.init()

    expect(refreshInventory).not.toHaveBeenCalled()
    expect(renewRecoveryLease).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(settings.get(pendingKey)).not.toBeNull()
    expect(fixture.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
  })
})
