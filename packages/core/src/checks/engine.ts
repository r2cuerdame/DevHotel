import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckReport, CheckResult, CheckStatus, RoomRecord } from '@devhotel/shared'
import type { IsolationBackend } from '../backend/types'
import { srcVolume } from '../backend/naming'
import { caTrustStatus, ensureCa } from '../gateway/ca'
import type { Gateway } from '../gateway/gateway'
import { tcpAnswers } from '../changes/types'
import { depsVolumeForGen } from '../changes/definitions/deps'
import { createHttpRelayConnection } from '../relayProtocol'

export interface CheckCtx {
  room: RoomRecord
  backend: IsolationBackend
  gateway: Gateway
  userData: string
  depsGen: number
  /** re-add the room's gateway route (self-heal during checks) */
  syncRoute: () => Promise<void>
}

const ASLEEP: Pick<CheckResult, 'status' | 'summary'> = { status: 'unknown', summary: 'room is asleep' }

export async function runChecks(ctx: CheckCtx): Promise<CheckReport> {
  const { room, backend, gateway } = ctx
  const awake = room.status !== 'sleeping' && room.status !== 'preparing'
  const results: CheckResult[] = []
  const push = (r: CheckResult): void => {
    results.push(r)
  }

  // 1 backend
  const health = await backend.health()
  push(
    health.ok
      ? { step: 'backend', status: 'healthy', summary: health.detail }
      : { step: 'backend', status: 'broken', summary: 'isolation backend unreachable', detail: health.detail }
  )
  const backendOk = health.ok

  // 2 metadata — android rooms created before the emulator screen carry
  // internalPort 0 until the wake-time fixup assigns 6080; that is not damage.
  const portShapeOk = (room.internalPort >= 1 && room.internalPort <= 65535) || (room.provider === 'android' && room.internalPort === 0)
  const metaOk = room.domain.endsWith('.localhost') && portShapeOk
  push(
    metaOk
      ? { step: 'metadata', status: 'healthy', summary: `room ${room.id} · ${room.domain}` }
      : { step: 'metadata', status: 'broken', summary: 'room record is inconsistent', detail: JSON.stringify(room) }
  )

  // 3 source
  if (room.workspaceMode === 'legacy-host-bind') {
    const ok = existsSync(room.sourceRef)
    push(
      ok
        ? { step: 'source', status: 'healthy', summary: `linked folder present` }
        : { step: 'source', status: 'broken', summary: `linked folder missing: ${room.sourceRef}` }
    )
  } else if (room.workspaceMode === 'hotel' && backendOk) {
    const sizes = await backend.volumeSizes(room.id)
    const size = sizes[srcVolume(room.id, room.workspaceVolumeRevision)]
    push(
      size && size > 500
        ? { step: 'source', status: 'healthy', summary: `Room-owned workspace r${room.stateRevision} present` }
        : { step: 'source', status: 'broken', summary: 'Room-owned workspace volume is missing or empty' }
    )
  } else {
    push({ step: 'source', status: 'healthy', summary: room.sourceType === 'empty' ? 'empty room' : 'skipped' })
  }

  if (room.provider === 'android') {
    return androidChecks(ctx, results, push, awake, backendOk)
  }

  // 4 runtime
  if (!backendOk) {
    push({ step: 'runtime', status: 'unknown', summary: 'backend unavailable' })
  } else if (awake && (await backend.webState(room.id)) === 'running') {
    const res = await backend.execInRoom(room.id, ['node', '--version'], { timeoutMs: 15_000 })
    const version = res.stdout.trim()
    const ok = res.code === 0 && version.startsWith(`v${room.runtime.version}.`)
    push(
      ok
        ? { step: 'runtime', status: 'healthy', summary: `Node ${version.slice(1)}` }
        : {
            step: 'runtime',
            status: 'warning',
            summary: `expected Node ${room.runtime.version}, container reports ${version || 'nothing'}`,
            fix: { kind: 'node-version', version: room.runtime.version }
          }
    )
  } else {
    const present = await backend.imageExists(`node:${room.runtime.version}-bookworm`)
    push(
      present
        ? { step: 'runtime', status: 'healthy', summary: `Node ${room.runtime.version} image ready` }
        : { step: 'runtime', status: 'warning', summary: `Node ${room.runtime.version} image will be pulled on next start` }
    )
  }

  // 5 package manager — report the live in-room version when possible
  if (backendOk && awake && (await backend.webState(room.id)) === 'running') {
    const res = await backend.execInRoom(
      room.id,
      ['sh', '-lc', `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; ${room.packageManager.kind} --version 2>/dev/null | head -1`],
      { timeoutMs: 30_000 }
    )
    const version = res.stdout.trim()
    push(
      res.code === 0 && version
        ? { step: 'package-manager', status: 'healthy', summary: `${room.packageManager.kind} ${version}` }
        : { step: 'package-manager', status: 'warning', summary: `${room.packageManager.kind} not answering in the room` }
    )
  } else {
    push({
      step: 'package-manager',
      status: 'healthy',
      summary: `${room.packageManager.kind}${room.packageManager.version ? ` ${room.packageManager.version}` : ''}`
    })
  }

  // 6 dependencies
  if (room.sourceType === 'empty') {
    push({ step: 'dependencies', status: 'healthy', summary: 'no dependencies in an empty room' })
  } else if (room.workspaceMode === 'legacy-host-bind' && !declaresDependencies(room.sourceRef)) {
    push({ step: 'dependencies', status: 'healthy', summary: 'project declares no dependencies' })
  } else if (backendOk) {
    const sizes = await backend.volumeSizes(room.id)
    const depsVol = depsVolumeForGen(room.id, room.runtime.version, ctx.depsGen)
    const size = sizes[depsVol] ?? 0
    push(
      size > 10_000
        ? { step: 'dependencies', status: 'healthy', summary: 'installed' }
        : {
            step: 'dependencies',
            status: 'warning',
            summary: `dependencies look missing for Node ${room.runtime.version}`,
            fix: { kind: 'deps-install', clean: false }
          }
    )
  } else {
    push({ step: 'dependencies', status: 'unknown', summary: 'backend unavailable' })
  }

  // 7 env
  if (room.workspaceMode === 'legacy-host-bind' && existsSync(join(room.sourceRef, '.env.example')) && !existsSync(join(room.sourceRef, '.env'))) {
    push({ step: 'env', status: 'warning', summary: '.env.example exists but .env is missing' })
  } else {
    push({ step: 'env', status: 'healthy', summary: 'no missing env profile detected' })
  }

  // 8 services
  const serviceEntries = Object.entries(room.services ?? {}) as ['postgres' | 'redis', { version: string }][]
  if (serviceEntries.length === 0) {
    push({ step: 'services', status: 'healthy', summary: 'no services configured' })
  } else if (!awake || !backendOk) {
    push({ step: 'services', status: 'unknown', summary: 'room is asleep' })
  } else {
    const down: string[] = []
    const up: string[] = []
    for (const [svc, cfg] of serviceEntries) {
      const state = await backend.serviceState(room.id, svc)
      if (state === 'running') up.push(`${svc} ${cfg.version}`)
      else down.push(svc)
    }
    push(
      down.length === 0
        ? { step: 'services', status: 'healthy', summary: up.join(', ') }
        : { step: 'services', status: 'broken', summary: `${down.join(', ')} not running`, fix: { kind: 'start-services' } }
    )
  }

  // 9 start command
  push(
    room.startCommand.trim()
      ? { step: 'start-command', status: 'healthy', summary: room.startCommand }
      : { step: 'start-command', status: 'broken', summary: 'no start command configured' }
  )

  // 10-14 need a running room
  if (!awake || !backendOk) {
    push({ step: 'process', ...ASLEEP })
    push({ step: 'port', ...ASLEEP })
    push({ step: 'gateway', ...ASLEEP })
    push({ step: 'https', ...(room.https ? ASLEEP : { status: 'healthy', summary: 'HTTPS off' }) })
    push({ step: 'http', ...ASLEEP })
    return finish(room.id, results)
  }

  // 10 process
  const state = await backend.webState(room.id)
  push(
    state === 'running'
      ? { step: 'process', status: 'healthy', summary: 'web process running' }
      : {
          step: 'process',
          status: 'broken',
          summary: state === 'exited' ? 'web process exited' : 'web container missing',
          fix: { kind: 'restart-web' }
        }
  )

  // 11 internal port (via the room's loopback relay)
  const relayToken = state === 'running' && room.hostPort != null ? await backend.relayToken(room.id) : undefined
  const portOk =
    state === 'running' &&
    room.hostPort != null &&
    relayToken !== undefined &&
    (await tcpAnswers(room.hostPort, 2000, relayToken))
  push(
    portOk
      ? { step: 'port', status: 'healthy', summary: `port ${room.internalPort} listening` }
      : {
          step: 'port',
          status: state === 'running' ? 'broken' : 'unknown',
          summary: state === 'running' ? `nothing listening on internal port ${room.internalPort}` : 'web process not running'
        }
  )

  // 12 gateway route (self-heals)
  let routed = gateway.status().routes.some((r) => r.domain === room.domain)
  if (!routed) {
    try {
      await ctx.syncRoute()
      routed = gateway.status().routes.some((r) => r.domain === room.domain)
    } catch {
      routed = false
    }
    push(
      routed
        ? { step: 'gateway', status: 'healthy', summary: 'route was missing — restored' }
        : { step: 'gateway', status: 'broken', summary: `no gateway route for ${room.domain}` }
    )
  } else {
    push({ step: 'gateway', status: 'healthy', summary: `${room.domain} routed` })
  }

  // 13 https
  if (!room.https) {
    push({ step: 'https', status: 'healthy', summary: 'HTTPS off' })
  } else {
    const httpsPort = gateway.status().httpsPort
    if (httpsPort == null) {
      push({ step: 'https', status: 'broken', summary: 'gateway has no HTTPS port bound' })
    } else {
      await ensureCa(join(ctx.userData, 'ca'))
      const trust = await caTrustStatus(join(ctx.userData, 'ca'))
      push({
        step: 'https',
        status: 'healthy',
        summary: trust === 'trusted' ? 'certificate ready, CA trusted' : 'certificate ready (CA not trusted in Windows yet)'
      })
    }
  }

  // 14 http response through the gateway target
  if (portOk && room.hostPort != null) {
    const res = await httpProbe(room.hostPort, room.domain, relayToken)
    push(
      res.ok
        ? { step: 'http', status: 'healthy', summary: `HTTP ${res.status}` }
        : { step: 'http', status: 'broken', summary: res.detail, fix: { kind: 'restart-web' } }
    )
  } else {
    push({ step: 'http', status: 'unknown', summary: 'skipped — port not listening' })
  }

  return finish(room.id, results)
}

