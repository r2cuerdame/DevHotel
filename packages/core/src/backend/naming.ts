import type { AnchorSpec, WebSpec } from './types'
import { RELAY_PREAMBLE_PREFIX } from '../relayProtocol'

export const ANCHOR_IMAGE = 'alpine/socat'
export const RELAY_PORT = 3999

export function anchorName(roomId: string): string {
  return `dh-${roomId}-anchor`
}

export function roomNetworkName(roomId: string): string {
  return `dh-${roomId}-net`
}

export function webName(roomId: string): string {
  return `dh-${roomId}-web`
}

export function jobName(roomId: string, jobId: string): string {
  const compact = jobId.replaceAll('-', '').toLowerCase()
  if (!/^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(compact)) {
    throw new Error('invalid one-shot job ID')
  }
  return `dh-${roomId}-job-${compact}`
}

export function isJobName(roomId: string, name: string): boolean {
  const prefix = `dh-${roomId}-job-`
  if (!name.startsWith(prefix)) return false
  return /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(name.slice(prefix.length))
}

export function srcVolume(roomId: string, revision = 0): string {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid workspace volume revision')
  return revision === 0 ? `dh-${roomId}-src` : `dh-${roomId}-src-r${revision}`
}

export function workspaceSnapshotVolume(roomId: string, operationId: string): string {
  const compact = operationId.replaceAll('-', '').toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error('invalid workspace snapshot operation ID')
  return `dh-${roomId}-src-build-${compact}`
}

export function depsVolume(roomId: string, nodeMajor: string): string {
  return `dh-${roomId}-deps-node${nodeMajor}`
}

export function cacheVolume(roomId: string): string {
  return `dh-${roomId}-cache`
}

export function webImage(nodeMajor: string): string {
  return `node:${nodeMajor}-bookworm`
}

export function imageFor(spec: WebSpec): string {
  return spec.imageOverride ?? webImage(spec.nodeMajor)
}

export type ServiceKind = 'postgres' | 'redis'

/** Android emulator sidecar (KVM) — its noVNC screen is the room's "site". */
export const EMULATOR_DEFAULT_DEVICE = 'Samsung Galaxy S10'
export const EMULATOR_DEFAULT_VERSION = '14.0'
export const EMULATOR_IMAGE = emulatorImage(EMULATOR_DEFAULT_VERSION)
export const EMULATOR_SCREEN_PORT = 6080
/**
 * adb auto-detects the shared-netns emulator by its console port as
 * emulator-5554. Never `adb connect localhost:5555` — that registers the SAME
 * device under a second serial and Gradle instrumentation runs twice.
 */
export const EMULATOR_ADB_SERIAL = 'emulator-5554'
export const EMULATOR_SCREEN_WIDTH = 540
export const EMULATOR_SCREEN_HEIGHT = 1140
/** Where createEmulator stages the AVD override; docker-android appends it to config.ini at AVD creation. */
export const EMULATOR_AVD_OVERRIDE_PATH = '/home/androidusr/devhotel-avd-override.ini'

export function emulatorImage(version: string): string {
  return `budtmo/docker-android:emulator_${version}`
}

export function emulatorName(roomId: string): string {
  return `dh-${roomId}-svc-emulator`
}

export type EmulatorResolution = 'native' | 'balanced' | 'fast'
export type EmulatorOrientation = 'portrait' | 'landscape'

export interface EmulatorOpts {
  device: string
  version: string
  resolution?: EmulatorResolution
  orientation?: EmulatorOrientation
}

/** X screen dimensions for the emulator container, per orientation. */
export function emulatorScreen(orientation: EmulatorOrientation = 'portrait'): { width: number; height: number } {
  return orientation === 'landscape'
    ? { width: EMULATOR_SCREEN_HEIGHT, height: EMULATOR_SCREEN_WIDTH }
    : { width: EMULATOR_SCREEN_WIDTH, height: EMULATOR_SCREEN_HEIGHT }
}

