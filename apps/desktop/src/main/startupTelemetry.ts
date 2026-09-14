import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ENDPOINT = 'https://pulse-api.purpleshiphub.workers.dev/api/v1/ping'
const PROJECT_ID = 'pp_devhotel_a0d37c00'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface TelemetryState {
  installId: string
  lastAttemptDate?: string
}

export interface StartupTelemetryOptions {
  userData: string
  version: string
  os: string
  environment?: 'test'
  fetch?: typeof globalThis.fetch
  now?: Date
  timeoutMs?: number
}

function calendarDate(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeTelemetryOs(platform: string): string {
  const normalized = platform.toLowerCase()
  if (normalized === 'win32') return 'windows'
  if (normalized === 'darwin') return 'macos'
  if (normalized === 'linux') return 'linux'
  return normalized
}

function readState(path: string): TelemetryState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelemetryState>
    if (typeof value.installId === 'string' && UUID_PATTERN.test(value.installId)) {
      return {
        installId: value.installId,
        ...(typeof value.lastAttemptDate === 'string' ? { lastAttemptDate: value.lastAttemptDate } : {})
      }
    }
  } catch {
    // A missing or damaged file gets a new anonymous installation identity.
  }
  return { installId: randomUUID() }
}

function writeState(path: string, state: TelemetryState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
}

/**
 * Records the daily attempt before making the request, so offline launches and
 * crashes cannot create retry storms. All failures are deliberately silent.
 */
export async function sendStartupTelemetry(options: StartupTelemetryOptions): Promise<void> {
  const statePath = join(options.userData, 'telemetry.json')
  const state = readState(statePath)
  const today = calendarDate(options.now ?? new Date())
  if (state.lastAttemptDate === today) return

  try {
    writeState(statePath, { ...state, lastAttemptDate: today })
  } catch {
    // Do not send when the daily attempt cannot be persisted.
    return
  }

  const payload = {
    project_id: PROJECT_ID,
    install_id: state.installId,
    version: options.version,
    os: normalizeTelemetryOs(options.os),
    platform: 'electron',
    ...(options.environment ? { environment: options.environment } : {})
  }

  try {
    await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000)
    })
  } catch {
    // Telemetry must never delay or disrupt startup.
  }
}