/** Android rooms: JDK/Gradle build container plus the emulator screen served through the relay. */
async function androidChecks(
  ctx: CheckCtx,
  results: CheckResult[],
  push: (r: CheckResult) => void,
  awake: boolean,
  backendOk: boolean
): Promise<CheckReport> {
  const { room, backend } = ctx
  const running = backendOk && awake && (await backend.webState(room.id)) === 'running'

  if (running) {
    const res = await backend.execInRoom(room.id, ['sh', '-lc', 'java -version 2>&1 | head -1'], { timeoutMs: 20_000 })
    const line = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? ''
    push(
      res.code === 0 && line
        ? { step: 'runtime', status: 'healthy', summary: line }
        : { step: 'runtime', status: 'warning', summary: 'JDK not answering inside the room' }
    )
  } else {
    push({ step: 'runtime', status: 'healthy', summary: `JDK ${room.runtime.version} (in the room image)` })
  }
  if (running) {
    const gradle = await backend.execInRoom(
      room.id,
      [
        'sh',
        '-lc',
        "if [ -f ./gradlew ]; then printf 'Gradle Wrapper'; elif command -v gradle >/dev/null 2>&1; then gradle --version 2>/dev/null | grep -m1 Gradle; else exit 1; fi"
      ],
      { timeoutMs: 20_000 }
    )
    const summary = gradle.stdout.trim().split(/\r?\n/)[0] ?? ''
    push(
      gradle.code === 0 && summary
        ? { step: 'package-manager', status: 'healthy', summary }
        : { step: 'package-manager', status: 'broken', summary: 'Gradle Wrapper and image Gradle are both unavailable' }
    )
  } else {
    push({ step: 'package-manager', status: 'healthy', summary: 'Gradle (Room image)' })
  }
  push({ step: 'dependencies', status: 'healthy', summary: 'Gradle cache is Room-owned' })
  push({ step: 'env', status: 'healthy', summary: 'not enforced for build rooms' })
  push(
    Object.keys(room.services).length === 0
      ? { step: 'services', status: 'healthy', summary: 'no services configured' }
      : { step: 'services', status: 'warning', summary: 'managed services are unavailable in Android Rooms' }
  )
  push(
    room.startCommand.trim()
      ? { step: 'start-command', status: 'healthy', summary: room.startCommand }
      : { step: 'start-command', status: 'broken', summary: 'no build command configured' }
  )

  if (!awake || !backendOk) {
    push({ step: 'process', ...ASLEEP })
    push({ step: 'port', ...ASLEEP })
    push({ step: 'gateway', ...ASLEEP })
    push({ step: 'https', status: 'healthy', summary: 'HTTPS off' })
    push({ step: 'http', ...ASLEEP })
    return finish(room.id, results)
  }

  const state = await backend.webState(room.id)
  push(
    state === 'running'
      ? { step: 'process', status: 'healthy', summary: 'build container running' }
      : { step: 'process', status: 'broken', summary: 'build container not running', fix: { kind: 'restart-web' } }
  )

  // the emulator screen (noVNC) is what the room serves through the relay
  const emulator = await backend.emulatorState(room.id)
  const relayToken = emulator === 'running' && room.hostPort != null ? await backend.relayToken(room.id) : undefined
  const portOk =
    emulator === 'running' &&
    room.hostPort != null &&
    relayToken !== undefined &&
    (await tcpAnswers(room.hostPort, 2000, relayToken))
  push(
    portOk
      ? { step: 'port', status: 'healthy', summary: `emulator screen on port ${room.internalPort}` }
      : {
          step: 'port',
          status: emulator === 'running' ? 'warning' : 'broken',
          summary:
            emulator === 'running'
              ? 'emulator screen not answering yet (still booting?)'
              : `emulator container ${emulator}`
        }
  )

  let routed = ctx.gateway.status().routes.some((r) => r.domain === room.domain)
  if (!routed) {
    try {
      await ctx.syncRoute()
      routed = ctx.gateway.status().routes.some((r) => r.domain === room.domain)
    } catch {
      routed = false
    }
    push(
      routed
        ? { step: 'gateway', status: 'healthy', summary: 'route was missing — restored' }
        : { step: 'gateway', status: 'broken', summary: `no gateway route for ${room.domain}` }
    )
  } else {
    push({ step: 'gateway', status: 'healthy', summary: `${room.domain} routed` })
  }

  push({ step: 'https', status: 'healthy', summary: 'HTTPS off' })

  if (portOk && room.hostPort != null) {
    const res = await httpProbe(room.hostPort, room.domain, relayToken)
    push(
      res.ok
        ? { step: 'http', status: 'healthy', summary: `HTTP ${res.status}` }
        : { step: 'http', status: 'broken', summary: res.detail }
    )
  } else {
    push({ step: 'http', status: 'unknown', summary: 'skipped — emulator screen not answering' })
  }
  return finish(room.id, results)
}

function declaresDependencies(sourceDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0
  } catch {
    return true // can't tell — keep the volume-size heuristic
  }
}

async function httpProbe(
  port: number,
  host: string,
  relayToken: string
): Promise<{ ok: boolean; status?: number; detail: string }> {
  const http = await import('node:http')
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: { host },
        timeout: 8000,
        createConnection: (_options, oncreate) => createHttpRelayConnection(port, relayToken, oncreate)
      },
      (res) => {
        res.resume()
        resolve({ ok: true, status: res.statusCode ?? 0, detail: `HTTP ${res.statusCode}` })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, detail: 'HTTP request timed out after 8s' })
    })
    req.on('error', (err) => resolve({ ok: false, detail: `HTTP request failed: ${err.message}` }))
    req.end()
  })
}

function finish(roomId: string, results: CheckResult[]): CheckReport {
  const worst = (statuses: CheckStatus[]): CheckStatus => {
    if (statuses.includes('broken')) return 'broken'
    if (statuses.includes('warning')) return 'warning'
    if (statuses.every((s) => s === 'unknown')) return 'unknown'
    return 'healthy'
  }
  return {
    roomId,
    ranAt: new Date().toISOString(),
    results,
    overall: worst(results.map((r) => r.status))
  }
}
