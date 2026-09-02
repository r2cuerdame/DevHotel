import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import {
  anchorName,
  androidControlNetworkName,
  androidRuntimeAnchorName,
  emulatorName,
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  NETWORK_AUTHORITY_STARTED_AT_LABEL,
  roomNetworkName,
  webName,
  workspaceSnapshotVolume
} from '../backend/naming'
import {
  importHostFolderScript,
  OciCliBackend,
  workspaceSnapshotScript,
  workspaceTransactionalFingerprintScript
} from '../backend/ociCli'
import { tempDir } from './fakes'
import { ANDROID_IMAGE } from '../providers/androidProvider'

vi.mock('../backend/cli', () => ({
  getPinnedDockerRuntime: vi.fn(() => ({ context: 'test-context' })),
  runDocker: vi.fn()
}))

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const OPERATION_ID = '11111111-2222-4333-8444-555555555555'
const SNAPSHOT = workspaceSnapshotVolume(ROOM_ID, OPERATION_ID)
const ok = { code: 0, stdout: '', stderr: '' }
const SCREENSHOT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const SCREENSHOT_BASE64_LIMIT = Math.ceil(SCREENSHOT_ARTIFACT_MAX_BYTES / 3) * 4

function volumeInspect(): string {
  return JSON.stringify([{
    Name: SNAPSHOT,
    Labels: {
      'devhotel.room': ROOM_ID,
      'devhotel.role': 'volume',
      'devhotel.managed': '1'
    }
  }])
}

