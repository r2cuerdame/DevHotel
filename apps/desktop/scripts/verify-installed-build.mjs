#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

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
  if (!/^[a-f0-9]{64}$/.test(expectedRaw.appAsarSha256)) throw new Error('invalid packaged artifact digest')
  if (!/^[a-f0-9]{64}$/.test(expectedRaw.mcpSha256)) throw new Error('invalid packaged artifact digest')
  if (await sha256(appAsar) !== expectedRaw.appAsarSha256) throw new Error('installed app.asar digest mismatch')
  if (await sha256(mcpFile) !== expectedRaw.mcpSha256) throw new Error('installed MCP digest mismatch')
  const discoveryRaw = JSON.parse(await readFile(controlFile, 'utf8'))
  const discovery = identity(discoveryRaw)
  if (!Number.isInteger(discoveryRaw.port) || discoveryRaw.port < 1 || typeof discoveryRaw.token !== 'string') {
    throw new Error('invalid control discovery')
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

  process.stdout.write(`${JSON.stringify({ ok: true, build: expected })}\n`)
}

main().catch((error) => {
  const message = error instanceof Error && /^(?:usage:.*|invalid build identity|invalid packaged artifact digest|invalid control discovery|invalid timeout|control API \/v1\/(?:ping|status) returned \d{3}|installed app\.asar digest mismatch|installed MCP digest mismatch|installed build identity mismatch)$/.test(error.message)
    ? error.message
    : 'verification failed'
  process.stderr.write(`verify-installed-build: ${message}\n`)
  process.exitCode = 1
})
