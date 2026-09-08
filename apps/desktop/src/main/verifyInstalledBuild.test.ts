import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const BUILD = {
  version: '0.5.2',
  commit: 'b'.repeat(40),
  buildTime: '2026-09-08T01:02:03.004Z',
  sourceVerified: true
}
const APP_ASAR = Buffer.from('packaged-app-asar')
const APP_ASAR_SHA256 = createHash('sha256').update(APP_ASAR).digest('hex')
const MCP = Buffer.from('packaged-mcp-entry')
const MCP_SHA256 = createHash('sha256').update(MCP).digest('hex')
const EXECUTABLE_NAME = process.platform === 'win32' ? 'DevHotel.exe' : 'devhotel'
const EXECUTABLE_SHA256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const RUNTIME_PAYLOADS = [
  { path: EXECUTABLE_NAME, sha256: EXECUTABLE_SHA256 },
  { path: 'resources/app.asar', sha256: APP_ASAR_SHA256 },
  { path: 'resources/mcp/index.js', sha256: MCP_SHA256 }
]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function verify(liveBuild = BUILD, appAsar = APP_ASAR, hang = false, mcp = MCP, unpackedMain = false, foreignResources = false, extraRuntime = false, runtimePayloads = RUNTIME_PAYLOADS) {
  const root = mkdtempSync(join(tmpdir(), 'devhotel-installed-build-private-'))
  roots.push(root)
  const expectedFile = join(root, 'expected.json')
  const controlFile = join(root, 'control.json')
  const installDir = join(root, 'install')
  const resourcesDir = join(installDir, 'resources')
  const suppliedResources = foreignResources ? join(root, 'other-install', 'resources') : resourcesDir
  const appAsarFile = join(suppliedResources, 'app.asar')
  const mcpFile = join(suppliedResources, 'mcp', 'index.js')
  const executable = join(installDir, EXECUTABLE_NAME)
  const serverFile = join(root, 'server.cjs')
  mkdirSync(join(resourcesDir, 'mcp'), { recursive: true })
  mkdirSync(join(suppliedResources, 'mcp'), { recursive: true })
  try {
    linkSync(process.execPath, executable)
  } catch {
    copyFileSync(process.execPath, executable)
  }
  chmodSync(executable, 0o755)
  writeFileSync(expectedFile, JSON.stringify({
    ...BUILD,
    appAsarSha256: APP_ASAR_SHA256,
    mcpSha256: MCP_SHA256,
    runtimePayloads
  }))
  writeFileSync(join(resourcesDir, 'app.asar'), APP_ASAR)
  writeFileSync(join(resourcesDir, 'mcp', 'index.js'), MCP)
  writeFileSync(appAsarFile, appAsar)
  writeFileSync(mcpFile, mcp)
  if (extraRuntime) writeFileSync(join(installDir, 'injected.dll'), 'unexpected native payload')
  if (unpackedMain) {
    const chunks = join(suppliedResources, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunks, { recursive: true })
    writeFileSync(join(chunks, 'executable.js'), 'modified executable payload\n')
  }

  const token = 'sensitive-control-token'
  writeFileSync(serverFile, `
const { createServer } = require('node:http')
const build = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const hang = process.argv[3] === 'hang'
const token = ${JSON.stringify(token)}
const server = createServer((req, res) => {
  if (req.headers.authorization !== \`Bearer \${token}\`) return res.writeHead(401).end()
  if (hang) return
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url === '/v1/status' ? { ...build, update: { state: 'idle', targetVersion: null } } : build))
})
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'))
`)
  const server = spawn(executable, [serverFile, Buffer.from(JSON.stringify(liveBuild)).toString('base64url'), hang ? 'hang' : 'reply'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let stdout = ''
    const timer = setTimeout(() => rejectPort(new Error('test server startup timeout')), 10_000)
    server.once('error', rejectPort)
    server.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const value = Number(stdout.trim())
      if (Number.isInteger(value) && value > 0) {
        clearTimeout(timer)
        resolvePort(value)
      }
    })
  })
  writeFileSync(controlFile, JSON.stringify({ ...BUILD, port, token, pid: server.pid }))
  try {
    return await execFileAsync(process.execPath, [
      resolve(import.meta.dirname, '../../scripts/verify-installed-build.mjs'),
      '--expected', expectedFile,
      '--control', controlFile,
      '--app-asar', appAsarFile,
      '--mcp', mcpFile,
      '--timeout-ms', hang ? '100' : '10000'
    ])
  } finally {
    if (server.exitCode === null) {
      server.kill()
      await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()))
    }
  }
}

describe('installed build verifier', { timeout: 20_000 }, () => {
  it('accepts matching expected, discovery, ping, and status identities', async () => {
    const result = await verify()
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, build: BUILD })
  })

  it('fails closed without printing the bearer token or local paths', async () => {
    try {
      await verify({ ...BUILD, commit: 'c'.repeat(40) })
      throw new Error('verifier unexpectedly passed')
    } catch (error) {
      const output = String((error as { stderr?: string }).stderr ?? '')
      expect(output).toContain('installed build identity mismatch')
      expect(output).not.toContain('sensitive-control-token')
      expect(output).not.toContain('devhotel-installed-build-private')
    }
  })

  it('rejects a patched installed app.asar', async () => {
    try {
      await verify(BUILD, Buffer.from('patched-app-asar'))
      throw new Error('verifier unexpectedly passed')
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? '')).toContain('installed app.asar digest mismatch')
    }
  })

  it('rejects identity emitted from an unverifiable source tree', async () => {
    await expect(verify({ ...BUILD, sourceVerified: false })).rejects.toMatchObject({
      stderr: expect.stringContaining('invalid build identity')
    })
  })

  it('rejects a patched installed MCP entry', async () => {
    await expect(verify(BUILD, APP_ASAR, false, Buffer.from('patched-mcp-entry'))).rejects.toMatchObject({
      stderr: expect.stringContaining('installed MCP digest mismatch')
    })
  })

  it('rejects an unpacked main-process executable payload', async () => {
    await expect(verify(BUILD, APP_ASAR, false, MCP, true)).rejects.toMatchObject({
      stderr: expect.stringContaining('unexpected unpacked main-process payload')
    })
  })

  it('rejects matching resources from a different installation than the live process', async () => {
    await expect(verify(BUILD, APP_ASAR, false, MCP, false, true)).rejects.toMatchObject({
      stderr: expect.stringContaining('live process installation mismatch')
    })
  })

  it('rejects an unmanifested native runtime payload', async () => {
    await expect(verify(BUILD, APP_ASAR, false, MCP, false, false, true)).rejects.toMatchObject({
      stderr: expect.stringContaining('installed runtime payload mismatch')
    })
  })

  it('rejects a live executable digest that does not match the release manifest', async () => {
    const mismatched = RUNTIME_PAYLOADS.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry)
    await expect(verify(BUILD, APP_ASAR, false, MCP, false, false, false, mismatched)).rejects.toMatchObject({
      stderr: expect.stringContaining('installed runtime payload mismatch')
    })
  })

  it('bounds live identity requests', async () => {
    const started = Date.now()
    await expect(verify(BUILD, APP_ASAR, true)).rejects.toBeDefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
