import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AndroidDevice, DeviceConnection, DeviceHealth } from '@devhotel/shared'
import type { ExecOutputChunk, ExecResult } from '../backend/types'

/** One line of `adb devices -l`, already parsed. */
export interface AdbDeviceLine {
  serial: string
  state: string
  model: string | null
  usb: string | null
  transportId: string | null
}

export interface AdbHostAvailability {
  ok: boolean
  detail: string
}

/** Private mDNS data. It must never be returned by the Room/API/MCP surface. */
export interface AdbPairingService {
  serviceName: string
  endpoint: string
}

/** Fixed result: raw `adb pair` output can contain the endpoint and is dropped. */
export interface AdbPairingAttempt {
  ok: boolean
}

/** Kept separate from AdbHost so Room-authorized callers cannot discover endpoints. */
export interface AdbPairingHost {
  discoverPairingServices(): Promise<AdbPairingService[]>
  pairWithCode(endpoint: string, pairingCode: string): Promise<AdbPairingAttempt>
}

export interface AdbBinaryResult {
  code: number
  stdout: Buffer
  stderr: string
  /** True only when the Host safety cap terminated the adb process. */
  outputLimitExceeded: boolean
}

export interface AdbExecOptions {
  timeoutMs?: number
  /** Internal lease fence. Aborting kills the owned Host adb process. */
  signal?: AbortSignal
  /** Internal/test override. Public callers never choose the Host buffer cap. */
  maxStdoutBytes?: number
  /** Internal/test override. Public callers never choose the Host buffer cap. */
  maxStderrBytes?: number
  /** Internal high-level evidence stream; accepted bytes are still Host-capped. */
  onStdout?: (chunk: ExecOutputChunk) => void
  /** Internal high-level evidence stream; accepted bytes are still Host-capped. */
  onStderr?: (chunk: ExecOutputChunk) => void
}

/**
 * The Host-side `adb` the broker owns. Physical phones hang off the Host's USB
 * bus, not off a Room's network namespace, so the broker is the one component
 * that is allowed to talk to them — and every Room path goes through it.
 */
export interface AdbHost {
  available(): Promise<AdbHostAvailability>
  devices(): Promise<AdbDeviceLine[]>
  exec(serial: string, args: string[], opts?: AdbExecOptions): Promise<ExecResult>
  /** Binary-safe variant for commands such as `exec-out screencap -p`. */
  execBinary(serial: string, args: string[], opts?: AdbExecOptions): Promise<AdbBinaryResult>
}

function isTcpPort(raw: string): boolean {
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function isDnsHost(raw: string): boolean {
  if (raw.length === 0 || raw.length > 253) return false
  return raw.split('.').every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
}

function pairingEndpoint(raw: string): string | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(raw)
  if (!match || isIP(match[1]!) !== 4 || !isTcpPort(match[2]!)) return null
  return raw
}

/** Parse only active Android pairing services, never connect/legacy entries. */
export function parseAdbPairingServices(stdout: string): AdbPairingService[] {
  const services: AdbPairingService[] = []
  const seen = new Set<string>()
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^list of discovered mdns services$/i.test(line)) continue
    const [serviceName, serviceType, rawEndpoint, ...extra] = line.split(/\s+/)
    if (
      !serviceName ||
      serviceName.length > 253 ||
      !serviceType ||
      serviceType.replace(/\.$/, '').toLowerCase() !== '_adb-tls-pairing._tcp' ||
      !rawEndpoint ||
      extra.length > 0
    ) {
      continue
    }
    const endpoint = pairingEndpoint(rawEndpoint)
    if (!endpoint || seen.has(endpoint)) continue
    seen.add(endpoint)
    services.push({ serviceName, endpoint })
  }
  return services
}

export function connectionForSerial(serial: string, usbLocation: string | null = null): DeviceConnection {
  if (/^emulator-\d+$/.test(serial)) return 'emulator'
  // `adb devices -l` supplies this field only for a USB transport. Prefer the
  // transport metadata over serial-shape heuristics (USB serials are opaque).
  if (usbLocation) return 'usb'
  // Android Wireless Debugging uses a DNS-SD service name instead of a
  // host:port on current platform-tools. Only the connect service is a device;
  // the similarly named pairing service must never enter inventory.
  if (/^.+\._adb-tls-connect\._tcp(?:\.local)?\.?$/i.test(serial)) return 'wireless'

  const bracketedIpv6 = /^\[([0-9A-Fa-f:.]+)(?:%([A-Za-z0-9._~-]+))?\]:(\d{1,5})$/.exec(serial)
  if (bracketedIpv6 && isIP(bracketedIpv6[1]!) === 6 && isTcpPort(bracketedIpv6[3]!)) return 'wireless'

  // Legacy network-attached devices are reported as IPv4-or-DNS host:port.
  // Requiring exactly one syntactically valid host and a bounded TCP port
  // avoids broadening the classifier to arbitrary colon-bearing serials.
  const hostEndpoint = /^([^:]+):(\d{1,5})$/.exec(serial)
  if (hostEndpoint && isTcpPort(hostEndpoint[2]!)) {
    const host = hostEndpoint[1]!
    if (isIP(host) === 4 || isDnsHost(host)) return 'wireless'
  }
  return 'usb'
}

