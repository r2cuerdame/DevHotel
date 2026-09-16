import type { AnchorSpec, WebSpec } from './types'
import { RELAY_PREAMBLE_PREFIX } from '../relayProtocol'
import { NODE_PACKAGE_SHARED_CACHE, sharedCacheVolume } from '../lifecycle/sharedCache'

export const ANCHOR_IMAGE = 'alpine/socat'
export const RELAY_PORT = 3999
export const NETWORK_AUTHORITY_SANDBOX_LABEL = 'devhotel.network-authority-sandbox'
export const NETWORK_AUTHORITY_STARTED_AT_LABEL = 'devhotel.network-authority-started-at'

export interface NetworkNamespaceAuthority {
  id: string
  sandboxId: string
  startedAt: string
  networkId?: string
}

function networkAuthorityLabelArgs(sandboxId?: string, startedAt?: string): string[] {
  if (sandboxId === undefined && startedAt === undefined) return []
  if (typeof sandboxId !== 'string' || !/^[a-f0-9]{64}$/.test(sandboxId)) {
    throw new Error('invalid network authority sandbox identity')
  }
  if (
    typeof startedAt !== 'string' ||
    !/^(?:19[7-9]\d|2\d{3})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(startedAt) ||
    !Number.isFinite(Date.parse(startedAt))
  ) {
    throw new Error('invalid network authority start generation')
  }
  return [
    '-l',
    `${NETWORK_AUTHORITY_SANDBOX_LABEL}=${sandboxId}`,
    '-l',
    `${NETWORK_AUTHORITY_STARTED_AT_LABEL}=${startedAt}`
  ]
}

export function anchorName(roomId: string): string {
  return `dh-${roomId}-anchor`
}

export function roomNetworkName(roomId: string): string {
  return `dh-${roomId}-net`
}

/** Private bridge containing only the Android relay anchor; the emulator joins the anchor's netns. */
export function androidControlNetworkName(roomId: string): string {
  return `dh-${roomId}-android-control-net`
}

