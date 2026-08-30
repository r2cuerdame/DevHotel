import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { anchorName, emulatorName, webName, workspaceSnapshotVolume } from '../backend/naming'
import {
  importHostFolderScript,
  OciCliBackend,
  workspaceSnapshotScript,
  workspaceTransactionalFingerprintScript
} from '../backend/ociCli'
import { tempDir } from './fakes'
import { ANDROID_IMAGE } from '../providers/androidProvider'

vi.mock('../backend/cli', () => ({ runDocker: vi.fn() }))

const mockedRunDocker = vi.mocked(runDocker)
const ROOM_ID = 'room1abc'
const OPERATION_ID = '11111111-2222-4333-8444-555555555555'
const SNAPSHOT = workspaceSnapshotVolume(ROOM_ID, OPERATION_ID)
const ok = { code: 0, stdout: '', stderr: '' }

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
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, 'verified-apk')
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
    const run = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')?.[0]
    expect(run).toEqual(expect.arrayContaining([
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${SNAPSHOT}:/workspace:ro`
    ]))
    expect(run?.find((arg) => arg.endsWith(':/out'))).toBe(`${realpathSync.native(join(root, OPERATION_ID))}:/out`)
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
    ).rejects.toThrow(/copy failed/)
    expect(existsSync(join(root, OPERATION_ID))).toBe(false)
  })

  it('runs fenced emulator ADB through one private owned server in the anchor network namespace', async () => {
    const ids = {
      web: 'a'.repeat(64),
      anchor: 'b'.repeat(64),
      emulator: 'c'.repeat(64),
      sandbox: 'd'.repeat(64)
    }
    const inspect = (name: string, role: string, id: string, paused = false) => JSON.stringify([{
      Id: id,
      Name: `/${name}`,
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': role, 'devhotel.managed': '1' } },
      State: { Status: 'running', Paused: paused },
      ...(role === 'anchor' || role === 'svc-emulator' ? { NetworkSettings: { SandboxID: ids.sandbox } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${anchorName(ROOM_ID)}` } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'inspect') {
        if (args[1] === webName(ROOM_ID)) {
          return { code: 0, stdout: inspect(webName(ROOM_ID), 'web', ids.web, true), stderr: '' }
        }
        if (args[1] === anchorName(ROOM_ID)) {
          return { code: 0, stdout: inspect(anchorName(ROOM_ID), 'anchor', ids.anchor), stderr: '' }
        }
        if (args[1] === emulatorName(ROOM_ID)) {
          return { code: 0, stdout: inspect(emulatorName(ROOM_ID), 'svc-emulator', ids.emulator), stderr: '' }
        }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        opts?.onStdout?.('device\n')
        return ok
      }
      return ok
    })

    const result = await new OciCliBackend().execFencedEmulatorAdb(
      ROOM_ID,
      ['shell', 'getprop', 'sys.boot_completed'],
      { timeoutMs: 20_000, maxStdoutBytes: 128, maxStderrBytes: 64 }
    )

    expect(result).toEqual({ code: 0, stdout: 'device\n', stderr: '' })
    const call = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')!
    const run = call[0]
    const runOpts = call[1]
    expect(run).toEqual(expect.arrayContaining([
      '--network', `container:${ids.anchor}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--entrypoint', '/bin/sh',
      ANDROID_IMAGE
    ]))
    expect(run).not.toContain('/workspace')
    expect(run).not.toContain('--entrypoint=adb')
    const script = run[run.indexOf('-c') + 1]!
    expect(script).toContain('env -i')
    expect(script).toContain('localfilesystem:$socket_path')
    expect(script).toContain('"$adb" -L "$socket" -s emulator-5554')
    expect(script).toContain('[ ! -e "$socket_path" ] && [ ! -L "$socket_path" ]')
    expect(script).toContain('[ -S "$socket_path" ]')
    expect(script).toContain('run_adb kill-server')
    expect(script).not.toMatch(/localhost|127\.0\.0\.1|5037|tcp:/)
    expect(run.slice(-3)).toEqual(['shell', 'getprop', 'sys.boot_completed'])
    expect(run).toEqual(expect.arrayContaining(['shell', 'getprop', 'sys.boot_completed']))
    expect(runOpts).toMatchObject({
      timeoutMs: 20_000,
      maxStdoutBytes: 128,
      maxStderrBytes: 64,
      onAbort: expect.any(Function)
    })
  })

  it('cuts off fenced helper sinks at the requested cap and rejects all later chunks', async () => {
    const inspect = (name: string, role: string, paused = false) => JSON.stringify([{
      Id: role === 'anchor' ? 'b'.repeat(64) : role === 'svc-emulator' ? 'c'.repeat(64) : 'a'.repeat(64),
      Name: `/${name}`,
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': role, 'devhotel.managed': '1' } },
      State: { Status: 'running', Paused: paused },
      ...(role === 'anchor' || role === 'svc-emulator' ? { NetworkSettings: { SandboxID: 'd'.repeat(64) } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${anchorName(ROOM_ID)}` } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args, opts) => {
      if (args[0] === 'inspect') {
        const name = args[1]!
        if (name === webName(ROOM_ID)) return { code: 0, stdout: inspect(name, 'web', true), stderr: '' }
        if (name === anchorName(ROOM_ID)) return { code: 0, stdout: inspect(name, 'anchor'), stderr: '' }
        if (name === emulatorName(ROOM_ID)) return { code: 0, stdout: inspect(name, 'svc-emulator'), stderr: '' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      if (args[0] === 'run') {
        opts?.onStdout?.('abcdefgh')
        opts?.onStdout?.('must-not-pass')
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
  })

  it('accepts Moby name-form container mode but refuses a different network sandbox', async () => {
    const container = (name: string, role: string, id: string, sandboxId: string, networkMode?: string) => JSON.stringify([{
      Id: id,
      Name: `/${name}`,
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': role, 'devhotel.managed': '1' } },
      State: { Status: 'running' },
      NetworkSettings: { SandboxID: sandboxId },
      ...(networkMode ? { HostConfig: { NetworkMode: networkMode } } : {})
    }])
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'inspect' && args[1] === anchorName(ROOM_ID)) {
        return { code: 0, stdout: container(args[1], 'anchor', 'a'.repeat(64), 'd'.repeat(64)), stderr: '' }
      }
      if (args[0] === 'inspect' && args[1] === emulatorName(ROOM_ID)) {
        return {
          code: 0,
          stdout: container(
            args[1],
            'svc-emulator',
            'b'.repeat(64),
            'e'.repeat(64),
            `container:${anchorName(ROOM_ID)}`
          ),
          stderr: ''
        }
      }
      return ok
    })

    await expect(new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state']))
      .rejects.toThrow(/exact owned anchor network namespace/)
    expect(mockedRunDocker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false)
  })

  it('aborted helper cleanup removes only the exact labeled container ID and ignores name reuse', async () => {
    const ownedIds = { anchor: 'a'.repeat(64), emulator: 'b'.repeat(64), helper: 'c'.repeat(64) }
    const sandboxId = 'd'.repeat(64)
    let helperInspect: Record<string, unknown> | null = null
    const roomContainer = (name: string, role: string, id: string) => ({
      Id: id,
      Name: `/${name}`,
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': role, 'devhotel.managed': '1' } },
      State: { Status: 'running' },
      ...(role === 'anchor' || role === 'svc-emulator' ? { NetworkSettings: { SandboxID: sandboxId } } : {}),
      ...(role === 'svc-emulator' ? { HostConfig: { NetworkMode: `container:${anchorName(ROOM_ID)}` } } : {})
    })
    mockedRunDocker.mockImplementation(async (args) => {
      if (args[0] === 'rm') {
        helperInspect = null
        return ok
      }
      if (args[0] === 'inspect') {
        if (args[1] === anchorName(ROOM_ID)) {
          return { code: 0, stdout: JSON.stringify([roomContainer(args[1], 'anchor', ownedIds.anchor)]), stderr: '' }
        }
        if (args[1] === emulatorName(ROOM_ID)) {
          return { code: 0, stdout: JSON.stringify([roomContainer(args[1], 'svc-emulator', ownedIds.emulator)]), stderr: '' }
        }
        return helperInspect
          ? { code: 0, stdout: JSON.stringify([helperInspect]), stderr: '' }
          : { code: 1, stdout: '', stderr: 'No such container' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') return ok
      return ok
    })
    await new OciCliBackend().execFencedEmulatorAdb(ROOM_ID, ['get-state'])
    const helperCall = mockedRunDocker.mock.calls.find(([args]) => args[0] === 'run')!
    const helperArgs = helperCall[0]
    const helperOpts = helperCall[1]!
    const helperName = helperArgs[helperArgs.indexOf('--name') + 1]!
    const tokenLabel = helperArgs.find((arg) => arg.startsWith('devhotel.abort-token='))!
    const abortToken = tokenLabel.slice('devhotel.abort-token='.length)

    helperInspect = {
      ...roomContainer(helperName, 'job', 'd'.repeat(64)),
      Config: { Labels: { 'devhotel.room': ROOM_ID, 'devhotel.role': 'job', 'devhotel.managed': '1' } }
    }
    await helperOpts.onAbort?.()
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
