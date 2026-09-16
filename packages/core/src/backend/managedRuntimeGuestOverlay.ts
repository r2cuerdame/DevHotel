import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

/**
 * DevHotel's guest bootstrap, expressed as an Alpine *apkovl* overlay.
 *
 * Alpine's initramfs (`nlplug-findfs`) scans every attached block device for a
 * `*.apkovl.tar.gz` and `initramfs-init` extracts the first one it finds into
 * the new root before OpenRC starts. That is the only offline configuration
 * channel the published Alpine images actually honour: the cloud VHDs pin
 * cloud-init to their own provider's datasource, so a `CIDATA` seed is never
 * read. This path needs no network, no cloud-init and no datasource.
 *
 * The archive is built deterministically — fixed mtimes, root ownership,
 * fixed member order — so the same runtime identity always produces the same
 * bytes, and the digest can be recorded as ownership evidence.
 */

export interface ManagedRuntimeGuestIdentity {
  installId: string
  runtimeId: string
  runtimeVersion: string
  daemonVersion: string
}

export interface ManagedRuntimeGuestOwnership {
  schemaVersion: 1
  owner: 'devhotel'
  backend: 'hyper-v'
  installId: string
  runtimeId: string
  runtimeVersion: string
}

export interface ManagedRuntimeGuestOverlay {
  /** File name the guest initramfs matches against `*.apkovl.tar.gz`. */
  fileName: string
  bytes: Buffer
  sha256: string
  ownership: ManagedRuntimeGuestOwnership
}

/** The serial port DevHotel wires to its private named pipe: Hyper-V COM2. */
export const MANAGED_RUNTIME_GUEST_SERIAL = '/dev/ttyS1'
export const MANAGED_RUNTIME_OVERLAY_FILE = 'devhotel.apkovl.tar.gz'

const IDENTITY = /^[0-9A-Za-z._-]{1,128}$/
/** A fixed timestamp keeps the archive byte-identical across builds. */
const FIXED_MTIME = 0

type EntryType = 'file' | 'directory' | 'symlink'

interface Entry {
  path: string
  type: EntryType
  mode: number
  content?: string
  linkTarget?: string
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii')
}

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512)
  const typeflag = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0'
  const name = entry.type === 'directory' ? `${entry.path}/` : entry.path
  if (Buffer.byteLength(name, 'utf8') > 100) throw new Error('Managed runtime guest overlay path is too long')

  block.write(name, 0, 100, 'utf8')
  octal(entry.mode, 8).copy(block, 100)
  octal(0, 8).copy(block, 108) // uid: root
  octal(0, 8).copy(block, 116) // gid: root
  octal(size, 12).copy(block, 124)
  octal(FIXED_MTIME, 12).copy(block, 136)
  block.write('        ', 148, 8, 'ascii') // checksum placeholder
  block.write(typeflag, 156, 1, 'ascii')
  if (entry.linkTarget) block.write(entry.linkTarget, 157, 100, 'utf8')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write('root', 265, 32, 'ascii')
  block.write('root', 297, 32, 'ascii')

  let checksum = 0
  for (const byte of block) checksum += byte
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return block
}

function pad(size: number): Buffer {
  const remainder = size % 512
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder)
}

function tar(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const content = entry.type === 'file' ? Buffer.from(entry.content ?? '', 'utf8') : Buffer.alloc(0)
    blocks.push(header(entry, content.byteLength), content, pad(content.byteLength))
  }
  // Two zero blocks terminate a tar archive.
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function assertIdentity(identity: ManagedRuntimeGuestIdentity): void {
  for (const value of [identity.installId, identity.runtimeId, identity.runtimeVersion, identity.daemonVersion]) {
    if (!IDENTITY.test(value)) throw new Error('Managed runtime guest identity is invalid')
  }
}

/**
 * The private runtime agent. It speaks only on Hyper-V COM2, has no TCP or
 * management socket, and answers a health request by echoing back the exact
 * nonce the Host sent along with the identity this install was provisioned
 * with. The Host accepts a health proof only if both match.
 */
