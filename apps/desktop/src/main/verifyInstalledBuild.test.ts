import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function verify(liveBuild = BUILD, appAsar = APP_ASAR, hang = false, mcp = MCP) {
  const root = mkdtempSync(join(tmpdir(), 'devhotel-installed-build-private-'))
  roots.push(root)
  const expectedFile = join(root, 'expected.json')
  const controlFile = join(root, 'control.json')
  const appAsarFile = join(root, 'app.asar')
  const mcpFile = join(root, 'mcp-index.js')
  writeFileSync(expectedFile, JSON.stringify({ ...BUILD, appAsarSha256: APP_ASAR_SHA256, mcpSha256: MCP_SHA256 }))
  writeFileSync(appAsarFile, appAsar)
  writeFileSync(mcpFile, mcp)

  const token = 'sensitive-control-token'
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (hang) return
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/v1/status' ? { ...liveBuild, update: { state: 'idle', targetVersion: null } } : liveBuild))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as { port: number }).port
  writeFileSync(controlFile, JSON.stringify({ ...BUILD, port, token, pid: process.pid }))
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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

describe('installed build verifier', () => {
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

  it('bounds live identity requests', async () => {
    const started = Date.now()
    await expect(verify(BUILD, APP_ASAR, true)).rejects.toBeDefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
