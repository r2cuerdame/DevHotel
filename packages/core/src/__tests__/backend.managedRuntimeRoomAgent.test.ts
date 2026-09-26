import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_AGENT_PORT,
  MANAGED_RUNTIME_GUEST_ENGINE,
  MANAGED_RUNTIME_GUEST_STAGE_ROOT,
  MANAGED_RUNTIME_GUEST_STATE_ROOT,
  buildManagedRuntimeGuestAgent
} from '../backend/managedRuntimeGuestAgent'
import {
  MANAGED_RUNTIME_GUEST_APK_BRANCH,
  MANAGED_RUNTIME_GUEST_PACKAGES,
  MANAGED_RUNTIME_STATE_LABEL,
  buildManagedRuntimeGuestOverlay,
  type ManagedRuntimeGuestIdentity
} from '../backend/managedRuntimeGuestOverlay'

const run = promisify(execFile)
const temps: string[] = []

const identity: ManagedRuntimeGuestIdentity = {
  installId: 'install-0123456789',
  runtimeId: 'runtime-0123456789',
  runtimeVersion: '0.2.0',
  daemonVersion: '0.2.0'
}

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  )
})

/** Reads one member's content out of the overlay archive. */
function member(bytes: Buffer, wanted: string): string {
  const tar = gunzipSync(bytes)
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const block = tar.subarray(offset, offset + 512)
    const name = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    if (name === wanted) return tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`the overlay carries no ${wanted}`)
}

function members(bytes: Buffer): Map<string, { type: string; mode: string; link: string }> {
  const tar = gunzipSync(bytes)
  const entries = new Map<string, { type: string; mode: string; link: string }>()
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const block = tar.subarray(offset, offset + 512)
    const name = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    entries.set(name, {
      type: block.subarray(156, 157).toString('ascii'),
      mode: block.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(),
      link: block.subarray(157, 257).toString('ascii').replace(/\0.*$/, '')
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/** A cold interpreter on a loaded Windows runner can take seconds to start. */
const PYTHON_SPAWN_TIMEOUT_MS = 45_000

/**
 * Compiles `file` with the first Python found, in one spawn per candidate:
 * probing with `--version` first doubled the cold starts that pushed this past
 * the suite timeout on CI. `-I -S -B` skips site-packages and writes no .pyc.
 * Returns false when no interpreter exists (ENOENT, or the Windows Store alias
 * stub exiting 9009); a syntax error rejects.
 */
async function compilePython(file: string): Promise<boolean> {
  const source = "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')"
  for (const candidate of ['python3', 'python', 'py']) {
    try {
      await run(candidate, ['-I', '-S', '-B', '-c', source, file], { timeout: PYTHON_SPAWN_TIMEOUT_MS })
      return true
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT' || code === 9009) continue
      throw error
    }
  }
  return false
}

async function posixShell(): Promise<string | null> {
  if (process.platform !== 'win32') return 'sh'
  for (const candidate of [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe')
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

describe('managed runtime Room command agent', () => {
  it('runs one pinned engine and never evaluates a shell string', () => {
    const agent = buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId })

    expect(agent).toContain(JSON.stringify(MANAGED_RUNTIME_GUEST_ENGINE))
    // argv is passed as a list to one fixed executable. `shell=True`, `os.system`
    // or `eval` would turn a Room's own argument into guest code execution.
    expect(agent).toContain('[ENGINE] + argv')
    expect(agent).not.toMatch(/shell\s*=\s*True/)
    expect(agent).not.toMatch(/\bos\.system\b/)
    expect(agent).not.toMatch(/\beval\(|\bexec\(/)
  })

  it('refuses every operation until the boot token is proven, in constant time', () => {
    const agent = buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId })

    expect(agent).toContain('hmac.compare_digest')
    // Authorization is checked before any operation dispatch, not per-operation,
    // so a new op cannot be added without inheriting the gate.
    expect(agent.indexOf('if not self.authorized:')).toBeLessThan(agent.indexOf('if op == "exec"'))
    expect(agent).toContain('"message": "unauthorized"')
  })

  it('binds the token to this install so another install cannot drive this runtime', () => {
    const one = buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId })
    const other = buildManagedRuntimeGuestAgent({ installId: 'install-9999999999', runtimeId: identity.runtimeId })

    expect(one).toContain(JSON.stringify(identity.installId))
    expect(one).not.toBe(other)
    // The token is derived, per boot, from fresh entropy plus this identity, and
    // is stored where only root can read it.
    expect(one).toContain('os.urandom(32)')
    expect(one).toContain('0o600')
  })

  it('rejects an identity that could break out of the generated agent', () => {
    expect(() =>
      buildManagedRuntimeGuestAgent({ installId: 'bad"; import os; os.system("x")', runtimeId: identity.runtimeId })
    ).toThrow(/identity is invalid/)
    expect(() => buildManagedRuntimeGuestAgent({ installId: 'short', runtimeId: identity.runtimeId })).toThrow(
      /identity is invalid/
    )
  })

  it('confines file transfer to the staging root, after resolving symlinks', () => {
    const agent = buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId })

    expect(agent).toContain('os.path.realpath')
    expect(agent).toContain('path escapes the DevHotel staging root')
    // `realpath` before the prefix check is what makes a symlink planted by a
    // Room unable to redirect a Host transfer outside the staging root.
    expect(agent.indexOf('os.path.realpath')).toBeLessThan(agent.indexOf('candidate.startswith'))
  })

  it('is syntactically valid Python', { timeout: PYTHON_SPAWN_TIMEOUT_MS + 5_000 }, async (ctx) => {
    // A syntax error here would surface only as a runtime that boots and never
    // accepts a Room command, so it is caught where the file is generated.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-room-agent-'))
    temps.push(dir)
    const file = path.join(dir, 'agent.py')
    await writeFile(file, buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId }))

    if (!(await compilePython(file))) return ctx.skip()
  })
})

