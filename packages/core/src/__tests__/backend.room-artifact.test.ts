import { createHash } from 'node:crypto'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import {
  androidRuntimeAnchorName,
  cacheVolume,
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  roomNetworkName,
  srcVolume,
  webName,
  wrapStartCommand
} from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import { RoomArtifactPublicationError, type WebSpec } from '../backend/types'
import { ANDROID_IMAGE } from '../providers/androidProvider'
import { tempDir } from './fakes'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const REVISION = 2
const WORKSPACE = srcVolume(ROOM_ID, REVISION)
const WEB_ID = 'a'.repeat(64)
const PRIMARY_ID = 'b'.repeat(64)
const FINALIZER_ID = 'c'.repeat(64)
const STAGE_TOKEN = 'd'.repeat(32)
const RELATIVE_PATH = 'docs/evidence/login-success.png'
const ok = { code: 0, stdout: '', stderr: '' }
const WEB_RUNTIME_FENCE = {
  containerId: WEB_ID,
  workspaceVolume: WORKSPACE,
  runtimeSpecSha256: 'e'.repeat(64),
  volumeSetSha256: '2'.repeat(64),
  networkAuthorityId: 'f'.repeat(64),
  networkId: '3'.repeat(64),
  networkSandboxId: '1'.repeat(64),
  networkAuthorityStartedAt: '2026-09-02T00:00:00.100000001Z'
}

interface HelperState {
  id: string
  name: string
  token: string
  kind: 'primary' | 'finalizer'
  status: 'created' | 'running' | 'exited'
  exitCode: number
  mounts: Array<{ Type: string; Name?: string; Source?: string; Destination: string; RW: boolean }>
}

