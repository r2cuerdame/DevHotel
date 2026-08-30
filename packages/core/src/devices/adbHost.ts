import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AndroidDevice, DeviceConnection, DeviceHealth } from '@devhotel/shared'
import type { ExecResult } from '../backend/types'

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

export interface AdbBinaryResult {
  code: number
  stdout: Buffer
  stderr: string
}

/**
 * The Host-side `adb` the broker owns. Physical phones hang off the Host's USB
 * bus, not off a Room's network namespace, so the broker is the one component
 * that is allowed to talk to them — and every Room path goes through it.
 */
export interface AdbHost {
  available(): Promise<AdbHostAvailability>
  devices(): Promise<AdbDeviceLine[]>
  exec(serial: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  /** Binary-safe variant for commands such as `exec-out screencap -p`. */
  execBinary(serial: string, args: string[], opts?: { timeoutMs?: number }): Promise<AdbBinaryResult>
}

/**
 * A phone's adb serial is stable but is also a hardware identifier a user may
 * not want echoed into logs and issue comments. The broker's public ID is a
 * short digest of it: stable across reconnects, meaningless off this machine.
 */
export function deviceIdForSerial(serial: string): string {
  return `d${createHash('sha256').update(serial).digest('hex').slice(0, 11)}`
}

export function connectionForSerial(serial: string): DeviceConnection {
  if (/^emulator-\d+$/.test(serial)) return 'emulator'
  // adb reports network-attached devices as host:port.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial) || /^[A-Za-z0-9.-]+:\d+$/.test(serial)) return 'wireless'
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

function runBinary(executable: string, args: string[], timeoutMs: number): Promise<AdbBinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    const stdout: Buffer[] = []
    let stderr = ''
    let timedOut = false
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) stderr += `\nadb ${args[0] ?? ''} timed out after ${timeoutMs}ms`
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr })
    })
  })
}

async function run(executable: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  const result = await runBinary(executable, args, timeoutMs)
  return { code: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr }
}

/** The real Host adb. Every call names an explicit serial — never a default device. */
export class SpawnedAdbHost implements AdbHost {
  constructor(private readonly executable: string = resolveAdbExecutable()) {}

  async available(): Promise<AdbHostAvailability> {
    try {
      const result = await run(this.executable, ['version'], 15_000)
      if (result.code !== 0) {
        return { ok: false, detail: `adb exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}` }
      }
      return { ok: true, detail: result.stdout.split(/\r?\n/)[0]?.trim() || 'adb available' }
    } catch (err) {
      return {
        ok: false,
        detail: `no usable adb (${err instanceof Error ? err.message : String(err)}). Set DEVHOTEL_ADB_PATH or install platform-tools.`
      }
    }
  }

  async devices(): Promise<AdbDeviceLine[]> {
    const result = await run(this.executable, ['devices', '-l'], 20_000)
    if (result.code !== 0) throw new Error(`adb devices failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 200)}`)
    return parseAdbDevices(result.stdout)
  }

  exec(serial: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return run(this.executable, ['-s', serial, ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  execBinary(serial: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<AdbBinaryResult> {
    return runBinary(this.executable, ['-s', serial, ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }
}

/** Read-only properties worth showing next to a queued request. */
export interface DeviceProps {
  androidVersion: string | null
  apiLevel: number | null
  model: string | null
}

export async function readDeviceProps(adb: AdbHost, serial: string): Promise<DeviceProps> {
  const props: DeviceProps = { androidVersion: null, apiLevel: null, model: null }
  const read = async (name: string): Promise<string | null> => {
    try {
      const result = await adb.exec(serial, ['shell', 'getprop', name], { timeoutMs: 10_000 })
      const value = result.stdout.trim()
      return result.code === 0 && value ? value : null
    } catch {
      return null
    }
  }
  props.androidVersion = await read('ro.build.version.release')
  const sdk = await read('ro.build.version.sdk')
  props.apiLevel = sdk && /^\d+$/.test(sdk) ? Number.parseInt(sdk, 10) : null
  props.model = await read('ro.product.model')
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