/** `adb devices` states mapped onto what a waiting project needs to know. */
export function healthForState(state: string): DeviceHealth {
  switch (state) {
    case 'device':
      return 'ready'
    case 'unauthorized':
      return 'unauthorized'
    case 'offline':
    case 'bootloader':
    case 'recovery':
    case 'sideload':
      return 'offline'
    default:
      return 'disconnected'
  }
}

export function parseAdbDevices(stdout: string): AdbDeviceLine[] {
  const lines: AdbDeviceLine[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^list of devices/i.test(line) || /^\*/.test(line)) continue
    const [serial, state, ...rest] = line.split(/\s+/)
    if (!serial || !state) continue
    const fields = new Map<string, string>()
    for (const field of rest) {
      const idx = field.indexOf(':')
      if (idx > 0) fields.set(field.slice(0, idx), field.slice(idx + 1))
    }
    lines.push({
      serial,
      state,
      model: fields.get('model')?.replaceAll('_', ' ') ?? null,
      usb: fields.get('usb') ?? null,
      transportId: fields.get('transport_id') ?? null
    })
  }
  return lines
}

export interface ResolveAdbOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (candidate: string) => boolean
  home?: string
}

/**
 * Find an `adb` without asking the user to put one on PATH. DevHotel does not
 * ship a Host Android SDK, so the shipping product will provision its own adb
 * as Hotel-owned infrastructure; until then an explicit override wins, then
 * PATH, then the conventional SDK platform-tools location.
 */
export function resolveAdbExecutable(opts: ResolveAdbOptions = {}): string {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const fileExists = opts.fileExists ?? existsSync
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const name = platform === 'win32' ? 'adb.exe' : 'adb'

  const override = env.DEVHOTEL_ADB_PATH?.trim()
  if (override) return override.replace(/^"|"$/g, '')

  for (const rawDir of (env.PATH ?? env.Path ?? '').split(pathApi.delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    if (fileExists(pathApi.join(dir, name))) return pathApi.join(dir, name)
  }

  const roots = [
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    platform === 'win32'
      ? env.LOCALAPPDATA
        ? pathApi.join(env.LOCALAPPDATA, 'Android', 'Sdk')
        : null
      : pathApi.join(opts.home ?? homedir(), platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk')
  ].filter((root): root is string => Boolean(root))
  for (const root of new Set(roots)) {
    const candidate = pathApi.join(root, 'platform-tools', name)
    if (fileExists(candidate)) return candidate
  }
  return name
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_TEXT_STDOUT_LIMIT_BYTES = 1024 * 1024
const DEFAULT_BINARY_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024
const DEFAULT_STDERR_LIMIT_BYTES = 256 * 1024

interface RunBinaryOptions {
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  signal?: AbortSignal
  onStdout?: (chunk: ExecOutputChunk) => void
  onStderr?: (chunk: ExecOutputChunk) => void
}

function runBinary(executable: string, args: string[], opts: RunBinaryOptions): Promise<AdbBinaryResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Host ADB operation was aborted'))
      return
    }
    const child = spawn(executable, args, { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimit: { stream: 'stdout' | 'stderr'; limit: number } | null = null
    let timedOut = false
    let aborted = false

    const removeAbortListener = (): void => opts.signal?.removeEventListener('abort', abort)
    const abort = (): void => {
      aborted = true
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    // Abort may race the synchronous spawn/listener-registration window. An
    // AbortSignal does not replay an event that fired before registration, so
    // re-check after the listener is installed before allowing adb to run.
    if (opts.signal?.aborted) abort()

    const stopForLimit = (stream: 'stdout' | 'stderr', limit: number): void => {
      if (outputLimit) return
      outputLimit = { stream, limit }
      child.kill('SIGKILL')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, opts.maxStdoutBytes - stdoutBytes)
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining)
        stdout.push(captured)
        stdoutBytes += captured.length
        opts.onStdout?.(captured)
      }
      if (chunk.length > remaining) stopForLimit('stdout', opts.maxStdoutBytes)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, opts.maxStderrBytes - stderrBytes)
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining)
        stderr.push(captured)
        stderrBytes += captured.length
        opts.onStderr?.(captured)
      }
      if (chunk.length > remaining) stopForLimit('stderr', opts.maxStderrBytes)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      removeAbortListener()
      if (aborted) {
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('Host ADB operation was aborted'))
        return
      }
      reject(new Error('Host ADB process could not be launched; inspect Host diagnostics locally'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      removeAbortListener()
      if (aborted) {
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('Host ADB operation was aborted'))
        return
      }
      let stderrText = Buffer.concat(stderr, stderrBytes).toString('utf8')
      if (timedOut) stderrText += `\nadb ${args[0] ?? ''} timed out after ${opts.timeoutMs}ms`
      if (outputLimit) {
        stderrText += `\nadb ${outputLimit.stream} exceeded the ${outputLimit.limit}-byte Host safety limit; process terminated`
      }
      resolve({
        code: outputLimit ? -1 : (code ?? -1),
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: stderrText,
        outputLimitExceeded: outputLimit !== null
      })
    })
  })
}