describe('OciCliBackend Android artifact export', () => {
  let buildInputDigest: string

  beforeEach(() => {
    buildInputDigest = 'e'.repeat(64)
    mockedRunDocker.mockReset()
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return args[2] === SNAPSHOT
          ? { code: 0, stdout: volumeInspect(), stderr: '' }
          : { code: 1, stdout: '', stderr: 'Error: No such volume' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        if (args.at(-1)?.includes('transaction_paths=$(mktemp)')) {
          return { code: 0, stdout: `${buildInputDigest}  /tmp/transaction-records\n`, stderr: '' }
        }
        if (args.at(-1)?.includes('sync_paths=$(mktemp)')) {
          return { code: 0, stdout: `fingerprint\t${buildInputDigest}\n`, stderr: '' }
        }
        if (args.at(-1)?.includes('records=$(mktemp)')) {
          return { code: 0, stdout: `${buildInputDigest}  /tmp/records\n`, stderr: '' }
        }
        const mount = args.find((arg) => arg.endsWith(':/out'))!
        const output = mount.slice(0, -':/out'.length)
        const apk = join(output, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
        const metadata = join(dirname(apk), 'output-metadata.json')
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, 'verified-apk')
        writeFileSync(metadata, '{}')
        return {
          code: 0,
          stdout: 'devhotel-android-export-v1\t1\t14\t1\n',
          stderr: ''
        }
      }
      return ok
    })
  })

  it('digests every build-consumed path with NUL-safe path ordering and explicit symlink handling', async () => {
    const backend = new OciCliBackend()
    await expect(backend.fingerprintBuildInput(ROOM_ID, SNAPSHOT)).resolves.toBe('e'.repeat(64))
    const run = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')?.[0]
    const script = run?.at(-1) ?? ''
    expect(script).toContain('find . -mindepth 1 -print0 > "$paths"; sort -z "$paths" > "$sorted"')
    expect(script).toContain('done < "$sorted"')
    expect(script).not.toContain('find . -mindepth 1 -print0 |')
    expect(script).toContain('readlink')
    expect(script).toContain("kind=F")
    expect(script).not.toContain("! -path")
    expect(script).not.toContain("build/outputs")
    expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'NET_RAW']))
    expect(run).not.toContain('ALL')
    expect(run).not.toContain('no-new-privileges')

    // Regression: unlike the sync fingerprint, a change under build/ or
    // .gradle is part of this contract and therefore changes the helper digest.
    buildInputDigest = 'f'.repeat(64)
    await expect(backend.fingerprintBuildInput(ROOM_ID, SNAPSHOT)).resolves.toBe('f'.repeat(64))
  })

  it('keeps Git control state in the NUL-safe transactional fingerprint while pruning Git objects', async () => {
    const backend = new OciCliBackend()
    await expect(backend.fingerprintWorkspace(ROOM_ID, 0, SNAPSHOT)).resolves.toBe('e'.repeat(64))
    const run = mockedRunDocker.mock.calls.find(
      ([args]) => args[0] === 'run' && args.at(-1)?.includes('transaction_paths=$(mktemp)')
    )?.[0]
    const script = run?.at(-1) ?? ''
    expect(script).toContain('-print0 > "$transaction_paths"')
    expect(script).toContain('sort -zu "$transaction_paths" > "$transaction_sorted"')
    expect(script).toContain('done < "$transaction_sorted"')
    expect(script).toContain("-path '*/.git/objects'")
    expect(script).not.toContain("-name '.git'")
    expect(script).toContain('find "./$include" -print0 >> "$transaction_paths"')
    expect(script).toContain('.devhotel-sync-include')
    expect(script).toContain('readlink -n')
    expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'NET_RAW']))
  })

  it('makes the filtered source snapshot NUL-safe and fails closed when listing or hashing fails', async () => {
    const backend = new OciCliBackend()
    await expect(backend.snapshotWorkspace(ROOM_ID, 0, SNAPSHOT)).resolves.toMatchObject({
      fingerprint: 'e'.repeat(64),
      entries: []
    })
    const run = mockedRunDocker.mock.calls.find(
      ([args]) => args[0] === 'run' && args.at(-1)?.includes('sync_paths=$(mktemp)')
    )?.[0]
    const script = run?.at(-1) ?? ''
    expect(script).toContain('-print0 > "$sync_paths"')
    expect(script).toContain('sort -zu "$sync_paths" > "$sync_sorted"')
    expect(script).toContain('done < "$sync_sorted"')
    expect(script).not.toContain('-print |')
    expect(script).toContain('readlink -n')
    expect(script).toContain('.devhotel-sync-include')
    for (const generated of ['build', '.gradle', '.kotlin', '.cxx', '.externalNativeBuild', 'target']) {
      expect(script).toContain(`-name '${generated}'`)
    }
    expect(script).toContain("! -name '*.apk' ! -name '*.aab'")
    expect(script.indexOf('-prune -o')).toBeLessThan(script.indexOf('-print0 > "$sync_paths"'))
    expect(script).toContain('find "./$include" \\( -type f -o -type l \\) -print0 >> "$sync_paths"')
    expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'NET_RAW']))

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') return { code: 1, stdout: '', stderr: 'find: permission denied' }
      return ok
    })
    await expect(backend.fingerprintWorkspace(ROOM_ID, 0, SNAPSHOT)).rejects.toThrow(/permission denied/)
    await expect(backend.snapshotWorkspace(ROOM_ID, 0, SNAPSHOT)).rejects.toThrow(/permission denied/)
    await expect(backend.fingerprintBuildInput(ROOM_ID, SNAPSHOT)).rejects.toThrow(/permission denied/)
  })

  it('normalizes one trailing include slash before rejecting empty path components', () => {
    for (const script of [
      importHostFolderScript(),
      workspaceSnapshotScript(),
      workspaceTransactionalFingerprintScript()
    ]) {
      expect(script.indexOf('include=${include%/}')).toBeGreaterThanOrEqual(0)
      expect(script.indexOf('include=${include%/}')).toBeLessThan(script.indexOf('case "/$include/"'))
      expect(script).toContain('include_probe=$include_dir')
      expect(script.indexOf('realpath "$include_probe"')).toBeLessThan(
        script.indexOf('if [ ! -e "$include" ]')
      )
    }
  })

  it('exports only from the exact owned snapshot into a derived Hotel directory and hashes the APK', async () => {
    const root = join(tempDir(), 'artifacts')
    const artifacts = await new OciCliBackend().exportAndroidArtifacts(
      ROOM_ID,
      SNAPSHOT,
      root,
      OPERATION_ID
    )

    expect(artifacts).toEqual([{
      relativePath: 'app/build/outputs/apk/debug/app-debug.apk',
      size: 12,
      sha256: createHash('sha256').update('verified-apk').digest('hex')
    }])
    const exportCall = mockedRunDocker.mock.calls.find(([args]) =>
      args[0] === 'run' && args.some((arg) => arg.endsWith(':/out'))
    )!
    const run = exportCall[0]
    const opts = exportCall[1]
    expect(run).toEqual(expect.arrayContaining([
      '--name',
      '--label', `devhotel.room=${ROOM_ID}`, '--label', 'devhotel.role=job', '--label', 'devhotel.managed=1',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${SNAPSHOT}:/workspace:ro`
    ]))
    expect(run[run.indexOf('--name') + 1]).toMatch(/^dh-room1abc-job-[0-9a-f]{32}$/)
    expect(run?.find((arg) => arg.endsWith(':/out'))).toBe(`${realpathSync.native(join(root, OPERATION_ID))}:/out`)
    expect(opts).toMatchObject({
      maxStdoutBytes: 256,
      maxStderrBytes: 64 * 1024
    })
    expect(opts?.onAbort).toEqual(expect.any(Function))
    const script = run.at(-1) ?? ''
    expect(script).toContain("find . -xdev \\( -type f -o -type l \\) -path '*/build/outputs/apk/*' -iname '*.apk' -print0")
    expect(script).toContain('sort -zu "$apk_paths"')
    expect(script).toContain('while IFS= read -r -d "" file; do')
    expect(script).toContain('line_feed=$(printf "\\nx"); line_feed=${line_feed%x}')
    expect(script).toContain('*"$line_feed"*|*"$carriage_return"*')
    expect(script).toContain('[ "$apk_count" -le 64 ]')
    expect(script).toContain('[ "$3" -ge 1 ] && [ "$3" -le 536870912 ]')
    expect(script).toContain('[ "$aggregate_bytes" -le 2147483648 ]')
    expect(script).toContain('[ "$1" = "$workspace_device" ]')
    expect(script).toContain('[ ! -L "$source" ]')
    expect(script).toContain('cmp -s "$metadata_expected" "$metadata_sorted"')
    expect(script.indexOf('cmp -s "$metadata_expected" "$metadata_sorted"'))
      .toBeLessThan(script.indexOf('copy_manifest "$apk_manifest"'))
  })

  it('fails closed on bounded-helper overflow and on a Host inventory mismatch', async () => {
    const helperId = 'a'.repeat(64)
    let helperName = ''
    let helperExists = false
    let cleanupCompleted = false
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'inspect') {
        if (helperExists && (args[1] === helperName || args[1] === helperId)) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              Id: helperId,
              Name: `/${helperName}`,
              Config: { Labels: {
                'devhotel.room': ROOM_ID,
                'devhotel.role': 'job',
                'devhotel.managed': '1'
              } },
              State: { Status: 'running' }
            }]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'rm') {
        expect(args).toEqual(['rm', '-f', helperId])
        helperExists = false
        cleanupCompleted = true
        return ok
      }
      if (args[0] === 'run') {
        helperName = args[args.indexOf('--name') + 1]!
        helperExists = true
        await opts?.onAbort?.()
        return { code: -1, stdout: '', stderr: 'output exceeded safety limit', outputLimitExceeded: true }
      }
      return ok
    })
    let root = join(tempDir(), 'artifacts')
    await expect(new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID))
      .rejects.toThrow(/diagnostics exceeded the safety limit/)
    expect(cleanupCompleted).toBe(true)
    expect(existsSync(join(root, OPERATION_ID))).toBe(false)

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        const mount = args.find((arg) => arg.endsWith(':/out'))!
        const output = mount.slice(0, -':/out'.length)
        const apk = join(output, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
        const metadata = join(dirname(apk), 'output-metadata.json')
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, 'verified-apk')
        writeFileSync(metadata, '{}')
        return { code: 0, stdout: 'devhotel-android-export-v1\t2\t14\t1\n', stderr: '' }
      }
      return ok
    })
    root = join(tempDir(), 'artifacts')
    await expect(new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID))
      .rejects.toThrow(/do not match the validated snapshot inventory/)
    expect(existsSync(join(root, OPERATION_ID))).toBe(false)
  })

  it('preserves case-insensitive APK extensions and rejects line-separator paths on the Host recheck', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        const mount = args.find((arg) => arg.endsWith(':/out'))!
        const output = mount.slice(0, -':/out'.length)
        const apk = join(output, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.APK')
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, 'verified-apk')
        writeFileSync(join(dirname(apk), 'output-metadata.json'), '{}')
        return { code: 0, stdout: 'devhotel-android-export-v1\t1\t14\t1\n', stderr: '' }
      }
      return ok
    })
    let root = join(tempDir(), 'artifacts')
    await expect(new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID))
      .resolves.toMatchObject([{ relativePath: expect.stringMatching(/\.APK$/) }])

    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        const mount = args.find((arg) => arg.endsWith(':/out'))!
        const output = mount.slice(0, -':/out'.length)
        const apk = join(output, 'app', 'build', 'outputs', 'apk', 'debug', 'bad\u2028name.apk')
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, 'verified-apk')
        writeFileSync(join(dirname(apk), 'output-metadata.json'), '{}')
        return { code: 0, stdout: 'devhotel-android-export-v1\t1\t14\t1\n', stderr: '' }
      }
      return ok
    })
    root = join(tempDir(), 'artifacts')
    await expect(new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID))
      .rejects.toThrow(/Host artifact path is invalid/)
    expect(existsSync(join(root, OPERATION_ID))).toBe(false)
  })

  it('rejects a mismatched operation snapshot and refuses an existing output directory', async () => {
    const root = join(tempDir(), 'artifacts')
    await expect(
      new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    ).rejects.toThrow(/not this build operation snapshot/)
    expect(mockedRunDocker).not.toHaveBeenCalled()

    const output = join(root, OPERATION_ID)
    mkdirSync(output, { recursive: true })
    await expect(
      new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID)
    ).rejects.toThrow(/already exists/)
    expect(existsSync(output)).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false)
  })

  it('removes a partial Hotel output directory when export fails', async () => {
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: volumeInspect(), stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') return { code: 1, stdout: '', stderr: 'copy failed' }
      return ok
    })
    const root = join(tempDir(), 'artifacts')
    await expect(
      new OciCliBackend().exportAndroidArtifacts(ROOM_ID, SNAPSHOT, root, OPERATION_ID)
    ).rejects.toThrow(/export Android build artifacts failed \(exit 1\)/)
    expect(existsSync(join(root, OPERATION_ID))).toBe(false)
  })

  it('refuses a pre-aborted fenced helper before any Docker command', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['get-state'],
      { signal: controller.signal }
    )).rejects.toThrow(/aborted/i)
    expect(mockedRunDocker).not.toHaveBeenCalled()
  })

  it('creates and configures an emulator only by its captured ID and cleans a definitively failed allocation', async () => {
    const anchorId = 'a'.repeat(64)
    const emulatorId = 'b'.repeat(64)
    const controlSandboxId = 'c'.repeat(64)
    const controlNetworkId = '1'.repeat(64)
    const controlStartedAt = '2026-09-02T00:00:00.100000001Z'
    const emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    let emulator: Record<string, unknown> | null = null
    let failCreate = false
    let startedEmulatorSandboxId = ''
    let emulatorAuthorityLabel: string | undefined = controlSandboxId
    let emulatorAuthorityStartedAtLabel: string | undefined = controlStartedAt
    let controlAnchorSandboxId = controlSandboxId
    let controlAnchorStartedAt = controlStartedAt
    let driftControlSandboxAfterStart = false
    let driftControlStartedAtAfterStart = false
    const anchor = {
      Id: anchorId,
      Name: `/${anchorName(ROOM_ID)}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': 'anchor',
        'devhotel.managed': '1'
      } },
      State: { Status: 'running', StartedAt: controlStartedAt },
      HostConfig: { NetworkMode: androidControlNetworkName(ROOM_ID) },
      NetworkSettings: {
        SandboxID: controlSandboxId,
        Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: controlNetworkId } }
      }
    }
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'network' && args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: controlNetworkId,
            Name: androidControlNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: { [anchorId]: { Name: anchorName(ROOM_ID) } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === anchorName(ROOM_ID) || args[1] === anchorId) {
          return {
            code: 0,
            stdout: JSON.stringify([{
              ...anchor,
              State: { Status: 'running', StartedAt: controlAnchorStartedAt },
              NetworkSettings: {
                SandboxID: controlAnchorSandboxId,
                Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: controlNetworkId } }
              }
            }]),
            stderr: ''
          }
        }
        if (emulator && (args[1] === emulatorId || args[1] === emulatorName(ROOM_ID))) {
          if (driftControlSandboxAfterStart && (emulator.State as { Status?: string }).Status === 'running') {
            controlAnchorSandboxId = '8'.repeat(64)
          }
          if (driftControlStartedAtAfterStart && (emulator.State as { Status?: string }).Status === 'running') {
            controlAnchorStartedAt = '2026-09-02T00:00:01.100000001Z'
          }
          return { code: 0, stdout: JSON.stringify([emulator]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'create') {
        const token = args.find((arg) => arg.startsWith('devhotel.abort-token='))!.split('=')[1]!
        emulator = {
          Id: emulatorId,
          Name: `/${emulatorName(ROOM_ID)}`,
          Config: { Labels: {
            'devhotel.room': ROOM_ID,
            'devhotel.role': 'svc-emulator',
            'devhotel.managed': '1',
            ...(emulatorAuthorityLabel
              ? { [NETWORK_AUTHORITY_SANDBOX_LABEL]: emulatorAuthorityLabel }
              : {}),
            ...(emulatorAuthorityStartedAtLabel
              ? { [NETWORK_AUTHORITY_STARTED_AT_LABEL]: emulatorAuthorityStartedAtLabel }
              : {}),
            'devhotel.abort-token': token
          } },
          State: { Status: 'created' },
          HostConfig: { NetworkMode: `container:${anchorId}` }
        }
        return failCreate
          ? { code: 1, stdout: '', stderr: 'create failed after daemon allocation' }
          : { code: 0, stdout: `${emulatorId}\n`, stderr: '' }
      }
      if (args[0] === 'cp') return ok
      if (args[0] === 'start') {
        emulator = {
          ...(emulator ?? {}),
          State: { Status: 'running', StartedAt: emulatorStartedAt },
          NetworkSettings: { SandboxID: startedEmulatorSandboxId }
        }
        return ok
      }
      if (args[0] === 'rm') {
        emulator = null
        return ok
      }
      return ok
    })

    await new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })
    const calls = mockedRunDocker.mock.calls.map(([args]) => args)
    const create = calls.find((args) => args[0] === 'create')!
    const createOpts = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')?.[1]
    expect(create).toEqual(expect.arrayContaining(['--network', `container:${anchorId}`]))
    expect(create).toContain(`${NETWORK_AUTHORITY_SANDBOX_LABEL}=${controlSandboxId}`)
    expect(create).toContain(`${NETWORK_AUTHORITY_STARTED_AT_LABEL}=${controlStartedAt}`)
    expect(createOpts).toMatchObject({ timeoutMs: null, killOnOutputLimit: false })
    expect(createOpts?.signal).toBeUndefined()
    expect(calls.filter((args) => args[0] === 'cp')).toHaveLength(2)
    expect(calls.filter((args) => args[0] === 'cp').every((args) => args[2]?.startsWith(`${emulatorId}:`))).toBe(true)
    expect(calls).toContainEqual(['start', emulatorId])
    expect(calls.some((args) => args[0] === 'start' && args[1] === emulatorName(ROOM_ID))).toBe(false)

    mockedRunDocker.mockClear()
    emulator = null
    emulatorAuthorityLabel = undefined
    emulatorAuthorityStartedAtLabel = undefined
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/network namespace authority generation/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    emulator = null
    emulatorAuthorityLabel = '9'.repeat(64)
    emulatorAuthorityStartedAtLabel = controlStartedAt
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/network namespace authority generation/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    emulator = null
    emulatorAuthorityLabel = controlSandboxId
    emulatorAuthorityStartedAtLabel = controlStartedAt
    startedEmulatorSandboxId = ''
    driftControlSandboxAfterStart = true
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/control anchor network namespace changed/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    emulator = null
    driftControlSandboxAfterStart = false
    controlAnchorSandboxId = controlSandboxId
    controlAnchorStartedAt = controlStartedAt
    emulatorAuthorityLabel = controlSandboxId
    emulatorAuthorityStartedAtLabel = controlStartedAt
    startedEmulatorSandboxId = 'd'.repeat(64)
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/outside the exact control anchor network namespace/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    emulator = null
    startedEmulatorSandboxId = ''
    driftControlStartedAtAfterStart = true
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/control anchor start identity changed/)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    emulator = null
    driftControlStartedAtAfterStart = false
    controlAnchorStartedAt = controlStartedAt
    startedEmulatorSandboxId = ''
    failCreate = true
    await expect(new OciCliBackend().createEmulator(ROOM_ID, {
      device: 'Samsung Galaxy S10',
      version: '14.0'
    })).rejects.toThrow(/create emulator container/)
    expect(mockedRunDocker.mock.calls.filter(([args]) =>
      args[0] === 'inspect' && args[1] === emulatorName(ROOM_ID)
    )).toHaveLength(1)
    expect(mockedRunDocker).toHaveBeenCalledWith(['rm', '-f', emulatorId], { timeoutMs: 30_000 })
  })

  it('runs fenced emulator ADB through one private owned server and carries bounded captures above 1 MiB', async () => {
    const ids = {
      web: 'a'.repeat(64),
      anchor: 'b'.repeat(64),
      emulator: 'c'.repeat(64),
      sandbox: 'd'.repeat(64),
      helper: 'e'.repeat(64),
      runtime: 'f'.repeat(64),
      runtimeSandbox: '1'.repeat(64),
      controlNetwork: '3'.repeat(64),
      runtimeNetwork: '4'.repeat(64)
    }
    const controlGenerationStartedAt = '2026-09-02T00:00:00.100000001Z'
    const runtimeGenerationStartedAt = '2026-09-02T00:00:00.200000001Z'
    let emulatorStartedAt = '2026-09-02T00:00:00.300000001Z'
    let webStartedAt = '2026-09-02T00:00:00.400000001Z'
    let controlStartedAt = controlGenerationStartedAt
    let runtimeStartedAt = runtimeGenerationStartedAt
    let helper: Record<string, unknown> | null = null
    let helperNetworkMode = `container:${ids.emulator}`
    let helperState = 'created'
    let emulatorSandboxId = ''
    let webSandboxId = ''
    let driftEmulatorSandboxAfterCreate = false
    let abortOnRemove: AbortController | null = null
    let abortAfterHelperInspect: AbortController | null = null
    let createDelayMs = 0
    let createOutputOverflow = false
    let createFailureStderr: string | null = null
    let cleanupFailureStderr: string | null = null
    let holdStartUntilAbort = false
    let replaceEmulatorAfterStart = false
    let restartEmulatorGenerationAfterStart = false
    let restartWebGenerationAfterStart = false
    let emulatorReplaced = false
    let receivedBytes = 0
    let bootStart = false
    let bootReceipt = 'devhotel-emulator-boot-v1\tready\tdevice\t1\t0\n'
    let bootHelperCode = 0
    const inspect = (name: string, role: string, id: string, paused = false) => JSON.stringify([{
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': role,
        'devhotel.managed': '1',
        ...(role === 'svc-emulator'
          ? {
              [NETWORK_AUTHORITY_SANDBOX_LABEL]: ids.sandbox,
              [NETWORK_AUTHORITY_STARTED_AT_LABEL]: controlGenerationStartedAt
            }
          : role === 'web'
            ? {
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: ids.runtimeSandbox,
                [NETWORK_AUTHORITY_STARTED_AT_LABEL]: runtimeGenerationStartedAt
              }
            : {})
      } },
      State: {
        Status: 'running',
        Paused: paused,
        StartedAt: role === 'anchor'
          ? controlStartedAt
          : role === 'android-runtime-anchor'
            ? runtimeStartedAt
            : role === 'svc-emulator'
              ? emulatorStartedAt
              : webStartedAt
      },
      ...(role === 'anchor'
        ? {
            NetworkSettings: {
              SandboxID: ids.sandbox,
              Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: ids.controlNetwork } }
            }
          }
        : role === 'android-runtime-anchor'
          ? {
              NetworkSettings: {
                SandboxID: ids.runtimeSandbox,
                Networks: { [roomNetworkName(ROOM_ID)]: { NetworkID: ids.runtimeNetwork } }
              }
            }
          : role === 'svc-emulator'
            ? { NetworkSettings: { SandboxID: emulatorSandboxId } }
            : role === 'web'
              ? { NetworkSettings: { SandboxID: webSandboxId } }
              : {}),
      ...(role === 'anchor' ? { HostConfig: { NetworkMode: androidControlNetworkName(ROOM_ID) } } : {}),
      ...(role === 'android-runtime-anchor' ? { HostConfig: { NetworkMode: roomNetworkName(ROOM_ID) } } : {}),
      ...(role === 'web' ? { HostConfig: { NetworkMode: `container:${ids.runtime}` } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${ids.anchor}` } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        const control = args[2] === androidControlNetworkName(ROOM_ID) || args[2] === ids.controlNetwork
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: control ? ids.controlNetwork : ids.runtimeNetwork,
            Name: control ? androidControlNetworkName(ROOM_ID) : roomNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: control
              ? { [ids.anchor]: { Name: anchorName(ROOM_ID) } }
              : { [ids.runtime]: { Name: androidRuntimeAnchorName(ROOM_ID) } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === webName(ROOM_ID) || args[1] === ids.web) {
          return { code: 0, stdout: inspect(webName(ROOM_ID), 'web', ids.web, true), stderr: '' }
        }
        if (args[1] === anchorName(ROOM_ID) || args[1] === ids.anchor) {
          return { code: 0, stdout: inspect(anchorName(ROOM_ID), 'anchor', ids.anchor), stderr: '' }
        }
        if (args[1] === androidRuntimeAnchorName(ROOM_ID) || args[1] === ids.runtime) {
          return {
            code: 0,
            stdout: inspect(androidRuntimeAnchorName(ROOM_ID), 'android-runtime-anchor', ids.runtime),
            stderr: ''
          }
        }
        if (args[1] === ids.emulator && emulatorReplaced) {
          return { code: 1, stdout: '', stderr: 'No such container' }
        }
        if (args[1] === emulatorName(ROOM_ID) || args[1] === ids.emulator) {
          const emulatorId = emulatorReplaced ? '9'.repeat(64) : ids.emulator
          return { code: 0, stdout: inspect(emulatorName(ROOM_ID), 'svc-emulator', emulatorId), stderr: '' }
        }
        if (helper && (args[1] === ids.helper || args[1] === (helper.Name as string).slice(1))) {
          abortAfterHelperInspect?.abort()
          return { code: 0, stdout: JSON.stringify([helper]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!
        const token = args.find((arg) => arg.startsWith('devhotel.abort-token='))!.split('=')[1]!
        helper = {
          Id: ids.helper,
          Name: `/${name}`,
          Config: { Labels: {
            'devhotel.room': ROOM_ID,
            'devhotel.role': 'job',
            'devhotel.managed': '1',
            'devhotel.abort-token': token
          } },
          State: { Status: helperState },
          HostConfig: { NetworkMode: helperNetworkMode }
        }
        if (driftEmulatorSandboxAfterCreate) emulatorSandboxId = '2'.repeat(64)
        if (createDelayMs > 0) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, createDelayMs))
        }
        if (createFailureStderr) {
          return { code: 1, stdout: `${ids.helper}\n`, stderr: createFailureStderr }
        }
        return createOutputOverflow
          ? { code: -1, stdout: `${ids.helper}\n`, stderr: '', outputLimitExceeded: true }
          : { code: 0, stdout: `${ids.helper}\n`, stderr: '' }
      }
      if (args[0] === 'start') {
        if (bootStart) {
          opts?.onStdout?.(bootReceipt)
          if (replaceEmulatorAfterStart) emulatorReplaced = true
          return { code: bootHelperCode, stdout: '', stderr: '' }
        }
        if (holdStartUntilAbort) {
          opts?.onStdout?.('begin\n')
          return await new Promise<typeof ok>((_resolve, reject) => {
            const abort = async () => {
              try {
                await opts?.onAbort?.()
              } catch (error) {
                reject(error)
                return
              }
              reject(opts?.signal?.reason instanceof Error ? opts.signal.reason : new Error('aborted'))
            }
            opts?.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        opts?.onStdout?.(Buffer.alloc(SCREENSHOT_BASE64_LIMIT - 1, 0x61))
        if (replaceEmulatorAfterStart) emulatorReplaced = true
        if (restartEmulatorGenerationAfterStart) {
          emulatorStartedAt = '2026-09-02T00:00:02.300000001Z'
        }
        if (restartWebGenerationAfterStart) webStartedAt = '2026-09-02T00:00:02.400000001Z'
        return ok
      }
      if (args[0] === 'rm') {
        if (cleanupFailureStderr) return { code: 1, stdout: '', stderr: cleanupFailureStderr }
        helper = null
        abortOnRemove?.abort()
        return ok
      }
      return ok
    })

    const controller = new AbortController()
    const result = await new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['shell', 'getprop', 'sys.boot_completed'],
      {
        timeoutMs: 20_000,
        signal: controller.signal,
        maxStdoutBytes: SCREENSHOT_BASE64_LIMIT,
        maxStderrBytes: 64,
        onStdout: (chunk) => { receivedBytes += Buffer.from(chunk).byteLength }
      }
    )

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(receivedBytes).toBe(SCREENSHOT_BASE64_LIMIT - 1)
    const createCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')!
    const startCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'start')!
    const create = createCall[0]
    const start = startCall[0]
    const startOpts = startCall[1]
    expect(create).toEqual(expect.arrayContaining([
      '--network', `container:${ids.emulator}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=23m',
      '--entrypoint', '/bin/sh',
      ANDROID_IMAGE
    ]))
    expect(create).not.toContain(`container:${ids.anchor}`)
    expect(create).not.toContain(`container:${anchorName(ROOM_ID)}`)
    expect(create).not.toContain('/workspace')
    expect(create).not.toContain('--entrypoint=adb')
    const script = create[create.indexOf('-c') + 1]!
    expect(script).toContain('env -i')
    expect(script).toContain('localfilesystem:$socket_path')
    expect(script).toContain('"$adb" -L "$socket" -s emulator-5554')
    expect(script).toContain('[ ! -e "$socket_path" ] && [ ! -L "$socket_path" ]')
    expect(script).toContain('[ -S "$socket_path" ]')
    expect(script).toContain('run_adb kill-server')
    expect(script).toContain('head -c "$((stdout_limit + 1))" < "$stdout_pipe" &')
    expect(script).toContain('head -c "$((stderr_limit + 1))" < "$stderr_pipe" >&2 &')
    expect(script).not.toContain('stdout_file=')
    expect(script).not.toContain('stderr_file=')
    expect(script).not.toMatch(/localhost|127\.0\.0\.1|5037|tcp:/)
    expect(create.slice(-4)).toEqual(['command', 'shell', 'getprop', 'sys.boot_completed'])
    expect(create).toEqual(expect.arrayContaining(['shell', 'getprop', 'sys.boot_completed']))
    expect(createCall[1]).toMatchObject({
      timeoutMs: null,
      maxStdoutBytes: 128,
      maxStderrBytes: 8 * 1024,
      killOnOutputLimit: false
    })
    expect(createCall[1]?.signal).toBeUndefined()
    expect(createCall[1]?.onAbort).toBeUndefined()
    expect(start).toEqual(['start', '-a', ids.helper])
    expect(startOpts).toMatchObject({
      timeoutMs: 20_000,
      signal: controller.signal,
      maxStdoutBytes: SCREENSHOT_BASE64_LIMIT,
      maxStderrBytes: 64,
      onAbort: expect.any(Function)
    })

    mockedRunDocker.mockClear()
    bootStart = true
    const boot = await new OciCliBackend().waitForFencedEmulatorBoot(ROOM_ID, { timeoutMs: 20_000 })
    bootStart = false
    expect(boot).toEqual({
      booted: true,
      adbState: 'device',
      bootProperty: '1',
      lastAdbCode: 0,
      helperCode: 0
    })
    const bootCalls = mockedRunDocker.mock.calls.map(([args]) => args)
    expect(bootCalls.filter((args) => args[0] === 'create')).toHaveLength(1)
    expect(bootCalls.filter((args) => args[0] === 'start')).toHaveLength(1)
    expect(bootCalls.filter((args) => args[0] === 'rm' && args[2] === ids.helper)).toHaveLength(1)
    const bootCreate = bootCalls.find((args) => args[0] === 'create')!
    const bootScript = bootCreate[bootCreate.indexOf('-c') + 1]!
    expect(bootCreate.slice(-1)).toEqual(['wait-for-boot'])
    expect(bootScript).toContain('if [ "$mode" = wait-for-boot ]')
    expect(bootScript).toContain('run_adb_bounded start-server')
    expect(bootScript).toContain('while [ "$(date +%s)" -lt "$boot_deadline" ]')
    expect(helper).toBeNull()
    expect(mockedRunDocker.mock.calls.find(([args]) => args[0] === 'start')?.[1])
      .toMatchObject({ timeoutMs: 30_000 })

    mockedRunDocker.mockClear()
    bootReceipt = 'devhotel-emulator-boot-v1\ttimeout\tunauthorized\tempty\t1\n'
    bootHelperCode = 74
    bootStart = true
    await expect(new OciCliBackend().waitForFencedEmulatorBoot(ROOM_ID, { timeoutMs: 20_000 }))
      .resolves.toEqual({
        booted: false,
        adbState: 'unauthorized',
        bootProperty: 'empty',
        lastAdbCode: 1,
        helperCode: 74
      })
    bootStart = false
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'create')).toHaveLength(1)
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1)
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toHaveLength(1)
    expect(helper).toBeNull()

    mockedRunDocker.mockClear()
    bootReceipt = 'devhotel-emulator-boot-v1\ttimeout\tunauthorized\tempty\t999\n'
    bootStart = true
    await expect(new OciCliBackend().waitForFencedEmulatorBoot(ROOM_ID, { timeoutMs: 20_000 }))
      .rejects.toThrow(/invalid bounded evidence/)
    bootStart = false
    expect(mockedRunDocker.mock.calls.filter(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toHaveLength(1)
    expect(helper).toBeNull()
    bootReceipt = 'devhotel-emulator-boot-v1\tready\tdevice\t1\t0\n'
    bootHelperCode = 0

    mockedRunDocker.mockClear()
    webSandboxId = ids.runtimeSandbox
    runtimeStartedAt = '2026-09-02T00:00:01.200000001Z'
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)
    webSandboxId = ''
    runtimeStartedAt = runtimeGenerationStartedAt

    mockedRunDocker.mockClear()
    emulatorSandboxId = ids.sandbox
    controlStartedAt = '2026-09-02T00:00:01.100000001Z'
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)
    emulatorSandboxId = ''
    controlStartedAt = controlGenerationStartedAt

    mockedRunDocker.mockClear()
    replaceEmulatorAfterStart = true
    let replacementError = ''
    bootStart = true
    try {
      await new OciCliBackend().waitForFencedEmulatorBoot(ROOM_ID, { timeoutMs: 20_000 })
    } catch (error) {
      replacementError = error instanceof Error ? error.message : String(error)
    }
    bootStart = false
    expect(replacementError).toMatch(/topology participant disappeared/)
    expect(replacementError).not.toContain('a'.repeat(32))
    expect(helper).toBeNull()
    const replacementCalls = mockedRunDocker.mock.calls.map(([args]) => args)
    const helperCleanupAt = replacementCalls.findIndex((args) => args[0] === 'rm' && args[2] === ids.helper)
    const topologyPostflightAt = replacementCalls.findLastIndex((args) => args[0] === 'inspect' && args[1] === ids.emulator)
    expect(helperCleanupAt).toBeGreaterThanOrEqual(0)
    expect(topologyPostflightAt).toBeGreaterThan(helperCleanupAt)
    replaceEmulatorAfterStart = false
    emulatorReplaced = false

    mockedRunDocker.mockClear()
    restartEmulatorGenerationAfterStart = true
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/network namespace changed while the helper was created/)
    expect(helper).toBeNull()
    restartEmulatorGenerationAfterStart = false
    emulatorStartedAt = '2026-09-02T00:00:00.300000001Z'

    mockedRunDocker.mockClear()
    restartWebGenerationAfterStart = true
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/network namespace changed while the helper was created/)
    expect(helper).toBeNull()
    restartWebGenerationAfterStart = false
    webStartedAt = '2026-09-02T00:00:00.400000001Z'

    mockedRunDocker.mockClear()
    holdStartUntilAbort = true
    const liveController = new AbortController()
    const liveAbortReason = new Error('stop long-lived witness')
    let firstChunkResolve: (() => void) | undefined
    const firstChunk = new Promise<void>((resolveChunk) => { firstChunkResolve = resolveChunk })
    let liveSettled = false
    const liveOperation = new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['logcat', '-m', '16'],
      {
        signal: liveController.signal,
        onStdout: () => firstChunkResolve?.()
      }
    )
    void liveOperation.then(
      () => { liveSettled = true },
      () => { liveSettled = true }
    )
    await firstChunk
    expect(liveSettled).toBe(false)
    liveController.abort(liveAbortReason)
    let observedLiveAbort: unknown
    try {
      await liveOperation
    } catch (error) {
      observedLiveAbort = error
    }
    expect(observedLiveAbort).toBe(liveAbortReason)
    expect(helper).toBeNull()
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)
    holdStartUntilAbort = false

    mockedRunDocker.mockClear()
    helperNetworkMode = `container:${ids.anchor}`
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact emulator network namespace/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)

    mockedRunDocker.mockClear()
    helperNetworkMode = `container:${ids.emulator}`
    helperState = 'running'
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/not inert/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)

    mockedRunDocker.mockClear()
    helperState = 'created'
    driftEmulatorSandboxAfterCreate = true
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/network namespace changed|not live in the exact control anchor/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)
    driftEmulatorSandboxAfterCreate = false
    emulatorSandboxId = ''

    mockedRunDocker.mockClear()
    abortOnRemove = new AbortController()
    await expect(new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['get-state'],
      { signal: abortOnRemove.signal }
    )).rejects.toThrow(/aborted/i)
    expect(helper).toBeNull()
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)

    mockedRunDocker.mockClear()
    abortOnRemove = null
    createDelayMs = 5_200
    const delayedAbort = new AbortController()
    const delayedOperation = new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['get-state'],
      { signal: delayedAbort.signal }
    )
    setTimeout(() => delayedAbort.abort(), 50)
    await expect(delayedOperation).rejects.toThrow(/aborted/i)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)
    const delayedCreateOpts = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')?.[1]
    expect(delayedCreateOpts).toMatchObject({ timeoutMs: null, killOnOutputLimit: false })
    expect(delayedCreateOpts?.signal).toBeUndefined()

    mockedRunDocker.mockClear()
    createDelayMs = 0
    abortAfterHelperInspect = new AbortController()
    await expect(new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['get-state'],
      { signal: abortAfterHelperInspect.signal }
    )).rejects.toThrow(/aborted/i)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)
    abortAfterHelperInspect = null

    mockedRunDocker.mockClear()
    createOutputOverflow = true
    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/create fenced emulator ADB helper/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)

    mockedRunDocker.mockClear()
    createOutputOverflow = false
    const privateStageRoot = tempDir()
    const canonicalStageDir = join(privateStageRoot, 'canonical-stage')
    const aliasedStageDir = join(privateStageRoot, 'aliased-stage')
    mkdirSync(canonicalStageDir)
    symlinkSync(canonicalStageDir, aliasedStageDir, process.platform === 'win32' ? 'junction' : 'dir')
    const privateApk = join(aliasedStageDir, 'host-secret-build.apk')
    writeFileSync(privateApk, 'apk-bytes')
    expect(realpathSync.native(privateApk)).not.toBe(resolve(privateApk))
    const callerAbortReason = new Error('caller cancelled the install operation')
    const callerAbort = new AbortController()
    callerAbort.abort(callerAbortReason)
    let observedAbort: unknown
    try {
      await new OciCliBackend().installFencedEmulatorApk(
        ROOM_ID,
        privateApk,
        { signal: callerAbort.signal }
      )
    } catch (error) {
      observedAbort = error
    }
    expect(observedAbort).toBe(callerAbortReason)

    createFailureStderr = `mount source denied: ${privateApk}`
    let surfacedInstallError = ''
    try {
      await new OciCliBackend().installFencedEmulatorApk(ROOM_ID, privateApk)
    } catch (error) {
      surfacedInstallError = error instanceof Error ? error.message : String(error)
    }
    expect(surfacedInstallError).toContain('[private APK stage]')
    expect(surfacedInstallError).not.toContain(privateApk)
    expect(surfacedInstallError).not.toContain('host-secret-build.apk')
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)

    mockedRunDocker.mockClear()
    cleanupFailureStderr = `cleanup also echoed ${privateApk}`
    surfacedInstallError = ''
    try {
      await new OciCliBackend().installFencedEmulatorApk(ROOM_ID, privateApk)
    } catch (error) {
      surfacedInstallError = error instanceof Error ? error.message : String(error)
    }
    expect(surfacedInstallError).toContain('exact helper cleanup also failed')
    expect(surfacedInstallError).not.toContain(privateApk)
    expect(surfacedInstallError).not.toContain('host-secret-build.apk')
  }, 30_000)

  it('cuts off fenced helper sinks at the requested cap and rejects all later chunks', async () => {
    const ids = {
      web: 'a'.repeat(64),
      anchor: 'b'.repeat(64),
      emulator: 'c'.repeat(64),
      runtime: 'e'.repeat(64),
      helper: 'f'.repeat(64),
      runtimeSandbox: '1'.repeat(64),
      controlNetwork: '2'.repeat(64),
      runtimeNetwork: '3'.repeat(64)
    }
    const controlStartedAt = '2026-09-02T00:00:00.100000001Z'
    const runtimeStartedAt = '2026-09-02T00:00:00.200000001Z'
    const emulatorStartedAt = '2026-09-02T00:00:00.300000001Z'
    const webStartedAt = '2026-09-02T00:00:00.400000001Z'
    let helper: Record<string, unknown> | null = null
    const inspect = (name: string, role: string, paused = false) => JSON.stringify([{
      Id: role === 'anchor'
        ? ids.anchor
        : role === 'svc-emulator'
          ? ids.emulator
          : role === 'android-runtime-anchor'
            ? ids.runtime
            : ids.web,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': role,
        'devhotel.managed': '1',
        ...(role === 'svc-emulator'
          ? {
              [NETWORK_AUTHORITY_SANDBOX_LABEL]: 'd'.repeat(64),
              [NETWORK_AUTHORITY_STARTED_AT_LABEL]: controlStartedAt
            }
          : role === 'web'
            ? {
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: ids.runtimeSandbox,
                [NETWORK_AUTHORITY_STARTED_AT_LABEL]: runtimeStartedAt
              }
            : {})
      } },
      State: {
        Status: 'running',
        Paused: paused,
        StartedAt: role === 'anchor'
          ? controlStartedAt
          : role === 'android-runtime-anchor'
            ? runtimeStartedAt
            : role === 'svc-emulator'
              ? emulatorStartedAt
              : webStartedAt
      },
      ...(role === 'anchor'
        ? {
            NetworkSettings: {
              SandboxID: 'd'.repeat(64),
              Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: ids.controlNetwork } }
            }
          }
        : role === 'android-runtime-anchor'
          ? {
              NetworkSettings: {
                SandboxID: ids.runtimeSandbox,
                Networks: { [roomNetworkName(ROOM_ID)]: { NetworkID: ids.runtimeNetwork } }
              }
            }
          : role === 'svc-emulator' || role === 'web'
            ? { NetworkSettings: { SandboxID: '' } }
            : {}),
      ...(role === 'anchor' ? { HostConfig: { NetworkMode: androidControlNetworkName(ROOM_ID) } } : {}),
      ...(role === 'android-runtime-anchor' ? { HostConfig: { NetworkMode: roomNetworkName(ROOM_ID) } } : {}),
      ...(role === 'web' ? { HostConfig: { NetworkMode: `container:${ids.runtime}` } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${ids.anchor}` } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        const control = args[2] === androidControlNetworkName(ROOM_ID) || args[2] === ids.controlNetwork
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: control ? ids.controlNetwork : ids.runtimeNetwork,
            Name: control ? androidControlNetworkName(ROOM_ID) : roomNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: control
              ? { [ids.anchor]: { Name: anchorName(ROOM_ID) } }
              : { [ids.runtime]: { Name: androidRuntimeAnchorName(ROOM_ID) } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        const name = args[1]!
        if (name === webName(ROOM_ID) || name === ids.web) {
          return { code: 0, stdout: inspect(webName(ROOM_ID), 'web', true), stderr: '' }
        }
        if (name === anchorName(ROOM_ID) || name === ids.anchor) {
          return { code: 0, stdout: inspect(anchorName(ROOM_ID), 'anchor'), stderr: '' }
        }
        if (name === androidRuntimeAnchorName(ROOM_ID) || name === ids.runtime) {
          return { code: 0, stdout: inspect(androidRuntimeAnchorName(ROOM_ID), 'android-runtime-anchor'), stderr: '' }
        }
        if (name === emulatorName(ROOM_ID) || name === ids.emulator) {
          return { code: 0, stdout: inspect(emulatorName(ROOM_ID), 'svc-emulator'), stderr: '' }
        }
        if (helper && (name === ids.helper || name === (helper.Name as string).slice(1))) {
          return { code: 0, stdout: JSON.stringify([helper]), stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!
        const token = args.find((arg) => arg.startsWith('devhotel.abort-token='))!.split('=')[1]!
        helper = {
          Id: ids.helper,
          Name: `/${name}`,
          Config: { Labels: {
            'devhotel.room': ROOM_ID,
            'devhotel.role': 'job',
            'devhotel.managed': '1',
            'devhotel.abort-token': token
          } },
          State: { Status: 'created' },
          HostConfig: { NetworkMode: `container:${ids.emulator}` }
        }
        return { code: 0, stdout: `${ids.helper}\n`, stderr: '' }
      }
      if (args[0] === 'start') {
        opts?.onStdout?.('abcdefgh')
        opts?.onStdout?.('must-not-pass')
        return ok
      }
      if (args[0] === 'rm') {
        helper = null
        return ok
      }
      return ok
    })
    const chunks: Buffer[] = []

    const result = await new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state'], {
      maxStdoutBytes: 4,
      maxStderrBytes: 4,
      onStdout: (chunk) => chunks.push(Buffer.from(chunk))
    })

    expect(result).toMatchObject({ code: -1, stdout: '', stderr: expect.stringContaining('safety limit') })
    expect(Buffer.concat(chunks).toString('utf8')).toBe('abcd')
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === ids.helper)).toBe(true)
  })

  it('captures emulator screen bytes only from one exact topology and withholds them after replacement', async () => {
    const ids = {
      anchor: 'a'.repeat(64),
      runtime: 'b'.repeat(64),
      web: 'c'.repeat(64),
      emulator: 'd'.repeat(64),
      replacement: 'e'.repeat(64),
      controlSandbox: 'f'.repeat(64),
      runtimeSandbox: '1'.repeat(64),
      controlNetwork: '2'.repeat(64),
      runtimeNetwork: '3'.repeat(64)
    }
    const controlStartedAt = '2026-09-02T00:00:00.100000001Z'
    const runtimeStartedAt = '2026-09-02T00:00:00.200000001Z'
    const emulatorStartedAt = '2026-09-02T00:00:00.300000001Z'
    const webStartedAt = '2026-09-02T00:00:00.400000001Z'
    let liveEmulatorId = ids.emulator
    let replaceAfterExec = false
    let foreignEmulatorName = false
    let emulatorSandbox = ''
    const participant = (name: string, role: string, id: string, sandboxId: string, networkMode: string) => ({
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': role,
        'devhotel.managed': foreignEmulatorName && role === 'svc-emulator' ? '0' : '1',
        ...(role === 'svc-emulator'
          ? {
              [NETWORK_AUTHORITY_SANDBOX_LABEL]: ids.controlSandbox,
              [NETWORK_AUTHORITY_STARTED_AT_LABEL]: controlStartedAt
            }
          : role === 'web'
            ? {
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: ids.runtimeSandbox,
                [NETWORK_AUTHORITY_STARTED_AT_LABEL]: runtimeStartedAt
              }
            : {})
      } },
      State: {
        Status: 'running',
        StartedAt: role === 'anchor'
          ? controlStartedAt
          : role === 'android-runtime-anchor'
            ? runtimeStartedAt
            : role === 'svc-emulator'
              ? emulatorStartedAt
              : webStartedAt
      },
      HostConfig: { NetworkMode: networkMode },
      NetworkSettings: {
        SandboxID: sandboxId,
        ...(role === 'anchor'
          ? { Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: ids.controlNetwork } } }
          : role === 'android-runtime-anchor'
            ? { Networks: { [roomNetworkName(ROOM_ID)]: { NetworkID: ids.runtimeNetwork } } }
            : {})
      }
    })
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        const control = args[2] === androidControlNetworkName(ROOM_ID) || args[2] === ids.controlNetwork
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: control ? ids.controlNetwork : ids.runtimeNetwork,
            Name: control ? androidControlNetworkName(ROOM_ID) : roomNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: control
              ? { [ids.anchor]: { Name: anchorName(ROOM_ID) } }
              : { [ids.runtime]: { Name: androidRuntimeAnchorName(ROOM_ID) } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        const name = args[1]!
        if (name === anchorName(ROOM_ID) || name === ids.anchor) {
          return {
            code: 0,
            stdout: JSON.stringify([participant(
              anchorName(ROOM_ID),
              'anchor',
              ids.anchor,
              ids.controlSandbox,
              androidControlNetworkName(ROOM_ID)
            )]),
            stderr: ''
          }
        }
        if (name === androidRuntimeAnchorName(ROOM_ID) || name === ids.runtime) {
          return {
            code: 0,
            stdout: JSON.stringify([participant(
              androidRuntimeAnchorName(ROOM_ID),
              'android-runtime-anchor',
              ids.runtime,
              ids.runtimeSandbox,
              roomNetworkName(ROOM_ID)
            )]),
            stderr: ''
          }
        }
        if (name === webName(ROOM_ID) || name === ids.web) {
          return {
            code: 0,
            stdout: JSON.stringify([participant(
              webName(ROOM_ID),
              'web',
              ids.web,
              '',
              `container:${ids.runtime}`
            )]),
            stderr: ''
          }
        }
        if (name === emulatorName(ROOM_ID)) {
          return {
            code: 0,
            stdout: JSON.stringify([participant(
              emulatorName(ROOM_ID),
              'svc-emulator',
              liveEmulatorId,
              emulatorSandbox,
              `container:${ids.anchor}`
            )]),
            stderr: ''
          }
        }
        if (name === ids.emulator && liveEmulatorId === ids.emulator) {
          return {
            code: 0,
            stdout: JSON.stringify([participant(
              emulatorName(ROOM_ID),
              'svc-emulator',
              ids.emulator,
              emulatorSandbox,
              `container:${ids.anchor}`
            )]),
            stderr: ''
          }
        }
        return { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'exec') {
        opts?.onStdout?.('a'.repeat(128))
        if (replaceAfterExec) liveEmulatorId = ids.replacement
        return ok
      }
      return ok
    })

    const controller = new AbortController()
    await expect(new OciCliBackend().captureEmulatorScreen(
      ROOM_ID,
      { signal: controller.signal, timeoutMs: 45_000 }
    )).resolves.toBe('a'.repeat(128))
    const execCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'exec')!
    expect(execCall[0][1]).toBe(ids.emulator)
    expect(execCall[1]).toMatchObject({
      signal: controller.signal,
      timeoutMs: 45_000,
      maxStdoutBytes: SCREENSHOT_BASE64_LIMIT,
      maxStderrBytes: 64 * 1024
    })

    mockedRunDocker.mockClear()
    replaceAfterExec = true
    await expect(new OciCliBackend().captureEmulatorScreen(ROOM_ID))
      .rejects.toThrow(/topology participant disappeared/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'exec' && args[1] === ids.emulator)).toBe(true)

    mockedRunDocker.mockClear()
    liveEmulatorId = ids.emulator
    replaceAfterExec = false
    emulatorSandbox = '2'.repeat(64)
    await expect(new OciCliBackend().captureEmulatorScreen(ROOM_ID))
      .rejects.toThrow(/not live in the exact control anchor/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'exec')).toBe(false)

    mockedRunDocker.mockClear()
    emulatorSandbox = ''
    foreignEmulatorName = true
    await expect(new OciCliBackend().emulatorState(ROOM_ID)).rejects.toThrow(/ownership metadata/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'exec')).toBe(false)
  })

  it('refuses crossed recovery endpoints and accepts absent endpoints for retained stopped workloads', async () => {
    const ids = { anchor: 'a'.repeat(64), emulator: 'b'.repeat(64), runtime: 'c'.repeat(64), web: 'd'.repeat(64) }
    const networkIds = { control: '1'.repeat(64), runtime: '2'.repeat(64) }
    const root = tempDir()
    const backend = () => new OciCliBackend({
      identityFile: join(root, 'runtime', 'docker-engine.json'),
      networkRecoveryAttestationDir: join(root, 'runtime', 'network-recovery-attestations')
    })
    let extraControlMember = true
    let crossConnectedControl = false
    let anchorState = 'running'
    let emulatorState = 'running'
    let runtimeAnchorState = 'running'
    let webState = 'running'
    let emulatorNetworkMode = `container:${'f'.repeat(64)}`
    let emulatorSandboxId = ''
    let controlSandboxId = 'e'.repeat(64)
    let rotateControlSandboxOnStart = false
    let driftControlImmediatelyAfterEmulatorStart = false
    let driftControlSandboxAfterEmulatorStart = false
    let driftWebStartedAtAfterEmulatorStart = false
    let anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    let emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    let restartedEmulatorStartedAt = '2026-09-02T00:00:03.000000001Z'
    let emulatorAuthorityLabel: string | undefined = 'e'.repeat(64)
    let emulatorAuthorityStartedAtLabel: string | undefined = '2026-09-02T00:00:00.100000001Z'
    const runtimeStartedAt = '2026-09-02T00:00:00.300000001Z'
    let webStartedAt = '2026-09-02T00:00:00.400000001Z'
    const container = (name: string, role: string, id: string, sandboxId: string, networkMode?: string) => JSON.stringify([{
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': role,
        'devhotel.managed': '1',
        ...(role === 'svc-emulator'
          ? {
              ...(emulatorAuthorityLabel
                ? { [NETWORK_AUTHORITY_SANDBOX_LABEL]: emulatorAuthorityLabel }
                : {}),
              ...(emulatorAuthorityStartedAtLabel
                ? { [NETWORK_AUTHORITY_STARTED_AT_LABEL]: emulatorAuthorityStartedAtLabel }
                : {})
            }
          : role === 'web'
            ? {
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: 'f'.repeat(64),
                [NETWORK_AUTHORITY_STARTED_AT_LABEL]: runtimeStartedAt
              }
            : {})
      } },
      State: {
        Status: role === 'anchor'
          ? anchorState
          : role === 'svc-emulator'
            ? emulatorState
            : role === 'android-runtime-anchor'
              ? runtimeAnchorState
              : webState,
        StartedAt: role === 'anchor'
          ? anchorStartedAt
          : role === 'svc-emulator'
            ? emulatorStartedAt
            : role === 'android-runtime-anchor'
              ? runtimeStartedAt
              : webStartedAt
      },
      NetworkSettings: {
        SandboxID: sandboxId,
        ...(role === 'android-runtime-anchor'
          ? { Networks: { [roomNetworkName(ROOM_ID)]: { NetworkID: networkIds.runtime } } }
          : role === 'anchor'
            ? { Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: networkIds.control } } }
            : {})
      },
      ...(networkMode ? { HostConfig: { NetworkMode: networkMode } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'info') {
        return { code: 0, stdout: JSON.stringify({ ID: 'engine-recovery-test' }), stderr: '' }
      }
      if (args[0] === 'start') {
        if (args[1] === ids.anchor) {
          anchorState = 'running'
          if (rotateControlSandboxOnStart) {
            controlSandboxId = '8'.repeat(64)
            anchorStartedAt = '2026-09-02T00:00:02.000000001Z'
          }
        }
        if (args[1] === ids.emulator) {
          emulatorState = 'running'
          if (rotateControlSandboxOnStart) {
            emulatorStartedAt = restartedEmulatorStartedAt
          }
          if (driftControlImmediatelyAfterEmulatorStart) {
            controlSandboxId = '7'.repeat(64)
            anchorStartedAt = '2026-09-02T00:00:04.000000001Z'
          }
          if (driftWebStartedAtAfterEmulatorStart) {
            webStartedAt = '2026-09-02T00:00:04.400000001Z'
          }
        }
        return ok
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        const control = args[2] === androidControlNetworkName(ROOM_ID) || args[2] === networkIds.control
        const networkName = control ? androidControlNetworkName(ROOM_ID) : roomNetworkName(ROOM_ID)
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: control ? networkIds.control : networkIds.runtime,
            Name: networkName,
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: control
              ? {
                  ...(anchorState === 'running' ? { [ids.anchor]: { Name: anchorName(ROOM_ID) } } : {}),
                  ...(extraControlMember ? { ['9'.repeat(64)]: { Name: androidRuntimeAnchorName(ROOM_ID) } } : {})
                }
              : {
                  ...(runtimeAnchorState === 'running'
                    ? { [ids.runtime]: { Name: androidRuntimeAnchorName(ROOM_ID) } }
                    : {}),
                  ...(crossConnectedControl ? { [ids.anchor]: { Name: anchorName(ROOM_ID) } } : {})
                }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect' && (args[1] === anchorName(ROOM_ID) || args[1] === ids.anchor)) {
        return {
          code: 0,
          stdout: container(
            anchorName(ROOM_ID),
            'anchor',
            ids.anchor,
            controlSandboxId,
            androidControlNetworkName(ROOM_ID)
          ),
          stderr: ''
        }
      }
      if (
        args[0] === 'inspect' &&
        (args[1] === androidRuntimeAnchorName(ROOM_ID) || args[1] === ids.runtime)
      ) {
        return {
          code: 0,
          stdout: container(
            androidRuntimeAnchorName(ROOM_ID),
            'android-runtime-anchor',
            ids.runtime,
            'f'.repeat(64),
            roomNetworkName(ROOM_ID)
          ),
          stderr: ''
        }
      }
      if (args[0] === 'inspect' && (args[1] === webName(ROOM_ID) || args[1] === ids.web)) {
        return {
          code: 0,
          stdout: container(
              webName(ROOM_ID),
              'web',
              ids.web,
              '',
              `container:${ids.runtime}`
          ),
          stderr: ''
        }
      }
      if (args[0] === 'inspect' && (args[1] === emulatorName(ROOM_ID) || args[1] === ids.emulator)) {
        if (driftControlSandboxAfterEmulatorStart && emulatorState === 'running') {
          controlSandboxId = '9'.repeat(64)
        }
        return {
          code: 0,
          stdout: container(
            emulatorName(ROOM_ID),
            'svc-emulator',
            ids.emulator,
            emulatorSandboxId,
            emulatorNetworkMode
          ),
          stderr: ''
        }
      }
      return args[0] === 'inspect'
        ? { code: 1, stdout: '', stderr: 'No such container' }
        : ok
    })

    await expect(backend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact Android runtime namespace/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)

    extraControlMember = false
    await expect(backend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact Android runtime namespace/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)

    emulatorNetworkMode = `container:${anchorName(ROOM_ID)}`
    emulatorSandboxId = '9'.repeat(64)
    await expect(backend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/not live in the exact control anchor/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    emulatorNetworkMode = `container:${ids.anchor}`
    emulatorSandboxId = ''
    crossConnectedControl = true
    await expect(backend().execFencedEmulatorRecoveryAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/container ownership metadata is invalid|endpoint sets are not disjoint/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'create' || args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/container ownership metadata is invalid|endpoint sets are not disjoint/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    runtimeAnchorState = 'exited'
    webState = 'exited'
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/container ownership metadata is invalid|endpoint sets are not disjoint/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    crossConnectedControl = false
    extraControlMember = true
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/unprovable endpoint|only the exact owned control anchor endpoint/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    extraControlMember = false
    anchorState = 'running'
    emulatorState = 'running'
    controlSandboxId = '8'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:02.000000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    controlSandboxId = 'e'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    restartedEmulatorStartedAt = emulatorStartedAt
    rotateControlSandboxOnStart = true
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(existsSync(join(
      root,
      'runtime',
      'network-recovery-attestations',
      `${ROOM_ID}-${ids.emulator}.json`
    ))).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'running'
    emulatorState = 'running'
    controlSandboxId = '8'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:02.000000001Z'
    emulatorStartedAt = '2026-09-02T00:00:03.000000001Z'
    rotateControlSandboxOnStart = false
    driftControlSandboxAfterEmulatorStart = false
    emulatorAuthorityLabel = undefined
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(existsSync(join(
      root,
      'runtime',
      'network-recovery-attestations',
      `${ROOM_ID}-${ids.emulator}.json`
    ))).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    controlSandboxId = 'e'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    webStartedAt = '2026-09-02T00:00:00.400000001Z'
    restartedEmulatorStartedAt = '2026-09-02T00:00:03.000000001Z'
    rotateControlSandboxOnStart = true
    driftWebStartedAtAfterEmulatorStart = true
    emulatorAuthorityLabel = '8'.repeat(64)
    emulatorAuthorityStartedAtLabel = undefined
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/changed a retained Room workload/)
    driftWebStartedAtAfterEmulatorStart = false
    webStartedAt = '2026-09-02T00:00:00.400000001Z'

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    controlSandboxId = 'e'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    restartedEmulatorStartedAt = '2026-09-02T00:00:03.000000001Z'
    driftControlImmediatelyAfterEmulatorStart = true
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(existsSync(join(
      root,
      'runtime',
      'network-recovery-attestations',
      `${ROOM_ID}-${ids.emulator}.json`
    ))).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    controlSandboxId = 'e'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    restartedEmulatorStartedAt = '2026-09-02T00:00:03.000000001Z'
    rotateControlSandboxOnStart = true
    driftControlImmediatelyAfterEmulatorStart = false
    driftControlSandboxAfterEmulatorStart = true
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID))
      .rejects.toThrow(/control anchor network namespace changed/)
    expect(existsSync(join(
      root,
      'runtime',
      'network-recovery-attestations',
      `${ROOM_ID}-${ids.emulator}.json`
    ))).toBe(false)

    mockedRunDocker.mockClear()
    anchorState = 'exited'
    emulatorState = 'exited'
    controlSandboxId = 'e'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:00.100000001Z'
    emulatorStartedAt = '2026-09-02T00:00:00.200000001Z'
    rotateControlSandboxOnStart = true
    driftControlSandboxAfterEmulatorStart = false
    emulatorAuthorityLabel = '8'.repeat(64)
    emulatorAuthorityStartedAtLabel = undefined
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID)).resolves.toBeUndefined()
    expect(mockedRunDocker.mock.calls
      .filter(([args]) => args[0] === 'start')
      .map(([args]) => args[1])).toEqual([ids.anchor, ids.emulator])
    expect(runtimeAnchorState).toBe('exited')
    expect(webState).toBe('exited')
    expect(existsSync(join(
      root,
      'runtime',
      'network-recovery-attestations',
      `${ROOM_ID}-${ids.emulator}.json`
    ))).toBe(true)

    mockedRunDocker.mockClear()
    await expect(backend().startExistingEmulatorForRecovery(ROOM_ID)).resolves.toBeUndefined()
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    runtimeAnchorState = 'running'
    webState = 'running'
    mockedRunDocker.mockClear()
    await expect(backend().emulatorState(ROOM_ID)).resolves.toBe('running')
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)

    controlSandboxId = '6'.repeat(64)
    anchorStartedAt = '2026-09-02T00:00:05.000000001Z'
    mockedRunDocker.mockClear()
    await expect(backend().emulatorState(ROOM_ID))
      .rejects.toThrow(/exact network namespace authority generation/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
  })

  it('aborted helper cleanup removes only the exact labeled container ID and ignores name reuse', async () => {
    const ownedIds = {
      anchor: 'a'.repeat(64),
      emulator: 'b'.repeat(64),
      helper: 'c'.repeat(64),
      runtime: 'e'.repeat(64),
      web: 'f'.repeat(64),
      controlNetwork: '2'.repeat(64),
      runtimeNetwork: '3'.repeat(64)
    }
    const sandboxId = 'd'.repeat(64)
    const runtimeSandboxId = '1'.repeat(64)
    const controlStartedAt = '2026-09-02T00:00:00.100000001Z'
    const runtimeStartedAt = '2026-09-02T00:00:00.200000001Z'
    const emulatorStartedAt = '2026-09-02T00:00:00.300000001Z'
    const webStartedAt = '2026-09-02T00:00:00.400000001Z'
    let helperInspect: Record<string, unknown> | null = null
    const roomContainer = (name: string, role: string, id: string) => ({
      Id: id,
      Name: `/${name}`,
      Config: { Labels: {
        'devhotel.room': ROOM_ID,
        'devhotel.role': role,
        'devhotel.managed': '1',
        ...(role === 'svc-emulator'
          ? {
              [NETWORK_AUTHORITY_SANDBOX_LABEL]: sandboxId,
              [NETWORK_AUTHORITY_STARTED_AT_LABEL]: controlStartedAt
            }
          : role === 'web'
            ? {
                [NETWORK_AUTHORITY_SANDBOX_LABEL]: runtimeSandboxId,
                [NETWORK_AUTHORITY_STARTED_AT_LABEL]: runtimeStartedAt
              }
            : {})
      } },
      State: {
        Status: 'running',
        StartedAt: role === 'anchor'
          ? controlStartedAt
          : role === 'android-runtime-anchor'
            ? runtimeStartedAt
            : role === 'svc-emulator'
              ? emulatorStartedAt
              : webStartedAt
      },
      ...(role === 'anchor'
        ? {
            NetworkSettings: {
              SandboxID: sandboxId,
              Networks: { [androidControlNetworkName(ROOM_ID)]: { NetworkID: ownedIds.controlNetwork } }
            }
          }
        : role === 'android-runtime-anchor'
          ? {
              NetworkSettings: {
                SandboxID: runtimeSandboxId,
                Networks: { [roomNetworkName(ROOM_ID)]: { NetworkID: ownedIds.runtimeNetwork } }
              }
            }
          : role === 'svc-emulator' || role === 'web'
            ? { NetworkSettings: { SandboxID: '' } }
            : {}),
      ...(role === 'anchor' ? { HostConfig: { NetworkMode: androidControlNetworkName(ROOM_ID) } } : {}),
      ...(role === 'android-runtime-anchor' ? { HostConfig: { NetworkMode: roomNetworkName(ROOM_ID) } } : {}),
      ...(role === 'web' ? { HostConfig: { NetworkMode: `container:${ownedIds.runtime}` } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${ownedIds.anchor}` } } : {})
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'rm') {
        helperInspect = null
        return ok
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        const control = args[2] === androidControlNetworkName(ROOM_ID) || args[2] === ownedIds.controlNetwork
        return {
          code: 0,
          stdout: JSON.stringify([{
            Id: control ? ownedIds.controlNetwork : ownedIds.runtimeNetwork,
            Name: control ? androidControlNetworkName(ROOM_ID) : roomNetworkName(ROOM_ID),
            Driver: 'bridge',
            Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'network', 'devhotel.managed': '1' },
            Containers: control
              ? { [ownedIds.anchor]: { Name: anchorName(ROOM_ID) } }
              : { [ownedIds.runtime]: { Name: androidRuntimeAnchorName(ROOM_ID) } }
          }]),
          stderr: ''
        }
      }
      if (args[0] === 'inspect') {
        if (args[1] === anchorName(ROOM_ID) || args[1] === ownedIds.anchor) {
          return {
            code: 0,
            stdout: JSON.stringify([roomContainer(anchorName(ROOM_ID), 'anchor', ownedIds.anchor)]),
            stderr: ''
          }
        }
        if (args[1] === emulatorName(ROOM_ID) || args[1] === ownedIds.emulator) {
          return {
            code: 0,
            stdout: JSON.stringify([roomContainer(emulatorName(ROOM_ID), 'svc-emulator', ownedIds.emulator)]),
            stderr: ''
          }
        }
        if (args[1] === androidRuntimeAnchorName(ROOM_ID) || args[1] === ownedIds.runtime) {
          return {
            code: 0,
            stdout: JSON.stringify([
              roomContainer(androidRuntimeAnchorName(ROOM_ID), 'android-runtime-anchor', ownedIds.runtime)
            ]),
            stderr: ''
          }
        }
        if (args[1] === webName(ROOM_ID) || args[1] === ownedIds.web) {
          return {
            code: 0,
            stdout: JSON.stringify([roomContainer(webName(ROOM_ID), 'web', ownedIds.web)]),
            stderr: ''
          }
        }
        return helperInspect && (
          args[1] === helperInspect.Id || args[1] === (helperInspect.Name as string).slice(1)
        )
          ? { code: 0, stdout: JSON.stringify([helperInspect]), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!
        const abortToken = args.find((arg) => arg.startsWith('devhotel.abort-token='))!.split('=')[1]!
        helperInspect = {
          ...roomContainer(name, 'job', ownedIds.helper),
          Config: { Labels: {
            'devhotel.room': ROOM_ID,
            'devhotel.role': 'job',
            'devhotel.managed': '1',
            'devhotel.abort-token': abortToken
          } },
          State: { Status: 'created' },
          HostConfig: { NetworkMode: `container:${ownedIds.emulator}` }
        }
        return { code: 0, stdout: `${ownedIds.helper}\n`, stderr: '' }
      }
      return ok
    })
    await new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state'])
    const helperCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'create')!
    const startCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'start')!
    const helperArgs = helperCall[0]
    const helperOpts = startCall[1]!
    const helperName = helperArgs[helperArgs.indexOf('--name') + 1]!
    const tokenLabel = helperArgs.find((arg) => arg.startsWith('devhotel.abort-token='))!
    const abortToken = tokenLabel.slice('devhotel.abort-token='.length)
    mockedRunDocker.mockClear()

    helperInspect = {
      ...roomContainer(helperName, 'job', 'd'.repeat(64)),
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'job', 'devhotel.managed': '1' } }
    }
    await expect(helperOpts.onAbort?.()).resolves.toBeUndefined()
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)

    helperInspect = {
      ...roomContainer(helperName, 'job', ownedIds.helper),
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'job', 'devhotel.managed': '1' } }
    }
    await expect(helperOpts.onAbort?.()).rejects.toThrow(/ownership changed/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false)

    helperInspect = {
      ...roomContainer(helperName, 'job', ownedIds.helper),
      Config: {
        Labels: {
          'devhotel.room': ROOM_ID,
          'devhotel.role': 'job',
          'devhotel.managed': '1',
          'devhotel.abort-token': abortToken
        }
      }
    }
    await helperOpts.onAbort?.()
    expect(mockedRunDocker.mock.calls.some(([args]) =>
      args[0] === 'rm' && args[1] === '-f' && args[2] === ownedIds.helper
    )).toBe(true)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'rm' && args[2] === helperName)).toBe(false)

  })
})
