import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  MANAGED_RUNTIME_AGENT_PORT,
  MANAGED_RUNTIME_GUEST_AGENT_PATH,
  MANAGED_RUNTIME_GUEST_STATE_ROOT,
  buildManagedRuntimeGuestAgent
} from './managedRuntimeGuestAgent'

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

/**
 * The pinned Alpine branch the guest installs its runtime packages from.
 *
 * The ISO's own repository list points at its read-only on-media repo, which
 * carries no container engine, so the branch is named here explicitly rather
 * than inherited. It matches the pinned boot image exactly: a guest must never
 * resolve packages from a branch its kernel did not come from.
 */
export const MANAGED_RUNTIME_GUEST_APK_BRANCH = 'v3.22'
/** Filesystem label that identifies the runtime's own persistent disk. */
export const MANAGED_RUNTIME_STATE_LABEL = 'DHSTATE'
/** Guest packages the Room path needs, resolved once and then served from cache. */
export const MANAGED_RUNTIME_GUEST_PACKAGES = ['e2fsprogs', 'docker', 'python3', 'iproute2'] as const

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
 * The private runtime agent on Hyper-V COM2.
 *
 * It answers two things and nothing else. `health:<nonce>` echoes the nonce
 * with the identity this install was provisioned with, and the Host accepts a
 * health proof only if both match. `channel:<nonce>` reports where the Room
 * command channel is and the token that opens it.
 *
 * The second one is why the serial line survived #107 rather than being
 * replaced. Rooms need far more bandwidth than an emulated UART can carry, so
 * the command channel is a socket on the runtime's private NIC — but a socket
 * needs an address to connect to and a secret to prove the caller is this
 * install. The serial line is the only channel that is private to the Host by
 * construction, so it is what bootstraps the other one: the address can move
 * every boot and the token can be regenerated every boot, and neither ever
 * travels anywhere a Room could observe.
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
    '# Answers DevHotel probes on the private Hyper-V COM2 line.',
    '# The Host opens and closes the named pipe once per probe, so a read or',
    '# write can fail whenever it disconnects. Those are expected, not fatal:',
    '# the agent reopens the port and keeps serving instead of exiting and',
    '# leaving the runtime permanently unhealthy.',
    'set -u',
    `serial=${MANAGED_RUNTIME_GUEST_SERIAL}`,
    `reply='${reply}'`,
    `token_file=${MANAGED_RUNTIME_GUEST_STATE_ROOT}/boot-token`,
    `agent_port=${MANAGED_RUNTIME_AGENT_PORT}`,
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
    '        health:*)',
    '          nonce=${request#health:}',
    '          nonce=${nonce%%[!0-9a-f]*}',
    '          [ -n "$nonce" ] || continue',
    '          printf \'%s,"requestId":"%s"}\\n\' "$reply" "$nonce" >&3 || exit 0',
    '          ;;',
    '        channel:*)',
    '          nonce=${request#channel:}',
    '          nonce=${nonce%%[!0-9a-f]*}',
    '          [ -n "$nonce" ] || continue',
    '          token=$(cat "$token_file" 2>/dev/null || true)',
    // The runtime's own NIC address. Only a global-scope v4 address is
    // considered: loopback would be unreachable from the Host, and a
    // link-local address means DHCP has not finished, which is "preparing"
    // rather than a usable channel.
    '          address=$(ip -4 -o addr show scope global 2>/dev/null | awk \'NR==1{split($4,a,"/");print a[1]}\')',
    '          if [ -n "$token" ] && [ -n "$address" ]; then',
    '            printf \'{"owner":"devhotel","state":"ready","address":"%s","port":%s,"token":"%s","requestId":"%s"}\\n\' \\',
    '              "$address" "$agent_port" "$token" "$nonce" >&3 || exit 0',
    '          else',
    '            printf \'{"owner":"devhotel","state":"preparing","requestId":"%s"}\\n\' "$nonce" >&3 || exit 0',
    '          fi',
    '          ;;',
    '        *) continue ;;',
    '      esac',
    '    done',
    '  )',
    '  sleep 1',
    'done',
    ''
  ].join('\n')
}

/**
 * Brings up the runtime's persistent disk.
 *
 * The Room contract that #107 has to keep is that a workspace, a dependency
 * generation and a service's data survive sleep, wake and a Host reboot. In the
 * compatibility backend that is Docker's own volume storage on the Host disk;
 * here it is this disk, so everything the engine writes has to land on it
 * before the engine starts.
 *
 * Formatting is the one destructive act in the whole guest bootstrap, so it is
 * fenced twice: a disk is only formatted when it carries no filesystem at all,
 * and it is only ever *found* again by DevHotel's own label. A disk that
 * already has a filesystem DevHotel does not recognise is left untouched and
 * the service fails, because the alternative — guessing — would destroy Room
 * data on the run after a marker went missing.
 */