describe('managed runtime guest overlay, Room-capable', () => {
  it('installs the agent, the engine and the state disk as ordered services', () => {
    const table = members(buildManagedRuntimeGuestOverlay(identity).bytes)

    for (const file of [
      'usr/local/sbin/devhotel-room-agent',
      'usr/local/sbin/devhotel-engine',
      'usr/local/sbin/devhotel-runtime-state'
    ]) {
      expect(table.get(file)?.mode).toBe('0000755')
    }
    for (const service of ['devhotel-room-agent', 'devhotel-engine', 'devhotel-runtime-state']) {
      expect(table.get(`etc/init.d/${service}`)?.mode).toBe('0000755')
      expect(table.get(`etc/runlevels/default/${service}`)?.type).toBe('2')
    }
  })

  it('orders the services so a Room command can never precede a ready engine', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)

    // The engine's data root and packages live on the state disk, and serving a
    // Room command before the engine answers would turn a slow start into a
    // failed Room create.
    expect(member(overlay.bytes, 'etc/init.d/devhotel-engine')).toContain('need devhotel-runtime-state')
    expect(member(overlay.bytes, 'etc/init.d/devhotel-engine')).toContain('need net')
    expect(member(overlay.bytes, 'etc/init.d/devhotel-room-agent')).toContain('need devhotel-engine')
  })

  it('puts everything the engine writes on the persistent disk', () => {
    const engine = member(buildManagedRuntimeGuestOverlay(identity).bytes, 'usr/local/sbin/devhotel-engine')

    // This is Room persistence across sleep, wake and a Host reboot: an engine
    // whose data root stayed on the diskless tmpfs would lose every workspace,
    // dependency generation and service volume on every boot.
    expect(engine).toContain('"data-root"')
    expect(engine).toContain(MANAGED_RUNTIME_GUEST_STATE_ROOT)
    expect(engine).toContain('/engine')
  })

  it('formats a disk only when it is blank, and finds it again by its own label', () => {
    const state = member(buildManagedRuntimeGuestOverlay(identity).bytes, 'usr/local/sbin/devhotel-runtime-state')

    expect(state).toContain(`label=${MANAGED_RUNTIME_STATE_LABEL}`)
    expect(state).toContain('blkid -L "$label"')
    // The one destructive act in the guest bootstrap. A candidate is skipped if
    // it reports any filesystem, or has any partition, so a disk holding Room
    // data — or a user's disk — is never reformatted.
    expect(state).toContain('blkid -s TYPE -o value "$candidate"')
    expect(state).toMatch(/if \[ -n "\$\(blkid -s TYPE[^\n]*\]; then continue; fi/)
    expect(state.indexOf('continue; fi')).toBeLessThan(state.indexOf('mkfs.ext4'))
    expect(state).toContain('mkfs.ext4 -q -L "$label"')
  })

  it('resolves guest packages from the same pinned branch as the boot image', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const repositories = member(overlay.bytes, 'etc/apk/repositories')

    for (const component of ['main', 'community']) {
      expect(repositories).toContain(
        `https://dl-cdn.alpinelinux.org/alpine/${MANAGED_RUNTIME_GUEST_APK_BRANCH}/${component}`
      )
    }
    const engine = member(overlay.bytes, 'usr/local/sbin/devhotel-engine')
    for (const pkg of MANAGED_RUNTIME_GUEST_PACKAGES) expect(engine).toContain(pkg)
    // The cache on the persistent disk is what makes every boot after the first
    // one work with no network at all.
    expect(engine).toContain('--no-network')
    expect(engine).toContain('apk-cache')
  })

  it('bounds the Room command channel to the private NIC and the boot token', () => {
    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const agent = member(overlay.bytes, 'usr/local/sbin/devhotel-room-agent')

    // The listener is deliberate — Rooms cannot be driven over an emulated UART.
    // What bounds it is that the switch is a NAT'd private network, and that the
    // agent answers nothing before the per-boot token it never publishes.
    expect(agent).toContain(`PORT = ${MANAGED_RUNTIME_AGENT_PORT}`)
    expect(agent).toContain('hmac.compare_digest')
    expect(agent).toContain(MANAGED_RUNTIME_GUEST_STAGE_ROOT)

    // The token reaches the Host only over the serial line.
    const serial = member(overlay.bytes, 'usr/local/sbin/devhotel-runtime-agent')
    expect(serial).toContain('channel:')
    expect(serial).toContain('boot-token')
    // And only once DHCP has produced a global address; a half-ready runtime
    // reports that rather than an address the Host cannot use.
    expect(serial).toContain('"state":"preparing"')
    expect(serial).toContain('scope global')
  })

  it('generates state and engine scripts a POSIX shell accepts', async (ctx) => {
    const shell = await posixShell()
    if (!shell) return ctx.skip()

    const overlay = buildManagedRuntimeGuestOverlay(identity)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-guest-scripts-'))
    temps.push(dir)

    for (const name of ['devhotel-runtime-state', 'devhotel-engine']) {
      const file = path.join(dir, name)
      await writeFile(file, member(overlay.bytes, `usr/local/sbin/${name}`))
      await expect(run(shell, ['-n', file])).resolves.toBeTruthy()
    }
  })

  it('still writes nothing outside the DevHotel-owned guest paths', () => {
    for (const name of members(buildManagedRuntimeGuestOverlay(identity).bytes).keys()) {
      expect(name).toMatch(/^(etc|usr)(\/|$)/)
      expect(name).not.toContain('..')
      expect(path.posix.isAbsolute(name)).toBe(false)
    }
  })

  it('stays byte-identical for one identity and changes with the runtime version', () => {
    const first = buildManagedRuntimeGuestOverlay(identity)
    expect(buildManagedRuntimeGuestOverlay(identity).bytes.equals(first.bytes)).toBe(true)
    // The provider refuses to re-seed a different overlay under a runtime it
    // already provisioned, so the digest moving is what forces a version bump.
    expect(buildManagedRuntimeGuestOverlay({ ...identity, runtimeVersion: '0.3.0' }).sha256).not.toBe(first.sha256)
  })
})
