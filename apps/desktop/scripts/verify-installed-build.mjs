#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { hashRuntimePayloads, validateRuntimePayloads } from './runtime-payloads.mjs'

const SHA = /^[a-f0-9]{40}$/
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function identity(value) {
  const result = {
    version: value?.version,
    commit: value?.commit,
    buildTime: value?.buildTime,
    sourceVerified: value?.sourceVerified
  }
  if (
    !SEMVER.test(result.version) ||
    !SHA.test(result.commit) ||
    result.sourceVerified !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.buildTime) ||
    new Date(result.buildTime).toISOString() !== result.buildTime
  ) {
    throw new Error('invalid build identity')
  }
  return result
}

function same(left, right) {
  return left.version === right.version && left.commit === right.commit && left.buildTime === right.buildTime && left.sourceVerified === right.sourceVerified
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function processExecutable(pid) {
  if (process.platform === 'linux') return realpath(`/proc/${pid}/exe`)
  if (process.platform === 'win32') {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (!output) throw new Error('live process installation mismatch')
    return realpath(output)
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!output) throw new Error('live process installation mismatch')
    return realpath(output)
  }
  throw new Error('live process installation mismatch')
}

function resourcesForExecutable(executable) {
  return process.platform === 'darwin'
    ? resolve(dirname(executable), '..', 'Resources')
    : join(dirname(executable), 'resources')
}

async function liveResources(pid, appAsar, mcpFile) {
  const executable = await processExecutable(pid)
  const resources = resourcesForExecutable(executable)
  const liveAppAsar = await realpath(join(resources, 'app.asar'))
  const liveMcp = await realpath(join(resources, 'mcp', 'index.js'))
  if (await realpath(appAsar) !== liveAppAsar || await realpath(mcpFile) !== liveMcp) {
    throw new Error('live process installation mismatch')
  }
  return { executable, appAsar: liveAppAsar, mcpFile: liveMcp }
}

async function main() {
  const expectedFile = arg('--expected')
  const appAsar = arg('--app-asar')
  if (!expectedFile || !appAsar) {
    throw new Error('usage: verify-installed-build --expected <build-identity.json> --app-asar <installed app.asar> [--mcp <installed mcp/index.js>] [--control <control.json>]')
  }
  const mcpFile = arg('--mcp') || join(dirname(appAsar), 'mcp', 'index.js')
  const controlFile = arg('--control') || join(process.env.APPDATA || '', 'DevHotel', 'control.json')
  const timeoutMs = Number(arg('--timeout-ms') || '10000')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('invalid timeout')

  const expectedRaw = JSON.parse(await readFile(expectedFile, 'utf8'))
  const expected = identity(expectedRaw)
  const expectedRuntime = validateRuntimePayloads(expectedRaw.runtimePayloads)
  const discoveryRaw = JSON.parse(await readFile(controlFile, 'utf8'))
  const discovery = identity(discoveryRaw)
  if (!Number.isInteger(discoveryRaw.port) || discoveryRaw.port < 1 || typeof discoveryRaw.token !== 'string' ||
      !Number.isInteger(discoveryRaw.pid) || discoveryRaw.pid < 1) {
    throw new Error('invalid control discovery')
  }
  const live = await liveResources(discoveryRaw.pid, appAsar, mcpFile)
  if (existsSync(join(dirname(live.appAsar), 'app.asar.unpacked', 'out', 'main', 'chunks'))) {
    throw new Error('unexpected unpacked main-process payload')
  }
  if (!/^[a-f0-9]{64}$/.test(expectedRaw.appAsarSha256)) throw new Error('invalid packaged artifact digest')
  if (!/^[a-f0-9]{64}$/.test(expectedRaw.mcpSha256)) throw new Error('invalid packaged artifact digest')
  if (await sha256(live.appAsar) !== expectedRaw.appAsarSha256) throw new Error('installed app.asar digest mismatch')
  if (await sha256(live.mcpFile) !== expectedRaw.mcpSha256) throw new Error('installed MCP digest mismatch')
  const installedRuntime = await hashRuntimePayloads(dirname(live.executable))
  if (JSON.stringify(installedRuntime) !== JSON.stringify(expectedRuntime)) {
    throw new Error('installed runtime payload mismatch')
  }

  const headers = { authorization: `Bearer ${discoveryRaw.token}` }
  const request = async (path) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${discoveryRaw.port}${path}`, {
      headers,
      signal: globalThis.AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) throw new Error(`control API ${path} returned ${response.status}`)
    return response.json()
  }
  const [pingRaw, statusRaw] = await Promise.all([request('/v1/ping'), request('/v1/status')])
  const ping = identity(pingRaw)
  const status = identity(statusRaw)
  if (!same(expected, discovery) || !same(expected, ping) || !same(expected, status)) {
    throw new Error('installed build identity mismatch')
  }
  if (await processExecutable(discoveryRaw.pid) !== live.executable) {
    throw new Error('live process installation mismatch')
  }

  process.stdout.write(`${JSON.stringify({ ok: true, build: expected })}\n`)
}

main().catch((error) => {
  const message = error instanceof Error && /^(?:usage:.*|invalid build identity|invalid packaged artifact digest|invalid runtime payload manifest|invalid control discovery|invalid timeout|control API \/v1\/(?:ping|status) returned \d{3}|unexpected unpacked main-process payload|installed app\.asar digest mismatch|installed MCP digest mismatch|installed runtime payload mismatch|installed build identity mismatch|live process installation mismatch)$/.test(error.message)
    ? error.message
    : 'verification failed'
  process.stderr.write(`verify-installed-build: ${message}\n`)
  process.exitCode = 1
})