function stateDiskScript(): string {
  return [
    '#!/bin/sh',
    '# Mounts the DevHotel runtime state disk, formatting it only when blank.',
    'set -eu',
    `label=${MANAGED_RUNTIME_STATE_LABEL}`,
    `root=${MANAGED_RUNTIME_GUEST_STATE_ROOT}`,
    'mkdir -p "$root"',
    'mountpoint -q "$root" && exit 0',
    '',
    'existing=$(blkid -L "$label" 2>/dev/null || true)',
    'if [ -z "$existing" ]; then',
    '  # The seed disk carries the apkovl and is FAT-labelled DEVHOTEL; the boot',
    '  # media is a DVD, not an sd device. What is left is the state disk, and it',
    '  # is only claimed while it is genuinely blank.',
    '  for candidate in /dev/sd?; do',
    '    [ -b "$candidate" ] || continue',
    '    if [ -n "$(blkid -s TYPE -o value "$candidate" 2>/dev/null || true)" ]; then continue; fi',
    '    if [ -n "$(blkid -o device "$candidate"* 2>/dev/null | grep -v "^$candidate$" || true)" ]; then continue; fi',
    '    mkfs.ext4 -q -L "$label" "$candidate"',
    '    existing=$candidate',
    '    break',
    '  done',
    'fi',
    '[ -n "$existing" ] || { echo "DevHotel found no usable runtime state disk" >&2; exit 1; }',
    'mount -t ext4 "$existing" "$root"',
    'chmod 700 "$root"',
    'mkdir -p "$root/engine" "$root/apk-cache" "$root/stage"',
    'chmod 700 "$root/stage"',
    ''
  ].join('\n')
}

/**
 * Installs and starts the container engine.
 *
 * Alpine's `virt` ISO boots diskless: the root filesystem is a tmpfs, so a
 * package installed at boot is gone by the next one. Rather than ship a second
 * multi-hundred-megabyte image, the packages are resolved once from the pinned
 * branch into a cache on the persistent disk, and every later boot installs
 * from that cache with no network at all. That is also what makes the runtime's
 * first provision the only one that needs connectivity.
 */
function engineScript(): string {
  const packages = MANAGED_RUNTIME_GUEST_PACKAGES.join(' ')
  return [
    '#!/bin/sh',
    '# Installs the pinned guest runtime packages and starts the engine.',
    'set -eu',
    `root=${MANAGED_RUNTIME_GUEST_STATE_ROOT}`,
    'cache=$root/apk-cache',
    'mkdir -p "$cache"',
    '# A stable cache location is what makes the second boot offline.',
    'ln -sfn "$cache" /etc/apk/cache',
    `if ! apk info -e docker >/dev/null 2>&1; then`,
    `  apk add --no-progress ${packages} || apk add --no-progress --no-network ${packages}`,
    'fi',
    '# Every byte the engine writes belongs on the persistent disk, including',
    '# image layers and volume contents — that is the whole of Room persistence.',
    'mkdir -p /etc/docker',
    'printf \'{\\n  "data-root": "%s/engine",\\n  "iptables": true,\\n  "ip6tables": false,\\n  "live-restore": false\\n}\\n\' "$root" > /etc/docker/daemon.json',
    'rc-service docker start',
    '# The Room path is only usable once the engine answers, and a Room create',
    '# that raced the daemon would fail in a way the Host reports as a broken',
    '# runtime rather than a slow one.',
    'attempt=0',
    'while [ "$attempt" -lt 60 ]; do',
    '  if docker info >/dev/null 2>&1; then exit 0; fi',
    '  attempt=$((attempt + 1))',
    '  sleep 1',
    'done',
    'echo "DevHotel container engine did not become ready" >&2',
    'exit 1',
    ''
  ].join('\n')
}