/** Native panel pixels and density of the AVD profiles offered in the Stack tab. */
const EMULATOR_DEVICE_LCD: Record<string, { width: number; height: number; density: number }> = {
  'Samsung Galaxy S10': { width: 1440, height: 3040, density: 640 },
  'Samsung Galaxy S9': { width: 1440, height: 2960, density: 640 },
  'Nexus 5': { width: 1080, height: 1920, density: 480 },
  'Nexus 4': { width: 768, height: 1280, density: 320 },
  'Nexus One': { width: 480, height: 800, density: 240 }
}

const EMULATOR_RESOLUTION_SCALE: Record<EmulatorResolution, number> = {
  native: 1,
  balanced: 0.75,
  fast: 0.5
}

/**
 * AVD config.ini override. The emulator has no GPU passthrough in the room
 * (swiftshader renders in software), so shrinking the guest LCD is the single
 * biggest speed lever; 'balanced' is the default for a usable phone.
 */
export function emulatorAvdOverride(
  device?: string,
  resolution: EmulatorResolution = 'balanced',
  orientation: EmulatorOrientation = 'portrait'
): string {
  const lcd = EMULATOR_DEVICE_LCD[device ?? EMULATOR_DEFAULT_DEVICE] ?? EMULATOR_DEVICE_LCD[EMULATOR_DEFAULT_DEVICE]!
  const scale = EMULATOR_RESOLUTION_SCALE[resolution]
  const landscape = orientation === 'landscape'
  const lines = ['# DevHotel AVD overrides']
  if (scale !== 1 || landscape) {
    const even = (value: number): number => 2 * Math.round((value * scale) / 2)
    const width = even(lcd.width)
    const height = even(lcd.height)
    lines.push(
      // A landscape Room needs a landscape-shaped panel. Android takes its
      // orientation from the panel and qemu keeps the panel's aspect ratio, so
      // hw.initialOrientation on a portrait panel leaves a portrait device
      // stranded in a wide screen — swapping the axes is what actually rotates.
      // Reduced pixels remain the biggest speed lever under software rendering.
      `hw.lcd.width=${landscape ? height : width}`,
      `hw.lcd.height=${landscape ? width : height}`,
      `hw.lcd.density=${even(lcd.density)}`
    )
  }
  if (landscape) lines.push('hw.initialOrientation=landscape')
  lines.push('')
  return lines.join('\n')
}

/** `docker create` args — the container is started only after the openbox rules are staged inside. */
export function buildEmulatorArgs(roomId: string, opts?: Partial<EmulatorOpts>): string[] {
  const device = opts?.device ?? EMULATOR_DEFAULT_DEVICE
  const version = opts?.version ?? EMULATOR_DEFAULT_VERSION
  const screen = emulatorScreen(opts?.orientation)
  return [
    'create',
    '--name',
    emulatorName(roomId),
    '--network',
    `container:${anchorName(roomId)}`,
    '--cap-drop',
    'NET_RAW',
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    'devhotel.role=svc-emulator',
    '-l',
    'devhotel.managed=1',
    '--device',
    '/dev/kvm',
    '-e',
    `EMULATOR_DEVICE=${device}`,
    '-e',
    'WEB_VNC=true',
    // frameless phone screen on a phone-sized display — the site view shows
    // just the device screen instead of a desktop with a skinned emulator
    '-e',
    'EMULATOR_NO_SKIN=true',
    '-e',
    `EMULATOR_CONFIG_PATH=${EMULATOR_AVD_OVERRIDE_PATH}`,
    '-e',
    'EMULATOR_ADDITIONAL_ARGS=-no-boot-anim',
    '-e',
    `SCREEN_WIDTH=${screen.width}`,
    '-e',
    `SCREEN_HEIGHT=${screen.height}`,
    '-e',
    'SCREEN_DEPTH=24',
    emulatorImage(version)
  ]
}

export const SERVICE_DEFAULT_VERSIONS: Record<ServiceKind, string> = { postgres: '17', redis: '8' }
/** In-room credentials for managed services — local-only, documented in the Services UI. */
export const SERVICE_DB_USER = 'devhotel'
export const SERVICE_DB_PASSWORD = 'devhotel'
export const SERVICE_DB_NAME = 'devhotel'

