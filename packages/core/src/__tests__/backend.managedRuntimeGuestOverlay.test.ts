import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_GUEST_SERIAL,
  MANAGED_RUNTIME_OVERLAY_FILE,
  buildManagedRuntimeGuestOverlay,
  type ManagedRuntimeGuestIdentity
} from '../backend/managedRuntimeGuestOverlay'

const run = promisify(execFile)
const temps: string[] = []

/**
 * GNU tar reads a `C:\...` argument as a `host:path` remote spec, so on
 * Windows the test drives the system bsdtar instead. Alpine's initramfs uses
 * busybox tar; either one proves the archive is well formed.
 */
function tarExecutable(): string {
  if (process.platform !== 'win32') return 'tar'
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(system) ? system : 'tar'
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-guest-overlay-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const identity: ManagedRuntimeGuestIdentity = {
  installId: 'install-abcdef01',
  runtimeId: 'runtime-0123456789',
  runtimeVersion: '0.1.0',
  daemonVersion: '0.1.0'
}

/**
 * The guest agent runs under busybox ash. Any POSIX shell is close enough to
 * catch the mistakes that matter here; where none exists the two tests that
 * need one skip rather than fail, because a missing shell is an environment
 * gap and not a defect in the archive.
 */
let shellProbe: Promise<string | null> | null = null
function posixShell(): Promise<string | null> {
  shellProbe ??= (async () => {
    for (const shell of ['sh', 'bash']) {
      const ok = await run(shell, ['-c', 'exit 0'], { timeout: 30_000 }).then(
        () => true,
        () => false
      )
      if (ok) return shell
    }
    return null
  })()
  return shellProbe
}

/** The agent script exactly as it is written into the overlay. */
function agentSource(overlay: { bytes: Buffer }): string {
  const tar = gunzipSync(overlay.bytes)
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const block = tar.subarray(offset, offset + 512)
    const name = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    if (name === 'usr/local/sbin/devhotel-runtime-agent') {
      return tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('the overlay carries no agent script')
}

/** Reads the ustar member table straight out of the archive. */
function members(bytes: Buffer): { name: string; type: string; mode: string; link: string }[] {
  const tar = gunzipSync(bytes)
  const entries: { name: string; type: string; mode: string; link: string }[] = []
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const block = tar.subarray(offset, offset + 512)
    const name = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    entries.push({
      name,
      type: block.subarray(156, 157).toString('ascii'),
      mode: block.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(),
      link: block.subarray(157, 257).toString('ascii').replace(/\0.*$/, '')
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

describe('managed runtime guest overlay', () => {
  it('is a gzipped tar named so the Alpine initramfs will find it', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    expect(overlay.fileName).toBe(MANAGED_RUNTIME_OVERLAY_FILE)
    // `nlplug-findfs` matches `*.apkovl.tar.gz*` on any attached block device.
    expect(overlay.fileName).toMatch(/\.apkovl\.tar\.gz$/)
    expect(overlay.bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(gunzipSync(overlay.bytes).byteLength % 512).toBe(0)
  })

  it('carries exactly the ownership record, agent, service and runlevel link', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const table = members(overlay.bytes)
    const byName = new Map(table.map((entry) => [entry.name, entry]))

    expect(byName.get('etc/devhotel/ownership.json')?.mode).toBe('0000600')
    expect(byName.get('usr/local/sbin/devhotel-runtime-agent')?.mode).toBe('0000755')
    expect(byName.get('etc/init.d/devhotel-runtime-agent')?.mode).toBe('0000755')

    const link = byName.get('etc/runlevels/default/devhotel-runtime-agent')
    expect(link?.type).toBe('2')
    expect(link?.link).toBe('/etc/init.d/devhotel-runtime-agent')

    // Without this marker `initramfs-init` skips devfs/mdev/hwdrivers/modloop.
    expect(byName.has('etc/.default_boot_services')).toBe(true)

    // Nothing outside the DevHotel-owned paths may be written into the guest.
    for (const entry of table) {
      expect(entry.name).toMatch(/^(etc|usr)(\/|$)/)
      expect(entry.name).not.toContain('..')
      expect(path.posix.isAbsolute(entry.name)).toBe(false)
    }
  })

  it('produces byte-identical archives for the same identity', () => {
    const first = buildManagedRuntimeGuestOverlay(identity)
    const second = buildManagedRuntimeGuestOverlay(identity)
    expect(first.sha256).toBe(second.sha256)
    expect(first.bytes.equals(second.bytes)).toBe(true)
  })

  it('binds the archive digest to the runtime identity', () => {
    const first = buildManagedRuntimeGuestOverlay(identity)
    const other = buildManagedRuntimeGuestOverlay({ ...identity, runtimeId: 'runtime-9876543210' })
    expect(other.sha256).not.toBe(first.sha256)
  })

  it('answers health only on the private COM2 serial with the exact identity', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const tar = gunzipSync(overlay.bytes).toString('utf8')
    expect(tar).toContain(MANAGED_RUNTIME_GUEST_SERIAL)
    expect(tar).toContain('"state":"ready"')
    expect(tar).toContain(identity.installId)
    expect(tar).toContain(identity.runtimeId)
    // No Host-reachable network listener is ever installed in the guest.
    expect(tar).not.toMatch(/\b(nc|socat|sshd|iptables)\b.*-l/)
    expect(tar).not.toContain('0.0.0.0')
  })

  it('generates an agent script a POSIX shell accepts', async (ctx) => {
    const shell = await posixShell()
    if (!shell) return ctx.skip()

    // The guest runs this under busybox ash. A syntax error here would only
    // ever surface as a runtime that boots and never answers health, so it is
    // worth catching on the Host where the archive is built.
    const dir = await tempDir()
    const script = path.join(dir, 'agent.sh')
    await writeFile(script, agentSource(buildManagedRuntimeGuestOverlay(identity)))

    const failure = await run(shell, ['-n', 'agent.sh'], { cwd: dir, timeout: 30_000 }).catch(
      (error: unknown) => error as { stderr?: string }
    )
    expect((failure as { stderr?: string } | undefined)?.stderr ?? '').toBe('')
  })

  it('keeps answering health after the Host drops the serial line', async (ctx) => {
    const shell = await posixShell()
    if (!shell) return ctx.skip()

    // Hyper-V backs COM2 with a named pipe the Host opens and closes once per
    // probe, so the guest sees a disconnect after every single health check.
    // A regular file stands in here: it hands the agent one request and then
    // EOFs, which is exactly the shape of that disconnect.
    const dir = await tempDir()
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const source = agentSource(overlay).replace(
      `serial=${MANAGED_RUNTIME_GUEST_SERIAL}`,
      'serial=serial.txt'
    )
    expect(source).toContain('serial=serial.txt')
    await writeFile(path.join(dir, 'agent.sh'), source)
    await writeFile(path.join(dir, 'serial.txt'), 'health:0a1b2c3d\n')

    const agent = spawn(shell, ['agent.sh'], { cwd: dir, stdio: 'ignore' })
    let exited: number | null | 'running' = 'running'
    agent.on('exit', (code) => {
      exited = code
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000))

      const transcript = await readFile(path.join(dir, 'serial.txt'), 'utf8')
      const reply = transcript.split('\n').find((line) => line.startsWith('{'))
      expect(reply, `agent wrote no reply: ${JSON.stringify(transcript)}`).toBeTruthy()
      expect(JSON.parse(reply ?? '{}')).toEqual({
        owner: 'devhotel',
        installId: identity.installId,
        runtimeId: identity.runtimeId,
        runtimeVersion: identity.runtimeVersion,
        daemonVersion: identity.daemonVersion,
        state: 'ready',
        requestId: '0a1b2c3d'
      })

      // The point of the reconnect loop: EOF on the line must not end the
      // agent, or the runtime answers exactly one probe and is dead after it.
      expect(exited, 'the agent exited instead of reopening the serial line').toBe('running')
    } finally {
      agent.kill()
    }
  })

  it('records the ownership the Host will demand back over the wire', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    expect(overlay.ownership).toEqual({
      schemaVersion: 1,
      owner: 'devhotel',
      backend: 'hyper-v',
      installId: identity.installId,
      runtimeId: identity.runtimeId,
      runtimeVersion: identity.runtimeVersion
    })
  })

  it('rejects an identity that could break out of the generated guest files', () => {
    for (const bad of ['install "; reboot', "install'", 'install\nreboot', '', 'install$(reboot)']) {
      expect(() => buildManagedRuntimeGuestOverlay({ ...identity, installId: bad })).toThrow(/identity is invalid/)
    }
  })

  it('extracts with a real tar exactly as the Alpine initramfs would', async () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const dir = await tempDir()
    const archive = path.join(dir, overlay.fileName)
    const dest = path.join(dir, 'root')
    await writeFile(archive, overlay.bytes)
    await mkdir(dest, { recursive: true })

    // `initramfs-init` runs exactly `tar -C "$dest" -zxvf "$ovl"`.
    const extracted = await run(tarExecutable(), ['-C', dest, '-zxvf', archive], { timeout: 30_000 }).catch(
      (error: unknown) => error as { stderr?: string }
    )

    const ownership = JSON.parse(await readFile(path.join(dest, 'etc/devhotel/ownership.json'), 'utf8')) as unknown
    expect(ownership).toEqual(overlay.ownership)

    const agent = await readFile(path.join(dest, 'usr/local/sbin/devhotel-runtime-agent'), 'utf8')
    expect(agent.startsWith('#!/bin/sh')).toBe(true)
    expect(agent).toContain(MANAGED_RUNTIME_GUEST_SERIAL)

    const service = await readFile(path.join(dest, 'etc/init.d/devhotel-runtime-agent'), 'utf8')
    expect(service.startsWith('#!/sbin/openrc-run')).toBe(true)

    expect((await stat(path.join(dest, 'etc/devhotel'))).isDirectory()).toBe(true)
    expect(await readFile(path.join(dest, 'etc/.default_boot_services'), 'utf8')).toBe('')

    // Creating a symlink needs privileges Windows CI does not grant, so the
    // runlevel link is asserted from the archive header there; where the
    // extraction did succeed the link must point at the service script.
    const linkPath = path.join(dest, 'etc/runlevels/default/devhotel-runtime-agent')
    const target = await readlink(linkPath).catch(() => null)
    if (target === null) {
      expect(String((extracted as { stderr?: string })?.stderr ?? '')).toMatch(/symlink|privilege|Cannot|link/i)
    } else {
      expect(target.replaceAll('\\', '/')).toBe('/etc/init.d/devhotel-runtime-agent')
    }
  })
})
