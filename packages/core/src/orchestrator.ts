import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { customAlphabet } from 'nanoid'
import type {
  Actor,
  AndroidAction,
  AndroidAutomationStatus,
  AndroidAutomationTarget,
  AndroidCrashScenarioResult,
  AndroidDumpUiInput,
  AndroidForceStopInput,
  AndroidForceStopResult,
  AndroidForegroundInstallContext,
  AndroidLaunchAppInput,
  AndroidLaunchResult,
  AndroidLogcatInput,
  AndroidLogcatResult,
  AbandonAndroidLocaleMatrixRecoveryInput,
  AbandonAndroidLocaleMatrixRecoveryResult,
  AndroidLocaleScreenshotMatrixInput,
  AndroidLocaleScreenshotMatrixResult,
  AndroidRunCrashScenarioInput,
  AndroidTapTextInput,
  AndroidTapTextResult,
  AndroidTargetSelector,
  AndroidUiDumpResult,
  AndroidWaitForTextInput,
  AndroidWaitForTextResult,
  AndroidScreenshotArtifactMetadata,
  ArtifactExportResult,
  BackupInfo,
  ChangeEntry,
  CheckReport,
  CheckResult,
  CheckStatus,
  CloneRoomInput,
  CreateRoomInput,
  OperationRecord,
  HostResyncDriftFacts,
  HostResyncStateFacts,
  ProviderKind,
  QuickChange,
  RoomInspection,
  RoomPlan,
  RoomRecord,
  RoomRuntimeStatus,
  RoomArtifact,
  CaptureScreenshotArtifactBody,
  RuntimeRoomRecord,
  SafeHostResyncOutcome,
  SourceType
} from '@devhotel/shared'
import {
  canonicalAndroidLocaleTag,
  canonicalAndroidLocaleTags,
  hostInputCapability,
  androidLocaleScreenshotFilename,
  SCREENSHOT_ARTIFACT_MAX_BYTES,
  VMWARE_CONSOLE_CAPABILITY,
  zArtifactExportBody,
  zArtifactListLimit,
  zAndroidApplicationId,
  zAbandonAndroidLocaleMatrixRecoveryBody,
  zAndroidLocaleScreenshotMatrixBody,
  zCaptureScreenshotArtifactBody
} from '@devhotel/shared'
import type { DeviceBrokerStatus, DeviceLease, DeviceRequest, DeviceRequestResult, DeviceQueueEntry } from '@devhotel/shared'
import { AndroidDeviceBroker } from './devices/broker'
import { SpawnedAdbHost, type AdbHost } from './devices/adbHost'
import { androidDevicesRepo } from './store/androidDevicesRepo'
import { androidAppInstallsRepo, type AndroidAppInstallsRepo, type AndroidInstallTarget } from './store/androidAppInstallsRepo'
import {
  AndroidAutomationSession,
  type AndroidAppLocaleRestoreFence,
  type AndroidAppLocaleSnapshot,
  type AndroidForegroundInstallEvidence
} from './devices/androidAutomation'
import { artifactsRepo } from './store/artifactsRepo'
import { RoomArtifactStore } from './artifacts/store'
import { validateAndSanitizeScreenshotPng } from './artifacts/png'
import { getProvider } from './providers/index'
import { runDocker } from './backend/cli'
import { EMULATOR_ADB_SERIAL, EMULATOR_DEFAULT_DEVICE, EMULATOR_DEFAULT_VERSION, srcVolume, svcVolume } from './backend/naming'
import {
  RoomArtifactPublicationError,
  type ExecResult,
  type IsolationBackend,
  type RoomArtifactExpectation,
  type RoomArtifactWebRuntimeFence,
  type WebSpec
} from './backend/types'
import type { WindowsVmBackend } from './backend/windowsVm'
import { ChangeEngine } from './changes/engine'
import { registerQuickChanges, depsVolumeForGen, pmInstallCommand } from './changes/definitions/index'
import {
  cleanupAndroidBuildArtifacts,
  isSafeAndroidArtifactRelativePath,
  type SealedAndroidArtifactRef
} from './changes/definitions/androidBuild'
import {
  backupServiceToFile,
  pingService,
  resolveRoomBackupFile,
  restoreServiceFromFile,
  serviceForBackupId,
  validatePostgresLogicalClone
} from './changes/definitions/services'
import type { ChangeCtx } from './changes/types'
import { verifyWebUp } from './changes/types'
import { runChecks as runCheckPipeline } from './checks/engine'
import { slugify } from './detect/detector'
import type { SourceReader } from './detect/sourceReader'
import { fsSourceReader } from './detect/sourceReader'
import { buildDiagnostic } from './diagnostics/bundle'
import { redactSecrets } from './diagnostics/redact'
import { DevHotelError } from './errors'
import type { Gateway } from './gateway/gateway'
import { LogHub, type LogKind } from './logs'
import {
  RunOutputStore,
  type OutputSelection,
  type RunReadOptions,
  type RunReadResult,
  type RunSummary,
  type StreamReport
} from './runOutput'
import { writeManifest } from './manifest'
import { OperationTracker, type OperationReporter } from './operations'
import { operationsRepo, type OperationsRepo } from './store/operationsRepo'
import { reconcile, type ReconcileResult } from './reconcile'
import type { Db } from './store/db'
import { changesRepo, type ChangesRepo } from './store/changesRepo'
import { checksRepo, type ChecksRepo } from './store/checksRepo'
import { roomsRepo, type RoomsRepo } from './store/roomsRepo'
import { settingsRepo, type SettingsRepo } from './store/settingsRepo'
import { nextWorkspaceVolumeRevision, retainedWorkspaceGenKey, workspaceGenMaxKey, workspaceSyncBaseKey } from './workingState'
import {
  WorkspaceDriftError,
  diffWorkspaceSnapshots,
  parseWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  type WorkspaceSnapshot
} from './workspaceDrift'

const newRoomId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

/**
 * What one Room command returns: the bounded text a caller can actually read,
 * plus enough accounting to know what was left out and where to get it.
 */
export interface RoomExecResult extends ExecResult {
  output: {
    runId: string
    /** The complete raw output is kept under the Room and readable by run id. */
    retained: boolean
    stdout: StreamReport
    stderr: StreamReport
    /** Plain-language truncation/retention notices; empty when nothing was withheld. */
    notes: string[]
  }
}

const ANDROID_CHANGE_KINDS = new Set([
  'android-build',
  'android-run',
  'emulator-config',
  'start-command',
  'restart-web',
  'os-settings',
  'room-reset',
  'normalize-line-endings'
])

const WORKSPACE_MUTATION_KINDS = new Set(['package-install', 'deps-install', 'android-run'])

/**
 * The adb readiness probe is deliberately a single bounded question, not a
 * wait. A wake recreates the emulator, and a cold Android image needs minutes
 * to finish booting — blocking the wake on that would slow every Android wake
 * to no purpose, since the Room is already usable for builds and `android-run`
 * waits for the device itself. What the caller gains is the honest answer that
 * the phone is not usable yet, which a `ready` Room status does not say.
 */
const EMULATOR_ADB_PROBE_TIMEOUT_MS = 5_000
const HOST_RESYNC_CONFIRMATION_TTL_MS = 10 * 60 * 1000
const ARTIFACT_EXPORT_PENDING_PREFIX = 'artifactExportPending:'
const ANDROID_LOCALE_RESTORE_PENDING_PREFIX = 'androidLocaleRestorePending:'

interface PendingArtifactExport {
  version: 1
  workspaceVolumeRevision: number
  relativePath: string
  expected: RoomArtifactExpectation
  stageToken: string
}

function pendingArtifactExportKey(roomId: string): string {
  return `${ARTIFACT_EXPORT_PENDING_PREFIX}${roomId}`
}

function parsePendingArtifactExport(raw: string): PendingArtifactExport | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'expected,relativePath,stageToken,version,workspaceVolumeRevision' ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.workspaceVolumeRevision) ||
    (record.workspaceVolumeRevision as number) < 0 ||
    typeof record.stageToken !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record.stageToken)
  ) return null
  const path = zArtifactExportBody.safeParse({ relativePath: record.relativePath })
  const expected = record.expected
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return null
  const identity = expected as Record<string, unknown>
  if (
    Object.keys(identity).sort().join(',') !== 'sha256,sizeBytes' ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    (identity.sizeBytes as number) < 1 ||
    (identity.sizeBytes as number) > SCREENSHOT_ARTIFACT_MAX_BYTES ||
    typeof identity.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) ||
    !path.success
  ) return null
  return {
    version: 1,
    workspaceVolumeRevision: record.workspaceVolumeRevision as number,
    relativePath: path.data.relativePath,
    expected: { sizeBytes: identity.sizeBytes as number, sha256: identity.sha256 },
    stageToken: record.stageToken
  }
}

interface PendingAndroidLocaleRestore {
  version: 4
  operationId: string
  stage: number
  applicationId: string
  originalLocaleTags: string[]
  expectedLocaleTags: string[]
  attemptedLocaleTags: string[]
  /** Exact secondary private-use tag that binds a forward attempt to operationId; null for restoration attempts. */
  attemptedLocaleOwnershipTag: string | null
  /** True only after a synchronous durable CAS immediately before the locale setter is dispatched. */
  attemptedLocaleDispatchStarted: boolean
  /** True only after the locale shell command returned an exact acknowledgement and ownership was synchronously CASed. */
  attemptedLocaleOwned: boolean
  fence: AndroidAppLocaleRestoreFence
}

type PendingAndroidLocaleAbandonDecision = 'released' | 'refused' | 'cas-changed'

function pendingAndroidLocaleRestoreKey(roomId: string): string {
  return `${ANDROID_LOCALE_RESTORE_PENDING_PREFIX}${roomId}`
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function androidLocaleOwnershipTagForVersion(
  requestedLocale: string,
  operationId: string,
  preserveScript: boolean
): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) return null
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(requestedLocale)
  } catch {
    return null
  }
  const language = locale.language?.toLowerCase()
  if (!language || language === 'und') return null
  if (!/^[a-z]{2,8}$/.test(language)) return null
  let languageAndScript = language
  if (preserveScript) {
    const script = locale.script ?? locale.maximize().script
    if (script !== undefined) {
      if (!/^[A-Z][a-z]{3}$/.test(script)) return null
      languageAndScript = `${language}-${script}`
    }
  }
  const nonce = operationId.replaceAll('-', '')
  const marker = [
    `${languageAndScript}-x-dh`,
    nonce.slice(0, 8),
    nonce.slice(8, 12),
    nonce.slice(12, 16),
    nonce.slice(16, 20),
    nonce.slice(20, 28),
    nonce.slice(28, 32)
  ].join('-')
  return canonicalAndroidLocaleTag(marker)
}

function androidLocaleOwnershipTag(requestedLocale: string, operationId: string): string | null {
  return androidLocaleOwnershipTagForVersion(requestedLocale, operationId, true)
}

function legacyAndroidLocaleOwnershipTag(requestedLocale: string, operationId: string): string | null {
  return androidLocaleOwnershipTagForVersion(requestedLocale, operationId, false)
}

function isExactAndroidLocaleOwnershipTag(
  requestedLocale: string,
  operationId: string,
  ownershipTag: string
): boolean {
  return androidLocaleOwnershipTag(requestedLocale, operationId) === ownershipTag ||
    legacyAndroidLocaleOwnershipTag(requestedLocale, operationId) === ownershipTag
}

function isAndroidLocaleOwnershipMarkerTag(localeTag: string): boolean {
  return /^[a-z]{2,8}(?:-[A-Z][a-z]{3})?-x-dh-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{8}-[0-9a-f]{4}$/.test(
    localeTag
  )
}

function markedAndroidLocaleAttempt(requestedLocale: string, operationId: string): {
  localeTags: string[]
  ownershipTag: string
} {
  const ownershipTag = androidLocaleOwnershipTag(requestedLocale, operationId)
  const localeTags = ownershipTag
    ? canonicalAndroidLocaleTags([requestedLocale, ownershipTag])
    : null
  if (!ownershipTag || !localeTags || localeTags.length !== 2 || localeTags[1] !== ownershipTag) {
    throw new Error('Android locale ownership marker could not be constructed safely')
  }
  return { localeTags, ownershipTag }
}

function hasExactAndroidLocaleOwnershipMarker(pending: PendingAndroidLocaleRestore): boolean {
  return pending.attemptedLocaleOwnershipTag !== null &&
    pending.attemptedLocaleTags.length === 2 &&
    pending.attemptedLocaleTags[1] === pending.attemptedLocaleOwnershipTag &&
    isExactAndroidLocaleOwnershipTag(
      pending.attemptedLocaleTags[0]!,
      pending.operationId,
      pending.attemptedLocaleOwnershipTag
    )
}

function pendingAndroidLocaleOwnsCurrent(
  pending: PendingAndroidLocaleRestore,
  currentLocaleTags: readonly string[]
): boolean {
  if (pending.attemptedLocaleOwned) {
    return hasExactAndroidLocaleOwnershipMarker(pending) &&
      sameStringValues(currentLocaleTags, pending.attemptedLocaleTags)
  }
  return (
    pending.expectedLocaleTags.some(isAndroidLocaleOwnershipMarkerTag) &&
    sameStringValues(currentLocaleTags, pending.expectedLocaleTags)
  ) ||
    (pending.attemptedLocaleDispatchStarted &&
      hasExactAndroidLocaleOwnershipMarker(pending) &&
      sameStringValues(currentLocaleTags, pending.attemptedLocaleTags))
}

function sameAndroidLocaleRestoreFence(
  left: AndroidAppLocaleRestoreFence,
  right: AndroidAppLocaleRestoreFence
): boolean {
  return left.targetKind === right.targetKind &&
    left.targetId === right.targetId &&
    left.deviceId === right.deviceId &&
    left.leaseId === right.leaseId &&
    left.roomId === right.roomId &&
    left.applicationId === right.applicationId &&
    left.changeId === right.changeId &&
    left.apkSha256 === right.apkSha256 &&
    left.installedAt === right.installedAt &&
    left.packageIncarnation === right.packageIncarnation &&
    left.installUserId === right.installUserId &&
    left.installUserSerial === right.installUserSerial &&
    left.apiLevel === right.apiLevel
}

function parsePersistedLocaleTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null
  const canonical = canonicalAndroidLocaleTags(value as string[], { allowEmpty: true })
  return canonical && sameStringValues(canonical, value as string[]) ? canonical : null
}

function parsePendingAndroidLocaleRestore(raw: string, roomId: string): PendingAndroidLocaleRestore | null {
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const legacyV1 = record.version === 1 && keys ===
    'applicationId,attemptedLocaleTags,expectedLocaleTags,fence,operationId,originalLocaleTags,stage,version'
  const legacyV2 = record.version === 2 && keys ===
    'applicationId,attemptedLocaleOwned,attemptedLocaleTags,expectedLocaleTags,fence,operationId,originalLocaleTags,stage,version' &&
    typeof record.attemptedLocaleOwned === 'boolean'
  const currentV3 = record.version === 3 && keys ===
    'applicationId,attemptedLocaleOwned,attemptedLocaleOwnershipTag,attemptedLocaleTags,expectedLocaleTags,fence,operationId,originalLocaleTags,stage,version' &&
    typeof record.attemptedLocaleOwned === 'boolean' &&
    (record.attemptedLocaleOwnershipTag === null || typeof record.attemptedLocaleOwnershipTag === 'string')
  const currentV4 = record.version === 4 && keys ===
    'applicationId,attemptedLocaleDispatchStarted,attemptedLocaleOwned,attemptedLocaleOwnershipTag,attemptedLocaleTags,expectedLocaleTags,fence,operationId,originalLocaleTags,stage,version' &&
    typeof record.attemptedLocaleDispatchStarted === 'boolean' &&
    typeof record.attemptedLocaleOwned === 'boolean' &&
    (record.attemptedLocaleOwnershipTag === null || typeof record.attemptedLocaleOwnershipTag === 'string') &&
    !(record.attemptedLocaleOwned && !record.attemptedLocaleDispatchStarted)
  if (
    (!legacyV1 && !legacyV2 && !currentV3 && !currentV4) ||
    typeof record.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.operationId) ||
    !Number.isSafeInteger(record.stage) ||
    (record.stage as number) < 0
  ) return null
  const applicationId = zAndroidApplicationId.safeParse(record.applicationId)
  const originalLocaleTags = parsePersistedLocaleTags(record.originalLocaleTags)
  const expectedLocaleTags = parsePersistedLocaleTags(record.expectedLocaleTags)
  const attemptedLocaleTags = parsePersistedLocaleTags(record.attemptedLocaleTags)
  if (
    !applicationId.success ||
    originalLocaleTags === null ||
    expectedLocaleTags === null ||
    attemptedLocaleTags === null
  ) return null
  const attemptedLocaleOwnershipTag = currentV3 || currentV4
    ? record.attemptedLocaleOwnershipTag as string | null
    : null
  if (attemptedLocaleOwnershipTag !== null) {
    if (
      attemptedLocaleTags.length !== 2 ||
      attemptedLocaleTags[1] !== attemptedLocaleOwnershipTag ||
      (currentV4
        ? androidLocaleOwnershipTag(attemptedLocaleTags[0]!, record.operationId)
        : legacyAndroidLocaleOwnershipTag(attemptedLocaleTags[0]!, record.operationId)) !== attemptedLocaleOwnershipTag
    ) return null
  }

  if (record.fence === null || typeof record.fence !== 'object' || Array.isArray(record.fence)) return null
  const fence = record.fence as Record<string, unknown>
  if (
    Object.keys(fence).sort().join(',') !==
      'apiLevel,apkSha256,applicationId,changeId,deviceId,installUserId,installUserSerial,installedAt,leaseId,packageIncarnation,roomId,targetId,targetKind' ||
    (fence.targetKind !== 'emulator' && fence.targetKind !== 'physical') ||
    typeof fence.targetId !== 'string' ||
    fence.roomId !== roomId ||
    fence.applicationId !== applicationId.data ||
    typeof fence.changeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fence.changeId) ||
    typeof fence.apkSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fence.apkSha256) ||
    typeof fence.packageIncarnation !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fence.packageIncarnation) ||
    typeof fence.installedAt !== 'string' ||
    !Number.isFinite(Date.parse(fence.installedAt)) ||
    new Date(fence.installedAt).toISOString() !== fence.installedAt ||
    !Number.isSafeInteger(fence.installUserId) ||
    (fence.installUserId as number) < 0 ||
    !Number.isSafeInteger(fence.installUserSerial) ||
    (fence.installUserSerial as number) < 0 ||
    !Number.isSafeInteger(fence.apiLevel) ||
    (fence.apiLevel as number) < 33 ||
    (fence.apiLevel as number) > 100
  ) return null
  if (fence.targetKind === 'emulator') {
    if (fence.targetId !== roomId || fence.deviceId !== null || fence.leaseId !== null) return null
  } else if (
    !/^d[a-f0-9]{32}$/.test(fence.targetId) ||
    fence.deviceId !== fence.targetId ||
    typeof fence.leaseId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fence.leaseId)
  ) return null

  return {
    // Legacy records had no pre-dispatch CAS. Treat that ambiguity as already
    // dispatched so the public no-setter abandon path can never release one.
    version: 4,
    operationId: record.operationId,
    stage: record.stage as number,
    applicationId: applicationId.data,
    originalLocaleTags,
    expectedLocaleTags,
    attemptedLocaleTags,
    attemptedLocaleOwnershipTag,
    attemptedLocaleDispatchStarted: currentV4
      ? record.attemptedLocaleDispatchStarted === true
      : true,
    attemptedLocaleOwned: (legacyV2 || currentV3 || currentV4) && record.attemptedLocaleOwned === true,
    fence: {
      targetKind: fence.targetKind,
      targetId: fence.targetId,
      deviceId: fence.deviceId as string | null,
      leaseId: fence.leaseId as string | null,
      roomId,
      applicationId: applicationId.data,
      changeId: fence.changeId,
      apkSha256: fence.apkSha256,
      installedAt: fence.installedAt,
      packageIncarnation: fence.packageIncarnation,
      installUserId: fence.installUserId as number,
      installUserSerial: fence.installUserSerial as number,
      apiLevel: fence.apiLevel as number
    }
  }
}
const SCREENSHOT_ARTIFACT_MAX_BASE64_BYTES = Math.ceil(SCREENSHOT_ARTIFACT_MAX_BYTES / 3) * 4
const ADB_INSTALL_VERBS = new Set(['install', 'install-multiple', 'install-multi-package'])
const ADB_UNSAFE_HOST_FILE_VERBS = new Set(['pull', 'push', 'restore', 'sideload', 'sync'])
const ADB_INSTALL_BOOLEAN_FLAGS = new Set([
  '-r', '-t', '-d', '-g', '-s',
  '--instant', '--full', '--preload', '--force-sdk', '--no-streaming', '--streaming',
  '--fastdeploy', '--no-fastdeploy', '--force-agent', '--date-check-agent', '--version-check-agent',
  '--staged', '--non-staged', '--enable-rollback', '--skip-verification', '--bypass-low-target-sdk-block'
])
const ADB_INSTALL_VALUE_FLAGS = new Set([
  '-i', '--installer-package-name', '--abi', '--user', '--install-location', '--install-reason',
  '--originating-uri', '--referrer', '--force-uuid', '--staged-ready-timeout'
])
const MAX_STAGED_APK_BYTES = 512 * 1024 * 1024
const MAX_STAGED_INSTALL_BYTES = 1024 * 1024 * 1024

function posixRemoteArg(value: string): string {
  if (value.includes('\0')) throw new Error('Android remote command arguments cannot contain NUL bytes')
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** adb shell concatenates its remaining argv into one remote shell command. */
function protectAndroidRemoteCommand(args: string[]): string[] {
  const verb = args[0]
  if (verb !== 'shell' || args.length < 2) return args
  return [verb, args.slice(1).map(posixRemoteArg).join(' ')]
}

const ANDROID_EMULATOR_ROTATE_SCRIPT = [
  'settings put system accelerometer_rotation 0',
  'rotation=$(settings get system user_rotation)',
  'case "$rotation" in 0|1|2|3) ;; *) rotation=0 ;; esac',
  'settings put system user_rotation "$(( (rotation + 1) % 4 ))"'
].join('; ')

function androidEmulatorActionArgs(action: AndroidAction): string[] {
  switch (action) {
    case 'back': return ['shell', 'input', 'keyevent', '4']
    case 'home': return ['shell', 'input', 'keyevent', '3']
    case 'recents': return ['shell', 'input', 'keyevent', '187']
    case 'rotate': return ['shell', 'sh', '-c', ANDROID_EMULATOR_ROTATE_SCRIPT]
  }
  throw new DevHotelError('ANDROID_EMULATOR_ACTION_UNSUPPORTED', 'Unsupported Android emulator control.', {
    recoveryHint: 'Use Back, Home, Recents, or Rotate.', httpStatus: 400
  })
}

function workerProcessLiveness(workerId: string): boolean | 'unknown' {
  const match = /^pid:(\d{1,10})$/.exec(workerId)
  if (!match) return 'unknown'
  const pid = Number.parseInt(match[1]!, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : 'unknown'
  }
}

interface AdbOutputReplacement {
  privateValue: string
  publicValue: string
}

function redactAdbText(value: string, serial: string, replacements: AdbOutputReplacement[] = []): string {
  let safe = value
  for (const replacement of replacements) {
    for (const candidate of new Set([replacement.privateValue, replacement.privateValue.replaceAll('\\', '/')])) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      safe = safe.replace(new RegExp(escaped, 'gi'), replacement.publicValue)
    }
  }
  const escapedSerial = serial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return redactSecrets(safe.replace(new RegExp(escapedSerial, 'gi'), '[device-serial-redacted]'))
}

function redactAdbResult(
  result: ExecResult,
  serial: string,
  replacements: AdbOutputReplacement[] = []
): ExecResult {
  return {
    ...result,
    stdout: redactAdbText(result.stdout, serial, replacements),
    stderr: redactAdbText(result.stderr, serial, replacements)
  }
}

function privateAndroidStageError(
  error: unknown,
  privateRoots: Array<string | null | undefined>,
  fallback: string
): Error {
  const originalMessage = error instanceof Error ? error.message : String(error)
  let message = originalMessage
  // Replace the most specific private path first. Replacing the staging root
  // before its child would leave the random directory and filename visible in
  // a message such as `<root>\\android-install-receipt-*\\installed.apk`.
  const orderedRoots = privateRoots
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
  for (const root of orderedRoots) {
    for (const candidate of new Set([root, root.replaceAll('\\', '/')])) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      message = message.replace(new RegExp(escaped, 'gi'), '[private APK stage]')
    }
  }
  message = redactSecrets(message).trim()
  if (error instanceof Error && message === originalMessage) return error
  return new Error(message || fallback)
}

function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function emulatorApiLevel(version: string): number | null {
  const major = Number.parseInt(version, 10)
  const levels: Record<number, number> = { 11: 30, 12: 31, 13: 33, 14: 34, 15: 35 }
  return levels[major] ?? null
}

function decodeScreenshotBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > SCREENSHOT_ARTIFACT_MAX_BASE64_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new DevHotelError('SCREENSHOT_INVALID', 'Android capture did not return a bounded canonical PNG.', {
      recoveryHint: 'Retry the capture after the Android target is fully ready.'
    })
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > SCREENSHOT_ARTIFACT_MAX_BYTES || bytes.toString('base64') !== value) {
    throw new DevHotelError('SCREENSHOT_INVALID', 'Android capture did not return a bounded canonical PNG.', {
      recoveryHint: 'Retry the capture after the Android target is fully ready.'
    })
  }
  return bytes
}

function artifactMetadataText(value: string | null, maxLength: number): string | null {
  if (value === null) return null
  const safe = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, maxLength)
  return safe || null
}

function artifactLocale(value: string | null): string | null {
  const normalized = artifactMetadataText(value, 64)?.replaceAll('_', '-') ?? null
  return normalized && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(normalized) ? normalized : null
}

function sameScreenshotInstallEvidence(
  left: AndroidForegroundInstallEvidence,
  right: AndroidForegroundInstallEvidence
): boolean {
  const leftTarget = left.context.status.target
  const rightTarget = right.context.status.target
  if (
    leftTarget.kind !== rightTarget.kind ||
    leftTarget.deviceId !== rightTarget.deviceId ||
    leftTarget.nickname !== rightTarget.nickname ||
    leftTarget.model !== rightTarget.model ||
    leftTarget.androidVersion !== rightTarget.androidVersion ||
    leftTarget.apiLevel !== rightTarget.apiLevel ||
    left.context.status.foregroundApplicationId !== right.context.status.foregroundApplicationId ||
    left.context.status.locale !== right.context.status.locale ||
    left.context.status.installedApplicationIds.length !== right.context.status.installedApplicationIds.length ||
    left.context.status.installedApplicationIds.some(
      (applicationId, index) => applicationId !== right.context.status.installedApplicationIds[index]
    )
  ) return false

  if (left.seal === null || right.seal === null) return left.seal === right.seal
  return (
    left.seal.targetKind === right.seal.targetKind &&
    left.seal.targetId === right.seal.targetId &&
    left.seal.deviceId === right.seal.deviceId &&
    left.seal.leaseId === right.seal.leaseId &&
    left.seal.roomId === right.seal.roomId &&
    left.seal.applicationId === right.seal.applicationId &&
    left.seal.changeId === right.seal.changeId &&
    left.seal.apkSha256 === right.seal.apkSha256 &&
    left.seal.installedAt === right.seal.installedAt &&
    left.seal.packageIncarnation === right.seal.packageIncarnation &&
    left.seal.logFence === right.seal.logFence &&
    left.seal.installUserId === right.seal.installUserId &&
    left.seal.installUserSerial === right.seal.installUserSerial
  )
}

function screenshotInstallEvidenceIsConsistent(evidence: AndroidForegroundInstallEvidence): boolean {
  const { receipt, status } = evidence.context
  return receipt !== null && evidence.seal !== null && (
    receipt.applicationId === status.foregroundApplicationId &&
    receipt.applicationId === evidence.seal.applicationId &&
    receipt.changeId === evidence.seal.changeId &&
    receipt.apkSha256 === evidence.seal.apkSha256 &&
    receipt.installedAt === evidence.seal.installedAt &&
    receipt.target.kind === status.target.kind &&
    receipt.target.kind === evidence.seal.targetKind &&
    receipt.target.deviceId === status.target.deviceId &&
    receipt.target.deviceId === evidence.seal.deviceId
  )
}

export interface OrchestratorEvent {
  roomId: string
  kind: 'status' | 'change' | 'check' | 'deleted' | 'created'
  detail?: string
}

export type WindowsVmLifecycle = Pick<
  WindowsVmBackend,
  | 'health'
  | 'inspectTemplate'
  | 'create'
  | 'start'
  | 'state'
  | 'sleep'
  | 'delete'
  | 'reset'
  | 'validateBaseline'
  | 'openConsole'
>

export interface OrchestratorOptions {
  userData: string
  backend: IsolationBackend
  /** VMware lifecycle stays separate from the OCI backend's container contract. */
  windowsVm?: WindowsVmLifecycle
  gateway: Gateway
  db: Db
  appVersion: string
  /** clears a Room's browser profile; supplied by the desktop app, which owns the Electron session */
  clearBrowserData?: (roomId: string) => Promise<void>
  /** Host-side adb owning the shared physical phones; defaults to a resolved system adb. */
  adb?: AdbHost
}

interface PendingHostResyncConfirmation {
  token: string
  actor: Actor
  binding: string
  expiresAt: number
}

const EMPTY_READER: SourceReader = {
  readFile: async () => null,
  exists: async () => false
}

