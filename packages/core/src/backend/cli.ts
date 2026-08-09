import { spawn } from 'node:child_process'
import type { ExecResult } from './types'

export interface RunDockerOpts {
  timeoutMs?: number
  onLine?: (line: string) => void
  input?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

export function runDocker(args: string[], opts: RunDockerOpts = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let outRest = ''
    let errRest = ''
    let timedOut = false

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

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      outRest = feed(outRest, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      errRest = feed(errRest, chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (opts.onLine) {
        if (outRest.length > 0) opts.onLine(outRest)
        if (errRest.length > 0) opts.onLine(errRest)
      }
      if (timedOut) stderr += `\ndocker ${args[0] ?? ''} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