export function svcName(roomId: string, svc: ServiceKind): string {
  return `dh-${roomId}-svc-${svc}`
}

export function svcVolume(roomId: string, svc: ServiceKind): string {
  return `dh-${roomId}-svc-${svc}-data`
}

export function svcImage(svc: ServiceKind, version: string): string {
  return svc === 'postgres' ? `postgres:${version}-alpine` : `redis:${version}-alpine`
}

export function buildServiceArgs(roomId: string, svc: ServiceKind, version: string): string[] {
  const common = [
    'run',
    '-d',
    '--name',
    svcName(roomId, svc),
    '--network',
    `container:${anchorName(roomId)}`,
    '--cap-drop',
    'NET_RAW',
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    `devhotel.role=svc-${svc}`,
    '-l',
    'devhotel.managed=1'
  ]
  if (svc === 'postgres') {
    return [
      ...common,
      '-v',
      `${svcVolume(roomId, svc)}:/var/lib/postgresql/data`,
      '-e',
      `POSTGRES_USER=${SERVICE_DB_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${SERVICE_DB_PASSWORD}`,
      '-e',
      `POSTGRES_DB=${SERVICE_DB_NAME}`,
      svcImage(svc, version)
    ]
  }
  return [...common, '-v', `${svcVolume(roomId, svc)}:/data`, svcImage(svc, version), 'redis-server', '--appendonly', 'no']
}

function labelArgs(roomId: string, role: 'anchor' | 'web' | 'job'): string[] {
  return ['-l', `devhotel.room=${roomId}`, '-l', `devhotel.role=${role}`, '-l', 'devhotel.managed=1']
}

export function buildRoomNetworkCreateArgs(roomId: string): string[] {
  return [
    'network',
    'create',
    '--driver',
    'bridge',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    '--label',
    `devhotel.room=${roomId}`,
    '--label',
    'devhotel.role=network',
    '--label',
    'devhotel.managed=1',
    roomNetworkName(roomId),
  ]
}

export function buildAnchorArgs(spec: AnchorSpec, relayTokenSha256: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(relayTokenSha256)) throw new Error('invalid DevHotel relay verifier')
  const relayGateScript = `IFS= read -r -t 2 line || exit 1; case "$line" in "${RELAY_PREAMBLE_PREFIX}"*) token=\${line#"${RELAY_PREAMBLE_PREFIX}"};; *) exit 1;; esac; [ "\${#token}" -eq 64 ] || exit 1; case "$token" in *[!0-9a-f]*) exit 1;; esac; actual=$(printf '%s' "$token" | sha256sum); actual=\${actual%% *}; expected=$DEVHOTEL_RELAY_TOKEN_SHA256; mismatch=0; i=0; while [ "$i" -lt 64 ]; do ac=\${actual%"\${actual#?}"}; ec=\${expected%"\${expected#?}"}; [ "$ac" = "$ec" ] || mismatch=1; actual=\${actual#?}; expected=\${expected#?}; i=$((i + 1)); done; [ "$mismatch" -eq 0 ] || exit 1; exec socat STDIO "TCP:127.0.0.1:$DEVHOTEL_INTERNAL_PORT"`
  return [
    'run',
    '-d',
    '--name',
    anchorName(spec.roomId),
    '--network',
    roomNetworkName(spec.roomId),
    ...labelArgs(spec.roomId, 'anchor'),
    '-p',
    `127.0.0.1:0:${RELAY_PORT}`,
    '--cap-drop',
    'NET_RAW',
    '-e',
    `DEVHOTEL_RELAY_TOKEN_SHA256=${relayTokenSha256}`,
    '-e',
    `DEVHOTEL_INTERNAL_PORT=${spec.internalPort}`,
    '-e',
    `DEVHOTEL_RELAY_GATE=${relayGateScript}`,
    '--entrypoint',
    '/bin/sh',
    ANCHOR_IMAGE,
    '-c',
    `umask 077; printf '#!/bin/sh\n%s\n' "$DEVHOTEL_RELAY_GATE" > /tmp/devhotel-relay-gate; chmod 500 /tmp/devhotel-relay-gate; exec socat "$0" "$1"`,
    `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr`,
    'EXEC:/tmp/devhotel-relay-gate',
  ]
}

