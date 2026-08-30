import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import type { ExecOutputChunk, ExecResult } from './types'

export interface RunDockerOpts {
  timeoutMs?: number
  /** Kill the docker CLI immediately when stdout crosses this byte count. */
  maxStdoutBytes?: number
  /** Kill the docker CLI immediately when stderr crosses this byte count. */
  maxStderrBytes?: number
  /** Caller-owned, identity-safe cleanup invoked when timeout/output caps abort `docker run`. */
  onAbort?: () => Promise<void>
  onLine?: (line: string) => void
  input?: string
  /** Stream this host file to docker stdin without loading it into JS memory. */
  inputFile?: string
  /** Stream docker stdout to this host file without loading it into JS memory. */
  outputFile?: string
  /**
   * Receive stdout as it arrives. When set, stdout is NOT accumulated into the
   * result, so a caller that bounds or retains the stream itself never pays for
   * a gigabyte of log in JS memory.
   */
  onStdout?: (chunk: ExecOutputChunk) => void
  /** Same contract as onStdout, for stderr. */
  onStderr?: (chunk: ExecOutputChunk) => void
}

const DEFAULT_TIMEOUT_MS = 120_000

export interface ResolveDockerExecutableOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (candidate: string) => boolean
}

export interface PinnedDockerRuntime {
  executable: string
  context: string
  env: NodeJS.ProcessEnv
}

export interface CreatePinnedDockerRuntimeOptions extends ResolveDockerExecutableOptions {
  context?: string
}

function withoutOuterQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (env[key]) return env[key]
  if (platform !== 'win32') return undefined
  const found = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  return found ? env[found] : undefined
}

/**
 * Locate the Docker CLI without requiring installers to mutate the user's PATH.
 * An explicit override is authoritative; otherwise PATH is searched before the
 * standard Docker Desktop location on Windows.
 */
export function resolveDockerExecutable(opts: ResolveDockerExecutableOptions = {}): string {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const fileExists = opts.fileExists ?? existsSync
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const executableName = platform === 'win32' ? 'docker.exe' : 'docker'

  const override = envValue(env, 'DEVHOTEL_DOCKER_PATH', platform)
  if (override?.trim()) return withoutOuterQuotes(override)

  const searchPath = envValue(env, 'PATH', platform) ?? ''
  for (const rawDir of searchPath.split(pathApi.delimiter)) {
    const dir = withoutOuterQuotes(rawDir)
    if (!dir) continue
    const candidate = pathApi.join(dir, executableName)
    if (fileExists(candidate)) return candidate
  }

  if (platform === 'win32') {
    const programFiles = envValue(env, 'ProgramW6432', platform) ?? envValue(env, 'ProgramFiles', platform) ?? 'C:\\Program Files'
    const dockerDesktopCli = path.win32.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
    if (fileExists(dockerDesktopCli)) return dockerDesktopCli
  }

  return executableName
}

/**
 * Docker endpoint variables are intentionally not inherited. DevHotel pins one
 * explicit context for its process lifetime so a shell's DOCKER_HOST or a later
 * context switch cannot redirect Room mutations to another engine.
 */
export function buildDockerSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  context?: string,
  opts: { executable?: string; platform?: NodeJS.Platform } = {}
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform
  const pinnedContext = context ?? (envValue(env, 'DEVHOTEL_DOCKER_CONTEXT', platform)?.trim() || 'default')
  const out = { ...env }
  const blocked = new Set(['docker_host', 'docker_context', 'docker_tls_verify', 'docker_cert_path', 'docker_api_version'])
  for (const key of Object.keys(out)) {
    if (blocked.has(key.toLowerCase())) delete out[key]
  }
  out.DOCKER_CONTEXT = pinnedContext

  const executable = opts.executable
  if (executable) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix
    const executableDir = pathApi.dirname(executable)
    if (executableDir && executableDir !== '.') {
      const pathKey =
        platform === 'win32'
          ? Object.keys(out).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
          : 'PATH'
      const currentPath = out[pathKey] ?? ''
      out[pathKey] = currentPath ? `${executableDir}${pathApi.delimiter}${currentPath}` : executableDir
    }
  }
  return out
}

export function createPinnedDockerRuntime(opts: CreatePinnedDockerRuntimeOptions = {}): PinnedDockerRuntime {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const executable = resolveDockerExecutable({ env, platform, fileExists: opts.fileExists })
  const context = opts.context ?? (envValue(env, 'DEVHOTEL_DOCKER_CONTEXT', platform)?.trim() || 'default')
  return {
    executable,
    context,
    env: buildDockerSpawnEnv(env, context, { executable, platform })
  }
}

let pinnedDockerRuntime: PinnedDockerRuntime | null = null

export function getPinnedDockerRuntime(): PinnedDockerRuntime {
  if (!pinnedDockerRuntime) {
    pinnedDockerRuntime = createPinnedDockerRuntime()
  }
  return pinnedDockerRuntime
}

/** All long-lived and buffered Docker processes share the same pinned runtime. */
export function spawnDockerProcess(args: string[]): ChildProcessWithoutNullStreams {
  const runtime = getPinnedDockerRuntime()
  return spawn(runtime.executable, args, { windowsHide: true, env: runtime.env })
}