describe('OciCliBackend atomic Room artifact publication', () => {
  const roots: string[] = []
  let hostPngPath: string
  let expected: { sizeBytes: number; sha256: string }
  let helpers: Map<string, HelperState>
  let helperNames: Map<string, string>
  let createCalls: string[][]
  let webPaused: boolean
  let webRunning: boolean
  let webId: string
  let webWorkspace: string
  let primaryResult: { code: number; stdout: string; stderr: string; outputLimitExceeded?: boolean }
  let primaryThrows: Error | null
  let primaryCreateFailure: string | null
  let finalizerExitCode: number
  let finalizerResult: { code: number; stdout: string; stderr: string; outputLimitExceeded?: boolean }
  let afterPrimaryStart: (() => void) | null
  let afterFinalizerStart: (() => void) | null
  let primaryResidueOnExit: string[]
  let workspaceResidue: Set<string>
  let rmThrowAfterDeleteKinds: Set<HelperState['kind']>
  let rmRetainsKinds: Set<HelperState['kind']>

  const containerForHelper = (helper: HelperState) => ({
    Id: helper.id,
    Name: `/${helper.name}`,
    Config: {
      Image: ANDROID_IMAGE,
      Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'job',
        'devhotel.managed': '1',
        'devhotel.publish-token': helper.token
      }
    },
    State: {
      Status: helper.status,
      Running: helper.status === 'running',
      Paused: false,
      ExitCode: helper.exitCode
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      PidsLimit: 64,
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges']
    },
    Mounts: helper.mounts
  })

  const webContainer = () => ({
    Id: webId,
    Name: `/${webName(ROOM_ID)}`,
    Config: {
      Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'web',
        'devhotel.managed': '1'
      }
    },
    State: {
      Status: webRunning ? (webPaused ? 'paused' : 'running') : 'exited',
      Running: webRunning,
      Paused: webPaused
    },
    Mounts: [{ Type: 'volume', Name: webWorkspace, Destination: '/workspace', RW: true }]
  })

  beforeEach(() => {
    const root = tempDir()
    roots.push(root)
    hostPngPath = join(root, 'private-stage', '..', 'content.png')
    writeFileSync(hostPngPath, Buffer.from('bounded-canonical-png-for-backend-test'))
    const bytes = Buffer.from('bounded-canonical-png-for-backend-test')
    expected = {
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    helpers = new Map()
    helperNames = new Map()
    createCalls = []
    webPaused = true
    webRunning = true
    webId = WEB_ID
    webWorkspace = WORKSPACE
    primaryResult = {
      code: 0,
      stdout: `devhotel-room-artifact-v1\t${expected.sizeBytes}\t${expected.sha256}\n`,
      stderr: ''
    }
    primaryThrows = null
    primaryCreateFailure = null
    finalizerExitCode = 0
    finalizerResult = {
      code: 0,
      stdout: `devhotel-room-artifact-finalize-v1\tcommitted\t${expected.sizeBytes}\t${expected.sha256}\n`,
      stderr: ''
    }
    afterPrimaryStart = null
    afterFinalizerStart = null
    primaryResidueOnExit = ['stage', 'destination']
    workspaceResidue = new Set()
    rmThrowAfterDeleteKinds = new Set()
    rmRetainsKinds = new Set()

    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return args[2] === WORKSPACE
          ? {
              code: 0,
              stdout: JSON.stringify([{
                Name: WORKSPACE,
                Labels: {
                  'devhotel.room': ROOM_ID,
                  'devhotel.role': 'volume',
                  'devhotel.managed': '1'
                }
              }]),
              stderr: ''
            }
          : { code: 1, stdout: '', stderr: 'No such volume' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'inspect') {
        const target = args[1]!
        if (target === webName(ROOM_ID)) {
          return { code: 0, stdout: JSON.stringify([webContainer()]), stderr: '' }
        }
        if (target === WEB_ID) {
          return webId === WEB_ID
            ? { code: 0, stdout: JSON.stringify([webContainer()]), stderr: '' }
            : { code: 1, stdout: '', stderr: 'No such container' }
        }
        const helperId = helpers.has(target) ? target : helperNames.get(target)
        const helper = helperId ? helpers.get(helperId) : undefined
        return helper
          ? { code: 0, stdout: JSON.stringify([containerForHelper(helper)]), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'create') {
        createCalls.push(args)
        const kind = args.includes('devhotel-room-artifact-finalize') ? 'finalizer' : 'primary'
        if (kind === 'primary' && primaryCreateFailure !== null) {
          return { code: 1, stdout: '', stderr: primaryCreateFailure }
        }
        const id = kind === 'primary' ? PRIMARY_ID : FINALIZER_ID
        const name = args[args.indexOf('--name') + 1]!
        const tokenLabel = args.find((arg) => arg.startsWith('devhotel.publish-token='))!
        const token = tokenLabel.slice('devhotel.publish-token='.length)
        const mounts: HelperState['mounts'] = [
          { Type: 'volume', Name: WORKSPACE, Destination: '/workspace', RW: true }
        ]
        if (kind === 'primary') {
          mounts.push({
            Type: 'bind',
            Source: realpathSync.native(hostPngPath),
            Destination: '/devhotel-input/content.png',
            RW: false
          })
        }
        const helper: HelperState = { id, name, token, kind, status: 'created', exitCode: 0, mounts }
        helpers.set(id, helper)
        helperNames.set(name, id)
        return { code: 0, stdout: `${id}\n`, stderr: '' }
      }
      if (args[0] === 'start' && args[1] === '-a') {
        const helper = helpers.get(args[2]!)!
        helper.status = 'exited'
        if (helper.kind === 'primary') {
          helper.exitCode = primaryResult.code
          workspaceResidue = new Set(primaryResidueOnExit)
          afterPrimaryStart?.()
          if (primaryThrows) throw primaryThrows
          if (primaryResult.code !== 0) workspaceResidue.clear()
          return primaryResult
        }
        helper.exitCode = finalizerExitCode
        afterFinalizerStart?.()
        if (finalizerExitCode === 83) workspaceResidue.add('unresolved-finalizer-state')
        else workspaceResidue.clear()
        return finalizerResult
      }
      if (args[0] === 'stop') {
        const helper = helpers.get(args.at(-1)!)
        if (helper) {
          helper.status = 'exited'
          helper.exitCode = 143
        }
        return ok
      }
      if (args[0] === 'rm') {
        const id = args.at(-1)!
        const helper = helpers.get(id)
        if (helper && rmRetainsKinds.has(helper.kind)) {
          throw new Error(`lost rm response while ${helper.kind} remained`)
        }
        if (helper) helperNames.delete(helper.name)
        helpers.delete(id)
        if (helper && rmThrowAfterDeleteKinds.has(helper.kind)) {
          throw new Error(`lost rm response after ${helper.kind} deletion`)
        }
        return ok
      }
      return ok
    })
  })

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('uses exact isolated helper IDs and an authoritative same-inode finalizer', async () => {
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).resolves.toBeUndefined()

    expect(createCalls).toHaveLength(2)
    const primary = createCalls[0]!
    expect(primary).toEqual(expect.arrayContaining([
      'create', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
      '--mount', `type=volume,source=${WORKSPACE},target=/workspace`,
      '--mount', `type=bind,source=${realpathSync.native(hostPngPath)},target=/devhotel-input/content.png,readonly`,
      ANDROID_IMAGE, 'devhotel-room-artifact-publish', '/workspace', '/devhotel-input/content.png',
      RELATIVE_PATH, String(expected.sizeBytes), expected.sha256
    ]))
    const primaryScript = primary[primary.indexOf('-c') + 1]!
    expect(primaryScript).toContain('ln -- "$stage" "$destination"')
    expect(primaryScript).toContain('[ "$destination_identity" = "$stage_device $stage_inode $expected_size" ]')
    expect(primaryScript).toContain('destination_sha=$(sha256sum -- "$destination"')
    expect(primaryScript).toContain('assert_source\npublished=1')
    expect(primaryScript).not.toContain('mkdir -p')
    expect(primaryScript).not.toContain('mkdir ')
    expect(primaryScript).not.toContain('mv -T')
    expect(primaryScript).not.toContain('dir_marker_name=')
    expect(primaryScript).toContain('[ -d "$next" ] && [ ! -L "$next" ]')

    const finalizer = createCalls[1]!
    expect(finalizer).toEqual(expect.arrayContaining([
      '--network', 'none', '--cap-drop', 'ALL', '--read-only',
      '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
      '--mount', `type=volume,source=${WORKSPACE},target=/workspace`,
      ANDROID_IMAGE, 'devhotel-room-artifact-finalize', '/workspace', RELATIVE_PATH,
      String(expected.sizeBytes), expected.sha256
    ]))
    expect(finalizer.some((arg) => arg.includes('/devhotel-input/content.png'))).toBe(false)
    const finalizerScript = finalizer[finalizer.indexOf('-c') + 1]!
    const identityProof = finalizerScript.indexOf(
      '[ "$destination_identity" = "$stage_device $stage_inode $expected_size" ]'
    )
    const commitStageRemoval = finalizerScript.indexOf('rm -f -- "$stage"', identityProof)
    expect(identityProof).toBeLessThan(commitStageRemoval)
    expect(commitStageRemoval)
      .toBeLessThan(finalizerScript.lastIndexOf('destination_sha=$(sha256sum -- "$destination"'))
    expect(finalizerScript).not.toContain('mkdir ')
    expect(finalizerScript).not.toContain('dir_marker_name=')
    expect(finalizerScript).toContain('if [ "$committed" -eq 1 ]; then exit 0; fi')
    expect(finalizerScript).toContain('if [ "$committed" -ne 1 ] && [ "$status" -eq 0 ]; then status=83; fi')

    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'start').map(([args]) => args[2]))
      .toEqual([PRIMARY_ID, FINALIZER_ID])
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'rm').map(([args]) => args.at(-1)))
      .toEqual([PRIMARY_ID, FINALIZER_ID])
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'exec')).toBe(false)
    expect(workspaceResidue.size).toBe(0)
    for (const [, opts] of mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'start')) {
      expect(opts).toMatchObject({ maxStdoutBytes: 256, maxStderrBytes: 8 * 1024 })
      expect(opts?.timeoutMs).toEqual(expect.any(Number))
    }
  })

  it('settles a durable interrupted publication without requiring a live web container', async () => {
    webRunning = false

    await expect(new OciCliBackend().reconcileRoomArtifactPublication(
      ROOM_ID,
      REVISION,
      RELATIVE_PATH,
      expected,
      STAGE_TOKEN
    )).resolves.toBe('committed')

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toEqual(expect.arrayContaining([
      'devhotel-room-artifact-finalize', '/workspace', RELATIVE_PATH,
      String(expected.sizeBytes), expected.sha256, STAGE_TOKEN
    ]))
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'inspect' && args[1] === webName(ROOM_ID))).toBe(false)
    expect(workspaceResidue.size).toBe(0)
  })

  it.each([
    { primaryCode: 73, finalizerCode: 81, reason: 'destination-exists' },
    { primaryCode: 72, finalizerCode: 82, reason: 'unsafe-parent' },
    { primaryCode: 75, finalizerCode: 83, reason: 'publication-ambiguous' }
  ] as const)('fails closed for $reason and cleans both exact helpers', async ({ primaryCode, finalizerCode, reason }) => {
    primaryResult = { code: primaryCode, stdout: '', stderr: '' }
    finalizerExitCode = finalizerCode
    finalizerResult = { code: finalizerCode, stdout: '', stderr: '' }

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({
      name: 'RoomArtifactPublicationError',
      reason
    } satisfies Partial<RoomArtifactPublicationError>)
    expect(helpers.size).toBe(0)
    expect(workspaceResidue.size === 0).toBe(reason !== 'publication-ambiguous')
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'rm').map(([args]) => args.at(-1)))
      .toEqual([PRIMARY_ID, FINALIZER_ID])
  })

  it('accepts a proven commit when the primary attach response is lost after linking', async () => {
    primaryThrows = new Error('docker attach response was lost after the helper linked its exact stage')

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).resolves.toBeUndefined()
    expect(createCalls).toHaveLength(2)
    expect(helpers.size).toBe(0)
    expect(workspaceResidue.size).toBe(0)
  })

  it('reconciles primary and finalizer rm response loss by exact-ID absence', async () => {
    rmThrowAfterDeleteKinds = new Set(['primary', 'finalizer'])

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).resolves.toBeUndefined()
    expect(createCalls).toHaveLength(2)
    expect(helpers.size).toBe(0)
    expect(workspaceResidue.size).toBe(0)
  })

  it('reports an ambiguous publication when the primary exact ID cannot be removed', async () => {
    rmRetainsKinds = new Set(['primary'])

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
    expect(createCalls).toHaveLength(1)
    expect(helpers.has(PRIMARY_ID)).toBe(true)
  })

  it('keeps a proven commit ambiguous while its restartable finalizer remains', async () => {
    rmRetainsKinds = new Set(['finalizer'])

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
    expect(helpers.has(PRIMARY_ID)).toBe(false)
    expect(helpers.has(FINALIZER_ID)).toBe(true)
    expect(workspaceResidue.size).toBe(0)
  })

  it('treats the finalizer proof as authoritative if the Host-private source later changes', async () => {
    afterPrimaryStart = () => {
      writeFileSync(hostPngPath, Buffer.from('changed after the primary helper exited'))
    }

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).resolves.toBeUndefined()

    afterPrimaryStart = null
    afterFinalizerStart = () => {
      writeFileSync(hostPngPath, Buffer.from('changed after the finalizer committed'))
    }
    writeFileSync(hostPngPath, Buffer.from('bounded-canonical-png-for-backend-test'))
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).resolves.toBeUndefined()
  })

  it('rolls back a killed transaction before linking without creating parent directories', async () => {
    primaryThrows = new Error('attach lost before the exclusive destination link')
    primaryResidueOnExit = ['stage']
    finalizerExitCode = 80
    finalizerResult = {
      code: 80,
      stdout: 'devhotel-room-artifact-finalize-v1\tabsent\n',
      stderr: ''
    }

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'helper-failed' })
    expect(workspaceResidue.size).toBe(0)
    expect(helpers.size).toBe(0)
  })

  it('rejects a pause or immutable-web change before final acceptance', async () => {
    afterPrimaryStart = () => { webPaused = false }
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
    expect(createCalls).toHaveLength(1)

    mockedRunDocker.mockClear()
    webPaused = true
    afterPrimaryStart = () => { webId = 'd'.repeat(64) }
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
  })

  it('refuses the wrong workspace generation before creating a helper', async () => {
    webWorkspace = srcVolume(ROOM_ID, REVISION + 1)
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected,
      undefined,
      WEB_RUNTIME_FENCE
    )).rejects.toMatchObject({ reason: 'fence-changed' })
    expect(createCalls).toEqual([])
  })

  it('proves running-and-unpaused from one exact owned inspect', async () => {
    const backend = new OciCliBackend()
    await expect(backend.webRunningUnpaused(ROOM_ID)).resolves.toBe(false)

    webPaused = false
    await expect(backend.webRunningUnpaused(ROOM_ID)).resolves.toBe(true)

    webRunning = false
    await expect(backend.webRunningUnpaused(ROOM_ID)).resolves.toBe(false)
    expect(mockedRunDocker.mock.calls.every(([args]) => args[0] === 'inspect')).toBe(true)
  })

  it('redacts the private Host path and basename from Docker and filesystem failures', async () => {
    primaryCreateFailure =
      `invalid bind source ${realpathSync.native(hostPngPath)} (${hostPngPath.replaceAll('\\', '/')})`
    finalizerExitCode = 80
    finalizerResult = {
      code: 80,
      stdout: 'devhotel-room-artifact-finalize-v1\tabsent\n',
      stderr: ''
    }

    let thrown: unknown
    try {
      await new OciCliBackend().publishRoomArtifact(
        ROOM_ID,
        REVISION,
        hostPngPath,
        RELATIVE_PATH,
        expected,
        undefined,
        WEB_RUNTIME_FENCE
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RoomArtifactPublicationError)
    const rendered = `${String(thrown)}\n${thrown instanceof Error ? thrown.stack ?? '' : ''}`
    expect(rendered).not.toContain(realpathSync.native(hostPngPath))
    expect(rendered).not.toContain(hostPngPath.replaceAll('\\', '/'))
    expect(rendered).not.toContain('content.png')
    expect(rendered).toContain('[private screenshot stage]')
  })
})