function sourceMountArgs(spec: WebSpec): string[] {
  switch (spec.workspaceMode) {
    case 'hotel':
      return ['-v', `${spec.workspaceVolumeOverride ?? srcVolume(spec.roomId, spec.workspaceVolumeRevision)}:/workspace`]
    case 'legacy-host-bind':
      return ['-v', `${spec.sourceRef}:/workspace`]
    case 'empty':
      return []
  }
}

export function effectiveDepsVolume(spec: WebSpec): string {
  return spec.depsVolumeOverride ?? depsVolume(spec.roomId, spec.nodeMajor)
}

function mountArgs(spec: WebSpec): string[] {
  const args = sourceMountArgs(spec)
  if (args.length > 0 && !spec.noDepsVolume) {
    args.push('-v', `${effectiveDepsVolume(spec)}:/workspace/node_modules`)
  }
  if (!spec.noCacheVolume) args.push('-v', `${cacheVolume(spec.roomId)}:/cache`)
  for (const extra of spec.extraVolumes ?? []) {
    args.push('-v', `${extra.volume}:${extra.path}`)
  }
  return args
}

function envArgs(spec: WebSpec): string[] {
  const args = ['-e', 'npm_config_cache=/cache/npm', '-e', 'PNPM_HOME=/cache/pnpm']
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push('-e', `${key}=${value}`)
  }
  return args
}

function limitArgs(spec: WebSpec): string[] {
  const args: string[] = []
  if (spec.cpus) args.push('--cpus', String(spec.cpus))
  if (spec.memoryMB) args.push('--memory', `${spec.memoryMB}m`)
  return args
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function wrapStartCommand(startCommand: string): string {
  // `exec <text>` only works when <text> begins with a simple command. Room
  // commands are shell programs and may begin with `if`, `for`, assignments,
  // or pipelines. Execute an inner shell so those programs remain valid while
  // it still replaces the container's PID 1 for correct signal handling.
  return `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1; exec sh -lc ${quoteShellWord(startCommand)}`
}

export function buildWebCreateArgs(spec: WebSpec): string[] {
  return [
    'create',
    '--name',
    webName(spec.roomId),
    '--network',
    spec.standalone ? roomNetworkName(spec.roomId) : `container:${anchorName(spec.roomId)}`,
    '--cap-drop',
    'NET_RAW',
    ...labelArgs(spec.roomId, 'web'),
    ...mountArgs(spec),
    ...envArgs(spec),
    ...limitArgs(spec),
    '-w',
    '/workspace',
    imageFor(spec),
    'sh',
    '-lc',
    wrapStartCommand(spec.startCommand),
  ]
}

export function buildOneShotArgs(spec: WebSpec, cmd: string, jobId: string): string[] {
  return [
    'run',
    '--rm',
    '--name',
    jobName(spec.roomId, jobId),
    '--network',
    roomNetworkName(spec.roomId),
    '--cap-drop',
    'NET_RAW',
    ...labelArgs(spec.roomId, 'job'),
    ...mountArgs(spec),
    ...envArgs(spec),
    '-w',
    '/workspace',
    // A Room image may own a long-running ENTRYPOINT (the Android image starts
    // its emulator stack there). Passing `sh ...` after the image only changes
    // CMD, so the entrypoint can run our command and then keep the one-shot
    // container alive until DevHotel's timeout. Override it explicitly: the
    // requested shell program is the whole lifecycle of this job.
    '--entrypoint',
    '/bin/sh',
    imageFor(spec),
    '-lc',
    wrapStartCommand(cmd),
  ]
}

export function parsePortOutput(output: string): number {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (const line of lines) {
    const m = /^127\.0\.0\.1:(\d+)$/.exec(line)
    if (m?.[1]) return Number.parseInt(m[1], 10)
  }
  for (const line of lines) {
    const m = /:(\d+)$/.exec(line)
    if (m?.[1]) return Number.parseInt(m[1], 10)
  }
  throw new Error(`cannot parse docker port output: ${JSON.stringify(output)}`)
}
