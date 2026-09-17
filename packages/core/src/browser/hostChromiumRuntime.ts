import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DevHotelError } from '../errors'
import { findBrowserExecutable, type BrowserCandidate } from './browserLauncher'
import { SimpleCdpClient } from './cdpClient'
import type {
  ClientBrowserLaunchRequest,
  ClientBrowserProbe,
  ClientBrowserRuntime,
  LaunchedClientBrowser
} from './runtime'

const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort'
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const GRACEFUL_STOP_MS = 5_000
const PROBE_TIMEOUT_MS = 2_000
const TREE_DRAIN_MS = 5_000

/**
 * Flags that keep an automation browser quiet and self-contained. Nothing
 * here relaxes the DevTools listener: it stays loopback-only, on a port the
 * OS picks, with Chromium's own Origin check intact. Every agent reaches it
 * through the DevHotel endpoint, which strips browser origins and requires
 * the session token.
 */
function chromiumArgs(request: ClientBrowserLaunchRequest): string[] {
  const args = [
    `--user-data-dir=${request.profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--mute-audio',
    '--password-store=basic',
    '--use-mock-keychain',
    '--hide-scrollbars'
  ]
  if (request.headless) args.push('--headless=new')
  args.push('about:blank')
  return args
}

export interface DevToolsActivePort {
  port: number
  browserPath: string
}

/** Chromium writes `<port>\n<browser ws path>` into the profile once the listener is up. */
export function readDevToolsActivePort(profileDir: string): DevToolsActivePort | null {
  const file = join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE)
  if (!existsSync(file)) return null
  try {
    const [portLine, pathLine] = readFileSync(file, 'utf8').split(/\r?\n/)
    const port = Number.parseInt(portLine ?? '', 10)
    if (!Number.isInteger(port) || port <= 0 || !pathLine?.startsWith('/devtools/browser/')) return null
    return { port, browserPath: pathLine.trim() }
  } catch {
    return null
  }
}

function processAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function fetchVersion(
  host: string,
  port: number
): Promise<{ browser: string; webSocketDebuggerUrl: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal })
    if (!response.ok) return null
    const body = (await response.json()) as { Browser?: unknown; webSocketDebuggerUrl?: unknown }
    if (typeof body.webSocketDebuggerUrl !== 'string') return null
    return { browser: typeof body.Browser === 'string' ? body.Browser : 'unknown', webSocketDebuggerUrl: body.webSocketDebuggerUrl }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function waitForExit(pid: number | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !processAlive(pid)
}

async function closeViaCdp(wsUrl: string): Promise<boolean> {
  let client: SimpleCdpClient | null = null
  try {
    client = await SimpleCdpClient.connect(wsUrl, PROBE_TIMEOUT_MS)
    // The browser drops the socket while answering; a reply is not guaranteed.
    await Promise.race([client.send('Browser.close').catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000))])
    return true
  } catch {
    return false
  } finally {
    client?.close()
  }
}

function forceKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Renderer and GPU children hang off the browser process; take the tree.
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
    resolve()
  })
}

/**
 * Every process of a Chromium instance — browser, renderers, GPU, utilities —
 * carries `--user-data-dir=<profile>` on its command line, so the profile
 * path is the one fact that ties a PID to a session. Returns null when the
 * host could not be asked.
 */
async function listProfileProcesses(profileDir: string): Promise<number[] | null> {
  if (process.platform === 'win32') {
    return await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // The path travels in the environment, never in the script, so no quoting can break it.
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DEVHOTEL_CLIENT_BROWSER_PROFILE) } | ForEach-Object { $_.ProcessId }'
        ],
        { windowsHide: true, timeout: 15_000, env: { ...process.env, DEVHOTEL_CLIENT_BROWSER_PROFILE: profileDir } },
        (error, stdout) => {
          if (error) {
            resolve(null)
            return
          }
          resolve(stdout.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => Number.isInteger(pid) && pid > 0))
        }
      )
    })
  }
  try {
    const pids: number[] = []
    for (const entry of readdirSync('/proc')) {
      const pid = Number.parseInt(entry, 10)
      if (!Number.isInteger(pid) || pid <= 0) continue
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(profileDir)) pids.push(pid)
      } catch {
        // gone between listing and reading
      }
    }
    return pids
  } catch {
    return null
  }
}

/**
 * The browser process exits first; its GPU and utility children can still be
 * flushing caches into the profile for a moment, and on Windows an open file
 * blocks the directory removal. Wait for the tree to drain, then take the
 * stragglers, so a released profile is really free.
 */
async function reapProfileProcesses(profileDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let remaining = await listProfileProcesses(profileDir)
  while (remaining && remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    remaining = await listProfileProcesses(profileDir)
  }
  for (const pid of remaining ?? []) await forceKill(pid)
}

export interface HostChromiumRuntimeOptions {
  /** Explicit browser binary; otherwise DEVHOTEL_BROWSER_PATH, then the usual install locations. */
  executablePath?: string
  launchTimeoutMs?: number
}

/**
 * Runs Client Browsers as host-side Chromium processes. This is the runtime
 * the Docker-era install gets: Room containers carry no browser, and a Host
 * Chromium with a private profile gives the same isolation guarantees the
 * contract asks for — profile, cookies, storage, tabs and process are all
 * per session.
 */
export class HostChromiumRuntime implements ClientBrowserRuntime {
  readonly kind = 'host-chromium'
  private readonly executablePath?: string
  private readonly launchTimeoutMs: number

  constructor(options: HostChromiumRuntimeOptions = {}) {
    this.executablePath = options.executablePath
    this.launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  }

  private resolveExecutable(): BrowserCandidate {
    return findBrowserExecutable(this.executablePath)
  }

  async availability(): Promise<{ available: boolean; detail: string }> {
    try {
      const candidate = this.resolveExecutable()
      return { available: true, detail: `${candidate.kind}: ${candidate.path}` }
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser> {
    const candidate = this.resolveExecutable()
    mkdirSync(request.profileDir, { recursive: true })

    let child: ChildProcess
    try {
      child = spawn(candidate.path, chromiumArgs(request), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        detached: false
      })
    } catch (error) {
      throw new DevHotelError('CLIENT_BROWSER_LAUNCH_FAILED', `The browser could not be started: ${error instanceof Error ? error.message : String(error)}`)
    }

    const stderrTail: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail.push(chunk)
      while (stderrTail.length > 40) stderrTail.shift()
    })
    let exited = false
    let exitCode: number | null = null
    child.on('exit', (code) => {
      exited = true
      exitCode = code
    })
    child.on('error', () => {
      exited = true
    })

    const deadline = Date.now() + this.launchTimeoutMs
    let active: DevToolsActivePort | null = null
    while (Date.now() < deadline) {
      active = readDevToolsActivePort(request.profileDir)
      if (active) {
        // The file can be observed before the listener accepts; confirm it answers.
        const version = await fetchVersion('127.0.0.1', active.port)
        if (version) break
        active = null
      }
      if (exited) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!active) {
      if (!exited) await forceKill(child.pid ?? -1)
      throw new DevHotelError(
        'CLIENT_BROWSER_LAUNCH_FAILED',
        exited
          ? `The browser exited (code ${exitCode ?? 'unknown'}) before its DevTools listener came up.`
          : 'The browser did not expose its DevTools listener in time.',
        {
          recoveryHint: 'Check that the browser binary runs on this host; set DEVHOTEL_BROWSER_PATH to choose another Chromium.',
          evidence: { browser: candidate.path, stderr: stderrTail.join('').slice(-2_000) }
        }
      )
    }

    const pid = child.pid ?? null
    const cdpWsUrl = `ws://127.0.0.1:${active.port}${active.browserPath}`
    return {
      pid,
      browserKind: candidate.kind,
      devtoolsHost: '127.0.0.1',
      devtoolsPort: active.port,
      cdpWsUrl,
      stop: async () => {
        if (!exited) {
          await closeViaCdp(cdpWsUrl)
          if (!(await waitForExit(pid, GRACEFUL_STOP_MS)) && pid !== null) {
            await forceKill(pid)
            await waitForExit(pid, 2_000)
          }
        }
        await reapProfileProcesses(request.profileDir, TREE_DRAIN_MS)
      }
    }
  }

  async probe(record: { pid: number | null; devtoolsPort: number | null; profileDir: string }): Promise<ClientBrowserProbe> {
    const alive = processAlive(record.pid)
    const active = readDevToolsActivePort(record.profileDir)
    // The port must be the one recorded (when one was) and the ws path must
    // match the profile's own file: that is what proves the listener belongs
    // to this session and not to whatever reused the port later.
    if (!active || (record.devtoolsPort !== null && active.port !== record.devtoolsPort)) {
      return { processAlive: alive, cdpReachable: false, cdpWsUrl: null, browserVersion: null }
    }
    const version = await fetchVersion('127.0.0.1', active.port)
    if (!version || !version.webSocketDebuggerUrl.endsWith(active.browserPath)) {
      return { processAlive: alive, cdpReachable: false, cdpWsUrl: null, browserVersion: null }
    }
    return {
      processAlive: alive,
      cdpReachable: true,
      cdpWsUrl: `ws://127.0.0.1:${active.port}${active.browserPath}`,
      browserVersion: version.browser
    }
  }

  async stopOrphan(record: { pid: number | null; devtoolsPort: number | null; profileDir: string }): Promise<boolean> {
    const probe = await this.probe(record)
    if (probe.cdpReachable && probe.cdpWsUrl) {
      await closeViaCdp(probe.cdpWsUrl)
      if (await waitForExit(record.pid, GRACEFUL_STOP_MS)) return true
    }
    // A PID alone proves nothing after a restart: it may have been reused by
    // an unrelated process. Only a command line naming this profile is ours,
    // and that same fact finds the children the dead browser left behind.
    const owned = await listProfileProcesses(record.profileDir)
    if (owned === null) return !processAlive(record.pid)
    if (record.pid !== null && processAlive(record.pid) && !owned.includes(record.pid)) return false
    for (const pid of owned) await forceKill(pid)
    await reapProfileProcesses(record.profileDir, 2_000)
    return record.pid === null || (await waitForExit(record.pid, 2_000))
  }
}