async function run(executable: string, args: string[], opts: AdbExecOptions = {}): Promise<ExecResult> {
  const result = await runBinary(executable, args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: opts.maxStdoutBytes ?? DEFAULT_TEXT_STDOUT_LIMIT_BYTES,
    maxStderrBytes: opts.maxStderrBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
    signal: opts.signal
  })
  return { code: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr }
}

/**
 * Invoke the interactive form (`adb pair ENDPOINT`) and write the short-lived
 * code to stdin. Child output is drained and discarded because even successful
 * ADB versions echo the private endpoint and transport identity.
 */
function runPairing(executable: string, args: string[], pairingCode: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdbPairingAttempt> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    child.stdout.resume()
    child.stderr.resume()
    const secret = Buffer.from(`${pairingCode}\n`, 'utf8')
    let settled = false
    const clearSecret = (): void => {
      secret.fill(0)
    }
    const finish = (result: AdbPairingAttempt): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearSecret()
      resolve(result)
    }
    const fail = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearSecret()
      reject(new Error('Host ADB pairing process could not be launched; inspect Host diagnostics locally'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false })
    }, timeoutMs)
    child.stdin.on('error', () => {
      // ADB can exit before consuming stdin. Its exit status is the fixed result.
    })
    child.on('error', fail)
    child.on('close', (code) => finish({ ok: code === 0 }))
    child.stdin.end(secret, clearSecret)
  })
}

export interface SpawnedAdbHostOptions {
  executable?: string
  /** Prefix used by tests/wrappers before adb argv; empty in production. */
  prefixArgs?: string[]
  textStdoutLimitBytes?: number
  binaryStdoutLimitBytes?: number
  stderrLimitBytes?: number
}

/** The real Host adb. Every call names an explicit serial — never a default device. */
export class SpawnedAdbHost implements AdbHost, AdbPairingHost {
  private readonly executable: string
  private readonly prefixArgs: string[]
  private readonly textStdoutLimitBytes: number
  private readonly binaryStdoutLimitBytes: number
  private readonly stderrLimitBytes: number

  constructor(input: string | SpawnedAdbHostOptions = resolveAdbExecutable()) {
    const opts = typeof input === 'string' ? { executable: input } : input
    this.executable = opts.executable ?? resolveAdbExecutable()
    this.prefixArgs = opts.prefixArgs ?? []
    this.textStdoutLimitBytes = opts.textStdoutLimitBytes ?? DEFAULT_TEXT_STDOUT_LIMIT_BYTES
    this.binaryStdoutLimitBytes = opts.binaryStdoutLimitBytes ?? DEFAULT_BINARY_STDOUT_LIMIT_BYTES
    this.stderrLimitBytes = opts.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES
  }

  private argv(args: string[]): string[] {
    return [...this.prefixArgs, ...args]
  }

  async available(): Promise<AdbHostAvailability> {
    try {
      const result = await run(this.executable, this.argv(['version']), {
        timeoutMs: 15_000,
        maxStdoutBytes: this.textStdoutLimitBytes,
        maxStderrBytes: this.stderrLimitBytes
      })
      if (result.code !== 0) {
        return { ok: false, detail: `Host ADB probe failed with exit code ${result.code}; inspect Host diagnostics locally` }
      }
      return { ok: true, detail: result.stdout.split(/\r?\n/)[0]?.trim() || 'adb available' }
    } catch {
      return {
        ok: false,
        detail: 'No usable Host ADB could be launched. Set DEVHOTEL_ADB_PATH or install platform-tools.'
      }
    }
  }

