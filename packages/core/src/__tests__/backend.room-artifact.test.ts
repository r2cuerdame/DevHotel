import { createHash } from 'node:crypto'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { srcVolume, webName } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import { RoomArtifactPublicationError } from '../backend/types'
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
const RELATIVE_PATH = 'docs/evidence/login-success.png'
const ok = { code: 0, stdout: '', stderr: '' }

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
      expected
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
      expected
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
      expected
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
      expected
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
      expected
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
    expect(createCalls).toHaveLength(1)
    expect(helpers.has(PRIMARY_ID)).toBe(true)
  })

  it('does not reverse a proven commit when finalizer cleanup remains unavailable', async () => {
    rmRetainsKinds = new Set(['finalizer'])

    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected
    )).resolves.toBeUndefined()
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
      expected
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
      expected
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
      expected
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
      expected
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
      expected
    )).rejects.toMatchObject({ reason: 'publication-ambiguous' })
  })

  it('refuses the wrong workspace generation before creating a helper', async () => {
    webWorkspace = srcVolume(ROOM_ID, REVISION + 1)
    await expect(new OciCliBackend().publishRoomArtifact(
      ROOM_ID,
      REVISION,
      hostPngPath,
      RELATIVE_PATH,
      expected
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
        expected
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