export class RoomOrchestrator {
  readonly rooms: RoomsRepo
  readonly changes: ChangesRepo
  readonly checks: ChecksRepo
  readonly settings: SettingsRepo
  readonly operationRecords: OperationsRepo
  readonly logs: LogHub
  readonly runs: RunOutputStore
  readonly androidInstalls: AndroidAppInstallsRepo
  readonly artifacts: RoomArtifactStore
  private readonly operations: OperationTracker
  private readonly pendingHostResyncConfirmations = new Map<string, PendingHostResyncConfirmation>()
  private readonly engine = new ChangeEngine()
  private readonly emitter = new EventEmitter()
  private readonly roomOps = new Map<string, Promise<unknown>>()
  private readonly activeRoomLocks = new Set<string>()
  private readonly activeMutations = new Set<Promise<unknown>>()
  private readonly deletingRooms = new Set<string>()
  private readonly materializingRooms = new Set<string>()
  private mutationGate: 'open' | 'delete-all' | 'shutdown' = 'open'
  private shutdownTask: Promise<void> | null = null
  private deleteAllTask: Promise<{ deletedRooms: number; reclaimedBytes: number }> | null = null
  private readonly userData: string
  private readonly backend: IsolationBackend
  private readonly sqlite: Db['sqlite']
  private readonly windowsVm?: WindowsVmLifecycle
  private readonly gateway: Gateway
  private readonly appVersion: string
  private readonly clearBrowserData?: (roomId: string) => Promise<void>
  /** The shared Android phones are Hotel-owned, so the broker sits beside the Rooms, not inside one. */
  readonly devices: AndroidDeviceBroker

  constructor(opts: OrchestratorOptions) {
    this.userData = opts.userData
    this.backend = opts.backend
    this.sqlite = opts.db.sqlite
    this.windowsVm = opts.windowsVm
    this.gateway = opts.gateway
    this.appVersion = opts.appVersion
    this.clearBrowserData = opts.clearBrowserData
    this.rooms = roomsRepo(opts.db)
    this.changes = changesRepo(opts.db)
    this.checks = checksRepo(opts.db)
    this.settings = settingsRepo(opts.db)
    this.operationRecords = operationsRepo(opts.db)
    // Progress is a pull surface on purpose: a per-stage push would refresh
    // every renderer view and rebuild the tray several times per wake.
    this.operations = new OperationTracker(this.operationRecords)
    this.logs = new LogHub(opts.userData, opts.backend)
    this.runs = new RunOutputStore(opts.userData)
    this.androidInstalls = androidAppInstallsRepo(opts.db)
    this.artifacts = new RoomArtifactStore(opts.userData, artifactsRepo(opts.db))
    this.devices = new AndroidDeviceBroker({
      repo: androidDevicesRepo(opts.db),
      adb: opts.adb ?? new SpawnedAdbHost(),
      // A lease survives only while its Room is awake. A sleeping or deleted
      // Room cannot be running a test, so its phone belongs to the queue.
      ownerLiveness: (lease) => {
        const room = this.rooms.get(lease.roomId)
        if (room === null || room.status === 'sleeping' || room.status === 'broken') return false
        return workerProcessLiveness(lease.workerId)
      },
      recoveryProtected: (lease) => {
        const raw = this.settings.get(pendingAndroidLocaleRestoreKey(lease.roomId))
        if (raw === null) return false
        const pending = parsePendingAndroidLocaleRestore(raw, lease.roomId)
        return pending?.fence.targetKind === 'physical' &&
          pending.fence.deviceId === lease.deviceId &&
          pending.fence.leaseId === lease.id
      },
      roomEligible: (roomId) => {
        const room = this.rooms.get(roomId)
        return room !== null && room.status !== 'sleeping' && room.status !== 'broken'
      }
    })
    registerQuickChanges(this.engine)
  }

  async init(): Promise<{ backendOk: boolean; reconciled: ReconcileResult | null }> {
    // A prior process may have died after Docker accepted a one-shot Android
    // locale writer. No recovery proof is trustworthy until every such job is
    // removed and the managed inventory proves the role absent.
    const staleJobsAbsent = await this.removeStartupStaleJobs()
    // Locale commands are persistent Android mutations. Recover or hard-gate
    // an interrupted matrix before any unrelated startup dependency can fail.
    const pendingAndroidLocaleRecoveryRooms = await this.reconcileInterruptedAndroidLocaleRestorations(staleJobsAbsent)
    // The desktop still exposes its control API when init fails. Fence and
    // stop an uncertain exported workspace before any unrelated startup work
    // can abort initialization and leave the old Room record admissible.
    await this.reconcileInterruptedArtifactExports(staleJobsAbsent)
    // Callers must never keep polling work that died with the prior process.
    this.markInterruptedOperations()
    for (const room of this.rooms.list()) {
      try {
        this.artifacts.reconcileRoom(room.id)
      } catch {
        // Artifact storage is Host-private. Recovery diagnostics must never
        // project an underlying filesystem path or platform error into Room logs.
        this.olog(room.id, 'screenshot artifact recovery needs attention; stored paths and diagnostics were withheld')
      }
    }
    await this.gateway.start()
    const health = await this.backend.health()
    let reconciled: ReconcileResult | null = null
    if (health.ok) {
      reconciled = await reconcile(
        this.backend,
        this.rooms,
        (l) => this.olog('system', l),
        { preserveAwakeRoomIds: pendingAndroidLocaleRecoveryRooms }
      )
    }
    await this.reconcileWindowsRooms()
    await this.markInterruptedChanges()
    return { backendOk: health.ok, reconciled }
  }

  /**
   * Operations recorded as running belonged to the previous process. Nothing is
   * driving them now, so a caller polling one must be told it ended rather than
   * be left waiting on work that no longer exists.
   */
  private markInterruptedOperations(): void {
    for (const operation of this.operations.recoverInterrupted()) {
      this.olog(operation.roomId, `interrupted ${operation.kind} operation ${operation.id} was ended by an app restart`)
    }
  }

  private async removeStartupStaleJobs(): Promise<boolean> {
    try {
      const staleJobs = (await this.backend.listManagedContainers()).filter((container) => container.role === 'job')
      for (const job of staleJobs) await this.backend.removeManagedContainer(job.name)
      return !(await this.backend.listManagedContainers()).some((container) => container.role === 'job')
    } catch {
      return false
    }
  }

  private async reconcileInterruptedAndroidLocaleRestorations(staleJobsAbsent: boolean): Promise<Set<string>> {
    const pendingRooms = this.rooms.list().flatMap((room) => {
      const key = pendingAndroidLocaleRestoreKey(room.id)
      const raw = this.settings.get(key)
      return raw === null ? [] : [{ room, key, raw, pending: parsePendingAndroidLocaleRestore(raw, room.id) }]
    })
    const unresolved = new Set(pendingRooms.map(({ room }) => room.id))

    for (const { room, key, raw, pending } of pendingRooms) {
      let restored = false
      if (
        pending !== null &&
        room.provider === 'android' &&
        pending.fence.targetKind === 'emulator' &&
        staleJobsAbsent
      ) {
        try {
          await this.withRoomLock(room.id, async () => {
            const selector: AndroidTargetSelector = { kind: 'emulator' }
            const current = this.mustGet(room.id)
            if (current.status !== 'running' && current.status !== 'ready' && current.status !== 'attention') {
              // Recovery starts only the control anchor/emulator. Mark the
              // Room awake first so a crash cannot hide those processes
              // behind a persisted sleeping status; normal reconcile sleeps
              // it again after a successful intent release.
              this.rooms.update(room.id, { status: 'attention' })
            }
            await this.backend.startExistingEmulatorForRecovery(room.id)
            const session = await this.openAndroidAutomationSessionLocked(
              room.id,
              selector,
              { allowPendingRecovery: true }
            )
            const beforeRestore = await session.proveAppLocaleFinalState(
              pending.applicationId,
              pending.fence,
              30_000
            )
            const isOriginal = sameStringValues(beforeRestore.localeTags, pending.originalLocaleTags)
            const ownsCurrent = pendingAndroidLocaleOwnsCurrent(pending, beforeRestore.localeTags)
            if (
              beforeRestore.apiLevel !== pending.fence.apiLevel ||
              !sameAndroidLocaleRestoreFence(beforeRestore.restoreFence, pending.fence) ||
              beforeRestore.pids.length === 0 ||
              (!isOriginal && !ownsCurrent)
            ) {
              throw new Error('Interrupted Android locale stage no longer owns the exact current target')
            }
            if (isOriginal) {
              // The desired state is already present under a fresh composite
              // target/install/user/PID proof. Release without issuing any
              // locale setter, including for conservative legacy v1 records.
              if (!this.deletePendingAndroidLocaleRestorationIfOwned(key, raw, pending)) {
                throw new Error('Interrupted Android locale original-state ownership changed')
              }
              restored = true
              unresolved.delete(room.id)
              return
            }
            const recoveryStage: PendingAndroidLocaleRestore = {
              ...pending,
              version: 4,
              operationId: randomUUID(),
              stage: pending.stage === Number.MAX_SAFE_INTEGER ? 0 : pending.stage + 1,
              expectedLocaleTags: [...beforeRestore.localeTags],
              attemptedLocaleTags: [...pending.originalLocaleTags],
              attemptedLocaleOwnershipTag: null,
              attemptedLocaleDispatchStarted: false,
              attemptedLocaleOwned: false
            }
            const recoveryValue = JSON.stringify(recoveryStage)
            // No await separates the last exact observation above from this
            // CAS. A crash after it can always recognize either the prior
            // locale or the original locale that recovery is about to attempt.
            if (!this.settings.setIfValue(key, raw, recoveryValue)) {
              throw new Error('Interrupted Android locale restoration ownership changed before mutation')
            }
            let recoveryPending = recoveryStage
            let recoveryPendingValue = recoveryValue
            const markRecoveryMutationDispatched = (): undefined => {
              if (recoveryPending.attemptedLocaleDispatchStarted) {
                throw new Error('Interrupted Android locale restoration dispatch was already recorded')
              }
              const dispatched: PendingAndroidLocaleRestore = {
                ...recoveryPending,
                attemptedLocaleDispatchStarted: true
              }
              const dispatchedValue = JSON.stringify(dispatched)
              if (!this.settings.setIfValue(key, recoveryPendingValue, dispatchedValue)) {
                throw new Error('Interrupted Android locale restoration dispatch ownership changed')
              }
              recoveryPending = dispatched
              recoveryPendingValue = dispatchedValue
              return undefined
            }
            const confirmRecoveryMutationAccepted = (): undefined => {
              if (!recoveryPending.attemptedLocaleDispatchStarted) {
                throw new Error('Interrupted Android locale restoration acknowledgement preceded dispatch')
              }
              const confirmed: PendingAndroidLocaleRestore = {
                ...recoveryPending,
                attemptedLocaleOwned: true
              }
              const confirmedValue = JSON.stringify(confirmed)
              if (!this.settings.setIfValue(key, recoveryPendingValue, confirmedValue)) {
                throw new Error('Interrupted Android locale restoration acknowledgement ownership changed')
              }
              recoveryPending = confirmed
              recoveryPendingValue = confirmedValue
              return undefined
            }
            const result = await session.withActiveUserScreenWitness(
              (signal) => session.restoreAppLocalesFromFence(
                recoveryStage.applicationId,
                recoveryStage.originalLocaleTags,
                recoveryStage.fence,
                recoveryStage.expectedLocaleTags,
                recoveryStage.attemptedLocaleTags,
                {
                  timeoutMs: 30_000,
                  signal,
                  onBeforeMutation: markRecoveryMutationDispatched,
                  onMutationAccepted: confirmRecoveryMutationAccepted
                }
              ),
              { actionTimeoutMs: 30_000, allowApplicationIdTransitions: recoveryStage.applicationId }
            )
            if (
              result.applicationId !== recoveryStage.applicationId ||
              result.apiLevel !== recoveryStage.fence.apiLevel ||
              !sameStringValues(result.localeTags, recoveryStage.originalLocaleTags) ||
              !sameAndroidLocaleRestoreFence(result.restoreFence, recoveryStage.fence) ||
              result.pids.length === 0 ||
              result.readiness.application !== 'foreground' ||
              result.readiness.localeService !== 'ready' ||
              result.readiness.process !== 'running'
            ) {
              throw new Error('Interrupted Android locale restoration result changed')
            }
            const fresh = await session.proveAppLocaleFinalState(
              recoveryStage.applicationId,
              recoveryStage.fence,
              30_000
            )
            if (
              fresh.apiLevel !== recoveryStage.fence.apiLevel ||
              !sameStringValues(fresh.localeTags, recoveryStage.originalLocaleTags) ||
              !sameAndroidLocaleRestoreFence(fresh.restoreFence, recoveryStage.fence) ||
              fresh.pids.length === 0
            ) {
              throw new Error('Interrupted Android locale restoration proof changed')
            }
            // Final proof returned after every helper closed. Keep release in
            // this same JS turn so no awaited result can be reused later.
            if (!this.deletePendingAndroidLocaleRestorationIfOwned(
              key,
              recoveryPendingValue,
              recoveryPending
            )) {
              throw new Error('Interrupted Android locale restoration ownership changed')
            }
            restored = true
            unresolved.delete(room.id)
          }, { allowPendingAndroidLocaleRestoration: true })
        } catch {
          // The retained value remains a hard mutation gate. Recovery can be
          // retried only with the exact target/install/user/lease authority.
        }
      }
      if (!restored) {
        const current = this.rooms.get(room.id)
        if (current && current.provider === 'android') {
          this.rooms.update(room.id, { status: 'attention' })
        }
      }
      this.olog(
        room.id,
        restored
          ? 'interrupted Android locale matrix was restored under its exact retained fence'
          : 'interrupted Android locale matrix still needs exact target recovery; private details were withheld'
      )
    }
    return unresolved
  }

  private async reconcileInterruptedArtifactExports(staleJobsAbsent: boolean): Promise<void> {
    const interrupted: Array<{
      room: RoomRecord
      key: string
      raw: string
      pending: PendingArtifactExport | null
      fenced: boolean
    }> = []
    for (const room of this.rooms.list()) {
      const key = pendingArtifactExportKey(room.id)
      const raw = this.settings.get(key)
      if (raw === null) continue
      const pending = parsePendingArtifactExport(raw)
      // Fence the persisted Room before touching any external startup
      // dependency. init() failures are non-fatal to the desktop process, so a
      // stale ready record must never survive long enough to admit new work.
      let fenced = false
      try {
        this.markWorkspaceAmbiguous(room.id)
        fenced = true
      } catch {
        // Keep the durable intent if the database fence itself could not land.
      }
      interrupted.push({ room, key, raw, pending, fenced })
    }

    // The shared startup prepass already removed every retained job and proved
    // the role absent before locale or artifact recovery was allowed to run.
    if (staleJobsAbsent) this.cleanupStaleArtifactExportStaging()

    for (const { room, key, raw, pending, fenced } of interrupted) {
      // The recovery finalizer deliberately has no live-web probe: startup must
      // first prove both stale-job absence and that every Room workload stopped.
      let workloadsStopped = false
      if (room.provider !== 'windows') {
        try {
          await this.backend.stopRoomPod(room.id)
          workloadsStopped = true
        } catch {
          // Never finalize against a workspace that may still be in use.
        }
      }
      let settled = false
      if (
        fenced &&
        staleJobsAbsent &&
        workloadsStopped &&
        pending !== null &&
        room.workspaceMode === 'hotel' &&
        room.workspaceVolumeRevision === pending.workspaceVolumeRevision
      ) {
        try {
          const outcome = await this.backend.reconcileRoomArtifactPublication(
            room.id,
            pending.workspaceVolumeRevision,
            pending.relativePath,
            pending.expected,
            pending.stageToken
          )
          settled = outcome === 'committed' || outcome === 'absent' ||
            outcome === 'destination-exists' || outcome === 'unsafe-parent'
        } catch {
          // The durable intent remains for another startup. The Room fence is
          // still invalidated below so no workload can use an uncertain tree.
        }
      }
      if (settled && fenced) {
        try {
          this.settings.deleteIfValue(key, raw)
        } catch {
          // A repeated recovery is conservative and identity-fenced.
        }
      }
      this.olog(room.id, 'interrupted artifact export was fenced; private recovery details were withheld')
    }
  }