  async devices(): Promise<AdbDeviceLine[]> {
    const result = await run(this.executable, this.argv(['devices', '-l']), {
      timeoutMs: 20_000,
      maxStdoutBytes: this.textStdoutLimitBytes,
      maxStderrBytes: this.stderrLimitBytes
    })
    // A failing `adb devices` can echo raw transport serials. Inventory errors
    // become public broker status, so only the exit fact crosses this boundary.
    if (result.code !== 0) throw new Error(`adb devices failed with exit code ${result.code}; inspect Host diagnostics locally`)
    return parseAdbDevices(result.stdout)
  }

  async discoverPairingServices(): Promise<AdbPairingService[]> {
    const result = await run(this.executable, this.argv(['mdns', 'services']), {
      timeoutMs: 20_000,
      maxStdoutBytes: this.textStdoutLimitBytes,
      maxStderrBytes: this.stderrLimitBytes
    })
    if (result.code !== 0) {
      throw new Error(`ADB pairing discovery failed with exit code ${result.code}; inspect Host diagnostics locally`)
    }
    return parseAdbPairingServices(result.stdout)
  }

  pairWithCode(endpoint: string, pairingCode: string): Promise<AdbPairingAttempt> {
    if (pairingEndpoint(endpoint) === null) throw new Error('ADB pairing endpoint is invalid')
    if (!/^\d{6}$/.test(pairingCode)) throw new Error('ADB pairing code is invalid')
    return runPairing(this.executable, this.argv(['pair', endpoint]), pairingCode)
  }

  exec(serial: string, args: string[], opts: AdbExecOptions = {}): Promise<ExecResult> {
    return run(this.executable, this.argv(['-s', serial, ...args]), {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: Math.min(opts.maxStdoutBytes ?? this.textStdoutLimitBytes, this.textStdoutLimitBytes),
      maxStderrBytes: Math.min(opts.maxStderrBytes ?? this.stderrLimitBytes, this.stderrLimitBytes),
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      signal: opts.signal
    })
  }

  execBinary(serial: string, args: string[], opts: AdbExecOptions = {}): Promise<AdbBinaryResult> {
    return runBinary(this.executable, this.argv(['-s', serial, ...args]), {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: Math.min(opts.maxStdoutBytes ?? this.binaryStdoutLimitBytes, this.binaryStdoutLimitBytes),
      maxStderrBytes: Math.min(opts.maxStderrBytes ?? this.stderrLimitBytes, this.stderrLimitBytes),
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      signal: opts.signal
    })
  }
}

/** Read-only properties worth showing next to a queued request. */
export interface DeviceProps {
  androidVersion: string | null
  apiLevel: number | null
  model: string | null
}

async function readDeviceProperty(adb: AdbHost, serial: string, name: string): Promise<string | null> {
  try {
    const result = await adb.exec(serial, ['shell', 'getprop', name], {
      timeoutMs: 10_000,
      maxStdoutBytes: 256,
      maxStderrBytes: 256
    })
    const value = result.stdout.trim()
    return result.code === 0 && value ? value : null
  } catch {
    return null
  }
}

/**
 * Host-private physical identity material shared by USB and TLS/mDNS
 * transports. Callers must immediately turn this into an install-keyed HMAC;
 * the probe value is never logged, returned, or stored as a correlation key.
 */
export async function readPhysicalDeviceIdentity(adb: AdbHost, serial: string): Promise<string | null> {
  for (const name of ['ro.serialno', 'ro.boot.serialno']) {
    const value = await readDeviceProperty(adb, serial, name)
    if (
      value &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
      !/^(?:unknown|0123456789abcdef|0+)$/i.test(value)
    ) return value
  }
  return null
}

export async function readDeviceProps(adb: AdbHost, serial: string): Promise<DeviceProps> {
  const props: DeviceProps = { androidVersion: null, apiLevel: null, model: null }
  props.androidVersion = await readDeviceProperty(adb, serial, 'ro.build.version.release')
  const sdk = await readDeviceProperty(adb, serial, 'ro.build.version.sdk')
  props.apiLevel = sdk && /^\d+$/.test(sdk) ? Number.parseInt(sdk, 10) : null
  props.model = await readDeviceProperty(adb, serial, 'ro.product.model')
  return props
}

/** A readable default so the UI and MCP never have to print a raw serial. */
export function defaultNickname(model: string | null, connection: DeviceConnection, existing: AndroidDevice[]): string {
  const base = (model ?? (connection === 'emulator' ? 'Emulator' : 'Android')).replace(/\s+/g, '-')
  const taken = new Set(existing.map((device) => device.nickname))
  for (let index = 1; index < 1000; index++) {
    const candidate = `${base}-${String(index).padStart(2, '0')}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