function agentScript(identity: ManagedRuntimeGuestIdentity): string {
  const reply = [
    '{"owner":"devhotel"',
    `"installId":"${identity.installId}"`,
    `"runtimeId":"${identity.runtimeId}"`,
    `"runtimeVersion":"${identity.runtimeVersion}"`,
    `"daemonVersion":"${identity.daemonVersion}"`,
    '"state":"ready"'
  ].join(',')
  return [
    '#!/bin/sh',
    '# Answers DevHotel health probes on the private Hyper-V COM2 line.',
    '# The Host opens and closes the named pipe once per probe, so a read or',
    '# write can fail whenever it disconnects. Those are expected, not fatal:',
    '# the agent reopens the port and keeps serving instead of exiting and',
    '# leaving the runtime permanently unhealthy.',
    'set -u',
    `serial=${MANAGED_RUNTIME_GUEST_SERIAL}`,
    `reply='${reply}'`,
    'while true; do',
    '  # `clocal` matters: without it the shell blocks in open(2) waiting for a',
    '  # carrier the emulated UART need not assert. stty itself opens the port',
    '  # non-blocking, so it can set that even while nothing is connected.',
    '  stty -F "$serial" raw -echo clocal 115200 2>/dev/null || true',
    '  # `exec` is a POSIX special built-in: under busybox ash a failed',
    '  # redirection exits the shell outright, and `if`/`||` do not catch it.',
    '  # Opening the port inside a subshell keeps that failure survivable.',
    '  (',
    '    exec 3<>"$serial" || exit 1',
    '    while IFS= read -r request <&3; do',
    '      case "$request" in',
    '        health:*) ;;',
    '        *) continue ;;',
    '      esac',
    '      nonce=${request#health:}',
    '      nonce=${nonce%%[!0-9a-f]*}',
    '      [ -n "$nonce" ] || continue',
    '      printf \'%s,"requestId":"%s"}\\n\' "$reply" "$nonce" >&3 || exit 0',
    '    done',
    '  )',
    '  sleep 1',
    'done',
    ''
  ].join('\n')
}

function serviceScript(): string {
  return [
    '#!/sbin/openrc-run',
    'name="DevHotel private runtime agent"',
    'command=/usr/local/sbin/devhotel-runtime-agent',
    'command_background=true',
    'pidfile=/run/devhotel-runtime-agent.pid',
    'output_log=/var/log/devhotel-runtime-agent.log',
    'error_log=/var/log/devhotel-runtime-agent.log',
    '',
    'depend() {',
    '\tneed localmount',
    '\tafter bootmisc',
    '}',
    ''
  ].join('\n')
}

export function buildManagedRuntimeGuestOverlay(identity: ManagedRuntimeGuestIdentity): ManagedRuntimeGuestOverlay {
  assertIdentity(identity)
  const ownership: ManagedRuntimeGuestOwnership = {
    schemaVersion: 1,
    owner: 'devhotel',
    backend: 'hyper-v',
    installId: identity.installId,
    runtimeId: identity.runtimeId,
    runtimeVersion: identity.runtimeVersion
  }

  const entries: Entry[] = [
    { path: 'etc', type: 'directory', mode: 0o755 },
    // Without this marker `initramfs-init` skips Alpine's own boot services
    // whenever an apkovl is present, which would leave the guest with no
    // devfs, mdev, hwdrivers or modloop — and therefore no kernel modules.
    { path: 'etc/.default_boot_services', type: 'file', mode: 0o644, content: '' },
    { path: 'etc/devhotel', type: 'directory', mode: 0o700 },
    {
      path: 'etc/devhotel/ownership.json',
      type: 'file',
      mode: 0o600,
      content: `${JSON.stringify(ownership, null, 2)}\n`
    },
    { path: 'etc/init.d', type: 'directory', mode: 0o755 },
    { path: 'etc/init.d/devhotel-runtime-agent', type: 'file', mode: 0o755, content: serviceScript() },
    { path: 'etc/runlevels', type: 'directory', mode: 0o755 },
    { path: 'etc/runlevels/default', type: 'directory', mode: 0o755 },
    {
      path: 'etc/runlevels/default/devhotel-runtime-agent',
      type: 'symlink',
      mode: 0o777,
      linkTarget: '/etc/init.d/devhotel-runtime-agent'
    },
    { path: 'usr', type: 'directory', mode: 0o755 },
    { path: 'usr/local', type: 'directory', mode: 0o755 },
    { path: 'usr/local/sbin', type: 'directory', mode: 0o755 },
    { path: 'usr/local/sbin/devhotel-runtime-agent', type: 'file', mode: 0o755, content: agentScript(identity) }
  ]

  // Node's gzip writes a zero MTIME, so the member header carries no build
  // timestamp and the archive stays byte-identical across builds.
  const bytes = gzipSync(tar(entries), { level: 9 })
  return {
    fileName: MANAGED_RUNTIME_OVERLAY_FILE,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ownership
  }
}