export function runDocker(args: string[], opts: RunDockerOpts = {}): Promise<ExecResult> {
  if (opts.input !== undefined && opts.inputFile) {
    return Promise.reject(new Error('runDocker accepts either input or inputFile, not both'))
  }
  if (opts.outputFile && opts.onLine) {
    return Promise.reject(new Error('runDocker accepts either outputFile or onLine, not both'))
  }
  if ((opts.onStdout || opts.onStderr) && (opts.outputFile || opts.onLine)) {
    return Promise.reject(new Error('runDocker accepts either chunk sinks or outputFile/onLine, not both'))
  }
  if (opts.outputFile && opts.maxStdoutBytes !== undefined) {
    return Promise.reject(new Error('runDocker cannot apply an in-memory stdout cap to outputFile streaming'))
  }
  for (const [name, value] of [['maxStdoutBytes', opts.maxStdoutBytes], ['maxStderrBytes', opts.maxStderrBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return Promise.reject(new Error(`runDocker ${name} must be a non-negative safe integer`))
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawnDockerProcess(args)
    let stdout = ''
    let stderr = ''
    let outRest = ''
    let errRest = ''
    let timedOut = false
    let settled = false
    let childClosed = false
    let outputFinished = opts.outputFile === undefined
    let closeCode = -1
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimitExceeded = false
    let abortCleanup: Promise<void> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const abort = (): void => {
      if (timer) clearTimeout(timer)
      child.kill('SIGKILL')
      abortCleanup ??= opts.onAbort
        ? Promise.resolve().then(opts.onAbort).catch(() => undefined)
        : Promise.resolve()
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      abort()
      void (abortCleanup ?? Promise.resolve()).then(() => reject(err))
    }

    const finish = (): void => {
      if (settled || !childClosed || !outputFinished) return
      settled = true
      void (abortCleanup ?? Promise.resolve()).then(() => {
        resolve({ code: closeCode, stdout, stderr, ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}) })
      })
    }

    const feed = (rest: string, chunk: string): string => {
      const parts = (rest + chunk).split(/\r?\n/)
      const next = parts.pop() ?? ''
      if (opts.onLine) {
        for (const line of parts) {
          if (line.length > 0) opts.onLine(line)
        }
      }
      return next
    }

    const stopForOutputLimit = (): void => {
      if (outputLimitExceeded) return
      outputLimitExceeded = true
      abort()
    }

    const boundedChunk = (
      chunk: string | Buffer,
      stream: 'stdout' | 'stderr'
    ): { data: Buffer; exceeded: boolean } => {
      if (outputLimitExceeded) return { data: Buffer.alloc(0), exceeded: false }
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      const limit = stream === 'stdout' ? opts.maxStdoutBytes : opts.maxStderrBytes
      if (limit === undefined) return { data, exceeded: false }
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = Math.max(0, limit - used)
      const captured = data.subarray(0, remaining)
      if (stream === 'stdout') stdoutBytes += captured.byteLength
      else stderrBytes += captured.byteLength
      return { data: captured, exceeded: data.byteLength > remaining }
    }

    if (opts.outputFile) {
      const output = createWriteStream(opts.outputFile)
      output.on('error', fail)
      output.on('finish', () => {
        outputFinished = true
        finish()
      })
      child.stdout.pipe(output)
    } else if (!opts.onStdout) {
      child.stdout.setEncoding('utf8')
    }
    if (!opts.onStderr) child.stderr.setEncoding('utf8')
    if (!opts.outputFile) {
      child.stdout.on('data', (chunk: string | Buffer) => {
        const bounded = boundedChunk(chunk, 'stdout')
        if (bounded.data.byteLength === 0 && !bounded.exceeded) return
        if (opts.onStdout) {
          if (bounded.data.byteLength > 0) opts.onStdout(bounded.data)
        } else {
          const text = bounded.data.toString('utf8')
          stdout += text
          outRest = feed(outRest, text)
        }
        if (bounded.exceeded) stopForOutputLimit()
      })
    }
    child.stderr.on('data', (chunk: string | Buffer) => {
      const bounded = boundedChunk(chunk, 'stderr')
      if (bounded.data.byteLength === 0 && !bounded.exceeded) return
      if (opts.onStderr) {
        if (bounded.data.byteLength > 0) opts.onStderr(bounded.data)
      } else {
        const text = bounded.data.toString('utf8')
        stderr += text
        errRest = feed(errRest, text)
      }
      if (bounded.exceeded) stopForOutputLimit()
    })

    timer = setTimeout(() => {
      timedOut = true
      abort()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdin.on('error', () => {})
    if (opts.inputFile) {
      const input = createReadStream(opts.inputFile)
      input.on('error', fail)
      input.pipe(child.stdin)
    } else {
      if (opts.input !== undefined) child.stdin.write(opts.input)
      child.stdin.end()
    }

    child.on('error', fail)

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (opts.onLine) {
        if (outRest.length > 0) opts.onLine(outRest)
        if (errRest.length > 0) opts.onLine(errRest)
      }
      if (timedOut && !outputLimitExceeded) {
        // The timeout notice is the one line a caller must never lose, so it
        // follows the same path the rest of stderr took.
        const notice = `\ndocker ${args[0] ?? ''} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        if (opts.onStderr) opts.onStderr(notice)
        else stderr += notice
      }
      if (outputLimitExceeded && !opts.onStderr) {
        stderr += '\ndocker output exceeded its configured safety limit'
      }
      closeCode = outputLimitExceeded ? -1 : (code ?? -1)
      childClosed = true
      finish()
    })
  })
}
