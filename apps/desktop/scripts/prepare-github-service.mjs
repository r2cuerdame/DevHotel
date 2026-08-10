/* global process, AbortController, setTimeout, fetch, TransformStream, clearTimeout, URL */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const version = '2.97.0'
const name = `gh_${version}_windows_amd64.zip`
const expectedSize = 14_938_517
const expectedSha256 = '35d7fe05c4dd1411ffda1e73dfc7c6f44b75c936ca51fa6595c657fdc0350cec'
const allowedHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const here = dirname(fileURLToPath(import.meta.url))
const output = resolve(here, '..', 'resources', 'github', name)
const temp = `${output}.download`

mkdirSync(dirname(output), { recursive: true })
if (existsSync(output)) {
  const body = readFileSync(output)
  if (body.length === expectedSize && createHash('sha256').update(body).digest('hex') === expectedSha256) process.exit(0)
  rmSync(output)
}
rmSync(temp, { force: true })

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 90_000)
try {
  let url = new URL(`https://github.com/cli/cli/releases/download/v${version}/${name}`)
  let response
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error('download redirect left the pinned GitHub host allowlist')
    response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'DevHotel-build', Accept: 'application/octet-stream' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('download redirect had no location')
      url = new URL(location, url)
      continue
    }
    break
  }
  if (!response) throw new Error('download did not produce a response')
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const normalized = contentLength.trim()
    if (!/^\d+$/.test(normalized)) throw new Error('asset size header is invalid')
    const declared = Number(normalized)
    if (!Number.isSafeInteger(declared) || declared < 0 || declared !== expectedSize) throw new Error('asset size differs from pinned manifest')
  }
  let received = 0
  const stream = new TransformStream({ transform(chunk, ctl) { received += chunk.byteLength; if (received > expectedSize) throw new Error('download too large'); ctl.enqueue(chunk) } })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(stream)), createWriteStream(temp, { flags: 'wx' }))
  const body = readFileSync(temp)
  if (received !== expectedSize || createHash('sha256').update(body).digest('hex') !== expectedSha256) throw new Error('SHA-256 verification failed')
  renameSync(temp, output)
} finally {
  clearTimeout(timer)
  rmSync(temp, { force: true })
}
