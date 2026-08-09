import type { AnchorSpec, WebSpec } from './types'

export const ANCHOR_IMAGE = 'alpine/socat'
export const RELAY_PORT = 3999

export function anchorName(roomId: string): string {
  return `dh-${roomId}-anchor`
}

export function webName(roomId: string): string {
  return `dh-${roomId}-web`
}

export function srcVolume(roomId: string): string {
  return `dh-${roomId}-src`
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
export const EMULATOR_ADB_ADDR = 'localhost:5555'

export function emulatorImage(version: string): string {
  return `budtmo/docker-android:emulator_${version}`
}

export function emulatorName(roomId: string): string {
  return `dh-${roomId}-svc-emulator`
}

export interface EmulatorOpts {
  device: string
  version: string
}

export function buildEmulatorArgs(roomId: string, opts?: Partial<EmulatorOpts>): string[] {
  const device = opts?.device ?? EMULATOR_DEFAULT_DEVICE
  const version = opts?.version ?? EMULATOR_DEFAULT_VERSION
  return [
    'run',
    '-d',
    '--name',
    emulatorName(roomId),
    '--network',
    `container:${anchorName(roomId)}`,
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

function labelArgs(roomId: string, role: 'anchor' | 'web'): string[] {
  return ['-l', `devhotel.room=${roomId}`, '-l', `devhotel.role=${role}`, '-l', 'devhotel.managed=1']
}

export function buildAnchorArgs(spec: AnchorSpec): string[] {
  return [
    'run',
    '-d',
    '--name',
    anchorName(spec.roomId),
    ...labelArgs(spec.roomId, 'anchor'),
    '-p',
    `127.0.0.1:0:${RELAY_PORT}`,
    ANCHOR_IMAGE,
    `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr`,
    `TCP:127.0.0.1:${spec.internalPort}`,
  ]
}

function sourceMountArgs(spec: WebSpec): string[] {
  switch (spec.sourceType) {
    case 'managed-git':
      return ['-v', `${srcVolume(spec.roomId)}:/workspace`]
    case 'linked-folder':
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
  args.push('-v', `${cacheVolume(spec.roomId)}:/cache`)
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

export function wrapStartCommand(startCommand: string): string {
  return `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1; exec ${startCommand}`
}

export function buildWebCreateArgs(spec: WebSpec): string[] {
  return [
    'create',
    '--name',
    webName(spec.roomId),
    ...(spec.standalone ? [] : ['--network', `container:${anchorName(spec.roomId)}`]),
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

export function buildOneShotArgs(spec: WebSpec, cmd: string): string[] {
  return [
    'run',
    '--rm',
    ...labelArgs(spec.roomId, 'web'),
    ...mountArgs(spec),
    ...envArgs(spec),
    '-w',
    '/workspace',
    imageFor(spec),
    'sh',
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
