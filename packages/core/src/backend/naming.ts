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

function mountArgs(spec: WebSpec): string[] {
  const args = sourceMountArgs(spec)
  if (args.length > 0) {
    args.push('-v', `${depsVolume(spec.roomId, spec.nodeMajor)}:/workspace/node_modules`)
  }
  args.push('-v', `${cacheVolume(spec.roomId)}:/cache`)
  return args
}

function envArgs(spec: WebSpec): string[] {
  const args = ['-e', 'npm_config_cache=/cache/npm', '-e', 'PNPM_HOME=/cache/pnpm']
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push('-e', `${key}=${value}`)
  }
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
    '--network',
    `container:${anchorName(spec.roomId)}`,
    ...labelArgs(spec.roomId, 'web'),
    ...mountArgs(spec),
    ...envArgs(spec),
    '-w',
    '/workspace',
    webImage(spec.nodeMajor),
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
    webImage(spec.nodeMajor),
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