function openRcService(opts: {
  name: string
  command: string
  background: boolean
  needs: readonly string[]
}): string {
  return [
    '#!/sbin/openrc-run',
    `name="${opts.name}"`,
    `command=${opts.command}`,
    ...(opts.background
      ? [
          'command_background=true',
          `pidfile=/run/${opts.command.split('/').pop()}.pid`
        ]
      : []),
    `output_log=/var/log/${opts.command.split('/').pop()}.log`,
    `error_log=/var/log/${opts.command.split('/').pop()}.log`,
    '',
    'depend() {',
    ...opts.needs.map((need) => `\tneed ${need}`),
    '\tafter bootmisc',
    '}',
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
    { path: 'etc/apk', type: 'directory', mode: 0o755 },
    // The ISO's own list points at its read-only on-media repo, which has no
    // container engine in it. Pinned to the same branch as the boot image.
    {
      path: 'etc/apk/repositories',
      type: 'file',
      mode: 0o644,
      content: [
        `https://dl-cdn.alpinelinux.org/alpine/${MANAGED_RUNTIME_GUEST_APK_BRANCH}/main`,
        `https://dl-cdn.alpinelinux.org/alpine/${MANAGED_RUNTIME_GUEST_APK_BRANCH}/community`,
        ''
      ].join('\n')
    },
    { path: 'etc/network', type: 'directory', mode: 0o755 },
    // The runtime's private NIC. It carries the Room command channel and the
    // package/image pulls a Room needs, and nothing listens on it but the
    // agent, whose token the Host learns over the serial line instead.
    {
      path: 'etc/network/interfaces',
      type: 'file',
      mode: 0o644,
      content: ['auto lo', 'iface lo inet loopback', '', 'auto eth0', 'iface eth0 inet dhcp', ''].join('\n')
    },
    { path: 'etc/init.d', type: 'directory', mode: 0o755 },
    { path: 'etc/init.d/devhotel-runtime-agent', type: 'file', mode: 0o755, content: serviceScript() },
    {
      path: 'etc/init.d/devhotel-runtime-state',
      type: 'file',
      mode: 0o755,
      content: openRcService({
        name: 'DevHotel runtime state disk',
        command: '/usr/local/sbin/devhotel-runtime-state',
        background: false,
        needs: ['localmount']
      })
    },
    {
      path: 'etc/init.d/devhotel-engine',
      type: 'file',
      mode: 0o755,
      content: openRcService({
        name: 'DevHotel container engine',
        command: '/usr/local/sbin/devhotel-engine',
        background: false,
        // The engine's data root is on the state disk and its packages come from
        // the cache on it, so neither can start first.
        needs: ['devhotel-runtime-state', 'net']
      })
    },
    {
      path: 'etc/init.d/devhotel-room-agent',
      type: 'file',
      mode: 0o755,
      content: openRcService({
        name: 'DevHotel Room command agent',
        command: MANAGED_RUNTIME_GUEST_AGENT_PATH,
        background: true,
        // Serving Room commands before the engine answers would turn a slow
        // start into a Room create failure.
        needs: ['devhotel-engine']
      })
    },
    { path: 'etc/runlevels', type: 'directory', mode: 0o755 },
    { path: 'etc/runlevels/default', type: 'directory', mode: 0o755 },
    {
      path: 'etc/runlevels/default/devhotel-engine',
      type: 'symlink',
      mode: 0o777,
      linkTarget: '/etc/init.d/devhotel-engine'
    },
    {
      path: 'etc/runlevels/default/devhotel-room-agent',
      type: 'symlink',
      mode: 0o777,
      linkTarget: '/etc/init.d/devhotel-room-agent'
    },
    {
      path: 'etc/runlevels/default/devhotel-runtime-agent',
      type: 'symlink',
      mode: 0o777,
      linkTarget: '/etc/init.d/devhotel-runtime-agent'
    },
    {
      path: 'etc/runlevels/default/devhotel-runtime-state',
      type: 'symlink',
      mode: 0o777,
      linkTarget: '/etc/init.d/devhotel-runtime-state'
    },
    { path: 'usr', type: 'directory', mode: 0o755 },
    { path: 'usr/local', type: 'directory', mode: 0o755 },
    { path: 'usr/local/sbin', type: 'directory', mode: 0o755 },
    { path: 'usr/local/sbin/devhotel-engine', type: 'file', mode: 0o755, content: engineScript() },
    {
      path: 'usr/local/sbin/devhotel-room-agent',
      type: 'file',
      mode: 0o755,
      content: buildManagedRuntimeGuestAgent({ installId: identity.installId, runtimeId: identity.runtimeId })
    },
    { path: 'usr/local/sbin/devhotel-runtime-agent', type: 'file', mode: 0o755, content: agentScript(identity) },
    { path: 'usr/local/sbin/devhotel-runtime-state', type: 'file', mode: 0o755, content: stateDiskScript() }
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
