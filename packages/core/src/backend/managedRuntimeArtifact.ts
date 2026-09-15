import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export interface ManagedRuntimeRemoteArtifact {
  id: string
  url: string
  sha256: string
  sha512: string
  sizeBytes: number
  extension: '.vhd'
}

export interface ManagedRuntimeDownloadedArtifact {
  id: string
  file: string
  sha256: string
  sha512: string
  sizeBytes: number
}

export type ManagedRuntimeFetch = (url: string, init: RequestInit) => Promise<Response>

const MAX_REDIRECTS = 5

function validateArtifact(artifact: ManagedRuntimeRemoteArtifact, allowedHosts: ReadonlySet<string>): URL {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(artifact.id)) throw new Error('Managed runtime download identity is invalid')
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{128}$/.test(artifact.sha512)) {
    throw new Error('Managed runtime download digests are invalid')
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) {
    throw new Error('Managed runtime download size is invalid')
  }
  const url = new URL(artifact.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) {
    throw new Error('Managed runtime download origin is not allowed')
  }
  if (artifact.extension !== '.vhd') throw new Error('Managed runtime download format is invalid')
  return url
}

function assertAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>, message: string): void {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) {
    throw new Error(message)
  }
}

async function fetchAllowlisted(
  initialUrl: URL,
  allowedHosts: ReadonlySet<string>,
  fetcher: ManagedRuntimeFetch
): Promise<Response> {
  let requested = initialUrl
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(requested.toString(), { method: 'GET', redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) {
      const finalUrl = new URL(response.url || requested.toString())
      assertAllowedUrl(finalUrl, allowedHosts, 'Managed runtime download returned an untrusted origin')
      return response
    }

    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new Error('Managed runtime download redirect is missing a location')
    const next = new URL(location, requested)
    assertAllowedUrl(next, allowedHosts, 'Managed runtime download redirected to an untrusted origin')
    requested = next
  }
  throw new Error('Managed runtime download exceeded its redirect limit')
}

async function verifyFile(
  file: string,
  artifact: ManagedRuntimeRemoteArtifact
): Promise<ManagedRuntimeDownloadedArtifact> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed runtime downloaded artifact is unsafe')
  const canonical = await realpath(file)
  const handle = await open(canonical, 'r')
  try {
    const before = await handle.stat()
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sha256.update(chunk)
      sha512.update(chunk)
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Managed runtime downloaded artifact changed during verification')
    }
    const measured256 = sha256.digest('hex')
    const measured512 = sha512.digest('hex')
    if (after.size !== artifact.sizeBytes || measured256 !== artifact.sha256 || measured512 !== artifact.sha512) {
      throw new Error('Managed runtime downloaded artifact failed verification')
    }
    return {
      id: artifact.id,
      file: canonical,
      sha256: measured256,
      sha512: measured512,
      sizeBytes: after.size
    }
  } finally {
    await handle.close()
  }
}

/** Downloads one immutable runtime artifact into the DevHotel data root. */
export async function downloadManagedRuntimeArtifact(opts: {
  artifact: ManagedRuntimeRemoteArtifact
  destinationRoot: string
  allowedHosts: ReadonlySet<string>
  fetch?: ManagedRuntimeFetch
}): Promise<ManagedRuntimeDownloadedArtifact> {
  const requested = validateArtifact(opts.artifact, opts.allowedHosts)
  await mkdir(opts.destinationRoot, { recursive: true })
  const rootInfo = await lstat(opts.destinationRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Managed runtime download root is unsafe')
  const root = await realpath(opts.destinationRoot)
  const target = path.join(root, `${opts.artifact.id}-${opts.artifact.sha256}${opts.artifact.extension}`)
  if (existsSync(target)) return await verifyFile(target, opts.artifact)

  const fetcher = opts.fetch ?? fetch
  const response = await fetchAllowlisted(requested, opts.allowedHosts, fetcher)
  if (!response.ok || !response.body) throw new Error(`Managed runtime download failed with HTTP ${response.status}`)
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) !== opts.artifact.sizeBytes) {
    throw new Error('Managed runtime download Content-Length does not match its manifest')
  }

  const temporary = path.join(root, `.${opts.artifact.id}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx')
  let bytes = 0
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  try {
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > opts.artifact.sizeBytes) throw new Error('Managed runtime download exceeded its manifest size')
        sha256.update(value)
        sha512.update(value)
        await handle.write(value)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (
      bytes !== opts.artifact.sizeBytes ||
      sha256.digest('hex') !== opts.artifact.sha256 ||
      sha512.digest('hex') !== opts.artifact.sha512
    ) {
      throw new Error('Managed runtime download failed digest verification')
    }
    await rename(temporary, target)
    return await verifyFile(target, opts.artifact)
  } finally {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}