describe('OciCliBackend immutable Room artifact web runtime fence', () => {
  const RUNTIME_ANCHOR_ID = '2'.repeat(64)
  const NETWORK_ID = '3'.repeat(64)
  const RUNTIME_SANDBOX_ID = '4'.repeat(64)
  const RECREATED_WEB_ID = '5'.repeat(64)
  const IMAGE_CONTENT_ID = `sha256:${'6'.repeat(64)}`
  const RACE_REPLACEMENT_ID = '7'.repeat(64)
  const SDK_VOLUME = `dh-${ROOM_ID}-sdk`
  const CACHE_VOLUME = cacheVolume(ROOM_ID)
  const spec: WebSpec = {
    roomId: ROOM_ID,
    internalPort: 6080,
    nodeMajor: '17',
    sourceType: 'managed-git',
    sourceRef: 'https://example.invalid/android.git',
    workspaceMode: 'hotel',
    workspaceVolumeRevision: REVISION,
    startCommand: 'sleep 2147483647',
    env: { GRADLE_USER_HOME: '/cache/gradle' },
    imageOverride: ANDROID_IMAGE,
    androidRuntimeIsolation: true,
    noDepsVolume: true,
    extraVolumes: [{ volume: SDK_VOLUME, path: '/opt/android-sdk' }],
    cpus: 0.5,
    memoryMB: 256
  }

  interface RuntimeWebState {
    id: string
    name: string
    present: boolean
    status: 'created' | 'running' | 'paused' | 'exited'
    running: boolean
    paused: boolean
    image: string
    imageContentId: string
    workingDir: string
    cmd: string[]
    env: string[]
    entrypoint: string[]
    workspace: string
    networkMode: string
    memory: number
    nanoCpus: number
    mountSources: Record<string, string>
    mountSubpaths: Record<string, string>
    restoreToken?: string
  }

  let web: RuntimeWebState
  let createResponseLost: boolean
  let startResponseLost: boolean
  let createWithoutToken: boolean
  let renameDuringFailedStart: boolean
  let createCalls: string[][]
  let networkId: string
  let volumeCreatedAt: Record<string, string>
  let raceAfterUnpause: boolean
  let raceAfterStart: boolean
  let replaceOnNextNetworkInspect: boolean
  let replaceNetworkDuringAuthorityInspect: boolean
  let joinedWebSandboxId: string
  let authorityStartedAt: string
  let driftAuthorityAfterNextWebInspect: boolean

  const volumeMountpoint = (name: string): string => `/var/lib/docker/volumes/${name}/_data`

  const initialWeb = (): RuntimeWebState => ({
    id: WEB_ID,
    name: webName(ROOM_ID),
    present: true,
    status: 'running',
    running: true,
    paused: false,
    image: ANDROID_IMAGE,
    imageContentId: IMAGE_CONTENT_ID,
    workingDir: '/workspace',
    cmd: ['sh', '-lc', wrapStartCommand(spec.startCommand)],
    env: [
      'IMAGE_DEFAULT=retained-and-fingerprinted',
      'npm_config_cache=/cache/npm',
      'PNPM_HOME=/cache/pnpm',
      'GRADLE_USER_HOME=/cache/gradle',
      'DUPLICATE_ENV=first',
      'DUPLICATE_ENV=second'
    ],
    entrypoint: ['/usr/local/bin/android-entrypoint'],
    workspace: WORKSPACE,
    networkMode: `container:${RUNTIME_ANCHOR_ID}`,
    memory: 256 * 1024 * 1024,
    nanoCpus: 500_000_000,
    mountSources: {
      [WORKSPACE]: volumeMountpoint(WORKSPACE),
      [CACHE_VOLUME]: volumeMountpoint(CACHE_VOLUME),
      [SDK_VOLUME]: volumeMountpoint(SDK_VOLUME)
    },
    mountSubpaths: {}
  })

  const runtimeAnchor = () => ({
    Id: RUNTIME_ANCHOR_ID,
    Name: `/${androidRuntimeAnchorName(ROOM_ID)}`,
    Config: {
      Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'android-runtime-anchor',
        'devhotel.managed': '1'
      }
    },
    State: {
      Status: 'running',
      Running: true,
      Paused: false,
      StartedAt: authorityStartedAt
    },
    HostConfig: { NetworkMode: roomNetworkName(ROOM_ID) },
    NetworkSettings: {
      SandboxID: RUNTIME_SANDBOX_ID,
      Networks: {
        [roomNetworkName(ROOM_ID)]: { NetworkID: networkId }
      }
    }
  })

  const webContainer = () => ({
    Id: web.id,
    Image: web.imageContentId,
    Name: `/${web.name}`,
    Config: {
      Image: web.image,
      WorkingDir: web.workingDir,
      Cmd: web.cmd,
      Env: web.env,
      Entrypoint: web.entrypoint,
      User: '',
      Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'web',
        'devhotel.managed': '1',
        [NETWORK_AUTHORITY_SANDBOX_LABEL]: RUNTIME_SANDBOX_ID,
        ...(web.restoreToken ? { 'devhotel.artifact-restore-token': web.restoreToken } : {})
      }
    },
    State: {
      Status: web.status,
      Running: web.running,
      Paused: web.paused
    },
    HostConfig: {
      NetworkMode: web.networkMode,
      ReadonlyRootfs: false,
      PidsLimit: 0,
      Memory: web.memory,
      NanoCpus: web.nanoCpus,
      CapDrop: ['NET_RAW'],
      SecurityOpt: []
    },
    NetworkSettings: { SandboxID: web.running ? joinedWebSandboxId : '' },
    Mounts: [
      {
        Type: 'volume', Name: web.workspace, Source: web.mountSources[web.workspace],
        Destination: '/workspace', RW: true, SubPath: web.mountSubpaths[web.workspace]
      },
      {
        Type: 'volume', Name: CACHE_VOLUME, Source: web.mountSources[CACHE_VOLUME],
        Destination: '/cache', RW: true, SubPath: web.mountSubpaths[CACHE_VOLUME]
      },
      {
        Type: 'volume', Name: SDK_VOLUME, Source: web.mountSources[SDK_VOLUME],
        Destination: '/opt/android-sdk', RW: true, SubPath: web.mountSubpaths[SDK_VOLUME]
      }
    ]
  })

  beforeEach(() => {
    web = initialWeb()
    createResponseLost = false
    startResponseLost = false
    createWithoutToken = false
    renameDuringFailedStart = false
    createCalls = []
    networkId = NETWORK_ID
    volumeCreatedAt = {
      [WORKSPACE]: '2026-08-30T10:00:00.000000000Z',
      [CACHE_VOLUME]: '2026-08-30T10:00:01.000000000Z',
      [SDK_VOLUME]: '2026-08-30T10:00:02.000000000Z'
    }
    raceAfterUnpause = false
    raceAfterStart = false
    replaceOnNextNetworkInspect = false
    replaceNetworkDuringAuthorityInspect = false
    joinedWebSandboxId = ''
    authorityStartedAt = '2026-09-02T00:00:00.100000001Z'
    driftAuthorityAfterNextWebInspect = false
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        const name = args[2]!
        if (![WORKSPACE, CACHE_VOLUME, SDK_VOLUME].includes(name)) {
          return { code: 1, stdout: '', stderr: 'No such volume' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: name,
            CreatedAt: volumeCreatedAt[name],
            Driver: 'local',
            Scope: 'local',
            Mountpoint: volumeMountpoint(name),
            Labels: {
              'devhotel.room': ROOM_ID,
              'devhotel.role': 'volume',
              'devhotel.managed': '1'
            },
            Options: null
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        const target = args[2]!
        if (target !== roomNetworkName(ROOM_ID) && target !== networkId) {
          return { code: 1, stdout: '', stderr: 'No such network' }
        }
        if (replaceOnNextNetworkInspect) {
          replaceOnNextNetworkInspect = false
          web = {
            ...initialWeb(),
            id: RACE_REPLACEMENT_ID,
            workspace: srcVolume(ROOM_ID, REVISION + 1)
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: networkId,
            Name: roomNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: {
              'devhotel.room': ROOM_ID,
              'devhotel.role': 'network',
              'devhotel.managed': '1'
            },
            Containers: {
              [RUNTIME_ANCHOR_ID]: { Name: androidRuntimeAnchorName(ROOM_ID) }
            }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        const target = args[1]!
        if (target === RUNTIME_ANCHOR_ID || target === androidRuntimeAnchorName(ROOM_ID)) {
          if (replaceNetworkDuringAuthorityInspect) {
            replaceNetworkDuringAuthorityInspect = false
            networkId = '9'.repeat(64)
          }
          return { code: 0, stdout: JSON.stringify([runtimeAnchor()]), stderr: '' }
        }
        const foundById = target === web.id
        const foundByName = target === webName(ROOM_ID) && web.name === webName(ROOM_ID)
        if (!web.present || (!foundById && !foundByName)) {
          return { code: 1, stdout: '', stderr: 'No such container' }
        }
        const inspected = webContainer()
        if (driftAuthorityAfterNextWebInspect) {
          driftAuthorityAfterNextWebInspect = false
          authorityStartedAt = '2026-09-02T00:00:01.100000001Z'
        }
        return { code: 0, stdout: JSON.stringify([inspected]), stderr: '' }
      }
      if (args[0] === 'pause') {
        if (!web.present || args[1] !== web.id) return { code: 1, stdout: '', stderr: 'wrong container' }
        web.running = true
        web.paused = true
        web.status = 'paused'
        return ok
      }
      if (args[0] === 'unpause') {
        if (!web.present || args[1] !== web.id) return { code: 1, stdout: '', stderr: 'wrong container' }
        web.running = true
        web.paused = false
        web.status = 'running'
        if (raceAfterUnpause) replaceOnNextNetworkInspect = true
        return ok
      }
      if (args[0] === 'rm') {
        if (web.present && args.at(-1) === web.id) web.present = false
        return ok
      }
      if (args[0] === 'create' && args[args.indexOf('--name') + 1] === webName(ROOM_ID)) {
        createCalls.push(args)
        const restoreLabel = args.find((arg) => arg.startsWith('devhotel.artifact-restore-token='))
        web = {
          ...initialWeb(),
          id: RECREATED_WEB_ID,
          status: 'created',
          running: false,
          paused: false,
          restoreToken: createWithoutToken
            ? undefined
            : restoreLabel?.slice('devhotel.artifact-restore-token='.length)
        }
        if (createResponseLost) throw new Error('lost create response after exact container creation')
        return { code: 0, stdout: `${RECREATED_WEB_ID}\n`, stderr: '' }
      }
      if (args[0] === 'start') {
        if (!web.present || args[1] !== web.id) return { code: 1, stdout: '', stderr: 'wrong container' }
        if (renameDuringFailedStart) {
          web.name = 'concurrently-renamed-web'
          throw new Error('lost start response before the runtime became live')
        }
        web.running = true
        web.paused = false
        web.status = 'running'
        if (raceAfterStart) replaceOnNextNetworkInspect = true
        if (startResponseLost) throw new Error('lost start response after exact container start')
        return ok
      }
      return ok
    })
  })

  it('captures, pauses, and restores only the immutable full web ID', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)

    expect(fence).toMatchObject({
      containerId: WEB_ID,
      workspaceVolume: WORKSPACE,
      networkAuthorityId: RUNTIME_ANCHOR_ID,
      networkId: NETWORK_ID,
      networkSandboxId: RUNTIME_SANDBOX_ID,
      networkAuthorityStartedAt: authorityStartedAt,
      runtimeSpecSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      volumeSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    await backend.pauseRoomArtifactWeb(spec, fence)
    await backend.restoreRoomArtifactWeb(spec, fence)

    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'pause' && args[1] === WEB_ID)).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'unpause' && args[1] === WEB_ID)).toBe(true)
    expect(web.running).toBe(true)
    expect(web.paused).toBe(false)
    expect(createCalls).toEqual([])
  })

  it('rejects a runtime authority restart after the exact web proof', async () => {
    driftAuthorityAfterNextWebInspect = true
    await expect(new OciCliBackend().captureRoomArtifactWebFence(spec))
      .rejects.toThrow(/network authority changed after web runtime proof/)
  })

  it('persists the runtime authority start generation across artifact calls', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    authorityStartedAt = '2026-09-02T00:00:01.100000001Z'

    await expect(backend.pauseRoomArtifactWeb(spec, fence))
      .rejects.toThrow(/network authority start generation changed/)
    await expect(backend.restoreRoomArtifactWeb(spec, fence))
      .rejects.toThrow(/network authority start generation changed/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'pause' || args[0] === 'unpause')).toBe(false)
  })

  it('rejects a non-empty joined sandbox that differs from its exact runtime authority', async () => {
    joinedWebSandboxId = '9'.repeat(64)
    await expect(new OciCliBackend().captureRoomArtifactWebFence(spec))
      .rejects.toThrow(/exact fenced network namespace/)
  })

  it.each([
    ['workspace', (state: RuntimeWebState) => { state.workspace = srcVolume(ROOM_ID, REVISION + 1) }],
    ['image', (state: RuntimeWebState) => { state.image = `${ANDROID_IMAGE}-replacement` }],
    ['workdir', (state: RuntimeWebState) => { state.workingDir = '/tmp' }],
    ['command', (state: RuntimeWebState) => { state.cmd = ['sh', '-lc', 'sleep infinity'] }],
    ['environment', (state: RuntimeWebState) => { state.env = ['npm_config_cache=/wrong'] }],
    ['limits', (state: RuntimeWebState) => { state.memory = 128 * 1024 * 1024 }],
    ['network', (state: RuntimeWebState) => { state.networkMode = `container:${'9'.repeat(64)}` }],
    ['mount source', (state: RuntimeWebState) => {
      state.mountSources[WORKSPACE] = `${volumeMountpoint(WORKSPACE)}/nested`
    }],
    ['volume subpath', (state: RuntimeWebState) => { state.mountSubpaths[WORKSPACE] = 'nested' }]
  ])('rejects a same-name owned web with the wrong %s before capture', async (_field, mutate) => {
    mutate(web)
    await expect(new OciCliBackend().captureRoomArtifactWebFence(spec)).rejects.toThrow()
  })

  it('rejects a same-name exact-spec replacement with a different immutable ID', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web = { ...initialWeb(), id: '9'.repeat(64) }

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/same-name/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
  })

  it('rejects a same-ID runtime mutation through the captured runtime fingerprint', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.entrypoint = ['/concurrent/replacement-entrypoint']

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/fingerprint/)
  })

  it('keeps duplicate environment entry order in the runtime fingerprint', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    const first = web.env.indexOf('DUPLICATE_ENV=first')
    const second = web.env.indexOf('DUPLICATE_ENV=second')
    ;[web.env[first], web.env[second]] = [web.env[second]!, web.env[first]!]

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/fingerprint/)
  })

  it('rejects a changed immutable image content ID', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.imageContentId = `sha256:${'8'.repeat(64)}`

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/fingerprint/)
  })

  it('rejects a recreated same-name volume instance with a new CreatedAt identity', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    volumeCreatedAt[WORKSPACE] = '2026-08-31T10:00:00.000000000Z'

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/volume instance identity/)
  })

  it('rejects a recreated underlying Room bridge with the same name', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    networkId = '9'.repeat(64)

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/bridge network identity/)
  })

  it('rejects a disconnect-and-recreate race between network and authority inspection', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    replaceNetworkDuringAuthorityInspect = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/bridge identity/)
    expect(networkId).toBe('9'.repeat(64))
  })

  it('freshly inspects the exact original ID after awaited unpause proofs', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    raceAfterUnpause = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow(/same-name/)
    expect(web.id).toBe(RACE_REPLACEMENT_ID)
    expect(web.workspace).toBe(srcVolume(ROOM_ID, REVISION + 1))
  })

  it('freshly inspects the exact recreated ID after awaited start proofs', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.running = false
    web.paused = false
    web.status = 'exited'
    raceAfterStart = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow()
    expect(web.id).toBe(RACE_REPLACEMENT_ID)
    expect(web.workspace).toBe(srcVolume(ROOM_ID, REVISION + 1))
  })

  it('reconciles create and start response loss only with a one-time token and exact recreated ID', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.running = false
    web.paused = false
    web.status = 'exited'
    createResponseLost = true
    startResponseLost = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).resolves.toBeUndefined()

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toContainEqual(expect.stringMatching(/^devhotel\.artifact-restore-token=[a-f0-9]{32}$/))
    expect(createCalls[0]).toEqual(expect.arrayContaining([
      '--network', `container:${RUNTIME_ANCHOR_ID}`
    ]))
    expect(createCalls[0]).toContain(`${NETWORK_AUTHORITY_SANDBOX_LABEL}=${RUNTIME_SANDBOX_ID}`)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args.at(-1) === WEB_ID)).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start' && args[1] === RECREATED_WEB_ID)).toBe(true)
    expect(web).toMatchObject({ id: RECREATED_WEB_ID, present: true, running: true, paused: false })
  })

  it('does not accept a create-response replacement without the one-time restore token', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.running = false
    web.paused = false
    web.status = 'exited'
    createResponseLost = true
    createWithoutToken = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow()
    expect(web.present).toBe(true)
    expect(mockedRunDocker.mock.calls.some(
      ([args]) => args[0] === 'start' && args[1] === RECREATED_WEB_ID
    )).toBe(false)
  })

  it('cleans its exact token-created ID even after a concurrent rename', async () => {
    const backend = new OciCliBackend()
    const fence = await backend.captureRoomArtifactWebFence(spec)
    await backend.pauseRoomArtifactWeb(spec, fence)
    web.running = false
    web.paused = false
    web.status = 'exited'
    renameDuringFailedStart = true

    await expect(backend.restoreRoomArtifactWeb(spec, fence)).rejects.toThrow()
    expect(mockedRunDocker.mock.calls.some(
      ([args]) => args[0] === 'rm' && args.at(-1) === RECREATED_WEB_ID
    )).toBe(true)
    expect(web.present).toBe(false)
  })
})