  private artifactExportTemporaryRoot(create: boolean): string | null {
    const root = join(this.userData, 'tmp')
    if (create) mkdirSync(root, { recursive: true })
    if (!existsSync(root)) return null
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Artifact export temporary root is not a private regular directory')
    }
    const canonicalUserData = realpathSync.native(this.userData)
    const canonicalRoot = realpathSync.native(root)
    if (relative(canonicalUserData, canonicalRoot) !== 'tmp') {
      throw new Error('Artifact export temporary root escaped private app data')
    }
    return root
  }

  private inspectArtifactExportStaging(
    root: string,
    directory: string,
    expectedName: string
  ): { dev: number; ino: number; content: { path: string; dev: number; ino: number } | null } | null {
    if (relative(this.userData, root) !== 'tmp' || isAbsolute(relative(this.userData, root))) return null
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null
    const canonicalUserData = realpathSync.native(this.userData)
    const canonicalRoot = realpathSync.native(root)
    if (relative(canonicalUserData, canonicalRoot) !== 'tmp') return null
    const directoryStat = lstatSync(directory)
    const canonicalDirectory = realpathSync.native(directory)
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      relative(canonicalRoot, canonicalDirectory) !== expectedName
    ) return null
    const children = readdirSync(directory, { withFileTypes: true })
    if (children.length === 0) {
      return { dev: directoryStat.dev, ino: directoryStat.ino, content: null }
    }
    const child = children[0]
    if (
      children.length !== 1 ||
      child?.name !== 'content.png' ||
      !child.isFile() ||
      child.isSymbolicLink()
    ) return null
    const contentPath = join(directory, 'content.png')
    const contentStat = lstatSync(contentPath)
    const canonicalContent = realpathSync.native(contentPath)
    if (
      !contentStat.isFile() ||
      contentStat.isSymbolicLink() ||
      relative(canonicalDirectory, canonicalContent) !== 'content.png'
    ) return null
    return {
      dev: directoryStat.dev,
      ino: directoryStat.ino,
      content: { path: contentPath, dev: contentStat.dev, ino: contentStat.ino }
    }
  }

  private createArtifactExportStaging(content: Buffer): { root: string; temporary: string; hostFile: string } {
    const root = this.artifactExportTemporaryRoot(true)
    if (root === null) throw new Error('Artifact export temporary root was not created')
    let temporary: string | null = null
    try {
      temporary = mkdtempSync(join(root, 'artifact-export-'))
      const name = relative(root, temporary)
      if (!/^artifact-export-[A-Za-z0-9]{6}$/.test(name) || this.inspectArtifactExportStaging(root, temporary, name)?.content !== null) {
        throw new Error('Artifact export staging directory identity is invalid')
      }
      const hostFile = join(temporary, 'content.png')
      writeFileSync(hostFile, content, { flag: 'wx', mode: 0o600 })
      const staged = this.inspectArtifactExportStaging(root, temporary, name)
      if (staged === null || staged.content === null) {
        throw new Error('Artifact export staging file identity is invalid')
      }
      return { root, temporary, hostFile }
    } catch (error) {
      if (temporary !== null) {
        try { this.cleanupArtifactExportStagingDirectory(root, temporary) } catch { /* withheld by caller */ }
      }
      throw error
    }
  }

  /** Atomically quarantine one exact staging directory, then unlink without recursion. */
  private cleanupArtifactExportStagingDirectory(root: string, directory: string): boolean {
    const name = relative(root, directory)
    if (
      (!/^artifact-export-[A-Za-z0-9]{6}$/.test(name) &&
        !/^\.artifact-export-cleanup-[a-f0-9]{32}$/.test(name)) ||
      isAbsolute(name)
    ) return false
    const before = this.inspectArtifactExportStaging(root, directory, name)
    if (before === null) return false
    const quarantineName = `.artifact-export-cleanup-${randomUUID().replaceAll('-', '')}`
    const quarantine = join(root, quarantineName)
    renameSync(directory, quarantine)
    const after = this.inspectArtifactExportStaging(root, quarantine, quarantineName)
    if (
      after === null ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (before.content === null) !== (after.content === null) ||
      (before.content !== null && after.content !== null &&
        (before.content.dev !== after.content.dev || before.content.ino !== after.content.ino))
    ) return false
    if (after.content !== null) unlinkSync(after.content.path)
    rmdirSync(quarantine)
    return true
  }

  /** Reclaim only exact private export directories after stale jobs are absent. */
  private cleanupStaleArtifactExportStaging(): void {
    try {
      const root = this.artifactExportTemporaryRoot(false)
      if (root === null) return
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (
          !/^artifact-export-[A-Za-z0-9]{6}$/.test(entry.name) &&
          !/^\.artifact-export-cleanup-[a-f0-9]{32}$/.test(entry.name)
        ) continue
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        try {
          this.cleanupArtifactExportStagingDirectory(root, join(root, entry.name))
        } catch {
          // A changed or inaccessible entry is retained rather than followed.
        }
      }
    } catch {
      // Startup continues without exposing the Host-private cleanup detail.
    }
  }

  private async markInterruptedChanges(): Promise<void> {
    for (const room of this.rooms.list()) {
      const pending = this.changes.list(room.id).filter((entry) => entry.status === 'pending')
      if (pending.length === 0) continue
      for (const entry of pending) {
        if (entry.kind === 'android-build' || entry.kind === 'android-run') {
          const cleanupFailures: string[] = []
          try {
            await this.backend.removeWorkspaceSnapshot(room.id, entry.id)
          } catch (error) {
            cleanupFailures.push(error instanceof Error ? error.message : String(error))
          }
          const artifactCleanupError = cleanupAndroidBuildArtifacts(this.userData, room.id, entry.id)
          if (artifactCleanupError) cleanupFailures.push(artifactCleanupError)
          if (entry.kind === 'android-run') this.androidInstalls.removeForChange(room.id, entry.id)
          if (cleanupFailures.length > 0) {
            const detail = `interrupted Android snapshot cleanup will retry on next startup: ${cleanupFailures.join('; ')}`
            this.changes.setStatus(entry.id, 'pending', { verify: { ok: false, detail } })
            this.olog(room.id, detail)
            continue
          }
        }
        const detail = `interrupted while applying change #${entry.seq}; captured safety data was preserved`
        this.changes.setStatus(entry.id, 'failed', { verify: { ok: false, detail } })
        this.olog(room.id, detail)
      }
      const current = this.rooms.get(room.id)
      if (current && current.status !== 'broken') this.rooms.update(room.id, { status: 'attention' })
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.mutationGate = 'shutdown'
    this.shutdownTask = this.shutdownLocked()
    return this.shutdownTask
  }

  private async shutdownLocked(): Promise<void> {
    const failures: Error[] = []
    // A clean-removal request owns the inventory while it runs. Quitting waits
    // for it, then handles anything it deliberately left behind after failure.
    const deleteAllTask = this.deleteAllTask
    if (deleteAllTask) {
      try {
        await deleteAllTask
      } catch (error) {
        failures.push(asShutdownError('Clean removal failed before shutdown', error))
      }
    }
    // createRoom can still be detecting a source before it has a room ID, while
    // all other lifecycle work is represented in roomOps. The global gate above
    // prevents new work; waiting for both sets makes the room list stable.
    await this.drainRoomMutations()
    const localeRecoveryRooms = this.rooms.list().filter(
      (room) => this.settings.get(pendingAndroidLocaleRestoreKey(room.id)) !== null
    )
    if (localeRecoveryRooms.length > 0) {
      throw new AggregateError(
        localeRecoveryRooms.map(() => new Error('An Android locale recovery fence still owns its exact target.')),
        `DevHotel shutdown blocked by ${localeRecoveryRooms.length} pending Android locale restoration${
          localeRecoveryRooms.length === 1 ? '' : 's'
        }`
      )
    }
    for (const room of this.rooms.list()) {
      if (room.status === 'sleeping') continue
      try {
        if (room.status === 'broken') {
          // broken rooms may still own running containers — stop them but keep the status visible
          if (room.provider === 'android') await this.releaseAndroidDeviceLocked(room.id, 'Broken Room shut down')
          if (room.provider === 'windows') await this.mustWindowsVm().sleep(room.id)
          else await this.backend.stopRoomPod(room.id)
          this.rooms.update(room.id, { hostPort: null })
        } else {
          // The shutdown gate rejects public lifecycle calls. All admitted work
          // has settled, so shutdown owns the lifecycle and can call the locked
          // implementation directly without queueing behind itself.
          await this.sleepRoomLocked(room.id, 'devhotel')
        }
      } catch (error) {
        failures.push(asShutdownError(`Room ${room.project} / ${room.nickname} could not be stopped`, error))
      }
    }
    try {
      this.logs.dispose()
    } catch (error) {
      failures.push(asShutdownError('Room log streams could not be disposed', error))
    }
    try {
      await this.gateway.stop()
    } catch (error) {
      failures.push(asShutdownError('Gateway could not be stopped', error))
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `DevHotel shutdown incomplete (${failures.length} failure${failures.length === 1 ? '' : 's'})`)
    }
  }

  /** Serializes lifecycle mutations per room — concurrent UI/MCP calls queue instead of interleaving docker operations. */
  private withRoomLock<T>(
    roomId: string,
    fn: () => Promise<T>,
    opts: {
      admittedBeforeGate?: boolean
      allowPendingArtifactExport?: boolean
      allowPendingAndroidLocaleRestoration?: boolean
    } = {}
  ): Promise<T> {
    if (this.mutationGate !== 'open' && !opts.admittedBeforeGate) {
      return Promise.reject(this.mutationGateError())
    }
    const prev = this.roomOps.get(roomId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(async () => {
      if (!opts.allowPendingArtifactExport) this.assertNoPendingArtifactExport(roomId)
      if (!opts.allowPendingAndroidLocaleRestoration) this.assertNoPendingAndroidLocaleRestoration(roomId)
      if (this.activeRoomLocks.has(roomId)) throw new Error(`Room ${roomId} lock ownership is ambiguous`)
      this.activeRoomLocks.add(roomId)
      try {
        return await fn()
      } finally {
        this.activeRoomLocks.delete(roomId)
      }
    })
    this.roomOps.set(
      roomId,
      next.catch(() => undefined)
    )
    return next
  }

  private assertNoPendingArtifactExport(roomId: string): void {
    if (this.settings.get(pendingArtifactExportKey(roomId)) === null) return
    throw new DevHotelError(
      'ARTIFACT_EXPORT_RECOVERY_REQUIRED',
      'This Room is fenced while an interrupted artifact export is being recovered.',
      {
        recoveryHint: 'Restart DevHotel after the isolation backend is healthy; do not start or modify this Room meanwhile.',
        httpStatus: 409
      }
    )
  }

  private assertNoPendingAndroidLocaleRestoration(roomId: string): void {
    if (this.settings.get(pendingAndroidLocaleRestoreKey(roomId)) === null) return
    throw new DevHotelError(
      'ANDROID_LOCALE_RECOVERY_REQUIRED',
      'This Room is fenced while an interrupted Android locale matrix is being restored.',
      {
        recoveryHint: 'Restore the exact target, install, Android user and lease, then restart DevHotel.',
        httpStatus: 409
      }
    )
  }

  private deletePendingAndroidLocaleRestorationIfOwned(
    key: string,
    value: string,
    pending: PendingAndroidLocaleRestore
  ): boolean {
    if (pending.fence.targetKind !== 'physical') {
      return this.settings.deleteIfValue(key, value)
    }
    if (!pending.fence.deviceId || !pending.fence.leaseId) return false
    return this.settings.deleteIfValueForActiveAndroidLease(key, value, {
      id: pending.fence.leaseId,
      deviceId: pending.fence.deviceId,
      roomId: pending.fence.roomId
    })
  }

  /**
   * Release only one v4 stage whose setter was durably proved never dispatched
   * and whose fresh composite target proof is outside every potentially owned
   * locale state. The exact delete is synchronous with that proof.
   */
  private abandonPendingAndroidLocaleRestorationIfProvenOutside(
    key: string,
    value: string,
    pending: PendingAndroidLocaleRestore,
    proof: AndroidAppLocaleSnapshot
  ): PendingAndroidLocaleAbandonDecision {
    if (
      pending.version !== 4 ||
      pending.fence.targetKind !== 'emulator' ||
      pending.attemptedLocaleDispatchStarted ||
      pending.attemptedLocaleOwned ||
      proof.apiLevel !== pending.fence.apiLevel ||
      proof.pids.length === 0 ||
      !sameAndroidLocaleRestoreFence(proof.restoreFence, pending.fence)
    ) return 'refused'

    const currentLocaleTags = proof.localeTags
    if (
      sameStringValues(currentLocaleTags, pending.originalLocaleTags) ||
      sameStringValues(currentLocaleTags, pending.expectedLocaleTags) ||
      sameStringValues(currentLocaleTags, pending.attemptedLocaleTags) ||
      // A marker from an earlier stage is still DevHotel-attributable even
      // after stage advancement removed it from this record. Without durable
      // marker history, fail closed on every structurally valid marker.
      currentLocaleTags.some(isAndroidLocaleOwnershipMarkerTag)
    ) return 'refused'

    return this.settings.deleteIfValue(key, value) ? 'released' : 'cas-changed'
  }

  private assertRoomLockHeld(roomId: string): void {
    if (!this.activeRoomLocks.has(roomId)) {
      throw new Error(`Room ${roomId} operation requires the active Room lock`)
    }
  }

  private mutationGateError(): Error {
    return new Error('DevHotel is shutting down or removing its data; no new room changes can start')
  }

  /**
   * Reserve a newly-created Room ID while another Room's operation is still
   * materializing it. Ordinary target mutations queue behind this barrier;
   * durable starts are rejected until release because rollback can delete the
   * target. Global shutdown/delete-all drains it through roomOps like any other
   * lock.
   */
  private reserveRoomBarrier(roomId: string): () => void {
    this.materializingRooms.add(roomId)
    const previous = this.roomOps.get(roomId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const barrier = previous.catch(() => undefined).then(() => held)
    this.roomOps.set(roomId, barrier.catch(() => undefined))
    let released = false
    return () => {
      if (released) return
      released = true
      this.materializingRooms.delete(roomId)
      release()
    }
  }

  /** Tracks mutations which begin before a room ID/lock exists (currently room creation). */
  private trackMutation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.mutationGate !== 'open') {
      return Promise.reject(new Error('DevHotel is shutting down or removing its data; no new room changes can start'))
    }
    const task = Promise.resolve().then(fn)
    this.activeMutations.add(task)
    void task.then(
      () => this.activeMutations.delete(task),
      () => this.activeMutations.delete(task)
    )
    return task
  }

  private async drainRoomMutations(): Promise<void> {
    await Promise.allSettled([...this.activeMutations, ...this.roomOps.values()])
  }

  onEvent(cb: (e: OrchestratorEvent) => void): () => void {
    this.emitter.on('event', cb)
    return () => this.emitter.off('event', cb)
  }

  onLogLine(cb: (e: { roomId: string; kind: LogKind; line: string }) => void): () => void {
    this.logs.on('line', cb)
    return () => this.logs.off('line', cb)
  }

  listRooms(): RoomRecord[] {
    return this.rooms.list()
  }

  /** Public Room listing with live liveness overlaid; persisted records remain unchanged. */
  async listRoomsRuntime(): Promise<RuntimeRoomRecord[]> {
    let backendAvailable = false
    try {
      backendAvailable = (await this.backend.health()).ok
    } catch {
      // Each OCI Room reports unknown below; Windows Rooms use their own provider probe.
    }
    const rooms: RuntimeRoomRecord[] = []
    for (const room of this.rooms.list()) {
      const runtimeStatus = await this.observeRuntimeStatus(room, backendAvailable)
      rooms.push({ ...this.effectiveRoom(room, runtimeStatus), runtimeStatus })
    }
    return rooms
  }

  backendHealth(): Promise<{ ok: boolean; detail: string }> {
    return this.backend.health()
  }

  private runtimeExpectation(room: RoomRecord): RoomRuntimeStatus['expected'] {
    if (room.status === 'preparing') return 'transitional'
    if (room.status === 'running' || room.status === 'ready' || room.status === 'attention') return 'running'
    return 'stopped'
  }

  private runtimeRecoveryHint(room: RoomRecord): string {
    return room.provider === 'windows'
      ? 'Start or restart the Windows Room, then retry.'
      : 'Start or restart the Room, then retry.'
  }

  private async observeRuntimeStatus(room: RoomRecord, backendAvailable?: boolean): Promise<RoomRuntimeStatus> {
    const observedAt = new Date().toISOString()
    const expected = this.runtimeExpectation(room)
    if (expected !== 'running') {
      return {
        state: expected === 'stopped' ? 'stopped' : 'unknown',
        expected,
        recordedStatus: room.status,
        main: 'not-checked',
        emulator: null,
        observedAt,
        detail: expected === 'stopped' ? 'The recorded Room state does not expect a running runtime.' : 'The Room is transitioning.',
        recoveryHint: null
      }
    }

    if (room.provider === 'windows') {
      if (!this.windowsVm) {
        return {
          state: 'unknown',
          expected,
          recordedStatus: room.status,
          main: 'unknown',
          emulator: null,
          observedAt,
          detail: 'Windows runtime liveness is unavailable.',
          recoveryHint: this.runtimeRecoveryHint(room)
        }
      }
      try {
        const state = await this.windowsVm.state(room.id)
        const running = state === 'running'
        return {
          state: running ? 'running' : 'dead',
          expected,
          recordedStatus: room.status,
          main: state,
          emulator: null,
          observedAt,
          detail: running ? 'The Windows Room VM is running.' : `The recorded Room is ${room.status}, but its VM is ${state}.`,
          recoveryHint: running ? null : this.runtimeRecoveryHint(room)
        }
      } catch {
        return {
          state: 'unknown',
          expected,
          recordedStatus: room.status,
          main: 'unknown',
          emulator: null,
          observedAt,
          detail: 'Windows runtime liveness could not be determined.',
          recoveryHint: this.runtimeRecoveryHint(room)
        }
      }
    }

    let available = backendAvailable
    if (available === undefined) {
      try {
        available = (await this.backend.health()).ok
      } catch {
        available = false
      }
    }
    if (!available) {
      return {
        state: 'unknown',
        expected,
        recordedStatus: room.status,
        main: 'unknown',
        emulator: room.provider === 'android' ? 'unknown' : null,
        observedAt,
        detail: 'Runtime liveness is unavailable because the isolation backend is not responding.',
        recoveryHint: this.runtimeRecoveryHint(room)
      }
    }

    const [main, emulator] = await Promise.all([
      this.backend.webState(room.id).catch(() => 'unknown' as const),
      room.provider === 'android'
        ? this.backend.emulatorState(room.id).catch(() => 'unknown' as const)
        : Promise.resolve(null)
    ])
    if (room.provider !== 'android') {
      const running = main === 'running'
      return {
        state: running ? 'running' : main === 'unknown' ? 'unknown' : 'dead',
        expected,
        recordedStatus: room.status,
        main,
        emulator: null,
        observedAt,
        detail: running ? 'The Room runtime is running.' : main === 'unknown' ? 'Runtime liveness could not be determined.' : `The recorded Room is ${room.status}, but its runtime is ${main}.`,
        recoveryHint: running ? null : this.runtimeRecoveryHint(room)
      }
    }

    const bothRunning = main === 'running' && emulator === 'running'
    const eitherRunning = main === 'running' || emulator === 'running'
    const eitherUnknown = main === 'unknown' || emulator === 'unknown'
    const state = bothRunning ? 'running' : eitherRunning ? 'degraded' : eitherUnknown ? 'unknown' : 'dead'
    return {
      state,
      expected,
      recordedStatus: room.status,
      main,
      emulator,
      observedAt,
      detail: bothRunning
        ? 'The Android build runtime and emulator are running.'
        : state === 'degraded'
          ? `The Android Room is partially available (main: ${main}; emulator: ${emulator}).`
          : state === 'unknown'
            ? 'Android runtime liveness could not be determined.'
            : `The recorded Android Room is ${room.status}, but its runtime is dead (main: ${main}; emulator: ${emulator}).`,
      recoveryHint: bothRunning ? null : this.runtimeRecoveryHint(room)
    }
  }

  private effectiveRoom(room: RoomRecord, runtimeStatus: RoomRuntimeStatus): RoomRecord {
    if (runtimeStatus.expected !== 'running' || runtimeStatus.state === 'running') return room
    return { ...room, status: runtimeStatus.state === 'dead' ? 'broken' : 'attention' }
  }

  async planRoom(input: {
    sourceType: SourceType
    sourceRef: string
    nickname: string
    project?: string
    provider?: ProviderKind
  }): Promise<RoomPlan> {
    const project = input.project ?? deriveProjectName(input.sourceType, input.sourceRef)
    if ((input.provider ?? 'web') === 'windows') {
      if (input.sourceType !== 'empty' || input.sourceRef !== '') {
        throw new Error('Windows Rooms currently start empty; planning never imports Host or Git source')
      }
      return getProvider('windows').detect(EMPTY_READER, { project, nickname: input.nickname })
    }
    const { reader, cleanup } = await this.sourceReaderFor(input.sourceType, input.sourceRef)
    try {
      return await getProvider(input.provider ?? 'web').detect(reader, { project, nickname: input.nickname })
    } finally {
      cleanup()
    }
  }

  createRoom(input: CreateRoomInput): Promise<RoomRecord> {
    return this.trackMutation(() => this.createRoomAdmitted(input))
  }

  private async createRoomAdmitted(input: CreateRoomInput): Promise<RoomRecord> {
    const providerKind: ProviderKind = input.provider ?? 'web'
    if (providerKind === 'windows') return this.createWindowsRoomAdmitted(input)
    const provider = getProvider(providerKind)
    const { reader, cleanup } = await this.sourceReaderFor(input.sourceType, input.sourceRef)
    let plan: RoomPlan
    try {
      plan = await provider.detect(reader, {
        project: input.project,
        nickname: input.nickname,
        overrides: {
          runtimeVersion: input.planOverrides?.runtimeVersion,
          pmKind: input.planOverrides?.pmKind,
          startCommand: input.planOverrides?.startCommand,
          internalPort: input.planOverrides?.internalPort
        }
      })
    } finally {
      cleanup()
    }

    const id = newRoomId()
    const now = new Date().toISOString()
    const domain = this.uniqueDomain(input.planOverrides?.domain ?? plan.domain)
    const workspaceMode = input.sourceType === 'empty' ? 'empty' : 'hotel'
    const workspaceVolumeRevision = input.sourceType === 'linked-folder' ? 1 : 0
    const record: RoomRecord = {
      id,
      project: input.project,
      nickname: input.nickname,
      roomNumber: this.rooms.nextRoomNumber(),
      provider: providerKind,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      workspaceMode,
      stateRevision: input.sourceType === 'empty' ? 0 : 1,
      workspaceVolumeRevision,
      syncStatus: input.sourceType === 'empty' ? 'empty' : 'synced',
      lastSyncedAt: null,
      hostSyncEnabled: input.sourceType === 'linked-folder',
      workspaceFingerprint: null,
      runtime: { kind: plan.runtime.kind, version: plan.runtime.value },
      packageManager: { kind: plan.packageManager.value, version: plan.packageManager.version },
      startCommand: plan.startCommand.value,
      internalPort: plan.internalPort.value,
      domain,
      https: input.planOverrides?.https ?? false,
      status: 'preparing',
      services: {},
      os: { env: {} },
      hostPort: null,
      createdAt: now,
      lastUsedAt: now,
      thumbPath: null
    }
    this.rooms.create(record)
    if (record.workspaceVolumeRevision > 0) {
      this.settings.set(workspaceGenMaxKey(id), String(record.workspaceVolumeRevision))
    }
    mkdirSync(join(this.userData, 'rooms', id, 'logs'), { recursive: true })
    this.appendJournal(id, 'create-room', `Room created — ${record.project} / ${record.nickname}`, input.actor, 'Room', null, {
      runtime: `${record.runtime.kind} ${record.runtime.version}`,
      packageManager: record.packageManager.kind,
      domain: record.domain
    })
    this.emit(id, 'created')
    this.olog(
      id,
      `create room ${record.project}/${record.nickname} (${record.runtime.kind} ${record.runtime.version}, ${record.packageManager.kind})`
    )

    await this.withRoomLock(id, async () => {
      try {
        if (record.sourceType === 'linked-folder') {
          this.olog(id, 'import Host source into Room-owned workspace')
          await this.backend.importHostFolder(id, record.sourceRef, record.workspaceVolumeRevision, (line) => this.olog(id, line))
          const snapshot = await this.backend.snapshotWorkspace(id, record.workspaceVolumeRevision)
          this.rooms.update(id, { workspaceFingerprint: snapshot.fingerprint, lastSyncedAt: new Date().toISOString() })
          this.settings.set(workspaceSyncBaseKey(id), serializeWorkspaceSnapshot(snapshot))
        }
        const { hostPort } = await this.backend.createRoomPod(this.webSpecFor(record))
        this.rooms.update(id, {
          hostPort,
          status: 'running',
          ...(record.sourceType === 'managed-git' ? { lastSyncedAt: new Date().toISOString() } : {})
        })
        this.logs.attach(id)

        if (providerKind === 'web' && record.sourceType !== 'empty') {
          await this.engine.execute(this.ctxFor(id), 'deps-install', { clean: false }, 'devhotel')
        }
        if (providerKind === 'android') {
          this.olog(id, 'start emulator')
          try {
            await this.backend.createEmulator(id, this.mustGet(id).android)
          } catch (err) {
            // No KVM or a failed image pull must not brick the room — it can
            // still build APKs; checks surface the missing emulator screen.
            this.olog(id, `emulator unavailable, room continues build-only: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        await this.syncRouteFor(id)
        const verify = await verifyWebUp(this.ctxFor(id), { timeoutMs: 90_000 })
        this.rooms.update(id, { status: verify.ok ? 'ready' : 'attention', lastUsedAt: new Date().toISOString() })
        this.olog(id, `room up: ${verify.detail}`)
      } catch (err) {
        this.olog(id, `create failed: ${err instanceof Error ? err.message : String(err)}`)
        this.rooms.update(id, { status: 'broken' })
      }
    }, { admittedBeforeGate: true })

    const room = this.rooms.get(id)!
    await writeManifest(this.userData, room)
    this.emit(id, 'status')
    return room
  }

  private async createWindowsRoomAdmitted(input: CreateRoomInput): Promise<RoomRecord> {
    if (input.actor !== 'user') throw new Error('Windows Rooms require a user-approved VMware template')
    if (input.sourceType !== 'empty' || input.sourceRef !== '') {
      throw new Error('Windows Rooms currently start empty; source ingress arrives with the guest agent')
    }
    if (input.planOverrides) throw new Error('Web plan overrides do not apply to Windows Rooms')
    if (!input.windows) throw new Error('Choose a VMware template and clean snapshot')

    const windowsVm = this.mustWindowsVm()
    const health = await windowsVm.health()
    if (!health.ok) throw new Error(health.detail)
    const template = await windowsVm.inspectTemplate({
      templateVmxPath: input.windows.baseVmxPath,
      snapshot: input.windows.snapshot
    })
    const plan = await getProvider('windows').detect(EMPTY_READER, {
      project: input.project,
      nickname: input.nickname
    })

    const id = newRoomId()
    const now = new Date().toISOString()
    const record: RoomRecord = {
      id,
      project: input.project,
      nickname: input.nickname,
      roomNumber: this.rooms.nextRoomNumber(),
      provider: 'windows',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      stateRevision: 0,
      workspaceVolumeRevision: 0,
      syncStatus: 'empty',
      lastSyncedAt: null,
      hostSyncEnabled: false,
      workspaceFingerprint: null,
      runtime: { kind: 'windows', version: plan.runtime.value },
      packageManager: { kind: 'none' },
      startCommand: plan.startCommand.value,
      internalPort: 0,
      domain: this.uniqueDomain(plan.domain),
      https: false,
      status: 'preparing',
      services: {},
      os: { env: {} },
      windows: { backend: 'vmware', templateId: template.templateId, snapshot: template.snapshot },
      hostPort: null,
      createdAt: now,
      lastUsedAt: now,
      thumbPath: null
    }
    this.rooms.create(record)
    mkdirSync(join(this.userData, 'rooms', id, 'logs'), { recursive: true })
    this.appendJournal(
      id,
      'create-windows-room',
      `Windows Room created — ${record.project} / ${record.nickname}`,
      input.actor,
      'VMware',
      null,
      { templateId: template.templateId, snapshot: template.snapshot, clone: 'linked', network: 'offline' }
    )
    this.emit(id, 'created')
    this.olog(id, `create offline VMware linked clone from snapshot ${template.snapshot}`)

    await this.withRoomLock(
      id,
      async () => {
        try {
          const materialized = await windowsVm.create({
            roomId: id,
            templateVmxPath: input.windows!.baseVmxPath,
            snapshot: template.snapshot
          })
          if (materialized.templateId !== template.templateId) {
            throw new Error('The VMware template identity changed while the Room was being created')
          }
          await windowsVm.start(id)
          if ((await windowsVm.state(id)) !== 'running') throw new Error('VMware did not report the Windows Room as running')
          this.rooms.update(id, { status: 'ready', lastUsedAt: new Date().toISOString() })
          this.olog(id, 'Windows Room ready (offline Clean Room policy)')
        } catch (error) {
          this.olog(id, `create failed: ${error instanceof Error ? error.message : String(error)}`)
          this.rooms.update(id, { status: 'broken' })
        }
      },
      { admittedBeforeGate: true }
    )

    const room = this.mustGet(id)
    await writeManifest(this.userData, room)
    this.emit(id, 'status')
    return room
  }

  cloneRoom(input: CloneRoomInput): Promise<RoomRecord> {
    return this.withRoomLock(input.sourceRoomId, () => this.cloneRoomLocked(input))
  }

  private async cloneRoomLocked(input: CloneRoomInput): Promise<RoomRecord> {
    const source = this.mustGet(input.sourceRoomId)
    if (source.provider !== 'web') throw new Error('Clone Room currently supports Web rooms only')
    if (source.status === 'preparing') throw new Error('Wait for the source room to finish preparing before cloning it')
    if (source.workspaceMode === 'legacy-host-bind') {
      throw new Error('Move this legacy Host-bound Room into the Hotel before cloning it')
    }

    const nickname = input.nickname.trim()
    if (!nickname) throw new Error('Nickname cannot be empty')
    const duplicate = this.rooms
      .list()
      .some((room) => room.project.toLowerCase() === source.project.toLowerCase() && room.nickname.toLowerCase() === nickname.toLowerCase())
    if (duplicate) throw new Error(`${source.project} already has a room named ${nickname}`)

    let id = newRoomId()
    while (this.rooms.get(id)) id = newRoomId()
    const now = new Date().toISOString()
    const roomNumber = this.rooms.nextRoomNumber()
    const domainProject = slugify(source.project) || 'room'
    const domainNickname = slugify(nickname) || String(roomNumber)
    const services =
      input.services === 'exclude'
        ? {}
        : Object.fromEntries(
            Object.entries(source.services).map(([kind, config]) => [kind, { ...config }])
          )
    const record: RoomRecord = {
      id,
      project: source.project,
      nickname,
      roomNumber,
      provider: 'web',
      sourceType: source.sourceType,
      sourceRef: source.sourceRef,
      workspaceMode: source.workspaceMode,
      stateRevision: source.stateRevision,
      workspaceVolumeRevision: source.workspaceVolumeRevision,
      syncStatus: source.syncStatus,
      lastSyncedAt: source.lastSyncedAt,
      hostSyncEnabled: false,
      workspaceFingerprint: source.workspaceFingerprint,
      runtime: { ...source.runtime },
      packageManager: { ...source.packageManager },
      startCommand: source.startCommand,
      internalPort: source.internalPort,
      domain: this.uniqueDomain(`${domainProject}-${domainNickname}.localhost`),
      https: source.https,
      status: 'preparing',
      services,
      os: { ...source.os, env: { ...source.os.env } },
      hostPort: null,
      createdAt: now,
      lastUsedAt: now,
      thumbPath: null
    }

    // Persist ownership before creating Docker resources. Crash recovery can
    // then surface an interrupted clone instead of treating its containers as strays.
    this.rooms.create(record)
    if (record.workspaceVolumeRevision > 0) {
      this.settings.set(workspaceGenMaxKey(id), String(record.workspaceVolumeRevision))
    }
    mkdirSync(join(this.userData, 'rooms', id, 'logs'), { recursive: true })
    this.olog(id, `clone from ${source.project}/${source.nickname} (${source.id})`)
    // The clone itself is serialized by the source lock. Reserve the target as
    // well before the first await after publishing its preparing row, so a
    // caller that discovers it through listRooms cannot mutate partial state.
    const releaseTargetBarrier = this.reserveRoomBarrier(id)

    let sourceWebPaused = false
    const resumeSourceWeb = async (): Promise<void> => {
      if (!sourceWebPaused) return
      await this.backend.unpauseWeb(source.id)
      sourceWebPaused = false
    }
    try {
      const serviceEntries = Object.entries(record.services) as ['postgres' | 'redis', { version: string }][]
      const copyingWebVolumes = source.workspaceMode === 'hotel' || (input.copyDependencies && source.sourceType !== 'empty')
      const copyingServiceData = input.services === 'copy' && serviceEntries.length > 0
      if (copyingWebVolumes && !(await this.backend.imageExists('alpine'))) {
        this.olog(id, 'prepare volume-copy helper image')
        await this.backend.pullImage('alpine', (line) => this.olog(id, line))
      }
      if (
        (copyingWebVolumes || copyingServiceData) &&
        source.status !== 'sleeping' &&
        (await this.backend.webState(source.id)) === 'running'
      ) {
        this.olog(id, 'briefly pause source web process for a consistent Room copy')
        await this.backend.pauseWeb(source.id)
        sourceWebPaused = true
      }
      if (source.workspaceMode === 'hotel') {
        this.olog(id, 'copy Room-owned workspace')
        await this.backend.copyVolume(
          source.id,
          srcVolume(source.id, source.workspaceVolumeRevision),
          id,
          srcVolume(id, record.workspaceVolumeRevision),
          (line) => this.olog(id, line)
        )
      }

      if (input.copyDependencies && source.sourceType !== 'empty') {
        const sourceDeps = depsVolumeForGen(source.id, source.runtime.version, this.depsGen(source.id))
        const targetDeps = depsVolumeForGen(id, source.runtime.version, 0)
        this.olog(id, `copy dependencies from ${sourceDeps}`)
        await this.backend.copyVolume(source.id, sourceDeps, id, targetDeps, (line) => this.olog(id, line))
      }

      const logicalBackups = new Map<'postgres' | 'redis', string>()
      if (input.services === 'copy') {
        for (const [service] of serviceEntries) {
          if (source.status === 'sleeping') {
            const state = await this.backend.serviceState(source.id, service)
            if (state === 'running') {
              throw new Error(`Cannot copy ${service} volume because the sleeping source still has a running service`)
            }
            this.olog(id, `copy stopped ${service} data volume`)
            await this.backend.copyVolume(
              source.id,
              svcVolume(source.id, service),
              id,
              svcVolume(id, service),
              (line) => this.olog(id, line)
            )
            continue
          }
          if ((await this.backend.serviceState(source.id, service)) !== 'running') {
            throw new Error(`Cannot copy ${service} data because the source service is not running`)
          }
          if (service === 'postgres') await validatePostgresLogicalClone(this.ctxFor(source.id))
          this.olog(id, `create consistent ${service} backup`)
          const file = await backupServiceToFile(this.ctxFor(source.id), service)
          logicalBackups.set(service, file)
        }
      }
      // Keep the application quiesced until every sequential logical service
      // backup is complete, so code, dependencies and databases share one cut.
      await resumeSourceWeb()

      const { hostPort } = await this.backend.createRoomPod(this.webSpecFor(record), {
        initializeManagedSource: source.workspaceMode !== 'hotel',
        startWeb: false
      })
      this.rooms.update(id, { hostPort })

      if (!input.copyDependencies && source.sourceType !== 'empty') {
        const target = this.mustGet(id)
        const installCommand = pmInstallCommand(target)
        this.olog(id, `install fresh dependencies with ${installCommand}`)
        const installed = await this.backend.runOneShot(this.webSpecFor(target), installCommand, (line) => this.olog(id, line))
        if (installed.code !== 0) {
          throw new Error(`${installCommand} failed: ${installed.stderr.slice(-400) || `exit ${installed.code}`}`)
        }
      }

      for (const [service, config] of serviceEntries) {
        this.olog(id, `start ${service} ${config.version}`)
        await this.backend.createService(id, service, config.version)
        const ready = await pingService(this.ctxFor(id), service)
        if (!ready.ok) throw new Error(ready.detail)
        const backup = logicalBackups.get(service)
        if (backup) {
          this.olog(id, `restore copied ${service} data`)
          await restoreServiceFromFile(this.ctxFor(id), service, backup)
          const restored = await pingService(this.ctxFor(id), service)
          if (!restored.ok) throw new Error(restored.detail)
        }
      }

      // The target application must never observe an empty/partially restored
      // database. Its container was created stopped and is started exactly once
      // after dependencies and every service restore are complete.
      this.olog(id, 'start cloned web process')
      await this.backend.startWeb(id)
      this.rooms.update(id, { status: 'running' })
      this.logs.attach(id)

      await this.syncRouteFor(id)
      const verify = await verifyWebUp(this.ctxFor(id), { timeoutMs: 90_000 })
      this.rooms.update(id, {
        status: verify.ok ? 'ready' : 'attention',
        lastUsedAt: new Date().toISOString()
      })
      const cloned = this.mustGet(id)
      await writeManifest(this.userData, cloned)
      this.appendJournal(
        id,
        'clone-room',
        `Cloned from ${source.project} / ${source.nickname}`,
        input.actor,
        'Room',
        null,
        {
          sourceRoomId: source.id,
          dependencies: source.sourceType === 'empty' ? 'none' : input.copyDependencies ? 'copied' : 'fresh',
          services: input.services
        }
      )
      this.olog(id, `clone ready: ${verify.detail}`)
      this.emit(id, 'created')
      this.emit(id, 'status')
      return cloned
    } catch (err) {
      this.olog(id, `clone failed: ${err instanceof Error ? err.message : String(err)}`)
      try {
        await resumeSourceWeb()
      } catch (resumeError) {
        this.olog(source.id, `could not resume source web after clone failure: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`)
      }
      this.logs.detach(id)
      this.gateway.removeRoute(record.domain)
      try {
        await this.backend.deleteRoomPod(id, { volumes: true })
        // deleteRoomPod performs a post-delete ownership check. Only after that
        // succeeds is it safe to discard the target's recovery metadata.
        rmSync(join(this.userData, 'rooms', id), { recursive: true, force: true })
        this.rooms.delete(id)
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        this.rooms.update(id, { status: 'broken' })
        this.appendJournal(
          id,
          'clone-room-cleanup-required',
          `Clone failed; cleanup required for target ${id}`,
          input.actor,
          'Room',
          { sourceRoomId: source.id },
          { error: err instanceof Error ? err.message : String(err), cleanupError: detail }
        )
        this.olog(id, `automatic cleanup failed; target ownership retained for retry: ${detail}`)
        try {
          await writeManifest(this.userData, this.mustGet(id))
        } catch {
          // The database row remains the authoritative ownership record.
        }
        this.emit(id, 'created')
        this.emit(id, 'status')
        throw new Error(
          `Clone failed: ${err instanceof Error ? err.message : String(err)}. Automatic cleanup of target ${id} also failed: ${detail}`
        )
      }
      throw err
    } finally {
      if (sourceWebPaused) {
        try {
          await resumeSourceWeb()
        } catch (err) {
          this.olog(source.id, `could not resume source web after clone: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      releaseTargetBarrier()
    }
  }

  /**
   * Waking a Room is long enough that the caller's own timeout is the usual
   * reason a start "fails". Callers who need to survive that use
   * {@link startRoomOperation} and poll the returned operation; this awaits the
   * same single operation and keeps its original contract — it resolves once
   * the wake settled, and a wake that could not bring the Room up leaves the
   * Room marked `broken`/`attention` rather than rejecting.
   */
  async startRoom(roomId: string, actor: Actor): Promise<void> {
    await this.beginRoomStart(roomId, actor).completion
  }

  /**
   * Start (or join) the Room's wake and return its durable operation record
   * immediately. Repeat calls while a wake is running return that same record
   * instead of queueing a second wake.
   */
  startRoomOperation(roomId: string, actor: Actor): OperationRecord {
    return this.beginRoomStart(roomId, actor).record
  }

  private beginRoomStart(roomId: string, actor: Actor): { record: OperationRecord; completion: Promise<void> } {
    // OperationTracker persists before it publishes. Reject before that
    // boundary when global or per-Room deletion already owns the lifecycle, so
    // cleanup cannot be followed by a terminal write that resurrects an orphan
    // operation row.
    if (this.mutationGate !== 'open') throw this.mutationGateError()
    if (this.deletingRooms.has(roomId)) throw new Error(`Room ${roomId} is being deleted and cannot be started`)
    // Fail an unknown Room before an operation exists: there is nothing to poll.
    this.mustGet(roomId)
    this.assertNoPendingArtifactExport(roomId)
    // A clone publishes its preparing ownership row before the target exists.
    // Other lifecycle calls may safely queue behind that target's barrier, but
    // a start operation must not publish yet: clone rollback can delete the row
    // before queued work runs, leaving the operation as an orphan afterwards.
    if (this.materializingRooms.has(roomId)) {
      throw new Error(`Room ${roomId} is still being created and cannot be started`)
    }
    const handle = this.operations.run('room-start', roomId, actor, (report) =>
      this.withRoomLock(roomId, () => this.startRoomLocked(roomId, actor, report))
    )
    // The lifecycle lock's task resolves just before OperationTracker stores its
    // terminal snapshot. Make later delete/drain work wait for that publication
    // too, otherwise it could remove the Room and then lose a race to the final
    // operation INSERT.
    if (handle.newlyStarted) this.roomOps.set(roomId, handle.completion.catch(() => undefined))
    return handle
  }

  /** The Room's recent operations, newest first. */
  listOperations(roomId: string, limit?: number): OperationRecord[] {
    return this.operations.listForRoom(roomId, limit)
  }

  getOperation(operationId: string): OperationRecord | null {
    return this.operations.get(operationId)
  }

  /**
   * Wait up to `timeoutMs` for an operation to finish. Running out of time is
   * not an error: the record comes back with `status: 'running'`.
   */
  waitForOperation(operationId: string, timeoutMs: number): Promise<OperationRecord | null> {
    return this.operations.wait(operationId, timeoutMs)
  }

  private async startRoomLocked(roomId: string, _actor: Actor, report: OperationReporter): Promise<void> {
    const room = this.mustGet(roomId)
    const alreadyAwake = room.status === 'running' || room.status === 'ready'
    report.begin('preparing', 'Prepare the Room record')
    if (room.provider === 'windows') {
      const windowsVm = this.mustWindowsVm()
      if (alreadyAwake) {
        try {
          if ((await windowsVm.state(roomId)) === 'running') {
            report.skip('Room was already awake')
            return
          }
        } catch (error) {
          this.olog(
            roomId,
            `could not confirm Windows VM state; attempting recovery start: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      this.rooms.update(roomId, { status: 'preparing', hostPort: null })
      this.emit(roomId, 'status')
      this.olog(roomId, 'wake Windows VM')
      report.begin('vm-start', 'Start the Windows VM')
      try {
        await windowsVm.start(roomId)
        if ((await windowsVm.state(roomId)) !== 'running') throw new Error('VMware did not report the Windows Room as running')
        this.rooms.update(roomId, { status: 'ready', hostPort: null, lastUsedAt: new Date().toISOString() })
      } catch (error) {
        this.olog(roomId, `wake failed: ${error instanceof Error ? error.message : String(error)}`)
        this.rooms.update(roomId, { status: 'broken', hostPort: null })
        report.fail('wake failed', error)
      }
      await writeManifest(this.userData, this.mustGet(roomId))
      this.emit(roomId, 'status')
      return
    }
    if (alreadyAwake && room.hostPort != null) {
      const runtimeStatus = await this.observeRuntimeStatus(room)
      if (runtimeStatus.state === 'running') {
        report.skip('Room was already awake')
        return
      }
      this.olog(roomId, `wake requested for stale runtime: ${runtimeStatus.detail}`)
    }
    this.rooms.update(roomId, { status: 'preparing' })
    this.emit(roomId, 'status')
    this.olog(roomId, 'wake room')
    try {
      // Recreate containers from the current record so changes made while
      // asleep are materialized on wake.
      if (room.provider === 'android' && room.internalPort === 0) {
        // rooms created before the emulator screen existed relayed nothing
        this.rooms.update(roomId, { internalPort: 6080 })
      }
      report.begin('container-start', 'Start the Room containers')
      const { hostPort } = await this.backend.recreateAnchor({
        roomId,
        internalPort: this.mustGet(roomId).internalPort,
        androidRuntimeIsolation: room.provider === 'android'
      })
      this.rooms.update(roomId, { hostPort, status: 'running' })
      let emulatorStarted = false
      if (room.provider === 'android') {
        // the emulator joins the fresh anchor's netns, so it is recreated with it
        this.olog(roomId, 'start emulator')
        report.begin('emulator-boot', 'Start the Room emulator')
        try {
          this.clearAndroidEmulatorInstalls(roomId)
          await this.backend.removeEmulator(roomId)
          await this.backend.createEmulator(roomId, room.android)
          emulatorStarted = true
          report.detail('emulator container started')
        } catch (err) {
          // No KVM or a failed image pull must not brick the room — it can
          // still build APKs; checks surface the missing emulator screen.
          const detail = `emulator unavailable, room continues build-only: ${err instanceof Error ? err.message : String(err)}`
          this.olog(roomId, detail)
          report.skip(detail)
        }
      }
      report.begin('services-start', 'Start the Room services')
      // Services use the fresh runtime anchor (separate from Android's control
      // bridge), so every provider recreates them after anchor replacement.
      const services = Object.entries(room.services) as ['postgres' | 'redis', { version: string }][]
      if (services.length === 0) report.skip('this Room has no Room Services')
      for (const [svc, cfg] of services) {
        this.olog(roomId, `start service ${svc} ${cfg.version}`)
        await this.backend.removeService(roomId, svc, { volume: false })
        await this.backend.createService(roomId, svc, cfg.version)
      }
      report.begin('web-start', 'Start the Room web process')
      await this.backend.recreateWeb(this.webSpecFor(this.mustGet(roomId)))
      this.logs.attach(roomId)
      await this.syncRouteFor(roomId)
      report.begin('verify', 'Verify the Room answers')
      const verify = await verifyWebUp(this.ctxFor(roomId), { timeoutMs: 90_000 })
      this.rooms.update(roomId, {
        status: verify.ok ? 'ready' : 'attention',
        lastUsedAt: new Date().toISOString()
      })
      this.olog(roomId, `wake: ${verify.detail}`)
      report.detail(verify.detail)
      if (!verify.ok) {
        // The Room is left in `attention`, exactly as before — but the caller
        // now gets a terminal answer instead of a call that merely returned.
        report.fail(verify.detail)
        this.emit(roomId, 'status')
        return
      }
      if (emulatorStarted) await this.reportEmulatorReady(roomId, report)
    } catch (err) {
      this.olog(roomId, `wake failed: ${err instanceof Error ? err.message : String(err)}`)
      this.rooms.update(roomId, { status: 'broken' })
      report.fail('wake failed', err)
    }
    this.emit(roomId, 'status')
  }

  /**
   * Ask once whether the freshly started emulator already answers adb. Never
   * fatal: a Room whose phone is still booting is a working build Room.
   */
  private async reportEmulatorReady(roomId: string, report: OperationReporter): Promise<void> {
    report.begin('adb-ready', 'Check whether the emulator answers adb')
    let detail = ''
    try {
      const probe = await this.backend.execFencedEmulatorAdb(
        roomId,
        ['shell', 'getprop', 'sys.boot_completed'],
        { timeoutMs: EMULATOR_ADB_PROBE_TIMEOUT_MS, maxStdoutBytes: 1024, maxStderrBytes: 1024 }
      )
      if (probe.stdout.trim() === '1') {
        report.detail(`emulator ${EMULATOR_ADB_SERIAL} answers adb and finished booting`)
        return
      }
    } catch (err) {
      detail = ` (${err instanceof Error ? err.message : String(err)})`
    }
    report.skip(
      `emulator ${EMULATOR_ADB_SERIAL} is still booting${detail}; the Room is usable for builds now, ` +
        'and android-run waits for the device before installing'
    )
  }

  sleepRoom(roomId: string, actor: Actor): Promise<void> {
    return this.withRoomLock(
      roomId,
      () => this.sleepRoomLocked(roomId, actor),
      { allowPendingArtifactExport: true }
    )
  }

  private async sleepRoomLocked(roomId: string, _actor: Actor): Promise<void> {
    const room = this.mustGet(roomId)
    const artifactRecoveryPending = this.settings.get(pendingArtifactExportKey(roomId)) !== null
    this.olog(roomId, 'sleep room')
    await this.releaseAndroidDeviceLocked(roomId, 'Room went to sleep')
    if (room.provider === 'windows') {
      await this.mustWindowsVm().sleep(roomId)
      this.rooms.update(roomId, {
        status: artifactRecoveryPending ? 'broken' : 'sleeping',
        hostPort: null,
        lastUsedAt: new Date().toISOString()
      })
      await writeManifest(this.userData, this.mustGet(roomId))
      this.emit(roomId, 'status')
      return
    }
    this.logs.detach(roomId)
    this.gateway.removeRoute(room.domain)
    await this.backend.stopRoomPod(roomId)
    this.rooms.update(roomId, {
      status: artifactRecoveryPending ? 'broken' : 'sleeping',
      hostPort: null,
      lastUsedAt: new Date().toISOString()
    })
    await writeManifest(this.userData, this.mustGet(roomId))
    this.emit(roomId, 'status')
  }

  restartWeb(roomId: string, actor: Actor): Promise<ChangeEntry> {
    if (this.mustGet(roomId).provider === 'windows') throw new Error('Windows Rooms do not have a Web process to restart')
    return this.withRoomLock(roomId, async () => {
      const entry = await this.engine.execute(this.ctxFor(roomId), 'restart-web', {}, actor)
      this.reattachLogs(roomId)
      this.emit(roomId, 'change')
      return entry
    })
  }

  /**
   * The one Host-input capability DevHotel still has: the VMware console is a
   * Host window, and while it has focus the Room holds the real cursor and
   * keyboard. It is therefore user-only — an Agent must never be able to make
   * the Host surrender its desktop — and every use is journaled to the Room log
   * so the takeover is observable afterwards.
   */
  async openWindows(roomId: string, actor: Actor): Promise<void> {
    const room = this.mustGet(roomId)
    if (room.provider !== 'windows') throw new Error('Only Windows Rooms open in VMware Workstation')
    const capability = hostInputCapability(VMWARE_CONSOLE_CAPABILITY)!
    if (actor !== capability.requiresActor) {
      throw new Error(
        'Opening the VMware console takes the Host cursor, keyboard and foreground window, so it requires an explicit user action'
      )
    }
    this.olog(roomId, capability.auditLine)
    await this.mustWindowsVm().openConsole(roomId)
  }

  resetWindows(roomId: string, actor: Actor): Promise<void> {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (room.provider !== 'windows') throw new Error('Clean VM reset is available only for Windows Rooms')
      if (actor !== 'user') throw new Error('Clean VM reset requires an explicit user action')
      const wasAwake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      const windowsVm = this.mustWindowsVm()
      this.rooms.update(roomId, { status: 'preparing', hostPort: null })
      this.emit(roomId, 'status')
      this.olog(roomId, 'discard Windows clone and recreate from clean snapshot')
      try {
        const reset = await windowsVm.reset(roomId)
        if (reset.templateId !== room.windows?.templateId || reset.snapshot !== room.windows?.snapshot) {
          throw new Error('VMware reset returned a different template identity')
        }
        if (wasAwake) await windowsVm.start(roomId)
        this.rooms.update(roomId, {
          status: wasAwake ? 'ready' : 'sleeping',
          hostPort: null,
          lastUsedAt: new Date().toISOString()
        })
        this.appendJournal(
          roomId,
          'reset-windows-room',
          'Windows Room recreated from its clean snapshot',
          actor,
          'VMware',
          { clone: 'discarded' },
          { templateId: reset.templateId, snapshot: reset.snapshot, clone: 'linked', network: 'offline' }
        )
      } catch (error) {
        this.rooms.update(roomId, { status: 'broken', hostPort: null })
        this.olog(roomId, `clean reset failed: ${error instanceof Error ? error.message : String(error)}`)
        await writeManifest(this.userData, this.mustGet(roomId))
        this.emit(roomId, 'status')
        throw error
      }
      await writeManifest(this.userData, this.mustGet(roomId))
      this.emit(roomId, 'change', 'Clean VM reset')
      this.emit(roomId, 'status')
    })
  }

  deleteRoom(roomId: string, actor: Actor): Promise<{ reclaimedBytes: number }> {
    if (this.deletingRooms.has(roomId)) {
      return Promise.reject(new Error(`Room ${roomId} is already being deleted`))
    }
    // Reserve deletion synchronously. A concurrent start must fail before it
    // creates its durable operation record, not queue behind deletion and write
    // a terminal orphan after the Room row is gone.
    this.deletingRooms.add(roomId)
    const task = this.withRoomLock(
      roomId,
      () => this.deleteRoomLocked(roomId, actor),
      { allowPendingArtifactExport: true }
    )
    void task.then(
      () => this.deletingRooms.delete(roomId),
      () => this.deletingRooms.delete(roomId)
    )
    return task
  }

  /**
   * Exclusively removes every Room for the "remove DevHotel and all data"
   * workflow. The gate is kept closed after success so renderer/MCP requests
   * cannot recreate data before the process exits. A failed cleanup reopens the
   * gate and keeps failed Room records, making an explicit retry possible.
   */
  deleteAllRooms(actor: Actor): Promise<{ deletedRooms: number; reclaimedBytes: number }> {
    if (this.deleteAllTask) return this.deleteAllTask
    if (this.mutationGate !== 'open') {
      return Promise.reject(new Error('DevHotel is shutting down; all Room data cannot be removed now'))
    }
    this.mutationGate = 'delete-all'
    const task = this.deleteAllRoomsLocked(actor)
    this.deleteAllTask = task
    void task.catch(() => {
      if (this.mutationGate === 'delete-all') this.mutationGate = 'open'
      if (this.deleteAllTask === task) this.deleteAllTask = null
    })
    return task
  }

  private async deleteAllRoomsLocked(actor: Actor): Promise<{ deletedRooms: number; reclaimedBytes: number }> {
    // Mutations admitted before the gate may still be creating a row or target
    // volume. Drain them before taking the one stable inventory used below.
    await this.drainRoomMutations()
    const inventory = this.rooms.list()
    const localeRecoveryCount = inventory.filter(
      (room) => this.settings.get(pendingAndroidLocaleRestoreKey(room.id)) !== null
    ).length
    if (localeRecoveryCount > 0) {
      throw new Error(
        `Could not remove Room data while ${localeRecoveryCount} exact Android locale restoration${
          localeRecoveryCount === 1 ? ' is' : 's are'
        } still pending`
      )
    }
    let deletedRooms = 0
    let reclaimedBytes = 0
    const failures: string[] = []
    for (const room of inventory) {
      try {
        const result = await this.deleteRoomLocked(room.id, actor)
        deletedRooms += 1
        reclaimedBytes += result.reclaimedBytes
      } catch (err) {
        failures.push(`${room.project} / ${room.nickname}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length > 0) throw new Error(`Could not remove every Room:\n${failures.join('\n')}`)
    return { deletedRooms, reclaimedBytes }
  }

  private async deleteRoomLocked(roomId: string, _actor: Actor): Promise<{ reclaimedBytes: number }> {
    const room = this.mustGet(roomId)
    this.olog(roomId, 'delete room')
    await this.releaseAndroidDeviceLocked(roomId, 'Room was deleted')
    if (room.provider === 'windows') {
      const windowsVm = this.mustWindowsVm()
      const { reclaimedBytes } = await windowsVm.delete(roomId)
      this.rooms.delete(roomId)
      this.operations.forgetRoom(roomId)
      this.pendingHostResyncConfirmations.delete(roomId)
      rmSync(join(this.userData, 'rooms', roomId), { recursive: true, force: true })
      this.emit(roomId, 'deleted')
      return { reclaimedBytes }
    }
    this.logs.detach(roomId)
    this.gateway.removeRoute(room.domain)
    const { reclaimedBytes } = await this.backend.deleteRoomPod(roomId, { volumes: true })
    this.rooms.delete(roomId)
    this.operations.forgetRoom(roomId)
    this.pendingHostResyncConfirmations.delete(roomId)
    rmSync(join(this.userData, 'rooms', roomId), { recursive: true, force: true })
    this.emit(roomId, 'deleted')
    return { reclaimedBytes }
  }

  private static readonly ROOM_FILE_CAP = 16 * 1024 * 1024

  private validateRoomFilePath(roomId: string, path: string): string {
    this.assertNoPendingArtifactExport(roomId)
    if (!/^\/workspace\/[^\0]*$/.test(path) || path.split('/').includes('..')) {
      throw new Error('Room file paths must be absolute paths under /workspace')
    }
    // In a legacy Host-bound Room /workspace IS the user's real folder, so file
    // transfer there would read and write Host files directly (goal.md §5.11).
    if (this.mustGet(roomId).workspaceMode === 'legacy-host-bind') {
      throw new Error('Move this legacy Host-bound Room into the Hotel before transferring files')
    }
    return path
  }

  /** Official file egress: read one workspace file (base64), capped at 16MB. */
  pullRoomFile(roomId: string, path: string): Promise<{ path: string; size: number; contentBase64: string }> {
    return this.withRoomLock(roomId, async () => {
      if (this.mustGet(roomId).provider === 'windows') {
        throw new Error('Windows Room file transfer requires the forthcoming guest agent')
      }
      const safePath = this.validateRoomFilePath(roomId, path)
      const tmp = join(this.userData, 'tmp', `pull-${newRoomId()}`)
      mkdirSync(tmp, { recursive: true })
      const hostFile = join(tmp, 'file.bin')
      try {
        await this.backend.copyFromRoom(roomId, safePath, hostFile)
        const stats = statSync(hostFile)
        if (stats.size > RoomOrchestrator.ROOM_FILE_CAP) {
          throw new Error(`file is ${stats.size} bytes — larger than the 16MB pull cap`)
        }
        return { path: safePath, size: stats.size, contentBase64: readFileSync(hostFile).toString('base64') }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  }

  /** Official file ingress: write one workspace file from base64, capped at 16MB. */
  async pushRoomFile(roomId: string, path: string, contentBase64: string): Promise<{ path: string; size: number }> {
    return this.withRoomLock(roomId, async () => {
      if (this.mustGet(roomId).provider === 'windows') {
        throw new Error('Windows Room file transfer requires the forthcoming guest agent')
      }
      const safePath = this.validateRoomFilePath(roomId, path)
      const content = Buffer.from(contentBase64, 'base64')
      if (content.byteLength > RoomOrchestrator.ROOM_FILE_CAP) {
        throw new Error(`content is ${content.byteLength} bytes — larger than the 16MB push cap`)
      }
      const dir = safePath.slice(0, safePath.lastIndexOf('/')) || '/workspace'
      const mkdir = await this.backend.execInRoom(roomId, ['sh', '-lc', `mkdir -p '${dir}'`], { timeoutMs: 30_000 })
      if (mkdir.code !== 0) throw new Error(`could not create ${dir}: ${mkdir.stderr.slice(-200)}`)
      const tmp = join(this.userData, 'tmp', `push-${newRoomId()}`)
      mkdirSync(tmp, { recursive: true })
      const hostFile = join(tmp, 'file.bin')
      try {
        writeFileSync(hostFile, content)
        await this.backend.copyIntoRoom(roomId, hostFile, safePath)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      this.markWorkspaceModified(roomId)
      return { path: safePath, size: content.byteLength }
    })
  }

  listRoomArtifacts(roomId: string, limit = 20): RoomArtifact[] {
    this.mustGet(roomId)
    return this.artifacts.list(roomId, zArtifactListLimit.parse(limit))
  }

  getRoomArtifact(roomId: string, artifactId: string): RoomArtifact {
    this.mustGet(roomId)
    const artifact = this.artifacts.get(roomId, artifactId)
    if (!artifact) {
      throw new DevHotelError('ARTIFACT_NOT_FOUND', 'Screenshot artifact not found in this Room.', {
        recoveryHint: 'List this Room’s artifacts and use an ID from that response.',
        httpStatus: 404
      })
    }
    return artifact
  }

  readRoomArtifactContent(roomId: string, artifactId: string): { artifact: RoomArtifact; content: Buffer } {
    this.mustGet(roomId)
    try {
      return this.artifacts.readContent(roomId, artifactId)
    } catch (error) {
      if (error instanceof Error && /not found in this Room/.test(error.message)) {
        throw new DevHotelError('ARTIFACT_NOT_FOUND', 'Screenshot artifact not found in this Room.', {
          recoveryHint: 'List this Room’s artifacts and use an ID from that response.',
          httpStatus: 404
        })
      }
      throw new DevHotelError('ARTIFACT_CORRUPT', 'Screenshot artifact failed its integrity check.', {
        recoveryHint: 'Capture a fresh screenshot; the stored artifact was not served.',
        cause: error
      })
    }
  }

  captureAndroidScreenshotArtifact(
    roomId: string,
    rawInput: CaptureScreenshotArtifactBody,
    actor: Actor
  ): Promise<RoomArtifact> {
    return this.withRoomLock(roomId, async () => {
      const input = zCaptureScreenshotArtifactBody.parse(rawInput)
      const room = this.mustGet(roomId)
      this.validateScreenshotArtifactAssociationLocked(roomId, input.association)
      // Resolve one exact target before capture. The session retains the
      // physical lease fence; its post-capture status call therefore aborts
      // publication if the phone was handed to a new lease mid-capture.
      const target: AndroidTargetSelector = input.mode === 'screen' ? { kind: 'emulator' } : { kind: 'auto' }
      const releaseCapture = this.devices.beginCapturePermit()
      try {
        const session = await this.openAndroidAutomationSessionLocked(roomId, target)
        return this.captureAndroidScreenshotArtifactWithSessionLocked(room, input, actor, session, undefined, true)
      } finally {
        releaseCapture()
      }
    })
  }

  private validateScreenshotArtifactAssociationLocked(
    roomId: string,
    association: CaptureScreenshotArtifactBody['association']
  ): void {
    if (association?.changeId) {
      const change = this.changes.get(association.changeId)
      if (!change || change.roomId !== roomId) {
        throw new DevHotelError('ARTIFACT_ASSOCIATION_NOT_FOUND', 'Screenshot association was not found in this Room.', {
          recoveryHint: 'Use a change ID from this Room’s change journal.',
          httpStatus: 404
        })
      }
    }
    if (association?.runId && !this.runs.list(roomId).some((run) => run.runId === association.runId)) {
      throw new DevHotelError('ARTIFACT_ASSOCIATION_NOT_FOUND', 'Screenshot association was not found in this Room.', {
        recoveryHint: 'Use a run ID currently returned by list_room_runs for this Room.',
        httpStatus: 404
      })
    }
  }

  private async captureAndroidScreenshotArtifactWithSessionLocked(
    room: RoomRecord,
    input: CaptureScreenshotArtifactBody,
    actor: Actor,
    session: AndroidAutomationSession,
    expectedAppLocale?: {
      applicationId: string
      locale: string
      appliedLocaleTags: readonly string[]
      apiLevel: number
    },
    capturePermitHeld = false
  ): Promise<RoomArtifact> {
    const releaseCapture = capturePermitHeld ? () => {} : this.devices.beginCapturePermit()
    try {
      const capture = await session.withActiveUserScreenWitness(async (signal) => {
        const before = await session.foregroundInstallEvidence(signal)
        if (
          before.seal === null ||
          (expectedAppLocale && before.seal.applicationId !== expectedAppLocale.applicationId)
        ) {
          throw new DevHotelError(
            expectedAppLocale ? 'ANDROID_LOCALE_CAPTURE_CHANGED' : 'SCREENSHOT_APP_NOT_TRACKED',
            expectedAppLocale
              ? 'The locale matrix app no longer owns the exact tracked foreground screen.'
              : 'Screenshot artifacts require an exact tracked foreground Android application.',
            {
              recoveryHint: expectedAppLocale
                ? 'Return to the tracked matrix app and retry the matrix.'
                : 'Install and launch the application with android_run, then capture a fresh artifact.',
              httpStatus: 409
            }
          )
        }
        if (expectedAppLocale) {
          await session.assertAppLocaleCaptureState(
            expectedAppLocale.applicationId,
            expectedAppLocale.appliedLocaleTags,
            expectedAppLocale.apiLevel,
            signal
          )
        }
        const shot = await this.androidScreenshotWithCapturePermit(
          room.id,
          input.mode ?? 'auto',
          session.target,
          signal,
          before.seal.targetKind === 'physical' ? before.seal.leaseId : null
        )
        const capturedAt = new Date().toISOString()
        if (expectedAppLocale) {
          await session.assertAppLocaleCaptureState(
            expectedAppLocale.applicationId,
            expectedAppLocale.appliedLocaleTags,
            expectedAppLocale.apiLevel,
            signal
          )
        }
        const after = await session.foregroundInstallEvidence(signal)
        return { before, after, capturedAt, shot }
      }, { actionTimeoutMs: 120_000 })
      const { after: evidence, before, capturedAt, shot } = capture
      if (evidence.seal === null) {
        throw new DevHotelError(
          expectedAppLocale ? 'ANDROID_LOCALE_CAPTURE_CHANGED' : 'SCREENSHOT_APP_NOT_TRACKED',
          expectedAppLocale
            ? 'The locale matrix app was no longer the exact tracked foreground app after capture.'
            : 'Screenshot artifacts require an exact tracked foreground Android application.',
          {
            recoveryHint: expectedAppLocale
              ? 'Return to the tracked matrix app and retry the matrix.'
              : 'Install and launch the application with android_run, then capture a fresh artifact.',
            httpStatus: 409
          }
        )
      }
      if (
        !sameScreenshotInstallEvidence(before, evidence) ||
        !screenshotInstallEvidenceIsConsistent(evidence) ||
        evidence.context.receipt?.roomId !== room.id ||
        (expectedAppLocale && evidence.seal.applicationId !== expectedAppLocale.applicationId)
      ) {
        throw new DevHotelError(
          expectedAppLocale ? 'ANDROID_LOCALE_CAPTURE_CHANGED' : 'SCREENSHOT_TARGET_CHANGED',
          'Android app context changed while screenshot evidence was captured.',
          { recoveryHint: 'Return to the intended app and capture fresh evidence.' }
        )
      }
      let validated: ReturnType<typeof validateAndSanitizeScreenshotPng>
      try {
        validated = validateAndSanitizeScreenshotPng(decodeScreenshotBase64(shot.png))
      } catch (error) {
        if (error instanceof DevHotelError) throw error
        throw new DevHotelError('SCREENSHOT_INVALID', 'Android capture did not return a valid bounded PNG.', {
          recoveryHint: 'Retry the capture after the Android target is fully ready.',
          cause: error
        })
      }
      const { receipt, status } = evidence.context
      if (!receipt) throw new Error('tracked screenshot evidence lost its receipt')
      // The in-process Room lock cannot exclude a second DevHotel process.
      // Re-read after the screen witness, then let publishScreenshot prove
      // this same revision again under its cross-process write transaction.
      const currentRoom = this.mustGet(room.id)
      if (
        currentRoom.stateRevision !== room.stateRevision ||
        currentRoom.workspaceVolumeRevision !== room.workspaceVolumeRevision
      ) {
        throw new DevHotelError(
          'SCREENSHOT_TARGET_CHANGED',
          'Room state changed while screenshot evidence was captured.',
          { recoveryHint: 'Capture a fresh artifact from the current Room state.' }
        )
      }
      const systemLocale = artifactLocale(status.locale)
      const metadata: AndroidScreenshotArtifactMetadata = {
        schema: 1,
        room: {
          id: room.id,
          stateRevision: room.stateRevision,
          workspaceVolumeRevision: room.workspaceVolumeRevision
        },
        capture: {
          source: shot.source,
          capturedAt,
          width: validated.width,
          height: validated.height,
          orientation: validated.orientation
        },
        device: {
          kind: status.target.kind,
          deviceId: status.target.deviceId,
          model: artifactMetadataText(status.target.model, 200),
          androidVersion: artifactMetadataText(status.target.androidVersion, 64),
          apiLevel: expectedAppLocale?.apiLevel ?? status.target.apiLevel
        },
        app: {
          status: 'tracked-active',
          packageName: receipt.applicationId
        },
        locale: expectedAppLocale
          ? { tag: expectedAppLocale.locale, scope: 'app' }
          : { tag: systemLocale, scope: systemLocale ? 'system' : 'unknown' },
        build: {
          exact: true,
          changeId: receipt.changeId,
          apkSha256: receipt.apkSha256,
          installedAt: receipt.installedAt
        },
        association: {
          changeId: input.association?.changeId ?? null,
          runId: input.association?.runId ?? null
        }
      }
      try {
        return this.artifacts.publishScreenshot({
          roomId: room.id,
          filename: input.filename,
          png: validated.png,
          actor,
          createdAt: capturedAt,
          metadata
        })
      } catch (error) {
        if (error instanceof Error && /artifact quota reached/i.test(error.message)) {
          throw new DevHotelError('ARTIFACT_QUOTA_REACHED', 'This Room’s screenshot artifact quota is full.', {
            recoveryHint: 'Delete the Room when its evidence is no longer needed, or capture in a fresh Room.'
          })
        }
        if (error instanceof Error && /Room revision changed before publication/.test(error.message)) {
          throw new DevHotelError(
            'SCREENSHOT_TARGET_CHANGED',
            'Room state changed before screenshot artifact publication.',
            { recoveryHint: 'Capture a fresh artifact from the current Room state.' }
          )
        }
        throw new DevHotelError('ARTIFACT_STORE_FAILED', 'Screenshot artifact could not be published safely.', {
          recoveryHint: 'Retry the capture; no partial artifact was made visible.',
          cause: error,
          httpStatus: 500
        })
      }
    } finally {
      releaseCapture()
    }
  }

  abandonAndroidLocaleMatrixRecovery(
    roomId: string,
    rawInput: AbandonAndroidLocaleMatrixRecoveryInput
  ): Promise<AbandonAndroidLocaleMatrixRecoveryResult> {
    return this.withRoomLock(roomId, async () => {
      const input = zAbandonAndroidLocaleMatrixRecoveryBody.parse(rawInput)
      const room = this.mustGet(roomId)
      if (room.provider !== 'android') {
        throw new DevHotelError(
          'ANDROID_LOCALE_ABANDON_REFUSED',
          'Android locale recovery can be acknowledged only for an Android Room.',
          { recoveryHint: 'Choose the Android Room that owns the retained locale recovery fence.', httpStatus: 409 }
        )
      }
      const key = pendingAndroidLocaleRestoreKey(roomId)
      const raw = this.settings.get(key)
      const pending = raw === null ? null : parsePendingAndroidLocaleRestore(raw, roomId)
      if (
        raw === null ||
        pending === null ||
        pending.applicationId !== input.applicationId ||
        pending.fence.targetKind !== 'emulator' ||
        pending.attemptedLocaleDispatchStarted ||
        pending.attemptedLocaleOwned
      ) {
        throw new DevHotelError(
          'ANDROID_LOCALE_ABANDON_REFUSED',
          'The retained locale intent is absent, ambiguous, dispatched, owned, or belongs to another application.',
          {
            recoveryHint: 'Do not discard it; restart DevHotel for exact automatic restoration or inspect the matching app and target.',
            httpStatus: 409
          }
        )
      }

      const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      if (!awake || (await this.backend.emulatorState(roomId)) !== 'running') {
        throw new DevHotelError(
          'ANDROID_LOCALE_ABANDON_REFUSED',
          'The exact Room emulator must already be awake and running for read-only acknowledgement.',
          {
            recoveryHint: 'Do not wake, restart or otherwise mutate the retained target through this workflow.',
            httpStatus: 409
          }
        )
      }
      const session = await this.openAndroidAutomationSessionLocked(
        roomId,
        { kind: 'emulator' }
      )
      const proof = await session.proveAppLocaleFinalState(
        pending.applicationId,
        pending.fence,
        30_000
      )
      // No await may separate the final two-pulse target/install/user/PID/
      // locale proof from the exact raw compare-and-delete below.
      const decision = this.abandonPendingAndroidLocaleRestorationIfProvenOutside(
        key,
        raw,
        pending,
        proof
      )
      if (decision === 'cas-changed') {
        throw new DevHotelError(
          'ANDROID_LOCALE_RECOVERY_REQUIRED',
          'The retained Android locale intent changed before its exact acknowledgement could be committed.',
          { recoveryHint: 'Keep the target unchanged and inspect the newer retained recovery state.', httpStatus: 409 }
        )
      }
      if (decision === 'refused') {
        throw new DevHotelError(
          'ANDROID_LOCALE_ABANDON_REFUSED',
          'The current locale is original, expected, attempted, marker-bearing, or otherwise potentially owned by DevHotel.',
          {
            recoveryHint: 'Do not acknowledge this state as external; restart DevHotel for exact automatic restoration.',
            httpStatus: 409
          }
        )
      }
      this.olog(roomId, 'an explicitly acknowledged outside Android locale released one undispatched recovery fence')
      return { abandoned: true, applicationId: pending.applicationId, target: session.target }
    }, { allowPendingAndroidLocaleRestoration: true })
  }

  androidLocaleScreenshotMatrix(
    roomId: string,
    rawInput: AndroidLocaleScreenshotMatrixInput,
    actor: Actor
  ): Promise<AndroidLocaleScreenshotMatrixResult> {
    return this.withRoomLock(roomId, async () => {
      const input = zAndroidLocaleScreenshotMatrixBody.parse(rawInput)
      const captures = input.locales.map((locale) => ({
        locale,
        input: zCaptureScreenshotArtifactBody.parse({
          filename: androidLocaleScreenshotFilename(input.filenamePrefix, locale),
          mode: 'auto',
          ...(input.association ? { association: input.association } : {})
        })
      }))
      const room = this.mustGet(roomId)
      this.validateScreenshotArtifactAssociationLocked(roomId, input.association)
      const timeoutMs = input.readinessTimeoutMs ?? 30_000
      const releaseCapture = this.devices.beginCapturePermit()
      try {
        const session = await this.openAndroidAutomationSessionLocked(
          roomId,
          input.target ?? { kind: 'emulator' }
        )
        const original = await session.appLocaleSnapshot(input.applicationId, timeoutMs)
        if (original.restoreFence.targetKind !== 'emulator') {
          throw new DevHotelError(
            'ANDROID_LOCALE_TARGET_CHANGED',
            'Android locale matrices are restricted to the Room emulator.',
            {
              recoveryHint: 'Choose the managed Room emulator explicitly; physical and auto targets are not supported.',
              httpStatus: 409
            }
          )
        }
        const pendingKey = pendingAndroidLocaleRestoreKey(roomId)
        const initialOperationId = randomUUID()
        const initialAttempt = markedAndroidLocaleAttempt(captures[0]!.locale, initialOperationId)
        let pending: PendingAndroidLocaleRestore = {
          version: 4,
          operationId: initialOperationId,
          stage: 0,
          applicationId: input.applicationId,
          originalLocaleTags: [...original.localeTags],
          expectedLocaleTags: [...original.localeTags],
          attemptedLocaleTags: initialAttempt.localeTags,
          attemptedLocaleOwnershipTag: initialAttempt.ownershipTag,
          attemptedLocaleDispatchStarted: false,
          attemptedLocaleOwned: false,
          fence: original.restoreFence
        }
        let pendingValue = JSON.stringify(pending)
        const inserted = this.settings.setIfAbsent(pendingKey, pendingValue)
        if (!inserted) {
          throw new DevHotelError(
            'ANDROID_LOCALE_RECOVERY_REQUIRED',
            'A prior Android locale matrix still owns this Room recovery fence.',
            {
              recoveryHint: 'Restore the exact target, install, Android user and lease, then restart DevHotel.',
              httpStatus: 409
            }
          )
        }
        const entries: AndroidLocaleScreenshotMatrixResult['entries'] = []
        let primaryFailure: unknown = null
        let preconditionLostBeforeMutation: DevHotelError | null = null
        let expectedLocaleTags: string[] = [...original.localeTags]
        const assertFreshLocaleState = async (expected: readonly string[]) => {
          const fresh = await session.proveAppLocaleFinalState(
            input.applicationId,
            original.restoreFence,
            timeoutMs
          )
          if (
            fresh.apiLevel !== original.apiLevel ||
            !sameStringValues(fresh.localeTags, expected) ||
            !sameAndroidLocaleRestoreFence(fresh.restoreFence, original.restoreFence) ||
            fresh.pids.length === 0
          ) {
            throw new DevHotelError(
              'ANDROID_LOCALE_TARGET_CHANGED',
              'The exact Android locale or tracked install changed after the witnessed action.',
              { recoveryHint: 'Recover only under the retained exact matrix stage; do not overwrite the new state.' }
            )
          }
          return fresh
        }
        const advancePendingStage = (
          expected: readonly string[],
          attempted: readonly string[],
          withOwnershipMarker: boolean
        ): void => {
          const nextOperationId = randomUUID()
          const nextAttempt = withOwnershipMarker
            ? markedAndroidLocaleAttempt(attempted[0]!, nextOperationId)
            : { localeTags: [...attempted], ownershipTag: null }
          const next: PendingAndroidLocaleRestore = {
            ...pending,
            version: 4,
            operationId: nextOperationId,
            stage: pending.stage === Number.MAX_SAFE_INTEGER ? 0 : pending.stage + 1,
            expectedLocaleTags: [...expected],
            attemptedLocaleTags: nextAttempt.localeTags,
            attemptedLocaleOwnershipTag: nextAttempt.ownershipTag,
            attemptedLocaleDispatchStarted: false,
            attemptedLocaleOwned: false
          }
          const nextValue = JSON.stringify(next)
          if (!this.settings.setIfValue(pendingKey, pendingValue, nextValue)) {
            throw new DevHotelError(
              'ANDROID_LOCALE_RECOVERY_REQUIRED',
              'The Android locale recovery stage changed before the next mutation.',
              {
                recoveryHint: 'Keep the exact target connected and restart DevHotel for retained recovery.',
                httpStatus: 409
              }
            )
          }
          pending = next
          pendingValue = nextValue
        }
        const markPendingAttemptedLocaleDispatched = (): undefined => {
          if (pending.attemptedLocaleDispatchStarted) {
            throw new DevHotelError(
              'ANDROID_LOCALE_RECOVERY_REQUIRED',
              'The Android locale recovery stage already recorded a setter dispatch.',
              { recoveryHint: 'Restart DevHotel for exact retained recovery.', httpStatus: 409 }
            )
          }
          const dispatched: PendingAndroidLocaleRestore = {
            ...pending,
            attemptedLocaleDispatchStarted: true
          }
          const dispatchedValue = JSON.stringify(dispatched)
          if (!this.settings.setIfValue(pendingKey, pendingValue, dispatchedValue)) {
            throw new DevHotelError(
              'ANDROID_LOCALE_RECOVERY_REQUIRED',
              'The Android locale recovery stage changed before setter dispatch.',
              {
                recoveryHint: 'No locale setter was started; inspect the retained intent and retry recovery.',
                httpStatus: 409
              }
            )
          }
          pending = dispatched
          pendingValue = dispatchedValue
          return undefined
        }
        const confirmPendingAttemptedLocale = (): undefined => {
          if (!pending.attemptedLocaleDispatchStarted) {
            throw new DevHotelError(
              'ANDROID_LOCALE_RECOVERY_REQUIRED',
              'Android acknowledged a locale mutation before durable dispatch ownership was recorded.',
              { recoveryHint: 'Keep the target unchanged and restart DevHotel for retained recovery.', httpStatus: 409 }
            )
          }
          const confirmed: PendingAndroidLocaleRestore = {
            ...pending,
            attemptedLocaleOwned: true
          }
          const confirmedValue = JSON.stringify(confirmed)
          if (!this.settings.setIfValue(pendingKey, pendingValue, confirmedValue)) {
            throw new DevHotelError(
              'ANDROID_LOCALE_RECOVERY_REQUIRED',
              'The Android locale recovery stage changed before attempted-locale ownership was confirmed.',
              {
                recoveryHint: 'Keep the exact target unchanged and restart DevHotel for retained recovery.',
                httpStatus: 409
              }
            )
          }
          pending = confirmed
          pendingValue = confirmedValue
          return undefined
        }
        try {
          for (const [index, capture] of captures.entries()) {
            const { locale } = capture
            if (index > 0) {
              await assertFreshLocaleState(expectedLocaleTags)
              advancePendingStage(expectedLocaleTags, [locale], true)
            }
            const appliedLocaleTags = [...pending.attemptedLocaleTags]
            const transition = await session.withActiveUserScreenWitness(
              (signal) => session.applyAppLocalesAndWait(
                input.applicationId,
                appliedLocaleTags,
                {
                  timeoutMs,
                  signal,
                  expectedPreviousLocaleTags: expectedLocaleTags,
                  restoreFence: original.restoreFence,
                  onBeforeMutation: markPendingAttemptedLocaleDispatched,
                  onMutationAccepted: confirmPendingAttemptedLocale
                }
              ),
              { actionTimeoutMs: timeoutMs, allowApplicationIdTransitions: input.applicationId }
            )
            if (
              transition.apiLevel !== original.apiLevel ||
              !sameStringValues(transition.previousLocaleTags, expectedLocaleTags) ||
              !sameStringValues(transition.localeTags, appliedLocaleTags) ||
              !sameAndroidLocaleRestoreFence(transition.restoreFence, original.restoreFence)
            ) {
              throw new DevHotelError(
                'ANDROID_LOCALE_TARGET_CHANGED',
                'The exact Android target, install, API or prior locale changed during the locale matrix.',
                { recoveryHint: 'Recover the original target and let DevHotel restore its retained locale intent.' }
              )
            }
            await assertFreshLocaleState(appliedLocaleTags)
            expectedLocaleTags = appliedLocaleTags
            const artifact = await this.captureAndroidScreenshotArtifactWithSessionLocked(
              room,
              capture.input,
              actor,
              session,
              {
                applicationId: input.applicationId,
                locale,
                appliedLocaleTags,
                apiLevel: original.apiLevel
              },
              true
            )
            entries.push({
              locale,
              appliedLocaleTags,
              readiness: transition.readiness,
              process: transition.process,
              artifact
            })
          }
        } catch (error) {
          primaryFailure = error
          if (error instanceof DevHotelError && error.code === 'ANDROID_LOCALE_PRECONDITION_CHANGED') {
            // The stage CAS only records which locale DevHotel is about to
            // attempt. A matching live locale does not prove DevHotel wrote it:
            // another actor may have reached that value after the CAS but
            // before the setter's exact previous-locale check. In that case
            // the setter made no mutation, so treating attemptedLocaleTags as
            // owned and restoring would overwrite the external actor.
            preconditionLostBeforeMutation = error
          }
        }

        if (preconditionLostBeforeMutation) {
          const current = this.rooms.get(roomId)
          if (current && (current.status === 'running' || current.status === 'ready' || current.status === 'attention')) {
            this.rooms.update(roomId, { status: 'attention' })
          }
          throw new DevHotelError(
            'ANDROID_LOCALE_RECOVERY_REQUIRED',
            'The app locale changed before DevHotel could begin its fenced matrix mutation; no automatic restoration was attempted.',
            {
              recoveryHint: 'Do not overwrite the current locale; inspect the exact target and resolve the retained recovery intent explicitly.',
              cause: preconditionLostBeforeMutation,
              httpStatus: 409,
              evidence: {
                stage: 'precondition',
                primaryFailureCode: preconditionLostBeforeMutation.code
              }
            }
          )
        }

        let restoration: AndroidLocaleScreenshotMatrixResult['restoration'] | null = null
        try {
          const beforeRestore = await session.proveAppLocaleFinalState(
            input.applicationId,
            original.restoreFence,
            timeoutMs
          )
          const isOriginal = sameStringValues(beforeRestore.localeTags, original.localeTags)
          const ownsCurrent = pendingAndroidLocaleOwnsCurrent(pending, beforeRestore.localeTags)
          if (
            beforeRestore.apiLevel !== original.apiLevel ||
            !sameAndroidLocaleRestoreFence(beforeRestore.restoreFence, original.restoreFence) ||
            beforeRestore.pids.length === 0 ||
            (!isOriginal && !ownsCurrent)
          ) {
            throw new Error('Android locale is outside the exact retained matrix stage')
          }
          if (isOriginal) {
            const restored = await session.withActiveUserScreenWitness(
              (signal) => session.restoreAppLocalesFromFence(
                input.applicationId,
                original.localeTags,
                original.restoreFence,
                original.localeTags,
                original.localeTags,
                { timeoutMs, signal }
              ),
              { actionTimeoutMs: timeoutMs, allowApplicationIdTransitions: input.applicationId }
            )
            if (
              restored.apiLevel !== original.apiLevel ||
              !sameStringValues(restored.previousLocaleTags, original.localeTags) ||
              !sameStringValues(restored.localeTags, original.localeTags) ||
              !sameAndroidLocaleRestoreFence(restored.restoreFence, original.restoreFence) ||
              restored.pids.length === 0 ||
              restored.readiness.application !== 'foreground' ||
              restored.readiness.localeService !== 'ready' ||
              restored.readiness.process !== 'running'
            ) {
              throw new Error('Android locale original-state readiness proof changed')
            }
            const finalRestored = await assertFreshLocaleState(original.localeTags)
            restoration = {
              localeTags: [...original.localeTags],
              readiness: { ...restored.readiness, pids: [...finalRestored.pids] }
            }
            if (!this.deletePendingAndroidLocaleRestorationIfOwned(pendingKey, pendingValue, pending)) {
              throw new Error('Android locale original-state intent ownership changed before completion')
            }
          } else {
            advancePendingStage(beforeRestore.localeTags, original.localeTags, false)
            const restored = await session.withActiveUserScreenWitness(
              (signal) => session.restoreAppLocalesFromFence(
                input.applicationId,
                original.localeTags,
                original.restoreFence,
                pending.expectedLocaleTags,
                pending.attemptedLocaleTags,
                {
                  timeoutMs,
                  signal,
                  onBeforeMutation: markPendingAttemptedLocaleDispatched,
                  onMutationAccepted: confirmPendingAttemptedLocale
                }
              ),
              { actionTimeoutMs: timeoutMs, allowApplicationIdTransitions: input.applicationId }
            )
            if (
              restored.apiLevel !== original.apiLevel ||
              !sameStringValues(restored.localeTags, original.localeTags) ||
              !sameAndroidLocaleRestoreFence(restored.restoreFence, original.restoreFence) ||
              restored.pids.length === 0 ||
              restored.readiness.application !== 'foreground' ||
              restored.readiness.localeService !== 'ready' ||
              restored.readiness.process !== 'running'
            ) {
              throw new Error('Android locale restoration proof changed')
            }
            const finalRestored = await assertFreshLocaleState(original.localeTags)
            restoration = {
              localeTags: [...original.localeTags],
              readiness: { ...restored.readiness, pids: [...finalRestored.pids] }
            }
            if (!this.deletePendingAndroidLocaleRestorationIfOwned(pendingKey, pendingValue, pending)) {
              throw new Error('Android locale restoration intent ownership changed before completion')
            }
          }
        } catch (restoreFailure) {
          const current = this.rooms.get(roomId)
          if (current && (current.status === 'running' || current.status === 'ready' || current.status === 'attention')) {
            this.rooms.update(roomId, { status: 'attention' })
          }
          throw new DevHotelError(
            'ANDROID_LOCALE_RESTORE_FAILED',
            'The locale matrix did not prove and release the original app-locale ready state.',
            {
              recoveryHint: 'Keep the exact target connected and restart DevHotel so the retained recovery intent can run.',
              cause: new AggregateError([primaryFailure, restoreFailure].filter(Boolean)),
              evidence: {
                stage: 'restore',
                primaryFailureCode: primaryFailure instanceof DevHotelError ? primaryFailure.code : null,
                restoreFailureCode: restoreFailure instanceof DevHotelError ? restoreFailure.code : null
              }
            }
          )
        }
        if (primaryFailure) throw primaryFailure
        if (!restoration) throw new Error('locale matrix completed without a restoration proof')
        return {
          target: session.target,
          applicationId: input.applicationId,
          apiLevel: original.apiLevel,
          scope: 'app',
          entries,
          restoration
        }
      } finally {
        releaseCapture()
      }
    })
  }

  exportRoomArtifact(
    roomId: string,
    artifactId: string,
    rawInput: { relativePath: string },
    _actor: Actor
  ): Promise<ArtifactExportResult> {
    return this.withRoomLock(roomId, async () => {
      const input = zArtifactExportBody.parse(rawInput)
      const room = this.mustGet(roomId)
      if (room.workspaceMode !== 'hotel') {
        throw new DevHotelError(
          'ARTIFACT_EXPORT_NOT_ALLOWED',
          'Artifacts can be exported only into a Hotel-owned project workspace.',
          {
            recoveryHint: 'Move a legacy linked Room into the Hotel before exporting; Host paths are never accepted.',
            httpStatus: 403
          }
        )
      }
      const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      if (!awake) {
        throw new DevHotelError('ROOM_RUNTIME_NOT_RUNNING', 'Wake the Room before exporting an artifact.', {
          recoveryHint: 'Start the Room, wait for it to finish waking, then retry the export.'
        })
      }
      const { artifact, content } = this.readRoomArtifactContent(roomId, artifactId)
      const runtimeSpec = this.webSpecFor(room)
      const targetPath = `/workspace/${input.relativePath}`
      const { root: temporaryRoot, temporary, hostFile } = (() => {
        try {
          return this.createArtifactExportStaging(content)
        } catch (error) {
          throw new DevHotelError('ARTIFACT_EXPORT_FAILED', 'Artifact could not be staged for safe export.', {
            recoveryHint: 'Check Hotel storage health and retry with a new repository-relative destination.',
            httpStatus: 500,
            cause: error
          })
        }
      })()
      let pauseAttempted = false
      let webFence: RoomArtifactWebRuntimeFence | null = null
      let publicationCommitted = false
      let publicationAmbiguous = false
      let pendingIntentStored = false
      let runtimeRestoreUnsafe = false
      let runtimeContained = false
      let expectedRecoveryStateRevision = room.stateRevision
      let primaryError: unknown
      let stagingCleanupError: unknown
      const containmentErrors: unknown[] = []
      const pendingKey = pendingArtifactExportKey(roomId)
      const stageToken = randomUUID().replaceAll('-', '')
      const pendingValue = JSON.stringify({
        version: 1,
        workspaceVolumeRevision: room.workspaceVolumeRevision,
        relativePath: input.relativePath,
        expected: { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
        stageToken
      } satisfies PendingArtifactExport)
      const containRuntime = async (): Promise<void> => {
        if (runtimeContained) return
        runtimeContained = true
        containmentErrors.push(...await this.containArtifactExportRuntime(room))
      }
      try {
        // Own the durable recovery fence before the first runtime mutation.
        // A second process that claimed it after this operation entered the
        // in-process Room lock must remain byte-for-byte authoritative, and
        // this process must not pause or later restore that owner's runtime.
        if (!this.settings.setIfAbsent(pendingKey, pendingValue)) {
          throw new DevHotelError(
            'ARTIFACT_EXPORT_RECOVERY_REQUIRED',
            'A prior artifact export still owns this Room recovery fence.',
            {
              recoveryHint: 'Restart DevHotel after the isolation backend is healthy; do not retry this destination meanwhile.',
              httpStatus: 409
            }
          )
        }
        pendingIntentStored = true
        try {
          // Bind the export to the exact immutable web container and runtime
          // specification before making the first runtime mutation. A
          // conventional-name replacement must never inherit this fence.
          webFence = await this.backend.captureRoomArtifactWebFence(runtimeSpec)
        } catch (error) {
          runtimeRestoreUnsafe = true
          throw new DevHotelError(
            'ARTIFACT_EXPORT_FENCE_CHANGED',
            'Artifact export could not identify the exact Room workspace runtime.',
            {
              recoveryHint: 'Restart the Room runtime and retry with a new destination path.',
              cause: error
            }
          )
        }
        pauseAttempted = true
        try {
          await this.backend.pauseRoomArtifactWeb(runtimeSpec, webFence)
        } catch (error) {
          throw new DevHotelError(
            'ARTIFACT_EXPORT_FENCE_CHANGED',
            'Artifact export could not establish an exact paused Room workspace.',
            {
              recoveryHint: 'Restore the Room runtime and retry with a new destination path.',
              cause: error
            }
          )
        }
        const fencedRoom = this.mustGet(roomId)
        if (
          fencedRoom.workspaceVolumeRevision !== room.workspaceVolumeRevision ||
          fencedRoom.stateRevision !== room.stateRevision
        ) {
          // A concurrently admitted operation may have advanced the durable
          // Room pointer while this exact old runtime was paused. Never resume
          // that stale generation or release its recovery gate.
          runtimeRestoreUnsafe = true
          throw new DevHotelError(
            'ARTIFACT_EXPORT_FENCE_CHANGED',
            'Room workspace generation changed before artifact publication.',
            { recoveryHint: 'Retry the export against the current Room state.' }
          )
        }
        await this.backend.publishRoomArtifact(
          roomId,
          room.workspaceVolumeRevision,
          hostFile,
          input.relativePath,
          { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
          stageToken,
          webFence
        )
        publicationCommitted = true
        // The controlled helper resolves only after exact publication and
        // response-loss reconciliation. Record the real workspace mutation
        // before any fallible runtime resume step. This is a cross-process CAS:
        // never increment a newer Room record after publishing into the old
        // workspace generation.
        try {
          if (!this.rooms.markWorkspaceModifiedIfRevision({
            roomId,
            expectedWorkspaceVolumeRevision: room.workspaceVolumeRevision,
            expectedStateRevision: room.stateRevision
          })) {
            throw new Error('Room workspace revision changed during artifact publication')
          }
          expectedRecoveryStateRevision = room.stateRevision + 1
        } catch (revisionError) {
          runtimeRestoreUnsafe = true
          throw revisionError
        }
      } catch (error) {
        publicationAmbiguous = error instanceof RoomArtifactPublicationError &&
          error.reason === 'publication-ambiguous'
        primaryError = error
      }
      if (publicationAmbiguous || runtimeRestoreUnsafe) await containRuntime()
      try {
        if (!this.cleanupArtifactExportStagingDirectory(temporaryRoot, temporary)) {
          throw new Error('Private artifact staging directory could not be proven safe to remove')
        }
      } catch (error) {
        stagingCleanupError = error
      }

      if (publicationAmbiguous || runtimeRestoreUnsafe) await containRuntime()

      // Publication and cleanup can let an already-admitted second process
      // advance the Room record. Re-read its durable fence at the last point
      // before runtime restoration so the old generation is never resumed.
      if (pauseAttempted && !publicationAmbiguous && !runtimeRestoreUnsafe) {
        try {
          const recoveryRoom = this.rooms.get(roomId)
          if (
            recoveryRoom === null ||
            recoveryRoom.workspaceVolumeRevision !== room.workspaceVolumeRevision ||
            recoveryRoom.stateRevision !== expectedRecoveryStateRevision
          ) {
            throw new Error('Room workspace revision changed before runtime restoration')
          }
        } catch (revisionProofError) {
          runtimeRestoreUnsafe = true
          primaryError = new AggregateError(
            [...(primaryError ? [primaryError] : []), revisionProofError],
            'Artifact export runtime fence was unavailable before restoration'
          )
          await containRuntime()
        }
      }

      let runtimeRecoveryError: unknown
      if (pauseAttempted && !runtimeRestoreUnsafe && !publicationAmbiguous) {
        try {
          if (!webFence) throw new Error('Room artifact runtime fence was not retained')
          await this.backend.restoreRoomArtifactWeb(runtimeSpec, webFence)
          const restoredRoom = this.rooms.get(roomId)
          if (
            restoredRoom === null ||
            restoredRoom.workspaceVolumeRevision !== room.workspaceVolumeRevision ||
            restoredRoom.stateRevision !== expectedRecoveryStateRevision
          ) {
            throw new Error('Room workspace revision changed while restoring the artifact runtime')
          }
        } catch (error) {
          runtimeRecoveryError = error
        }
      }

      if (runtimeRecoveryError) {
        await containRuntime()
        if (publicationCommitted) {
          throw new DevHotelError(
            'ARTIFACT_EXPORT_COMMITTED_RUNTIME_FAILED',
            'Artifact export was committed, but the Room runtime could not be restored safely.',
            {
              recoveryHint: 'Do not retry the same path. Restart the Room, then inspect the committed repository-relative destination.',
              cause: new AggregateError(
                [
                  runtimeRecoveryError,
                  ...(primaryError ? [primaryError] : []),
                  ...(stagingCleanupError ? [stagingCleanupError] : []),
                  ...containmentErrors
                ],
                'Artifact export committed before runtime recovery failed'
              ),
              evidence: { committed: true, retrySafe: false, relativePath: input.relativePath }
            }
          )
        }
        throw new DevHotelError(
          'ARTIFACT_EXPORT_RUNTIME_FAILED',
          'Artifact export was withheld and the Room runtime could not be restored safely.',
          {
            recoveryHint: 'Restart the Room before retrying the export with a new destination path.',
            cause: new AggregateError(
              [
                runtimeRecoveryError,
                ...(primaryError ? [primaryError] : []),
                ...(stagingCleanupError ? [stagingCleanupError] : []),
                ...containmentErrors
              ],
              'Artifact export failed before runtime recovery'
            ),
            evidence: { committed: false, retrySafe: false }
          }
        )
      }

      if (pendingIntentStored && !runtimeRestoreUnsafe && !publicationAmbiguous) {
        try {
          // Keep the durable mutation gate until runtime recovery is proved.
          // If the final CAS cannot release this exact ownership, contain the
          // now-unpaused runtime while the retained value blocks new work.
          if (!this.settings.deleteIfValueAndRoomRevision(
            pendingKey,
            pendingValue,
            roomId,
            room.workspaceVolumeRevision,
            expectedRecoveryStateRevision
          )) {
            throw new Error('Artifact export recovery intent ownership changed before completion')
          }
          pendingIntentStored = false
        } catch (intentError) {
          if (publicationCommitted) {
            runtimeRestoreUnsafe = true
            primaryError = new AggregateError(
              [...(primaryError ? [primaryError] : []), intentError],
              'Artifact publication committed but its durable recovery intent could not be released'
            )
          } else {
            publicationAmbiguous = true
            primaryError = new AggregateError(
              [...(primaryError ? [primaryError] : []), intentError],
              'Artifact publication failed safely but its durable recovery intent could not be cleared'
            )
          }
        }
      }
      if (publicationAmbiguous || runtimeRestoreUnsafe) await containRuntime()

      if (publicationAmbiguous) {
        throw new DevHotelError(
          'ARTIFACT_EXPORT_PUBLICATION_AMBIGUOUS',
          'Artifact export could not prove whether publication completed, so the Room was not resumed.',
          {
            recoveryHint: 'Do not retry the same path. Restart DevHotel, then inspect the Room before further work.',
            cause: new AggregateError(
              [
                primaryError,
                ...(stagingCleanupError ? [stagingCleanupError] : []),
                ...containmentErrors
              ],
              'Artifact export publication could not be reconciled exactly'
            ),
            evidence: { committed: null, retrySafe: false, relativePath: input.relativePath }
          }
        )
      }

      if (publicationCommitted && (primaryError || stagingCleanupError)) {
        throw new DevHotelError(
          'ARTIFACT_EXPORT_COMMITTED_CLEANUP_FAILED',
          'Artifact export was committed, but its private staging cleanup or state update failed.',
          {
            recoveryHint: 'Do not retry the same path. Inspect the committed repository-relative destination.',
            cause: new AggregateError(
              [
                ...(primaryError ? [primaryError] : []),
                ...(stagingCleanupError ? [stagingCleanupError] : []),
                ...containmentErrors
              ],
              'Artifact export committed with a local cleanup failure'
            ),
            evidence: { committed: true, retrySafe: false, relativePath: input.relativePath }
          }
        )
      }
      if (primaryError || stagingCleanupError) {
        throw this.roomArtifactExportError(
          primaryError ?? new Error('Private artifact staging cleanup failed'),
          stagingCleanupError
        )
      }
      return {
        artifactId: artifact.id,
        path: targetPath,
        relativePath: input.relativePath,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        markdown: `![${artifact.filename}](${input.relativePath})`
      }
    })
  }

  private async containArtifactExportRuntime(room: RoomRecord): Promise<unknown[]> {
    const errors: unknown[] = []
    try {
      // Revoke ingress before any fallible backend or database containment.
      this.gateway.removeRoute(room.domain)
    } catch (error) {
      errors.push(error)
    }
    try {
      this.logs.detach(room.id)
    } catch (error) {
      errors.push(error)
    }
    try {
      // Publication or recovery may already have exposed an untrusted writer.
      // Invalidate the generation and disable the persisted Room before return.
      this.markWorkspaceAmbiguous(room.id)
    } catch (error) {
      errors.push(error)
    }
    try {
      await this.backend.stopRoomPod(room.id)
    } catch (error) {
      errors.push(error)
    }
    try {
      // A created/exited helper remains restartable with a RW workspace mount.
      // Remove only this Room's jobs and prove that the role is absent.
      const jobs = (await this.backend.listManagedContainers()).filter(
        (container) => container.roomId === room.id && container.role === 'job'
      )
      for (const job of jobs) await this.backend.removeManagedContainer(job.name)
      const retained = (await this.backend.listManagedContainers()).filter(
        (container) => container.roomId === room.id && container.role === 'job'
      )
      if (retained.length > 0) throw new Error('Room artifact helper containment is incomplete')
    } catch (error) {
      errors.push(error)
    }
    return errors
  }

  private roomArtifactExportError(primary: unknown, cleanup?: unknown): DevHotelError {
    if (primary instanceof DevHotelError && !cleanup) return primary
    const cause = cleanup
      ? new AggregateError([primary, cleanup], 'Artifact export and private staging cleanup both failed')
      : primary
    if (cleanup) {
      return new DevHotelError(
        'ARTIFACT_EXPORT_FAILED',
        'Artifact export was withheld, but its private staging cleanup also failed.',
        {
          recoveryHint: 'Check Hotel storage health before retrying with a new repository-relative destination.',
          httpStatus: 500,
          cause
        }
      )
    }
    if (primary instanceof RoomArtifactPublicationError) {
      if (primary.reason === 'destination-exists') {
        return new DevHotelError(
          'ARTIFACT_DESTINATION_EXISTS',
          'Artifact export destination already exists.',
          {
            recoveryHint: 'Choose a new repo-relative .png path; exports never overwrite project files.',
            cause
          }
        )
      }
      if (primary.reason === 'unsafe-parent' || primary.reason === 'invalid-input') {
        return new DevHotelError(
          'ARTIFACT_EXPORT_UNSAFE_PATH',
          'Artifact export path contains an unsafe directory or value.',
          {
            recoveryHint: 'Create the destination parent directory inside the Room, then choose a new repo-relative .png path beneath existing regular workspace directories.',
            httpStatus: 400,
            cause
          }
        )
      }
      if (primary.reason === 'fence-changed') {
        return new DevHotelError(
          'ARTIFACT_EXPORT_FENCE_CHANGED',
          'Artifact export lost its exact paused Room workspace fence.',
          { recoveryHint: 'Restore the Room runtime and retry with a new destination path.', cause }
        )
      }
    }
    return new DevHotelError(
      'ARTIFACT_EXPORT_FAILED',
      'Artifact could not be exported safely.',
      {
        recoveryHint: 'Restore the Room runtime and retry with a new repository-relative destination.',
        httpStatus: 500,
        cause
      }
    )
  }

  /**
   * Phone screen as base64 PNG. 'auto' prefers the sharp guest-side screencap;
   * 'screen' grabs the X display instead, which also shows FLAG_SECURE apps
   * (exactly what the preview shows).
   */
  // ---------------------------------------------------------------------------
  // Shared Android devices
  //
  // A USB phone is Hotel infrastructure shared by every Room, so the Room-facing
  // API is deliberately narrow: attach, release, heartbeat, and "run this on
  // whatever is attached". Rooms never name a serial, and never reach the phone
  // except through the broker's lease check.
  // ---------------------------------------------------------------------------

  refreshAndroidDevices(): Promise<ReturnType<AndroidDeviceBroker['listDevices']>> {
    return this.devices.refreshInventory()
  }

  androidDeviceStatus(): DeviceBrokerStatus {
    return this.devices.status()
  }

  /** Ask for a phone for this Room. Returns a lease, or a place in the queue. */
  async attachAndroidDevice(
    roomId: string,
    request: Omit<DeviceRequest, 'roomId' | 'project'> & { project?: string }
  ): Promise<DeviceRequestResult> {
    return this.withRoomLock(roomId, () => this.attachAndroidDeviceLocked(roomId, request))
  }

  private async attachAndroidDeviceLocked(
    roomId: string,
    request: Omit<DeviceRequest, 'roomId' | 'project'> & { project?: string }
  ): Promise<DeviceRequestResult> {
    const room = this.mustGet(roomId)
    if (room.provider !== 'android') throw new Error('Only Android Rooms can attach an Android device')
    if (room.status === 'sleeping' || room.status === 'broken') {
      throw new Error('Wake the Android Room before attaching a physical device')
    }
    const result = await this.devices.requestDevice({ ...request, roomId, project: request.project ?? room.project })
    this.olog(
      roomId,
      result.state === 'granted'
        ? `attached device ${result.device.nickname} for ${request.purpose}`
        : `queued for a device (#${result.position}): ${result.reason}`
    )
    this.emit(roomId, 'status')
    return result
  }

  releaseAndroidDevice(roomId: string, reason = 'released by the Room'): Promise<DeviceLease | null> {
    return this.withRoomLock(
      roomId,
      () => this.releaseAndroidDeviceLocked(roomId, reason),
      { allowPendingArtifactExport: true }
    )
  }

  private async releaseAndroidDeviceLocked(roomId: string, reason: string): Promise<DeviceLease | null> {
    const released = await this.devices.releaseRoom(roomId, reason)
    if (released) {
      this.olog(roomId, `released the attached device: ${reason}`)
      this.emit(roomId, 'status')
    }
    return released?.lease ?? null
  }

  heartbeatAndroidDevice(leaseId: string, opts: { busy?: boolean } = {}): DeviceLease {
    return this.devices.heartbeat(leaseId, opts)
  }

  cancelAndroidDeviceRequest(requestId: string): DeviceQueueEntry {
    return this.devices.cancelRequest(requestId)
  }

  setAndroidDeviceNickname(deviceId: string, nickname: string): ReturnType<AndroidDeviceBroker['setNickname']> {
    return this.devices.setNickname(deviceId, nickname)
  }

  /** Reclaim phones from dead owners; the desktop app calls this on a timer. */
  reapAndroidDevices(): ReturnType<AndroidDeviceBroker['reap']> {
    return this.devices.reap()
  }

  androidAutomationStatus(
    roomId: string,
    target: AndroidTargetSelector = { kind: 'auto' }
  ): Promise<AndroidAutomationStatus> {
    return this.withRoomLock(roomId, () => this.androidAutomationStatusLocked(roomId, target))
  }

  /** Trusted Core composition point for a caller that already owns the Room lock. */
  private async androidAutomationStatusLocked(
    roomId: string,
    target: AndroidTargetSelector = { kind: 'auto' }
  ): Promise<AndroidAutomationStatus> {
    this.assertRoomLockHeld(roomId)
    return (await this.openAndroidAutomationSessionLocked(roomId, target)).status()
  }

  /**
   * Trusted lock-held composition for screenshot/report workflows. It resolves
   * one exact session and returns only a tracked foreground receipt; raw serial
   * and the captured physical lease ID stay inside Core. A workflow attaching
   * metadata to already-captured evidence must instead open the session before
   * capture and call `session.foregroundInstallContext()` afterwards, so a
   * mid-capture physical lease replacement throws rather than becoming null.
   */
  private async androidForegroundInstallReceiptLocked(
    roomId: string,
    target: AndroidTargetSelector = { kind: 'auto' }
  ): Promise<AndroidForegroundInstallContext> {
    this.assertRoomLockHeld(roomId)
    return (await this.openAndroidAutomationSessionLocked(roomId, target)).foregroundInstallContext()
  }

  androidLaunchApp(roomId: string, input: AndroidLaunchAppInput): Promise<AndroidLaunchResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.launch(input.applicationId, input.activity, input.extras)
    })
  }

  androidForceStop(roomId: string, input: AndroidForceStopInput): Promise<AndroidForceStopResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.forceStop(input.applicationId)
    })
  }

  androidWaitForText(roomId: string, input: AndroidWaitForTextInput): Promise<AndroidWaitForTextResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.waitForText(input)
    })
  }

  androidTapText(roomId: string, input: AndroidTapTextInput): Promise<AndroidTapTextResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.tapText(input)
    })
  }

  androidDumpUi(roomId: string, input: AndroidDumpUiInput): Promise<AndroidUiDumpResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.dumpUi(input)
    })
  }

  androidLogcat(roomId: string, input: AndroidLogcatInput): Promise<AndroidLogcatResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.logcat(input)
    })
  }

  androidRunCrashScenario(
    roomId: string,
    input: AndroidRunCrashScenarioInput
  ): Promise<AndroidCrashScenarioResult> {
    return this.withRoomLock(roomId, async () => {
      const session = await this.openAndroidAutomationSessionLocked(roomId, input.target ?? { kind: 'auto' })
      return session.crashScenario(input)
    })
  }

  /**
   * Open one target while the caller already owns the Room lock. This method
   * never reacquires that lock, captures one exact physical lease, and gives
   * future internal workflows bounded app-scoped methods rather than raw adb.
   */
  private async openAndroidAutomationSessionLocked(
    roomId: string,
    selector: AndroidTargetSelector,
    options: { allowPendingRecovery?: boolean } = {}
  ): Promise<AndroidAutomationSession> {
    this.assertRoomLockHeld(roomId)
    const room = this.mustGet(roomId)
    if (room.provider !== 'android') {
      throw new DevHotelError('ANDROID_ROOM_REQUIRED', 'Android automation is available only for Android Rooms.', {
        recoveryHint: 'Choose an Android Room.', httpStatus: 409
      })
    }
    const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
    if (!awake && !options.allowPendingRecovery) {
      throw new DevHotelError('ANDROID_ROOM_ASLEEP', 'Wake the Android Room before driving its target.', {
        recoveryHint: 'Start the Room, wait for the target to become ready, and retry.', httpStatus: 409
      })
    }

    const attached = this.devices.deviceForRoom(roomId)
    const usePhysical = selector.kind === 'physical' || (selector.kind === 'auto' && attached !== null)
    if (usePhysical) {
      if (!attached) {
        throw new DevHotelError('ANDROID_PHYSICAL_NOT_ATTACHED', 'This Room has no attached physical Android target.', {
          recoveryHint: 'Attach a physical device lease, or explicitly select the Room emulator.', httpStatus: 409
        })
      }
      if (selector.kind === 'physical' && selector.deviceId && selector.deviceId !== attached.id) {
        throw new DevHotelError('ANDROID_TARGET_MISMATCH', 'The requested opaque device is not attached to this Room.', {
          recoveryHint: 'Inspect the device broker and attach the intended device first.', httpStatus: 409
        })
      }
      const captured = this.devices.authorizeInternalOperation(
        roomId,
        attached.id,
        'opening the high-level Android automation session'
      )
      if (!captured.leaseId) {
        throw new DevHotelError('ANDROID_PHYSICAL_NOT_LEASED', 'The selected physical Android target has no exclusive Room lease.', {
          recoveryHint: 'Attach the physical device before running acceptance automation.', httpStatus: 409
        })
      }
      const expectedLeaseId = captured.leaseId
      const target = {
        kind: 'physical' as const,
        deviceId: captured.device.id,
        nickname: captured.device.nickname,
        model: captured.device.model,
        androidVersion: captured.device.androidVersion,
        apiLevel: captured.device.apiLevel
      }
      return new AndroidAutomationSession({
        roomId,
        target,
        installTarget: {
          kind: 'physical',
          targetId: captured.device.id,
          deviceId: captured.device.id,
          leaseId: expectedLeaseId
        },
        installs: this.androidInstalls,
        exec: async (args, opts) => {
          const authorized = this.devices.authorizeInternalOperation(
            roomId,
            attached.id,
            'running the high-level Android automation command',
            expectedLeaseId
          )
          const executableArgs = protectAndroidRemoteCommand(args)
          const result = await this.withDeviceHeartbeat(roomId, attached.id, expectedLeaseId, (signal) =>
            this.devices.hostAdb.exec(authorized.serial, executableArgs, {
              timeoutMs: opts?.timeoutMs,
              signal,
              maxStdoutBytes: opts?.maxStdoutBytes,
              maxStderrBytes: opts?.maxStderrBytes,
              onStdout: opts?.onStdout,
              onStderr: opts?.onStderr
            }),
            true,
            opts?.signal
          )
          return redactAdbResult(result, authorized.serial)
        }
      })
    }

    if (!options.allowPendingRecovery && (await this.backend.emulatorState(roomId)) !== 'running') {
      throw new DevHotelError('ANDROID_EMULATOR_NOT_RUNNING', 'The Room emulator is not running.', {
        recoveryHint: 'Restart the Android Room and wait for its emulator container.', httpStatus: 409
      })
    }
    const version = room.android?.version ?? EMULATOR_DEFAULT_VERSION
    const target = {
      kind: 'emulator' as const,
      deviceId: null,
      nickname: 'Room emulator',
      model: room.android?.device ?? EMULATOR_DEFAULT_DEVICE,
      androidVersion: version,
      apiLevel: emulatorApiLevel(version)
    }
    return new AndroidAutomationSession({
      roomId,
      target,
      installTarget: { kind: 'emulator', targetId: roomId, deviceId: null },
      installs: this.androidInstalls,
      exec: async (args, opts) => {
        const exec = options.allowPendingRecovery
          ? this.backend.execFencedEmulatorRecoveryAdb.bind(this.backend)
          : this.backend.execFencedEmulatorAdb.bind(this.backend)
        const result = await exec(
          roomId,
          protectAndroidRemoteCommand(args),
          {
            timeoutMs: opts?.timeoutMs,
            signal: opts?.signal,
            maxStdoutBytes: opts?.maxStdoutBytes,
            maxStderrBytes: opts?.maxStderrBytes,
            onStdout: opts?.onStdout,
            onStderr: opts?.onStderr
          }
        )
        return {
          ...result,
          code: result.outputLimitExceeded === true ? -1 : result.code,
          stderr: `${result.stderr}${result.outputLimitExceeded === true
            ? '\nAndroid emulator command output exceeded its safety limit.'
            : ''}`
        }
      }
    })
  }

  /**
   * Where a Room's Android automation should point.
   *
   * This is the whole reason a high-level primitive never has to write a serial:
   * a Room with a phone attached targets that phone, and a Room without one
   * targets its own emulator. Attaching a device changes what `android-run` and
   * screenshots drive, with nothing else in the caller changing.
   */
  async resolveAdbTarget(roomId: string): Promise<{ kind: 'physical' | 'emulator'; deviceId: string | null; nickname: string }> {
    const room = this.mustGet(roomId)
    if (room.provider !== 'android') throw new Error('Only Android Rooms have an ADB target')
    const device = this.devices.deviceForRoom(roomId)
    if (device) {
      // Keep an attached physical target sticky. An offline/unauthorized phone
      // or a just-revoked disconnect is an acceptance failure, never permission
      // to silently use the Room emulator and report success against the wrong
      // device. Explicit release clears the disconnected target.
      const authorized = this.devices.authorizeInternalOperation(roomId, device.id, 'checking the attached physical device')
      return { kind: 'physical', deviceId: authorized.device.id, nickname: authorized.device.nickname }
    }
    return { kind: 'emulator', deviceId: null, nickname: 'Room emulator' }
  }

  /**
   * Run an ADB command against the Room's attached phone, through the lease
   * check. An interfering command from a Room that does not hold the lease is
   * refused here — before anything reaches the device.
   */
  adbOnDevice(roomId: string, args: string[], opts: { deviceId?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.withRoomLock(roomId, () => this.adbOnDeviceLocked(roomId, args, opts))
  }

  private async adbOnDeviceLocked(
    roomId: string,
    args: string[],
    opts: { deviceId?: string; timeoutMs?: number } = {},
    internal?: { reason: string; expectedLeaseId: string }
  ): Promise<ExecResult> {
    const room = this.mustGet(roomId)
    if (room.provider !== 'android') throw new Error('Only Android Rooms can use a physical Android device')
    const verb = args[0]
    if (!verb) throw new Error('Pass an ADB command without the leading adb executable')
    // The command must be first. This closes both split (`-s SERIAL`) and
    // attached (`-sSERIAL`, `--one-device=SERIAL`) selector variants without
    // rejecting command-local flags such as `adb install -t`.
    if (verb.startsWith('-')) {
      throw new Error('ADB global and target-selector options are owned by the Device Broker and cannot be supplied by a Room')
    }
    if (ADB_UNSAFE_HOST_FILE_VERBS.has(verb) || verb === 'bugreport') {
      throw new Error(`adb ${verb} exposes a Host filesystem path and is not available through the Device Broker`)
    }
    // Select synchronously, then let the first authorization capture the exact
    // lease ID. Awaiting a separate target probe here would let release +
    // reacquire by the same Room substitute a new lease under a stale call.
    const target = { deviceId: opts.deviceId ?? this.devices.deviceForRoom(roomId)?.id ?? null }
    if (!target.deviceId) {
      throw new Error('This Room has no physical Android device attached. Use run_in_room for its own emulator.')
    }
    const authorize = (argv: string[], expectedLeaseId?: string | null): ReturnType<AndroidDeviceBroker['authorize']> =>
      internal
        ? this.devices.authorizeInternalOperation(roomId, target.deviceId!, internal.reason, internal.expectedLeaseId)
        : this.devices.authorize(roomId, target.deviceId!, argv, expectedLeaseId)
    // Refuse an unleased writer before copying any Room bytes into Host staging.
    const capturedAuthorization = authorize(args, internal?.expectedLeaseId)
    const capturedLeaseId = internal?.expectedLeaseId ?? capturedAuthorization.leaseId
    let stagedDir: string | null = null
    const outputReplacements: AdbOutputReplacement[] = []
    const executableArgs = [...args]
    try {
      if (ADB_INSTALL_VERBS.has(verb)) {
        const workspaceInputs: { arg: string; index: number }[] = []
        for (let index = 1; index < args.length; index++) {
          const arg = args[index]!
          if (arg.startsWith('/workspace/')) {
            workspaceInputs.push({ arg, index })
            continue
          }
          if (ADB_INSTALL_BOOLEAN_FLAGS.has(arg)) continue
          if (ADB_INSTALL_VALUE_FLAGS.has(arg)) {
            const value = args[++index]
            if (!value || value.startsWith('-') || /[\\/]/.test(value) || value.startsWith('@')) {
              throw new Error(`adb ${verb} option ${arg} needs a non-path value`)
            }
            continue
          }
          const valueFlag = [...ADB_INSTALL_VALUE_FLAGS].find((flag) => arg.startsWith(`${flag}=`))
          if (valueFlag) {
            const value = arg.slice(valueFlag.length + 1)
            if (!value || /[\\/]/.test(value) || value.startsWith('@')) {
              throw new Error(`adb ${verb} option ${valueFlag} needs a non-path value`)
            }
            continue
          }
          throw new Error(
            `adb ${verb} accepts only approved flags and .apk inputs from /workspace; relative and Host paths are refused`
          )
        }
        if (workspaceInputs.length === 0) {
          throw new Error('Physical-device installs accept APKs only from /workspace; Host paths are never passed to adb')
        }
        if (workspaceInputs.some(({ arg }) => !/\.apk$/i.test(arg))) {
          throw new Error('Physical-device installs accept only .apk files from /workspace')
        }
        const stagingRoot = join(this.userData, 'tmp')
        mkdirSync(stagingRoot, { recursive: true })
        stagedDir = mkdtempSync(join(stagingRoot, 'device-adb-'))
        const privateStagingRoot = realpathSync(stagedDir)
        let stagedInstallBytes = 0
        for (const [stagedIndex, input] of workspaceInputs.entries()) {
          const roomPath = this.validateRoomFilePath(roomId, input.arg)
          const hostPath = join(stagedDir, `${String(stagedIndex).padStart(3, '0')}.apk`)
          try {
            await this.backend.copyFromRoom(roomId, roomPath, hostPath)
          } catch {
            throw new Error(`Physical-device install could not stage ${roomPath}`)
          }
          let stagedFile: ReturnType<typeof lstatSync>
          let stagedRealPath: string
          try {
            stagedFile = lstatSync(hostPath)
            stagedRealPath = realpathSync(hostPath)
          } catch {
            throw new Error(`Physical-device install received an invalid staged object for ${roomPath}`)
          }
          const escapedRoot = relative(privateStagingRoot, stagedRealPath)
          if (
            stagedFile.isSymbolicLink() ||
            !stagedFile.isFile() ||
            escapedRoot === '' ||
            escapedRoot === '..' ||
            escapedRoot.startsWith('../') ||
            escapedRoot.startsWith('..\\') ||
            isAbsolute(escapedRoot)
          ) {
            throw new Error(`Physical-device install refused a non-regular or escaped APK staged from ${roomPath}`)
          }
          stagedInstallBytes += stagedFile.size
          if (
            stagedFile.size <= 0 ||
            stagedFile.size > MAX_STAGED_APK_BYTES ||
            stagedInstallBytes > MAX_STAGED_INSTALL_BYTES
          ) {
            throw new Error(`Physical-device install refused an empty or oversized APK staged from ${roomPath}`)
          }
          executableArgs[input.index] = hostPath
          outputReplacements.push({ privateValue: hostPath, publicValue: roomPath })
        }
      }

      // Re-check after staging: a short TTL may have expired while bytes moved.
      const authorized = authorize(executableArgs, capturedLeaseId)
      // A raw install can replace one or several packages without producing a
      // tracked receipt. Revoke every capability on this exact physical target
      // before mutation, even when adb later reports an install failure.
      if (ADB_INSTALL_VERBS.has(verb) && !internal) {
        this.androidInstalls.invalidateTarget({ kind: 'physical', targetId: target.deviceId })
      }
      const result = await this.withDeviceHeartbeat(roomId, target.deviceId, authorized.leaseId, (signal) =>
        this.devices.hostAdb.exec(authorized.serial, executableArgs, { timeoutMs: opts.timeoutMs, signal }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(redactAdbText(message, authorized.serial, outputReplacements))
        })
      )
      // Defense in depth for read commands such as `cat`: even a vendor path
      // that happens to echo the transport serial cannot pierce the opaque ID.
      return redactAdbResult(result, authorized.serial, outputReplacements)
    } finally {
      if (stagedDir) rmSync(stagedDir, { recursive: true, force: true })
    }
  }

  private async withDeviceHeartbeat<T>(
    roomId: string,
    deviceId: string,
    expectedLeaseId: string | null,
    run: (signal: AbortSignal) => Promise<T>,
    busy = true,
    callerSignal?: AbortSignal
  ): Promise<T> {
    if (!expectedLeaseId) return run(callerSignal ?? new AbortController().signal)
    this.devices.authorizeInternalOperation(roomId, deviceId, 'starting the fenced device operation', expectedLeaseId)
    const lease = this.devices.leaseForRoom(roomId)
    if (!lease || lease.id !== expectedLeaseId || lease.deviceId !== deviceId) {
      throw new Error('The captured Android device lease changed before execution')
    }
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(
      callerSignal?.reason instanceof Error ? callerSignal.reason : new Error('Fenced Android operation was aborted')
    )
    if (callerSignal?.aborted) {
      abortFromCaller()
    } else if (callerSignal) {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true })
      // Abort can race the precheck and listener registration. Re-read after
      // registration so a state-changing Host ADB child cannot miss that edge.
      if (callerSignal.aborted) abortFromCaller()
    }
    let fenceError: unknown
    const pulse = (strict = false): void => {
      try {
        this.devices.authorizeInternalOperation(
          roomId,
          deviceId,
          'continuing the fenced device operation',
          expectedLeaseId
        )
        this.devices.heartbeat(expectedLeaseId, { busy })
      } catch (error) {
        fenceError ??= error
        controller.abort(fenceError)
        if (strict) throw error
      }
    }
    pulse(true)
    // This is an authorization fence, not only a TTL keepalive. A short pulse
    // bounds how long an in-flight Host adb process may outlive lease loss.
    const interval = Math.max(100, Math.min(1_000, Math.floor(lease.ttlMs / 6)))
    const timer = setInterval(pulse, interval)
    timer.unref?.()
    let value!: T
    let runError: unknown
    let runFailed = false
    try {
      value = await run(controller.signal)
    } catch (error) {
      runFailed = true
      runError = error
    } finally {
      clearInterval(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
    // No await may occur after this final exact-lease authorization. If lease
    // loss aborted the process, its structured fence error takes precedence
    // over the transport's AbortError or partial result.
    pulse()
    if (fenceError) throw fenceError
    if (callerSignal?.aborted || controller.signal.aborted) {
      throw callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Fenced Android operation was aborted')
    }
    if (runFailed) throw runError
    return value
  }

  androidScreenshot(roomId: string, mode: 'auto' | 'screen' = 'auto'): Promise<{ png: string; source: 'adb' | 'screen' }> {
    return this.withRoomLock(roomId, () => this.androidScreenshotLocked(roomId, mode))
  }

  private async androidScreenshotLocked(roomId: string, mode: 'auto' | 'screen'): Promise<{ png: string; source: 'adb' | 'screen' }> {
    // The permit makes the check bidirectional: pairing cannot start halfway
    // through an awaited screenshot, and a screenshot cannot start while the
    // pairing code is visible.
    const releaseCapture = this.devices.beginCapturePermit()
    try {
      return await this.androidScreenshotWithCapturePermit(roomId, mode)
    } finally {
      releaseCapture()
    }
  }

  private async androidScreenshotWithCapturePermit(
    roomId: string,
    mode: 'auto' | 'screen',
    exactTarget?: AndroidAutomationTarget,
    signal?: AbortSignal,
    expectedPhysicalLeaseId?: string | null
  ): Promise<{ png: string; source: 'adb' | 'screen' }> {
    const room = this.mustGet(roomId)
    if (room.provider !== 'android') throw new Error('Screenshots are available for Android rooms')
    const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
    if (!awake) throw new Error('Wake the room before taking a screenshot')
    // Auto follows whatever this Room is driving. Explicit screen mode always
    // captures the Room display so FLAG_SECURE surfaces remain visible there.
    const assignedPhysicalDevice = this.devices.deviceForRoom(roomId)
    if (
      exactTarget?.kind === 'physical' &&
      (!assignedPhysicalDevice || assignedPhysicalDevice.id !== exactTarget.deviceId)
    ) {
      throw new DevHotelError('SCREENSHOT_TARGET_CHANGED', 'Android target changed before screenshot evidence was captured.', {
        recoveryHint: 'Reacquire the intended target and capture a fresh artifact.'
      })
    }
    // A queued phone can be granted while an emulator capture is starting.
    // Artifact capture stays on the session resolved before capture instead of
    // silently switching the pixels to that newly assigned physical target.
    const physicalDevice = exactTarget?.kind === 'emulator' ? null : assignedPhysicalDevice
    if (physicalDevice && mode === 'auto') {
      if (exactTarget?.kind === 'physical' && !expectedPhysicalLeaseId) {
        throw new DevHotelError('SCREENSHOT_TARGET_CHANGED', 'Physical screenshot lease authority was not retained.', {
          recoveryHint: 'Reacquire the intended physical target and capture a fresh artifact.'
        })
      }
      const args = ['exec-out', 'screencap', '-p']
      const authorized = this.devices.authorizeInternalOperation(
        roomId,
        physicalDevice.id,
        'capturing the attached phone screen',
        expectedPhysicalLeaseId
      )
      const result = await this.withDeviceHeartbeat(
        roomId,
        physicalDevice.id,
        expectedPhysicalLeaseId ?? authorized.leaseId,
        (leaseSignal) => this.devices.hostAdb.execBinary(authorized.serial, args, {
            timeoutMs: 60_000,
            maxStdoutBytes: SCREENSHOT_ARTIFACT_MAX_BYTES,
            maxStderrBytes: 64 * 1024,
            signal: leaseSignal
          }),
        true,
        signal
      )
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      if (
        result.code === 0 &&
        !result.outputLimitExceeded &&
        result.stdout.subarray(0, signature.length).equals(signature)
      ) {
        return { png: result.stdout.toString('base64'), source: 'adb' }
      }
      const safeError = redactAdbResult(
        { code: result.code, stdout: '', stderr: result.stderr },
        authorized.serial
      ).stderr
      throw new Error(`screenshot of ${physicalDevice.nickname} failed: ${safeError.trim().slice(0, 200) || `adb exited ${result.code}`}`)
    }
    if (mode !== 'screen') {
      const result = await this.backend.execFencedEmulatorAdb(
        roomId,
        ['exec-out', 'sh', '-c', "screencap -p | base64 | tr -d '\\n'"],
        {
          timeoutMs: 60_000,
          maxStdoutBytes: SCREENSHOT_ARTIFACT_MAX_BASE64_BYTES,
          maxStderrBytes: 64 * 1024,
          signal
        }
      )
      if (result.outputLimitExceeded) {
        throw new DevHotelError('SCREENSHOT_INVALID', 'Android screenshot output exceeded its safety limit.', {
          recoveryHint: 'Retry after the Android target is fully ready.'
        })
      }
      const png = result.stdout.trim()
      if (result.code === 0 && result.stderr.length === 0 && png.length > 100) {
        return { png, source: 'adb' }
      }
    }
    return {
      png: await this.backend.captureEmulatorScreen(roomId, { signal, timeoutMs: 60_000 }),
      source: 'screen'
    }
  }

  /** One-call answer to "is DevHotel ready and what is running" for agents. */
  async hotelStatus(): Promise<{
    backend: { ok: boolean; detail: string }
    gateway: ReturnType<Gateway['status']>
    rooms: { id: string; project: string; nickname: string; provider: string; status: string; domain: string; url: string | null; emulator: 'running' | 'exited' | 'missing' | null; runtimeStatus: RoomRuntimeStatus }[]
    devices: DeviceBrokerStatus
  }> {
    const backend = await this.backend.health()
    const rooms = [] as { id: string; project: string; nickname: string; provider: string; status: string; domain: string; url: string | null; emulator: 'running' | 'exited' | 'missing' | null; runtimeStatus: RoomRuntimeStatus }[]
    for (const room of this.rooms.list()) {
      const runtimeStatus = await this.observeRuntimeStatus(room, backend.ok)
      const effective = this.effectiveRoom(room, runtimeStatus)
      const emulator = room.provider === 'android' && runtimeStatus.emulator !== 'unknown' && runtimeStatus.emulator !== 'not-checked'
        ? runtimeStatus.emulator as 'running' | 'exited' | 'missing'
        : null
      const url = runtimeStatus.state === 'running' ? this.inspectRoom(room.id).urls.app : null
      rooms.push({
        id: room.id,
        project: room.project,
        nickname: room.nickname,
        provider: room.provider,
        status: effective.status,
        domain: room.domain,
        url,
        emulator,
        runtimeStatus
      })
    }
    return { backend, gateway: this.gateway.status(), rooms, devices: this.devices.status() }
  }

  inspectRoom(roomId: string): RoomInspection {
    const room = this.mustGet(roomId)
    const recent = this.changes.list(roomId).slice(0, 15)
    const baseUrl = room.provider === 'windows' ? null : this.gateway.urlFor(room.domain, room.https)
    const deviceLease = this.devices.leaseForRoom(roomId)
    return {
      room,
      // android rooms open the emulator screen fullscreen and auto-connected
      urls: { app: room.provider === 'android' ? `${baseUrl!}/vnc.html?autoconnect=true&resize=scale` : baseUrl },
      dataDir: join(this.userData, 'rooms', room.id),
      backups: this.listBackups(room.id),
      stackLine:
        room.provider === 'windows'
          ? `Windows ${room.runtime.version} · VMware · offline Clean Room`
          : room.provider === 'android'
          ? `JDK ${room.runtime.version} · gradle`
          : `Node ${room.runtime.version} · ${room.packageManager.kind}`,
      latestCheck: this.checks.latest(roomId),
      recentChanges: recent,
      lastUndoable: this.changes.lastUndoable(roomId),
      storage: null,
      // Capability IDs, worker identity and heartbeat/cancellation facts stay
      // private to the broker; inspection needs only display-safe ownership.
      device: deviceLease
        ? {
            deviceId: deviceLease.deviceId,
            project: deviceLease.project,
            purpose: deviceLease.purpose,
            state: deviceLease.state,
            acquiredAt: deviceLease.acquiredAt
          }
        : null
    }
  }

  /** Agent/user inspection with a live, non-mutating runtime observation over the persisted Room record. */
  async inspectRoomRuntime(roomId: string): Promise<RoomInspection & { runtimeStatus: RoomRuntimeStatus }> {
    const recorded = this.mustGet(roomId)
    const runtimeStatus = await this.observeRuntimeStatus(recorded)
    const inspection = this.inspectRoom(roomId)
    return {
      ...inspection,
      room: this.effectiveRoom(recorded, runtimeStatus),
      urls: { app: runtimeStatus.state === 'running' ? inspection.urls.app : null },
      runtimeStatus
    }
  }

  syncFromHost(roomId: string, actor: Actor): Promise<RoomRecord> {
    return this.withRoomLock(roomId, () => this.replaceWorkspaceFromHostLocked(roomId, actor, false))
  }

  /**
   * Inspect, refuse-or-confirm, and publish a Host resync under one Room lock.
   * Confirmation accepts exactly the inspected generation; a later terminal or
   * process edit invalidates that acceptance before the runtime can switch.
   */
  safeResyncFromHost(
    roomId: string,
    actor: Actor,
    confirmationToken?: string
  ): Promise<SafeHostResyncOutcome> {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (actor !== 'user' && !this.agentHostSyncAllowed(roomId)) {
        throw new Error('Agent Host sync is revoked for this Room. Re-enable it in the Room, or run the sync yourself.')
      }
      if (room.sourceType !== 'linked-folder' || !room.hostSyncEnabled) {
        throw new Error('This Room is detached from its original Host folder')
      }
      if (room.workspaceMode !== 'hotel') {
        throw new Error('Move this legacy Room into the Hotel before syncing')
      }
      const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      if (!awake || (await this.backend.webState(roomId)) !== 'running') {
        throw new Error('Wake the Room before importing Host changes')
      }

      const inspection = await this.inspectHostSyncDrift(room)
      const before = this.hostResyncStateFacts(room)
      const confirmationRequired = inspection.drift.status !== 'clean'
      let confirmationProvided = false
      const recoveryBeforeSync = [
        'Export or commit meaningful Room-side source changes before replacing them.',
        'Repeat with the opaque confirmation token only when the listed Room changes are intentionally disposable.'
      ]
      const binding = this.hostResyncConfirmationBinding(room, before, inspection)
      const issueConfirmation = (recoveryGuidance: string[]) => {
        const token = randomUUID()
        this.pendingHostResyncConfirmations.set(roomId, {
          token,
          actor,
          binding,
          expiresAt: Date.now() + HOST_RESYNC_CONFIRMATION_TTL_MS
        })
        return {
          status: 'confirmation-required' as const,
          before,
          drift: inspection.drift,
          confirmation: { required: true as const, provided: false as const, token },
          recoveryGuidance
        }
      }
      if (confirmationToken !== undefined) {
        const pending = this.pendingHostResyncConfirmations.get(roomId)
        const accepted =
          pending?.token === confirmationToken &&
          pending.actor === actor &&
          pending.expiresAt >= Date.now() &&
          pending.binding === binding
        if (!accepted) {
          return issueConfirmation([
            'The prior confirmation token is missing, expired, already used, or no longer matches this Room snapshot.',
            ...recoveryBeforeSync
          ])
        }
        this.pendingHostResyncConfirmations.delete(roomId)
        confirmationProvided = true
      } else if (confirmationRequired) {
        return issueConfirmation(recoveryBeforeSync)
      } else {
        this.pendingHostResyncConfirmations.delete(roomId)
      }

      const title = confirmationRequired
        ? 'Inspected and confirmed Room changes, then safely resynced from Host'
        : 'Inspected a clean Room and safely resynced from Host'
      const updated = await this.replaceWorkspaceFromHostLocked(roomId, actor, false, {
        acceptedCurrentSnapshot: inspection.currentSnapshot,
        journal: {
          kind: 'safe-resync-from-host',
          title,
          before: { ...before, drift: inspection.drift },
          after: (published) => ({
            ...this.hostResyncStateFacts(published),
            retainedWorkspaceVolumeRevision: before.workspaceVolumeRevision
          })
        }
      })
      const after = this.hostResyncStateFacts(updated)
      return {
        status: 'synced',
        before,
        after,
        drift: inspection.drift,
        confirmation: { required: confirmationRequired || confirmationProvided, provided: confirmationProvided },
        baselineReset: true,
        retainedWorkspaceVolumeRevision: before.workspaceVolumeRevision,
        recoveryGuidance: [
          `The replaced Room workspace remains retained as generation r${before.workspaceVolumeRevision} until the next Host sync.`,
          'If the imported Host state is wrong, stop making Room changes and recover or export that retained generation before another sync.'
        ]
      }
    })
  }

  /** Revoke or restore this Room's inbound Host-sync grant for agents. */
  setAgentHostSync(roomId: string, allowed: boolean, actor: Actor): RoomRecord {
    const room = this.mustGet(roomId)
    if (room.sourceType !== 'linked-folder') throw new Error('Only Rooms linked to a Host folder have a sync grant')
    this.rooms.update(roomId, { agentHostSync: allowed })
    this.appendJournal(
      roomId,
      'agent-host-sync-grant',
      allowed ? 'Agents may sync this Room from its Host folder' : 'Agent Host sync revoked for this Room',
      actor,
      'Working State',
      { agentHostSync: room.agentHostSync ?? true },
      { agentHostSync: allowed }
    )
    this.emit(roomId, 'status')
    return this.mustGet(roomId)
  }

  /** True when an agent may run inbound sync without a fresh human action. */
  agentHostSyncAllowed(roomId: string): boolean {
    const room = this.mustGet(roomId)
    return room.sourceType === 'linked-folder' && room.hostSyncEnabled && room.agentHostSync !== false
  }

  moveIntoHotel(roomId: string, actor: Actor): Promise<RoomRecord> {
    return this.withRoomLock(roomId, () => this.replaceWorkspaceFromHostLocked(roomId, actor, true))
  }

  /**
   * Accept the Room's current files as the Host-sync baseline (goal.md §8.4).
   * Nothing is copied and no Host file is read — it only records "this is the
   * state I compare against next time", which is the one way out when a Room
   * has legitimately diverged (a build ran, a script wrote a file) and every
   * later sync would otherwise be refused forever. The destructive step, the
   * sync itself, still needs its own explicit user action.
   */
  resetSyncBaseline(roomId: string, actor: Actor): Promise<RoomRecord> {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (room.workspaceMode !== 'hotel') {
        throw new Error('Only Hotel-owned workspaces have a Host sync baseline')
      }
      if (room.sourceType !== 'linked-folder' || !room.hostSyncEnabled) {
        throw new Error('This Room is detached from its original Host folder')
      }
      const snapshot = await this.backend.snapshotWorkspace(roomId, room.workspaceVolumeRevision)
      const fingerprint = snapshot.fingerprint
      const before = { syncStatus: room.syncStatus, workspaceFingerprint: room.workspaceFingerprint }
      this.rooms.update(roomId, { workspaceFingerprint: fingerprint, syncStatus: 'synced' })
      this.settings.set(workspaceSyncBaseKey(roomId), serializeWorkspaceSnapshot(snapshot))
      this.appendJournal(
        roomId,
        'reset-sync-baseline',
        'Room files accepted as the Host sync baseline',
        actor,
        'Room',
        before,
        { syncStatus: 'synced', workspaceFingerprint: fingerprint }
      )
      this.olog(roomId, `sync baseline reset at r${room.stateRevision}`)
      const updated = this.mustGet(roomId)
      await writeManifest(this.userData, updated)
      this.emit(roomId, 'status')
      return updated
    })
  }

  private async replaceWorkspaceFromHostLocked(
    roomId: string,
    actor: Actor,
    migrateLegacy: boolean,
    options: {
      acceptedCurrentSnapshot?: WorkspaceSnapshot
      journal?: { kind: string; title: string; before: unknown; after: (published: RoomRecord) => unknown }
    } = {}
  ): Promise<RoomRecord> {
    const room = this.mustGet(roomId)
    // Moving a legacy Room into the Hotel rewires where it executes: always a
    // human decision. Inbound sync re-reads the folder the human already linked
    // to this Room, so agents may run it under the Room's revocable grant.
    if (actor !== 'user' && (migrateLegacy || !this.agentHostSyncAllowed(roomId))) {
      throw new Error(
        migrateLegacy
          ? 'Moving a Room into the Hotel requires an explicit user action'
          : 'Agent Host sync is revoked for this Room. Re-enable it in the Room, or run the sync yourself.'
      )
    }
    if (room.sourceType !== 'linked-folder' || !room.hostSyncEnabled) {
      throw new Error('This Room is detached from its original Host folder')
    }
    if (migrateLegacy !== (room.workspaceMode === 'legacy-host-bind')) {
      throw new Error(
        room.workspaceMode === 'legacy-host-bind'
          ? 'Move this legacy Room into the Hotel before syncing'
          : 'This Room already owns its workspace; use Sync from Host'
      )
    }
    if (room.workspaceMode === 'empty') throw new Error('Empty Rooms cannot sync from Host')
    const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
    if (!awake || (await this.backend.webState(roomId)) !== 'running') {
      throw new Error('Wake the Room before importing Host changes')
    }
    if (!migrateLegacy) {
      const currentSnapshot = await this.backend.snapshotWorkspace(roomId, room.workspaceVolumeRevision)
      if (options.acceptedCurrentSnapshot && currentSnapshot.fingerprint !== options.acceptedCurrentSnapshot.fingerprint) {
        this.rooms.update(roomId, { syncStatus: 'modified' })
        const changedSinceInspection = diffWorkspaceSnapshots(options.acceptedCurrentSnapshot, currentSnapshot)
        if (changedSinceInspection.length > 0) throw new WorkspaceDriftError(changedSinceInspection)
        throw new Error('Room files changed after Host resync inspection; inspect again before confirming.')
      }
      if (options.acceptedCurrentSnapshot) {
        // The combined operation explicitly accepted this exact snapshot. Do
        // not persist it as a standalone baseline: the Host import and final
        // baseline publish either complete together or not at all.
      } else {
        const baseline = await this.workspaceSyncBaseline(room)
        const changedPaths = baseline ? diffWorkspaceSnapshots(baseline, currentSnapshot) : null
        let acceptedFingerprint = room.workspaceFingerprint
        if (acceptedFingerprint && !baseline && currentSnapshot.fingerprint !== acceptedFingerprint) {
          const legacyFingerprint = await this.backend.fingerprintWorkspaceLegacy(room.id, room.workspaceVolumeRevision)
          const generatedOnlyFingerprint = legacyFingerprint === acceptedFingerprint
            ? legacyFingerprint
            : await this.backend.fingerprintWorkspaceLegacyCurrentExclusions(
                room.id,
                room.workspaceVolumeRevision
              )
          if (legacyFingerprint === acceptedFingerprint || generatedOnlyFingerprint === acceptedFingerprint) {
            acceptedFingerprint = currentSnapshot.fingerprint
            this.rooms.update(room.id, { workspaceFingerprint: acceptedFingerprint })
            this.settings.set(workspaceSyncBaseKey(room.id), serializeWorkspaceSnapshot(currentSnapshot))
          }
        }
        if (!acceptedFingerprint || currentSnapshot.fingerprint !== acceptedFingerprint) {
          this.rooms.update(roomId, { syncStatus: 'modified' })
          if (changedPaths && changedPaths.length > 0) throw new WorkspaceDriftError(changedPaths)
          throw new Error(
            'Room files changed since the last Host sync. Export or commit them first, ' +
              'or accept the current Room files as the new baseline (Reset baseline) and sync again.'
          )
        }
        // Upgrade pre-path-baseline Rooms without changing their accepted source.
        if (!baseline) this.settings.set(workspaceSyncBaseKey(room.id), serializeWorkspaceSnapshot(currentSnapshot))
      }
    }

    const nextVolumeRevision = nextWorkspaceVolumeRevision(
      room.workspaceVolumeRevision,
      this.settings.get(workspaceGenMaxKey(room.id))
    )
    // Reserve before import. A failed/staged generation must never be reused.
    this.settings.set(workspaceGenMaxKey(room.id), String(nextVolumeRevision))
    this.olog(roomId, `${migrateLegacy ? 'move into Hotel' : 'sync from Host'}: stage workspace r${nextVolumeRevision}`)
    let nextSnapshot: WorkspaceSnapshot
    try {
      await this.backend.importHostFolder(roomId, room.sourceRef, nextVolumeRevision, (line) => this.olog(roomId, line))
      nextSnapshot = await this.backend.snapshotWorkspace(roomId, nextVolumeRevision)
    } catch (err) {
      await this.backend.removeWorkspaceVolume(roomId, nextVolumeRevision).catch(() => undefined)
      throw err
    }

    const previousSpec = this.webSpecFor(room)
    const nextSpec = this.webSpecFor(room, {
      workspaceMode: 'hotel',
      workspaceVolumeRevision: nextVolumeRevision
    })
    if (options.acceptedCurrentSnapshot) {
      let paused = false
      try {
        await this.backend.pauseWeb(roomId)
        paused = true
        const publishSnapshot = await this.backend.snapshotWorkspace(roomId, room.workspaceVolumeRevision)
        if (publishSnapshot.fingerprint !== options.acceptedCurrentSnapshot.fingerprint) {
          this.rooms.update(roomId, { syncStatus: 'modified' })
          const changedDuringSync = diffWorkspaceSnapshots(options.acceptedCurrentSnapshot, publishSnapshot)
          if (changedDuringSync.length > 0) throw new WorkspaceDriftError(changedDuringSync)
          throw new Error('Room files changed while Host source was staged; nothing was published. Inspect and retry.')
        }
      } catch (guardError) {
        if (paused) {
          try {
            await this.backend.unpauseWeb(roomId)
          } catch (unpauseError) {
            try {
              await this.backend.recreateWeb(previousSpec)
              this.olog(roomId, `Host resync guard restored the prior runtime after unpause failed: ${unpauseError instanceof Error ? unpauseError.message : String(unpauseError)}`)
            } catch (recreateError) {
              this.rooms.update(roomId, { status: 'broken' })
              throw new AggregateError(
                [guardError, unpauseError, recreateError],
                'Host resync was refused, but the prior runtime could not be resumed or recreated'
              )
            }
          }
        }
        try {
          await this.backend.removeWorkspaceVolume(roomId, nextVolumeRevision)
        } catch (cleanupError) {
          throw new AggregateError(
            [guardError, cleanupError],
            `Host resync was refused and staged generation r${nextVolumeRevision} requires cleanup`
          )
        }
        throw guardError
      }
    }
    try {
      await this.backend.recreateWeb(nextSpec)
    } catch (switchError) {
      try {
        await this.backend.recreateWeb(previousSpec)
      } catch (rollbackError) {
        this.rooms.update(roomId, { status: 'broken' })
        throw new Error(
          `Workspace import failed and the previous runtime could not be restored: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: switchError }
        )
      }
      try {
        await this.backend.removeWorkspaceVolume(roomId, nextVolumeRevision)
      } catch (cleanupError) {
        this.rooms.update(roomId, { status: 'broken' })
        throw new Error(
          `Workspace import failed; the previous runtime was restored, but staged generation r${nextVolumeRevision} requires cleanup: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
          { cause: switchError }
        )
      }
      throw switchError
    }

    const baselineKey = workspaceSyncBaseKey(roomId)
    const retainedKey = retainedWorkspaceGenKey(roomId)
    const previouslyRetained = room.workspaceMode === 'hotel' ? this.settings.get(retainedKey) : null
    const syncedAt = new Date().toISOString()
    let updated: RoomRecord
    try {
      this.sqlite.exec('BEGIN IMMEDIATE')
      this.rooms.update(roomId, {
        workspaceMode: 'hotel',
        workspaceVolumeRevision: nextVolumeRevision,
        stateRevision: room.stateRevision + 1,
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        workspaceFingerprint: nextSnapshot.fingerprint,
        lastUsedAt: syncedAt
      })
      this.settings.set(baselineKey, serializeWorkspaceSnapshot(nextSnapshot))
      // Keep the recovery pointer and journal in the same synchronous database
      // transaction as the Room revision switch.
      if (room.workspaceMode === 'hotel') {
        this.settings.set(retainedKey, String(room.workspaceVolumeRevision))
      }
      updated = this.mustGet(roomId)
      this.appendJournal(
        roomId,
        options.journal?.kind ?? (migrateLegacy ? 'move-into-hotel' : 'sync-from-host'),
        options.journal?.title ?? (migrateLegacy ? 'Moved workspace into the Hotel' : 'Synced workspace from Host'),
        actor,
        'Working State',
        options.journal?.before ?? { revision: room.stateRevision, mode: room.workspaceMode },
        options.journal?.after(updated) ?? { revision: updated.stateRevision, mode: updated.workspaceMode }
      )
      this.sqlite.exec('COMMIT')
    } catch (publishError) {
      const rollbackErrors: unknown[] = []
      if (this.sqlite.isTransaction) {
        try {
          this.sqlite.exec('ROLLBACK')
        } catch (error) {
          rollbackErrors.push(error)
        }
      }
      try {
        await this.backend.recreateWeb(previousSpec)
      } catch (runtimeRollbackError) {
        rollbackErrors.push(runtimeRollbackError)
      }
      try {
        if (rollbackErrors.length === 0) {
          await this.backend.removeWorkspaceVolume(roomId, nextVolumeRevision)
        }
      } catch (error) {
        rollbackErrors.push(error)
      }
      if (rollbackErrors.length > 0) {
        try {
          this.rooms.update(roomId, { status: 'broken' })
        } catch {
          // The aggregate below retains every recoverable failure.
        }
        throw new AggregateError(
          [publishError, ...rollbackErrors],
          `Host resync publish failed; rollback was incomplete and staged generation r${nextVolumeRevision} requires recovery`
        )
      }
      throw new Error(
        `Host resync publish failed and the prior Room was restored: ${publishError instanceof Error ? publishError.message : String(publishError)}`,
        { cause: publishError }
      )
    }

    try {
      await writeManifest(this.userData, updated)
    } catch (error) {
      this.olog(roomId, `Host resync committed but its derived manifest could not be refreshed: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      this.emit(roomId, 'change')
      this.emit(roomId, 'status')
    } catch (error) {
      this.olog(roomId, `Host resync committed but an observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Keep the generation this sync replaced: it holds the Room's own edits and
    // its .git, so a sync that turns out to be wrong stays recoverable from the
    // retained volume. Only the generation kept by the *previous* sync is
    // dropped, so at most one spare generation ever accumulates.
    if (room.workspaceMode === 'hotel') {
      this.olog(roomId, `previous workspace generation r${room.workspaceVolumeRevision} retained for recovery`)
      const stale = previouslyRetained === null ? null : Number(previouslyRetained)
      if (
        stale !== null
        && Number.isSafeInteger(stale)
        && stale > 0
        && stale < nextVolumeRevision
        && stale !== room.workspaceVolumeRevision
        && stale !== nextVolumeRevision
      ) {
        try {
          await this.backend.removeWorkspaceVolume(roomId, stale)
        } catch (err) {
          this.olog(roomId, `stale workspace generation r${stale} retained for cleanup: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return updated
  }

  private hostResyncStateFacts(room: RoomRecord): HostResyncStateFacts {
    return {
      stateRevision: room.stateRevision,
      workspaceVolumeRevision: room.workspaceVolumeRevision,
      syncStatus: room.syncStatus,
      workspaceFingerprint: room.workspaceFingerprint,
      lastSyncedAt: room.lastSyncedAt
    }
  }

  private hostResyncConfirmationBinding(
    room: RoomRecord,
    before: HostResyncStateFacts,
    inspection: { currentSnapshot: WorkspaceSnapshot; drift: HostResyncDriftFacts }
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({
        roomId: room.id,
        sourceRef: room.sourceRef,
        workspaceMode: room.workspaceMode,
        hostSyncEnabled: room.hostSyncEnabled,
        before,
        currentSnapshot: serializeWorkspaceSnapshot(inspection.currentSnapshot),
        drift: inspection.drift
      }))
      .digest('hex')
  }

  private async inspectHostSyncDrift(room: RoomRecord): Promise<{
    currentSnapshot: WorkspaceSnapshot
    drift: HostResyncDriftFacts
  }> {
    const currentSnapshot = await this.backend.snapshotWorkspace(room.id, room.workspaceVolumeRevision)
    const baseline = await this.workspaceSyncBaseline(room)
    if (baseline) {
      const changedPaths = diffWorkspaceSnapshots(baseline, currentSnapshot)
      return {
        currentSnapshot,
        drift: {
          status: changedPaths.length > 0 ? 'changed' : 'clean',
          baselineEvidence: 'path-snapshot',
          changedPaths
        }
      }
    }

    const acceptedFingerprint = room.workspaceFingerprint
    if (acceptedFingerprint && currentSnapshot.fingerprint === acceptedFingerprint) {
      return {
        currentSnapshot,
        drift: { status: 'clean', baselineEvidence: 'current-fingerprint', changedPaths: [] }
      }
    }
    if (acceptedFingerprint) {
      const legacyFingerprint = await this.backend.fingerprintWorkspaceLegacy(room.id, room.workspaceVolumeRevision)
      const generatedOnlyFingerprint = legacyFingerprint === acceptedFingerprint
        ? legacyFingerprint
        : await this.backend.fingerprintWorkspaceLegacyCurrentExclusions(room.id, room.workspaceVolumeRevision)
      if (legacyFingerprint === acceptedFingerprint || generatedOnlyFingerprint === acceptedFingerprint) {
        return {
          currentSnapshot,
          drift: { status: 'clean', baselineEvidence: 'legacy-fingerprint', changedPaths: [] }
        }
      }
    }
    return {
      currentSnapshot,
      drift: { status: 'unknown', baselineEvidence: 'unavailable', changedPaths: [] }
    }
  }

  private async workspaceSyncBaseline(room: RoomRecord): Promise<WorkspaceSnapshot | null> {
    const stored = parseWorkspaceSnapshot(this.settings.get(workspaceSyncBaseKey(room.id)))
    if (stored) return stored

    // Older builds retained the replaced generation but stored only a whole-tree
    // digest. Read a path-addressable base from that immutable spare when it
    // still exists. Inspection is deliberately pure: a successful Host publish
    // stores the next baseline, while refusal leaves settings untouched.
    const retained = this.settings.get(retainedWorkspaceGenKey(room.id))
    if (retained === null) return null
    const revision = Number(retained)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= room.workspaceVolumeRevision) return null
    try {
      const snapshot = await this.backend.snapshotWorkspace(room.id, revision)
      if (snapshot.fingerprint !== room.workspaceFingerprint) return null
      return snapshot
    } catch {
      return null
    }
  }

  listChanges(roomId: string): ChangeEntry[] {
    return this.changes.list(roomId)
  }

  applyChange(roomId: string, change: QuickChange, actor: Actor): Promise<ChangeEntry> {
    const room = this.mustGet(roomId)
    if (room.provider === 'windows') {
      throw new Error(`'${change.kind}' is not available until the Windows guest agent is installed`)
    }
    if (room.provider === 'android' && !ANDROID_CHANGE_KINDS.has(change.kind)) {
      throw new Error(`'${change.kind}' is not available for Android rooms`)
    }
    if (room.provider === 'web' && change.kind === 'android-build') {
      throw new Error('Builds are only available in Android rooms')
    }
    return this.withRoomLock(roomId, async () => {
      const current = this.mustGet(roomId)
      if (actor === 'agent' && current.workspaceMode === 'legacy-host-bind') {
        throw new Error('Agent mutations are blocked for legacy Host-bound Rooms. Move the Room into the Hotel first.')
      }
      let entry: ChangeEntry
      try {
        entry = await this.engine.execute(this.ctxFor(roomId), change.kind, change, actor)
      } catch (error) {
        if (
          change.kind !== 'package-install' &&
          (change.kind === 'deps-install' || change.kind === 'android-run')
        ) this.markWorkspaceModified(roomId)
        throw error
      }
      if (change.kind !== 'package-install' && WORKSPACE_MUTATION_KINDS.has(change.kind)) {
        const applied = entry.status === 'verified' || entry.status === 'applied'
        const possiblyPartialFailure =
          entry.status === 'failed' &&
          ((change.kind === 'deps-install' && !change.clean) || change.kind === 'android-run')
        if (applied || possiblyPartialFailure) this.markWorkspaceModified(roomId)
      }
      this.syncStatusFromVerify(roomId, entry)
      this.reattachLogs(roomId)
      await writeManifest(this.userData, this.mustGet(roomId))
      this.emit(roomId, 'change', entry.title)
      this.emit(roomId, 'status')
      return entry
    })
  }

  undoChange(roomId: string, changeId: string, actor: Actor): Promise<ChangeEntry> {
    if (this.mustGet(roomId).provider === 'windows') throw new Error('Windows VM lifecycle actions are not undoable')
    return this.withRoomLock(roomId, async () => {
      if (actor === 'agent' && this.mustGet(roomId).workspaceMode === 'legacy-host-bind') {
        throw new Error('Agent mutations are blocked for legacy Host-bound Rooms. Move the Room into the Hotel first.')
      }
      const original = this.changes.get(changeId)
      const entry = await this.engine.undo(this.ctxFor(roomId), changeId, actor)
      if (original && original.kind !== 'package-install' && WORKSPACE_MUTATION_KINDS.has(original.kind)) {
        this.markWorkspaceModified(roomId)
      }
      this.syncStatusFromVerify(roomId, entry)
      this.reattachLogs(roomId)
      await writeManifest(this.userData, this.mustGet(roomId))
      this.emit(roomId, 'change', entry.title)
      this.emit(roomId, 'status')
      return entry
    })
  }

  /** Only rooms that are actually awake take their status from a change verify — broken/sleeping rooms keep theirs. */
  private syncStatusFromVerify(roomId: string, entry: ChangeEntry): void {
    const room = this.mustGet(roomId)
    const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
    if (entry.verify && awake) {
      this.rooms.update(roomId, { status: entry.verify.ok ? 'ready' : 'attention' })
    }
  }

  /** The `docker logs -f` pump dies with its container — re-arm it after operations that may have recreated the web container. */
  private reattachLogs(roomId: string): void {
    const room = this.rooms.get(roomId)
    if (room && room.provider !== 'windows' && (room.status === 'running' || room.status === 'ready' || room.status === 'attention')) {
      this.logs.detach(roomId)
      this.logs.attach(roomId)
    }
  }

  runChecks(roomId: string): Promise<CheckReport> {
    return this.withRoomLock(roomId, () => this.runChecksLocked(roomId))
  }

  private async runChecksLocked(roomId: string): Promise<CheckReport> {
    const room = this.mustGet(roomId)
    const report =
      room.provider === 'windows'
        ? await this.runWindowsChecks(room)
        : await runCheckPipeline({
            room,
            backend: this.backend,
            gateway: this.gateway,
            userData: this.userData,
            depsGen: this.depsGen(roomId),
            syncRoute: () => this.syncRouteFor(roomId)
          })
    this.checks.saveReport(report)
    if (room.status !== 'sleeping' && room.status !== 'preparing') {
      const coreBroken = report.results.some(
        (r) => (r.step === 'process' || r.step === 'port' || r.step === 'http') && r.status === 'broken'
      )
      const anyBad = report.results.some((r) => r.status === 'broken' || r.status === 'warning')
      this.rooms.update(roomId, { status: coreBroken ? 'broken' : anyBad ? 'attention' : 'ready' })
    }
    this.emit(roomId, 'check', report.overall)
    return report
  }

  private async runWindowsChecks(room: RoomRecord): Promise<CheckReport> {
    const windowsVm = this.mustWindowsVm()
    const results: CheckResult[] = []
    const health = await windowsVm.health()
    results.push(
      health.ok
        ? { step: 'backend', status: 'healthy', summary: health.detail }
        : { step: 'backend', status: 'broken', summary: 'VMware backend unavailable', detail: health.detail }
    )
    const metadataOk =
      room.runtime.kind === 'windows' &&
      room.packageManager.kind === 'none' &&
      room.sourceType === 'empty' &&
      room.workspaceMode === 'empty' &&
      room.internalPort === 0 &&
      room.hostPort === null &&
      room.windows?.backend === 'vmware' &&
      /^[a-f0-9]{64}$/.test(room.windows.templateId)
    results.push(
      metadataOk
        ? { step: 'metadata', status: 'healthy', summary: `offline VMware Room ${room.id}` }
        : { step: 'metadata', status: 'broken', summary: 'Windows Room record is inconsistent' }
    )
    const baseline = await windowsVm.validateBaseline(room.id)
    results.push(
      baseline.ok
        ? { step: 'source', status: 'healthy', summary: baseline.detail }
        : {
            step: 'source',
            status: 'warning',
            summary: 'clean VM baseline cannot be revalidated',
            detail: baseline.detail
          }
    )

    if (!health.ok) {
      results.push({ step: 'process', status: 'unknown', summary: 'VMware state is unavailable' })
    } else {
      const state = await windowsVm.state(room.id)
      const expectsRunning = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      results.push(
        state === 'missing'
          ? { step: 'process', status: 'broken', summary: 'owned VMware clone is missing' }
          : expectsRunning && state !== 'running'
            ? { step: 'process', status: 'broken', summary: 'Room record is awake but its VM is stopped' }
            : !expectsRunning && state === 'running'
              ? { step: 'process', status: 'warning', summary: 'sleeping Room still has a running VM' }
              : {
                  step: 'process',
                  status: expectsRunning ? 'healthy' : 'unknown',
                  summary: state === 'running' ? 'Windows VM is running' : 'Windows VM is stopped'
                }
      )
    }
    const statuses = results.map((result) => result.status)
    const overall: CheckStatus = statuses.includes('broken')
      ? 'broken'
      : statuses.includes('warning')
        ? 'warning'
        : statuses.every((status) => status === 'unknown')
          ? 'unknown'
          : 'healthy'
    return { roomId: room.id, ranAt: new Date().toISOString(), results, overall }
  }

  /**
   * Run one command in the Room and answer with a *bounded* view of its output.
   * The command streams into Room-owned run storage as it runs, so a caller
   * that asked for 64KB of a 400MB logcat still gets the complete raw stream
   * back by run id instead of losing it to a response limit.
   */
  androidEmulatorAction(roomId: string, action: AndroidAction): Promise<void> {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (room.provider !== 'android') {
        throw new DevHotelError('ANDROID_ROOM_REQUIRED', 'Android emulator controls are available only for Android Rooms.', {
          recoveryHint: 'Choose an awake Android Room.', httpStatus: 409
        })
      }
      const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
      if (!awake) {
        throw new DevHotelError('ANDROID_ROOM_ASLEEP', 'Wake the Android Room before using its emulator controls.', {
          recoveryHint: 'Start the Room, wait for the emulator, and retry.', httpStatus: 409
        })
      }
      if ((await this.backend.emulatorState(roomId)) !== 'running') {
        throw new DevHotelError('ANDROID_EMULATOR_NOT_RUNNING', 'The Room emulator is not running.', {
          recoveryHint: 'Restart the Android Room and wait for its emulator container.', httpStatus: 409
        })
      }

      let result: ExecResult
      try {
        result = await this.backend.execFencedEmulatorAdb(
          roomId,
          protectAndroidRemoteCommand(androidEmulatorActionArgs(action)),
          { timeoutMs: 20_000, maxStdoutBytes: 1024, maxStderrBytes: 1024 }
        )
      } catch {
        throw new DevHotelError(
          'ANDROID_EMULATOR_ACTION_FAILED',
          'The Room emulator did not accept the requested phone control.',
          { recoveryHint: 'Wait for the Room emulator to become responsive and retry.', httpStatus: 409 }
        )
      }
      if (result.code !== 0 || result.outputLimitExceeded === true) {
        throw new DevHotelError(
          'ANDROID_EMULATOR_ACTION_FAILED',
          'The Room emulator did not accept the requested phone control.',
          { recoveryHint: 'Wait for the Room emulator to become responsive and retry.', httpStatus: 409 }
        )
      }
    })
  }

  execInRoom(
    roomId: string,
    cmd: string[],
    opts?: { timeoutMs?: number; output?: OutputSelection },
    actor: Actor = 'agent'
  ): Promise<RoomExecResult> {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (room.provider === 'windows') throw new Error('Windows Room commands require the forthcoming guest agent')
      if (actor === 'agent' && room.workspaceMode === 'legacy-host-bind') {
        throw new Error('Agent commands are blocked for legacy Host-bound Rooms. Move the Room into the Hotel first.')
      }
      if (this.runtimeExpectation(room) !== 'running') throw this.runtimeNotRunningError(room, 'stopped')
      const runtimeState = await this.backend.webState(roomId).catch(() => 'unknown' as const)
      if (runtimeState !== 'running') throw this.runtimeNotRunningError(room, runtimeState)
      this.markWorkspaceModified(roomId)
      const run = this.runs.begin(roomId, cmd, actor, opts?.output ?? {})
      let sawStdout = false
      let sawStderr = false
      let result: ExecResult
      try {
        result = await this.backend.execInRoom(roomId, cmd, {
          timeoutMs: opts?.timeoutMs,
          onStdout: (chunk) => {
            sawStdout = true
            run.push('stdout', chunk)
          },
          onStderr: (chunk) => {
            sawStderr = true
            run.push('stderr', chunk)
          }
        })
      } catch (error) {
        this.runs.complete(run, -1)
        if (error instanceof DevHotelError) throw error
        const after = await this.backend.webState(roomId).catch(() => 'unknown' as const)
        if (after !== 'running') throw this.runtimeNotRunningError(room, after, error)
        throw error
      }
      // A backend that buffers instead of streaming still gets bounded here.
      if (!sawStdout && result.stdout) run.push('stdout', result.stdout)
      if (!sawStderr && result.stderr) run.push('stderr', result.stderr)
      const outcome = this.runs.complete(run, result.code)
      if (result.code !== 0) {
        const after = await this.backend.webState(roomId).catch(() => 'unknown' as const)
        if (after !== 'running') throw this.runtimeNotRunningError(room, after)
      }
      return {
        code: result.code,
        stdout: outcome.stdout.text,
        stderr: outcome.stderr.text,
        output: {
          runId: outcome.runId,
          retained: outcome.retained,
          stdout: outcome.stdout.report,
          stderr: outcome.stderr.report,
          notes: outcome.notes
        }
      }
    })
  }

  private runtimeNotRunningError(room: RoomRecord, state: string, cause?: unknown): DevHotelError {
    const unavailable = state === 'unknown'
    return new DevHotelError(
      unavailable ? 'ROOM_RUNTIME_STATUS_UNAVAILABLE' : 'ROOM_RUNTIME_NOT_RUNNING',
      unavailable
        ? `DevHotel could not verify that Room ${room.id} is running.`
        : `Room ${room.id} cannot run commands because its runtime is ${state}.`,
      {
        recoveryHint: this.runtimeRecoveryHint(room),
        httpStatus: unavailable ? 503 : 409,
        cause
      }
    )
  }

  /** Commands running now plus the runs whose full output this Room still holds. */
  listRuns(roomId: string): RunSummary[] {
    this.mustGet(roomId)
    return this.runs.list(roomId)
  }

  /**
   * Read a retained (or still running) command's raw output. Deliberately takes
   * no Room lock: the point is to be readable while the command still holds it.
   */
  readRunOutput(roomId: string, runId: string, opts: RunReadOptions = {}): RunReadResult {
    this.mustGet(roomId)
    return this.runs.read(roomId, runId, opts)
  }

  spawnInteractiveExec(roomId: string, cmd: string[]) {
    return this.withRoomLock(roomId, async () => {
      const room = this.mustGet(roomId)
      if (room.provider === 'windows') throw new Error('Windows Room terminals require the forthcoming guest agent')
      if (room.status === 'sleeping' || room.status === 'preparing') {
        throw new Error('The room must be awake for a terminal session')
      }
      this.markWorkspaceModified(roomId)
      return this.backend.spawnInteractiveExec(roomId, cmd)
    })
  }

  async getDiagnostic(roomId: string): Promise<string> {
    const room = this.mustGet(roomId)
    const report = await this.runChecks(roomId)
    let customPatterns: string[] = []
    try {
      customPatterns = JSON.parse(this.settings.get('redactPatterns') ?? '[]') as string[]
    } catch {
      customPatterns = []
    }
    return buildDiagnostic({
      room,
      appVersion: this.appVersion,
      report,
      recentChanges: this.changes.list(roomId).slice(0, 6),
      gateway: this.gateway.status(),
      webLogTail: this.logs.tail(roomId, 'web', 60),
      customPatterns
    })
  }

  /** Installed programs of a room with live versions (read from inside the room when awake). */
  async components(roomId: string): Promise<
    { id: string; label: string; version: string; source: 'live' | 'recorded'; changeKind?: string; options?: string[] }[]
  > {
    return this.withRoomLock(roomId, () => this.componentsLocked(roomId))
  }

  private async componentsLocked(roomId: string): Promise<
    { id: string; label: string; version: string; source: 'live' | 'recorded'; changeKind?: string; options?: string[] }[]
  > {
    const room = this.mustGet(roomId)
    if (room.provider === 'windows') {
      return [
        { id: 'windows', label: 'Windows', version: room.runtime.version, source: 'recorded' },
        { id: 'vmware', label: 'VMware Workstation', version: 'vmrun', source: 'recorded' },
        {
          id: 'snapshot',
          label: 'Clean snapshot',
          version: room.windows?.snapshot ?? 'missing',
          source: 'recorded'
        }
      ]
    }
    const awake =
      (room.status === 'running' || room.status === 'ready' || room.status === 'attention') &&
      (await this.backend.webState(roomId)) === 'running'
    const liveWeb = async (cmd: string): Promise<string | null> => {
      if (!awake) return null
      const res = await this.backend.execInRoom(roomId, ['sh', '-lc', cmd], { timeoutMs: 20_000 })
      const line = res.stdout.trim().split(/\r?\n/)[0] ?? ''
      return res.code === 0 && line ? line : null
    }
    const out: { id: string; label: string; version: string; source: 'live' | 'recorded'; changeKind?: string; options?: string[] }[] = []

    if (room.provider === 'android') {
      const jdk = await liveWeb('java -version 2>&1 | head -1')
      out.push({ id: 'jdk', label: 'JDK', version: jdk ?? `JDK ${room.runtime.version}`, source: jdk ? 'live' : 'recorded' })
      const gradle = await liveWeb(
        "if [ -f ./gradlew ]; then sh ./gradlew --version 2>/dev/null; else gradle --version 2>/dev/null; fi | grep -m1 Gradle"
      )
      out.push({ id: 'gradle', label: 'Gradle', version: gradle ?? 'gradle', source: gradle ? 'live' : 'recorded' })
      out.push({
        id: 'emulator',
        label: 'Android Emulator',
        version: `${room.android?.device ?? EMULATOR_DEFAULT_DEVICE} · Android ${room.android?.version ?? EMULATOR_DEFAULT_VERSION}`,
        source: 'recorded'
      })
      return out
    }

    const node = await liveWeb('node --version')
    out.push({
      id: 'node',
      label: 'Node.js',
      version: node ? node.replace(/^v/, '') : room.runtime.version,
      source: node ? 'live' : 'recorded',
      changeKind: 'node-version',
      options: ['18', '20', '22', '24']
    })
    const pm = await liveWeb(
      `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; ${room.packageManager.kind} --version 2>/dev/null | head -1`
    )
    out.push({
      id: 'pm',
      label: room.packageManager.kind,
      version: pm ?? room.packageManager.version ?? '—',
      source: pm ? 'live' : 'recorded',
      changeKind: 'package-manager',
      options: ['npm', 'pnpm']
    })
    for (const [svc, cfg] of Object.entries(room.services) as ['postgres' | 'redis', { version: string }][]) {
      let liveV: string | null = null
      if (awake && (await this.backend.serviceState(roomId, svc)) === 'running') {
        const res =
          svc === 'postgres'
            ? await this.backend.execInService(roomId, svc, ['psql', '--version'], { timeoutMs: 15_000 })
            : await this.backend.execInService(roomId, svc, ['redis-server', '--version'], { timeoutMs: 15_000 })
        const m = svc === 'postgres' ? /(\d+(?:\.\d+)*)/.exec(res.stdout) : /v=(\d+(?:\.\d+)*)/.exec(res.stdout)
        if (res.code === 0 && m?.[1]) liveV = m[1]
      }
      out.push({
        id: svc,
        label: svc === 'postgres' ? 'PostgreSQL' : 'Redis',
        version: liveV ?? cfg.version,
        source: liveV ? 'live' : 'recorded',
        changeKind: 'service-version',
        options: svc === 'postgres' ? ['15', '16', '17'] : ['7', '8']
      })
    }
    return out
  }

  renameRoom(roomId: string, nickname: string): Promise<void> {
    return this.withRoomLock(roomId, async () => {
      if (!nickname.trim()) throw new Error('Nickname cannot be empty')
      this.rooms.update(roomId, { nickname: nickname.trim() })
      this.emit(roomId, 'status')
    })
  }

  setThumbnail(roomId: string, thumbPath: string): void {
    if (this.mutationGate !== 'open') return
    if (this.rooms.get(roomId)) this.rooms.update(roomId, { thumbPath })
  }

  /* ------------------------------------------------------------------ */

  private ctxFor(roomId: string): ChangeCtx {
    const physicalDevice = this.devices.deviceForRoom(roomId)
    let physicalLeaseFence: string | null = null
    const capturePhysicalLease = (): string => {
      if (physicalLeaseFence) return physicalLeaseFence
      if (!physicalDevice) throw new Error('This Room has no physical Android device target')
      const authorized = this.devices.authorizeInternalOperation(
        roomId,
        physicalDevice.id,
        'starting the tracked Android operation'
      )
      if (!authorized.leaseId) throw new Error('The physical Android operation has no device lease')
      physicalLeaseFence = authorized.leaseId
      return physicalLeaseFence
    }
    return {
      roomId,
      backend: this.backend,
      gateway: this.gateway,
      rooms: this.rooms,
      changes: this.changes,
      settings: this.settings,
      userData: this.userData,
      log: (line) => this.olog(roomId, line),
      room: () => this.mustGet(roomId),
      webSpec: (overrides) => this.webSpecFor(this.mustGet(roomId), overrides),
      isAwake: () => {
        const s = this.mustGet(roomId).status
        return s === 'running' || s === 'ready' || s === 'attention'
      },
      syncRoute: () => this.syncRouteFor(roomId),
      clearBrowserData: this.clearBrowserData ? () => this.clearBrowserData!(roomId) : undefined,
      clearAndroidEmulatorInstalls: () => this.clearAndroidEmulatorInstalls(roomId),
      execFencedAndroidTarget: (args, opts) => {
        const expectedLeaseId = physicalDevice ? capturePhysicalLease() : null
        return physicalDevice
          ? this.adbOnDeviceLocked(roomId, args, opts, {
              reason: 'running the tracked Android app',
              expectedLeaseId: expectedLeaseId!
            })
          : this.backend.execFencedEmulatorAdb(roomId, args, opts)
      },
      installTrackedAndroidArtifact: async (applicationId, artifact, changeId) => {
        const expectedLeaseId = physicalDevice ? capturePhysicalLease() : null
        await this.installAndRecordAndroidArtifactLocked(
          roomId,
          physicalDevice
            ? {
                kind: 'physical',
                targetId: physicalDevice.id,
                deviceId: physicalDevice.id,
                leaseId: expectedLeaseId!
              }
            : { kind: 'emulator', targetId: roomId, deviceId: null },
          applicationId,
          artifact,
          changeId,
          expectedLeaseId
        )
      },
      removeTrackedAndroidInstall: (applicationId, changeId) => {
        const expectedLeaseId = physicalDevice ? capturePhysicalLease() : null
        const target: AndroidInstallTarget = physicalDevice
          ? {
              kind: 'physical',
              targetId: physicalDevice.id,
              deviceId: physicalDevice.id,
              leaseId: expectedLeaseId!
            }
          : { kind: 'emulator', targetId: roomId, deviceId: null }
        const receipt = this.androidInstalls.get(roomId, target, applicationId)
        if (receipt?.changeId === changeId) this.androidInstalls.remove(roomId, target, applicationId)
      },
      removeTrackedAndroidInstalls: (changeId) => {
        this.androidInstalls.removeForChange(roomId, changeId)
      },
      launchTrackedAndroidApp: async (applicationId) => {
        const selector = physicalDevice
          ? { kind: 'physical' as const, deviceId: physicalDevice.id }
          : { kind: 'emulator' as const }
        if (physicalDevice) capturePhysicalLease()
        const session = await this.openAndroidAutomationSessionLocked(roomId, selector)
        await session.launch(applicationId)
      },
      isTrackedAndroidAppForeground: async (applicationId) => {
        const selector = physicalDevice
          ? { kind: 'physical' as const, deviceId: physicalDevice.id }
          : { kind: 'emulator' as const }
        if (physicalDevice) capturePhysicalLease()
        const session = await this.openAndroidAutomationSessionLocked(roomId, selector)
        const status = await session.status()
        return status.foregroundApplicationId === applicationId
      },
      physicalAndroidDevice:
        physicalDevice
          ? {
              nickname: physicalDevice.nickname,
              keepAlive: (run) => this.withDeviceHeartbeat(roomId, physicalDevice.id, capturePhysicalLease(), run, false)
            }
          : undefined
    }
  }

  private clearAndroidEmulatorInstalls(roomId: string): void {
    this.androidInstalls.clearTarget(roomId, { kind: 'emulator', targetId: roomId, deviceId: null })
  }

  private async installAndRecordAndroidArtifactLocked(
    roomId: string,
    target: AndroidInstallTarget,
    applicationId: string,
    artifact: SealedAndroidArtifactRef,
    changeId: string,
    expectedLeaseId: string | null
  ): Promise<void> {
    if (
      artifact.operationId !== changeId ||
      !isSafeAndroidArtifactRelativePath(artifact.relativePath) ||
      !/^[a-f0-9]{64}$/.test(artifact.apkSha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 1 ||
      artifact.sizeBytes > MAX_STAGED_APK_BYTES
    ) {
      throw new Error('Android install refused invalid sealed artifact evidence')
    }
    const artifactsRoot = join(this.userData, 'rooms', roomId, 'artifacts')
    const operationRoot = join(artifactsRoot, changeId)
    const sourcePath = join(operationRoot, ...artifact.relativePath.split('/'))
    const stagingRoot = join(this.userData, 'tmp')
    let stagingDir: string | null = null
    let stagedApk: string | null = null
    let canonicalArtifactsRoot: string | null = null
    let canonicalOperationRoot: string | null = null
    let canonicalSource: string | null = null
    let operationError: Error | null = null
    try {
      const operationRootStat = lstatSync(operationRoot)
      canonicalArtifactsRoot = realpathSync.native(artifactsRoot)
      canonicalOperationRoot = realpathSync.native(operationRoot)
      if (
        operationRootStat.isSymbolicLink() ||
        !operationRootStat.isDirectory() ||
        relative(canonicalArtifactsRoot, canonicalOperationRoot) !== changeId
      ) throw new Error('Android sealed artifact directory escaped its Room-owned root')
      const sourceStat = lstatSync(sourcePath)
      canonicalSource = realpathSync.native(sourcePath)
      const sourceRel = relative(canonicalOperationRoot, canonicalSource)
      if (
        sourceStat.isSymbolicLink() ||
        !sourceStat.isFile() ||
        sourceStat.size !== artifact.sizeBytes ||
        isAbsolute(sourceRel) ||
        sourceRel === '..' ||
        sourceRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        await hashFileSha256(canonicalSource) !== artifact.apkSha256
      ) throw new Error('Android sealed artifact no longer matches its build provenance')

      mkdirSync(stagingRoot, { recursive: true })
      stagingDir = mkdtempSync(join(stagingRoot, 'android-sealed-install-'))
      stagedApk = join(stagingDir, 'installed.apk')
      copyFileSync(canonicalSource, stagedApk, constants.COPYFILE_EXCL)
      chmodSync(stagedApk, 0o400)
      const staged = lstatSync(stagedApk)
      if (
        !staged.isFile() ||
        staged.isSymbolicLink() ||
        staged.size !== artifact.sizeBytes ||
        await hashFileSha256(stagedApk) !== artifact.apkSha256
      ) {
        throw new Error('Android sealed artifact changed while entering its private install stage')
      }
      // Revoke immediately before the first target mutation. A failed or
      // partially committed install must never leave the prior capability.
      this.androidInstalls.invalidateTargetApplication(target, applicationId)
      let install: ExecResult
      if (target.kind === 'physical') {
        if (!expectedLeaseId) throw new Error('Physical Android install receipt has no captured lease')
        install = await this.installStagedApkOnPhysicalLocked(
          roomId,
          target.deviceId,
          expectedLeaseId,
          stagedApk,
          '[sealed Android artifact]'
        )
      } else {
        install = await this.backend.installFencedEmulatorApk(roomId, stagedApk, {
          timeoutMs: 180_000,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024
        })
      }
      if (install.code !== 0 || install.outputLimitExceeded === true) {
        const detail = redactSecrets((install.stderr || install.stdout).slice(-300))
        throw new Error(
          `adb install ${applicationId} failed${detail ? `: ${detail}` : ` (exit ${install.code})`}`
        )
      }
      const session = await this.openAndroidAutomationSessionLocked(
        roomId,
        target.kind === 'physical'
          ? { kind: 'physical', deviceId: target.deviceId }
          : { kind: 'emulator' }
      )
      // This Host timestamp is the public lower bound. Capture it before the
      // install marker so every sequence-fenced row is chronologically at or
      // after the reported `since`, never in the gap before receipt commit.
      const installedAt = new Date().toISOString()
      const evidence = await session.establishInstallEvidence(applicationId)
      if (evidence.apkSha256 !== artifact.apkSha256) {
        throw new Error('The installed Android package bytes differ from the tracked Room APK')
      }
      if (target.kind === 'physical') {
        this.devices.authorizeInternalOperation(
          roomId,
          target.deviceId,
          'committing the tracked Android install evidence',
          expectedLeaseId!
        )
      } else if ((await this.backend.emulatorState(roomId)) !== 'running') {
        throw new Error('The Room emulator disappeared before its install evidence was committed')
      }
      this.androidInstalls.record({
        roomId,
        target,
        applicationId,
        changeId,
        apkSha256: artifact.apkSha256,
        installedAt,
        packageIncarnation: evidence.packageIncarnation,
        logFence: evidence.logFence,
        installUserId: evidence.installUserId,
        installUserSerial: evidence.installUserSerial
      })
      try {
        // Close the evidence-return/SQLite-commit gap while the Room and exact
        // physical lease remain captured. Later primitives still revalidate on
        // every use because target-side package mutation cannot be locked out.
        await session.confirmInstallEvidence(applicationId, evidence)
      } catch (error) {
        this.androidInstalls.remove(roomId, target, applicationId)
        throw error
      }
    } catch (error) {
      operationError = privateAndroidStageError(
        error,
        [
          artifactsRoot,
          operationRoot,
          sourcePath,
          canonicalArtifactsRoot,
          canonicalOperationRoot,
          canonicalSource,
          stagingRoot,
          stagingDir,
          stagedApk
        ],
        'Android install failed while handling its private APK stage'
      )
    }
    let cleanupError: Error | null = null
    if (stagingDir) {
      try {
        rmSync(stagingDir, { recursive: true, force: true })
      } catch (error) {
        cleanupError = privateAndroidStageError(
          error,
          [stagingRoot, stagingDir, stagedApk],
          'Android private APK staging cleanup failed'
        )
      }
    }
    if (operationError || cleanupError) {
      const receipt = this.androidInstalls.get(roomId, target, applicationId)
      if (receipt?.changeId === changeId) this.androidInstalls.remove(roomId, target, applicationId)
    }
    if (operationError && cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `${operationError.message}; private APK staging cleanup also failed`
      )
    }
    if (operationError) throw operationError
    if (cleanupError) throw cleanupError
  }

  /** Install one already sealed Host-private APK through an exact physical lease. */
  private async installStagedApkOnPhysicalLocked(
    roomId: string,
    deviceId: string,
    expectedLeaseId: string,
    stagedApk: string,
    publicRoomPath: string
  ): Promise<ExecResult> {
    const canonicalApk = realpathSync(stagedApk)
    const staged = lstatSync(stagedApk)
    if (
      staged.isSymbolicLink() ||
      !staged.isFile() ||
      staged.size <= 0 ||
      staged.size > MAX_STAGED_APK_BYTES
    ) {
      throw new Error('Physical Android install refused an invalid private APK stage')
    }
    const authorized = this.devices.authorizeInternalOperation(
      roomId,
      deviceId,
      'installing the tracked Android app',
      expectedLeaseId
    )
    const result = await this.withDeviceHeartbeat(roomId, deviceId, expectedLeaseId, (signal) =>
      this.devices.hostAdb.exec(authorized.serial, ['install', '-r', canonicalApk], {
        timeoutMs: 180_000,
        signal,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024
      })
    )
    return redactAdbResult(result, authorized.serial, [{ privateValue: canonicalApk, publicValue: publicRoomPath }])
  }

  private webSpecFor(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
    const os = room.os ?? { env: {} }
    const osOverlay: Partial<WebSpec> = {
      cpus: os.cpus,
      memoryMB: os.memoryMB
    }
    const osEnv = { ...os.env, ...(os.timezone ? { TZ: os.timezone } : {}) }
    if (room.provider === 'android') {
      const base = getProvider('android').buildSpec(room, osOverlay)
      return { ...base, env: { ...base.env, ...osEnv }, ...overrides }
    }
    // Every container this Room ever materializes comes through here, so this
    // is where a provider the build cannot serve has to stop. Falling through
    // would hand it the Web runtime — a Linux Node image, Web checks and Web
    // change kinds — under another provider's name.
    if (room.provider !== 'web') {
      const provider = getProvider(room.provider)
      throw new Error(
        `${provider.info.label} cannot run in this DevHotel build: ${provider.info.unavailableReason ?? 'provider unavailable'}`
      )
    }
    const gen = this.depsGen(room.id)
    return {
      roomId: room.id,
      internalPort: room.internalPort,
      nodeMajor: room.runtime.version,
      sourceType: room.sourceType,
      sourceRef: room.sourceRef,
      workspaceMode: room.workspaceMode,
      workspaceVolumeRevision: room.workspaceVolumeRevision,
      startCommand: room.startCommand,
      env: osEnv,
      depsVolumeOverride: gen > 0 ? depsVolumeForGen(room.id, room.runtime.version, gen) : undefined,
      ...osOverlay,
      ...overrides
    }
  }

  private depsGen(roomId: string): number {
    const room = this.rooms.get(roomId)
    const major = room?.runtime.version ?? ''
    const raw = this.settings.get(`depsGen:${roomId}:node${major}`) ?? this.settings.get(`depsGen:${roomId}`)
    return raw ? Number.parseInt(raw, 10) : 0
  }

  private markWorkspaceModified(roomId: string): void {
    const room = this.mustGet(roomId)
    if (room.workspaceMode !== 'hotel') return
    this.rooms.update(roomId, {
      stateRevision: room.stateRevision + 1,
      syncStatus: 'modified'
    })
  }

  private markWorkspaceAmbiguous(roomId: string): void {
    const room = this.mustGet(roomId)
    this.rooms.update(roomId, {
      stateRevision: room.stateRevision + 1,
      syncStatus: room.workspaceMode === 'hotel' ? 'modified' : room.syncStatus,
      status: 'broken',
      hostPort: null
    })
  }

  private async syncRouteFor(roomId: string): Promise<void> {
    const room = this.mustGet(roomId)
    if (room.hostPort != null) {
      const relayToken = await this.backend.relayToken(room.id)
      await this.gateway.setRoute({
        domain: room.domain,
        roomId: room.id,
        targetPort: room.hostPort,
        https: room.https,
        relayToken
      })
    }
  }

  private uniqueDomain(domain: string): string {
    const taken = new Set(this.rooms.list().map((r) => r.domain))
    if (!taken.has(domain)) return domain
    const base = domain.replace(/\.localhost$/, '')
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}.localhost`
      if (!taken.has(candidate)) return candidate
    }
    throw new Error(`No free domain variant for ${domain}`)
  }

  private async sourceReaderFor(
    sourceType: SourceType,
    sourceRef: string
  ): Promise<{ reader: SourceReader; cleanup: () => void }> {
    if (sourceType === 'linked-folder') return { reader: fsSourceReader(sourceRef), cleanup: () => undefined }
    if (sourceType === 'empty') return { reader: EMPTY_READER, cleanup: () => undefined }
    // managed-git: shallow clone into a temp dir through docker so the host
    // never needs git installed
    const tmp = join(this.userData, 'tmp', `plan-${newRoomId()}`)
    mkdirSync(tmp, { recursive: true })
    const result = await runDocker(
      ['run', '--rm', '-v', `${tmp}:/workspace`, '-w', '/workspace', 'alpine/git', 'clone', '--depth', '1', sourceRef, '.'],
      { timeoutMs: 180_000 }
    )
    if (result.code !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`Could not read repository ${sourceRef}: ${result.stderr.slice(-300)}`)
    }
    return { reader: fsSourceReader(tmp), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
  }

  private appendJournal(
    roomId: string,
    kind: string,
    title: string,
    actor: Actor,
    component: string,
    before: unknown,
    after: unknown
  ): void {
    this.changes.append({
      id: crypto.randomUUID(),
      roomId,
      kind,
      title,
      actor,
      component,
      before,
      after,
      captured: null,
      steps: [],
      verify: { ok: true, detail: 'recorded' },
      undoable: false,
      undoStrategy: 'none',
      status: 'verified',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
  }

  private listBackups(roomId: string): BackupInfo[] {
    const dir = join(this.userData, 'rooms', roomId, 'backups')
    if (!existsSync(dir)) return []
    const out: BackupInfo[] = []
    for (const name of readdirSync(dir)) {
      const service = serviceForBackupId(name)
      if (!service) continue
      let full: string
      try {
        full = resolveRoomBackupFile(this.userData, roomId, service, name)
      } catch {
        continue
      }
      const stat = statSync(full)
      out.push({ id: name, service, size: stat.size, createdAt: stat.mtime.toISOString() })
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
  }

  private async reconcileWindowsRooms(): Promise<void> {
    const windowsRooms = this.rooms.list().filter((room) => room.provider === 'windows')
    if (windowsRooms.length === 0) return
    if (!this.windowsVm) {
      for (const room of windowsRooms) {
        if (room.status === 'preparing') this.rooms.update(room.id, { status: 'broken', hostPort: null })
        else if (room.status !== 'sleeping' && room.status !== 'broken') {
          this.rooms.update(room.id, { status: 'attention', hostPort: null })
        }
      }
      return
    }
    const health = await this.windowsVm.health()
    if (!health.ok) {
      for (const room of windowsRooms) {
        if (room.status === 'preparing') this.rooms.update(room.id, { status: 'broken', hostPort: null })
        else if (room.status !== 'sleeping' && room.status !== 'broken') {
          this.rooms.update(room.id, { status: 'attention', hostPort: null })
        }
      }
      return
    }

    for (const room of windowsRooms) {
      try {
        const state = await this.windowsVm.state(room.id)
        if (state === 'running') await this.windowsVm.sleep(room.id)
        if (room.status === 'preparing' || state === 'missing') {
          this.rooms.update(room.id, { status: 'broken', hostPort: null })
        } else if (room.status !== 'broken') {
          this.rooms.update(room.id, { status: 'sleeping', hostPort: null })
        }
      } catch (error) {
        this.rooms.update(room.id, { status: 'broken', hostPort: null })
        this.olog(room.id, `VMware reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private mustWindowsVm(): WindowsVmLifecycle {
    if (!this.windowsVm) throw new Error('VMware Workstation backend is not configured in this DevHotel build')
    return this.windowsVm
  }

  private mustGet(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    return room
  }

  private olog(roomId: string, line: string): void {
    if (roomId !== 'system') this.logs.orchestrator(roomId, line)
  }

  private emit(roomId: string, kind: OrchestratorEvent['kind'], detail?: string): void {
    this.emitter.emit('event', { roomId, kind, detail } satisfies OrchestratorEvent)
  }
}

function deriveProjectName(sourceType: SourceType, sourceRef: string): string {
  if (sourceType === 'managed-git') {
    return slugify((sourceRef.split('/').pop() ?? 'project').replace(/\.git$/, '')) || 'project'
  }
  if (sourceType === 'linked-folder') {
    return slugify(sourceRef.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'project') || 'project'
  }
  return 'project'
}

function asShutdownError(context: string, error: unknown): Error {
  return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}