/** Unpublished namespace leader shared by Android web and managed service containers. */
export function androidRuntimeAnchorName(roomId: string): string {
  return `dh-${roomId}-android-runtime-anchor`
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

/**
 * Per-Room persistent AVD storage volume for the managed emulator path (#108).
 *
 * Keeping the AVD outside the container image is the precondition for warm-Room
 * AVD reuse (#78): the emulator container can be recreated or updated without
 * losing the booted snapshot that makes a warm Room reach ADB-ready in under 60s.
 * On the compatibility (docker-android) path the AVD is baked into the image and
 * there is no equivalent — this volume is managed-runtime-only.
 */
export function androidAvdVolume(roomId: string): string {
  return `dh-${roomId}-android-avd`
}

/**
 * Shared Android SDK volume for a given API level.
 *
 * All Rooms of the same Android version share one SDK installation — the same
 * cmdline-tools, platform-tools, emulator binary and system image — so the ~2 GB
 * download happens once per API level rather than once per Room. The volume is
 * named after the level (not the Room) and is mounted read-only in the emulator
 * container so no Room can corrupt another Room's SDK.
 *
 * Named `dh-android-sdk-<apiLevel>` (e.g. `dh-android-sdk-34`).
 */
export function androidSdkVolume(apiLevel: number): string {
  return `dh-android-sdk-${apiLevel}`
}

export type EmulatorResolution = 'native' | 'balanced' | 'fast'
export type EmulatorOrientation = 'portrait' | 'landscape'

export interface EmulatorOpts {
  device: string
  version: string
  resolution?: EmulatorResolution
  orientation?: EmulatorOrientation
}

/**
 * Emulator guest budget (#104). Measured on a Windows Host against disposable
 * probes of the same emulator image: `-cores 4 -memory 4096 -noaudio` cut
 * average adb input latency ~355ms → ~230ms and screencap ~873ms → ~639ms,
 * with KVM and the image's swiftshader_indirect renderer left untouched. These
 * are the *ceiling*, not a demand — a Room that asked for less gets less.
 */
export const EMULATOR_BUDGET_CORES = 4
export const EMULATOR_BUDGET_MEMORY_MB = 4096
/**
 * The emulator container is not just qemu: Xvfb, x11vnc, websockify and
 * supervisord live there too, and qemu's own resident set carries the software
 * framebuffer on top of guest RAM. A Room's memory selection therefore cannot
 * be handed to the guest whole.
 */
export const EMULATOR_HOST_RESERVE_MB = 1024
/** An Android 14 AVD below this does not reach `sys.boot_completed`. */
export const EMULATOR_MIN_MEMORY_MB = 1024

export interface EmulatorLimits {
  /** Room CPU selection (`RoomOsSettings.cpus`); undefined = unlimited. */
  cpus?: number
  /** Room memory selection in MB (`RoomOsSettings.memoryMB`); undefined = unlimited. */
  memoryMB?: number
}

/**
 * The guest budget the Room's own control-panel limits allow.
 *
 * The limits are deliberately spent on the guest rather than on `--cpus` /
 * `--memory` for the emulator container. A hard container memory cap around a
 * qemu process whose RSS includes the software framebuffer does not make the
 * emulator smaller — it makes it OOM-killed, which the Room reports as "no
 * emulator" rather than "slow emulator". Guest cores and guest RAM are what
 * actually decide the sidecar's footprint, so that is where a 1 CPU / 1 GB Room
 * is held to what it asked for.
 */
export function emulatorBudget(limits?: EmulatorLimits): { cores: number; memoryMB: number } {
  const cores = limits?.cpus && Number.isFinite(limits.cpus)
    ? Math.max(1, Math.min(EMULATOR_BUDGET_CORES, Math.floor(limits.cpus)))
    : EMULATOR_BUDGET_CORES
  const memoryMB = limits?.memoryMB && Number.isFinite(limits.memoryMB)
    ? Math.max(
        EMULATOR_MIN_MEMORY_MB,
        Math.min(EMULATOR_BUDGET_MEMORY_MB, Math.floor(limits.memoryMB) - EMULATOR_HOST_RESERVE_MB)
      )
    : EMULATOR_BUDGET_MEMORY_MB
  return { cores, memoryMB }
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
  balanced: 0.5,
  fast: 0.375
}

/**
 * AVD config.ini override. The emulator has no GPU passthrough in the room
 * (swiftshader renders in software), so shrinking the guest LCD is the single
 * biggest speed lever. 'fast' matches the 540px preview width for the default phone,
 * avoiding a second software-render/downscale pass in the normal Room view.
 */
export function emulatorAvdOverride(
  device?: string,
  resolution: EmulatorResolution = 'fast',
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
export function buildEmulatorArgs(
  roomId: string,
  opts?: Partial<EmulatorOpts>,
  lifecycle: {
    networkNamespace?: string
    networkAuthoritySandboxId?: string
    networkAuthorityStartedAt?: string
    abortToken?: string
    limits?: EmulatorLimits
  } = {}
): string[] {
  const device = opts?.device ?? EMULATOR_DEFAULT_DEVICE
  const version = opts?.version ?? EMULATOR_DEFAULT_VERSION
  const screen = emulatorScreen(opts?.orientation)
  const budget = emulatorBudget(lifecycle.limits)
  return [
    'create',
    '--name',
    emulatorName(roomId),
    '--network',
    `container:${lifecycle.networkNamespace ?? anchorName(roomId)}`,
    '--cap-drop',
    'NET_RAW',
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    'devhotel.role=svc-emulator',
    '-l',
    'devhotel.managed=1',
    ...networkAuthorityLabelArgs(
      lifecycle.networkAuthoritySandboxId,
      lifecycle.networkAuthorityStartedAt
    ),
    ...(lifecycle.abortToken ? ['-l', `devhotel.abort-token=${lifecycle.abortToken}`] : []),
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
    // ADB authentication is disabled only for this managed emulator: its ADB
    // transport has no Host port or Room-network path, and immutable-ID
    // helpers can reach it only through the proved private control netns.
    `EMULATOR_ADDITIONAL_ARGS=-cores ${budget.cores} -memory ${budget.memoryMB} -noaudio -no-boot-anim -skip-adb-auth`,
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

export function buildServiceArgs(
  roomId: string,
  svc: ServiceKind,
  version: string,
  networkNamespace = anchorName(roomId),
  creationToken?: string,
  networkAuthoritySandboxId?: string,
  networkAuthorityStartedAt?: string
): string[] {
  const common = [
    'run',
    '-d',
    '--name',
    svcName(roomId, svc),
    '--network',
    `container:${networkNamespace}`,
    '--cap-drop',
    'NET_RAW',
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    `devhotel.role=svc-${svc}`,
    '-l',
    'devhotel.managed=1',
    ...networkAuthorityLabelArgs(networkAuthoritySandboxId, networkAuthorityStartedAt),
    ...(creationToken ? ['-l', `devhotel.creation-token=${creationToken}`] : [])
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

export function buildRoomNetworkCreateArgs(roomId: string, subnet?: string): string[] {
  return buildOwnedBridgeNetworkCreateArgs(roomId, roomNetworkName(roomId), subnet)
}

export function buildAndroidControlNetworkCreateArgs(roomId: string, subnet?: string): string[] {
  return buildOwnedBridgeNetworkCreateArgs(roomId, androidControlNetworkName(roomId), subnet)
}

function buildOwnedBridgeNetworkCreateArgs(roomId: string, name: string, subnet?: string): string[] {
  const args = [
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
  ]
  if (subnet) {
    args.push('--subnet', subnet)
  }
  args.push(name)
  return args
}

export function buildAnchorArgs(
  spec: AnchorSpec,
  relayTokenSha256: string,
  networkName = roomNetworkName(spec.roomId),
  /**
   * Where the relay gate is published, in the engine's own network view. The
   * managed runtime's engine is inside a VM, so a loopback publication would be
   * unreachable from the Host; everything else about the gate, including the
   * token check, is unchanged by the wider binding.
   */
  publishAddress = '127.0.0.1'
): string[] {
  if (!/^[a-f0-9]{64}$/.test(relayTokenSha256)) throw new Error('invalid DevHotel relay verifier')
  const relayGateScript = `IFS= read -r -t 2 line || exit 1; case "$line" in "${RELAY_PREAMBLE_PREFIX}"*) token=\${line#"${RELAY_PREAMBLE_PREFIX}"};; *) exit 1;; esac; [ "\${#token}" -eq 64 ] || exit 1; case "$token" in *[!0-9a-f]*) exit 1;; esac; actual=$(printf '%s' "$token" | sha256sum); actual=\${actual%% *}; expected=$DEVHOTEL_RELAY_TOKEN_SHA256; mismatch=0; i=0; while [ "$i" -lt 64 ]; do ac=\${actual%"\${actual#?}"}; ec=\${expected%"\${expected#?}"}; [ "$ac" = "$ec" ] || mismatch=1; actual=\${actual#?}; expected=\${expected#?}; i=$((i + 1)); done; [ "$mismatch" -eq 0 ] || exit 1; exec socat STDIO "TCP:127.0.0.1:$DEVHOTEL_INTERNAL_PORT"`
  return [
    'run',
    '-d',
    '--name',
    anchorName(spec.roomId),
    '--network',
    networkName,
    ...labelArgs(spec.roomId, 'anchor'),
    '-p',
    `${publishAddress}:0:${RELAY_PORT}`,
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

export function buildAndroidRuntimeAnchorArgs(roomId: string): string[] {
  return [
    'run',
    '-d',
    '--name',
    androidRuntimeAnchorName(roomId),
    '--network',
    roomNetworkName(roomId),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    'devhotel.role=android-runtime-anchor',
    '-l',
    'devhotel.managed=1',
    '--entrypoint',
    '/bin/sh',
    ANCHOR_IMAGE,
    '-c',
    'exec sleep 2147483647'
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
  for (const shared of spec.sharedCaches ?? []) {
    args.push('-v', `${shared.volume}:${shared.path}`)
  }
  for (const extra of spec.extraVolumes ?? []) {
    args.push('-v', `${extra.volume}:${extra.path}`)
  }
  return args
}

/**
 * Where a Room's package manager keeps its store.
 *
 * `/cache` is the Room's own and always exists. When a Hotel-scoped package
 * cache is mounted as well, the store moves into it: the contents are
 * content-addressed, so they are identical between Rooms by construction and
 * the per-Room copy bought nothing but a second download. Everything else a
 * Room dirties stays under `/cache`, where one Room cannot reach another's.
 */
function packageStorePaths(spec: WebSpec): { npm: string; pnpm: string } {
  const shared = (spec.sharedCaches ?? []).find((mount) => mount.volume === sharedCacheVolume(NODE_PACKAGE_SHARED_CACHE))
  if (!shared) return { npm: '/cache/npm', pnpm: '/cache/pnpm' }
  return { npm: `${shared.path}/npm`, pnpm: `${shared.path}/pnpm` }
}

/**
 * Caches that have to survive a container recreate but stay Room-scoped. Each
 * of these tools otherwise defaults to a path in the container's writable
 * layer, which a recreate throws away, so a browser download is re-fetched on
 * every wake that recreates the container. They do not join the Hotel-scoped
 * package cache: unlike a package store they are not content-addressed, so one
 * Room must not be able to reach another's.
 */
export const ROOM_SCOPED_CACHE_ENV: ReadonlyArray<readonly [string, string]> = [
  ['PLAYWRIGHT_BROWSERS_PATH', '/cache/playwright'],
  ['XDG_CACHE_HOME', '/cache/xdg']
]

/** Every managed cache variable a Room's web container is created with. */
export function roomCacheEnv(spec: WebSpec): Array<readonly [string, string]> {
  const store = packageStorePaths(spec)
  return [['npm_config_cache', store.npm], ['PNPM_HOME', store.pnpm], ...ROOM_SCOPED_CACHE_ENV]
}

function envArgs(spec: WebSpec): string[] {
  const args = roomCacheEnv(spec).flatMap(([key, value]) => ['-e', `${key}=${value}`])
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

export function buildWebCreateArgs(spec: WebSpec, networkAuthority?: NetworkNamespaceAuthority): string[] {
  return [
    'create',
    '--name',
    webName(spec.roomId),
    '--network',
    spec.standalone
      ? roomNetworkName(spec.roomId)
      : `container:${networkAuthority?.id ?? (
        spec.androidRuntimeIsolation ? androidRuntimeAnchorName(spec.roomId) : anchorName(spec.roomId)
      )}`,
    '--cap-drop',
    'NET_RAW',
    ...labelArgs(spec.roomId, 'web'),
    ...networkAuthorityLabelArgs(networkAuthority?.sandboxId, networkAuthority?.startedAt),
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
