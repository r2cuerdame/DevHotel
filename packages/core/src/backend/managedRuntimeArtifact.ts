import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, type statfs } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { assertManagedRuntimeDiskSpace } from './managedRuntimeDiskSpace'

export interface ManagedRuntimeRemoteArtifact {
  id: string
  url: string
  sha256: string
  sha512: string
  sizeBytes: number
  /** Only the formats DevHotel knows how to own are downloadable. */
  extension: '.iso' | '.vhd' | '.zip'
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

/**
 * How many times a *transport* failure is retried, and how long the first wait
 * is before it doubles.
 *
 * The pinned runtime artifact is ~150 MB fetched once on a Host that has just
 * been rebooted into a freshly enabled hypervisor, often over whatever network
 * the machine reconnects to first. A connection that drops at 90% is the
 * expected failure, not an exotic one, and restarting it from zero is what
 * makes a provision feel like it "just never works".
 *
 * Only transport failures are retried. A digest mismatch, a size overrun or a
 * manifest disagreement is an integrity failure: retrying it four times cannot
 * make it true, and doing so would hide a bad pin behind a slow error.
 */
const MAX_TRANSFER_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 500

/** HTTP statuses that mean "ask again", as opposed to "this will not work". */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/** A failure that resuming may fix. Anything else aborts the download outright. */
class TransientDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransientDownloadError'
  }
}

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
  if (artifact.extension !== '.iso' && artifact.extension !== '.vhd' && artifact.extension !== '.zip') {
    throw new Error('Managed runtime download format is invalid')
  }
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
  fetcher: ManagedRuntimeFetch,
  headers?: Record<string, string>
): Promise<Response> {
  let requested = initialUrl
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(requested.toString(), {
      method: 'GET',
      redirect: 'manual',
      ...(headers ? { headers } : {})
    })
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

export interface ManagedRuntimeDownloadOptions {
  artifact: ManagedRuntimeRemoteArtifact
  destinationRoot: string
  allowedHosts: ReadonlySet<string>
  fetch?: ManagedRuntimeFetch
  /** Transport attempts before the download gives up. Defaults to {@link MAX_TRANSFER_ATTEMPTS}. */
  attempts?: number
  /** Test seam for the backoff between attempts. */
  delay?: (milliseconds: number) => Promise<void>
  /** Bytes to leave free on the volume beyond the artifact itself. */
  headroomBytes?: number
  /** Test seam for the free-space probe. */
  statfs?: typeof statfs
}

/**
 * Downloads one immutable runtime artifact into the DevHotel data root.
 *
 * The transfer is resumable: a dropped connection keeps the bytes it already
 * has and asks for the rest with a `Range` request, because re-fetching 150 MB
 * from zero on every hiccup is the difference between a provision that
 * eventually succeeds and one the user gives up on. The running digests are
 * updated only after each write lands, so what has been hashed and what is on
 * disk never disagree — which is what makes resuming safe rather than merely
 * fast.
 *
 * A server that ignores `Range` and answers `200` is handled by starting over,
 * not by appending a second copy of the file onto the first.
 */
export async function downloadManagedRuntimeArtifact(
  opts: ManagedRuntimeDownloadOptions
): Promise<ManagedRuntimeDownloadedArtifact> {
  const requested = validateArtifact(opts.artifact, opts.allowedHosts)
  await mkdir(opts.destinationRoot, { recursive: true })
  const rootInfo = await lstat(opts.destinationRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Managed runtime download root is unsafe')
  const root = await realpath(opts.destinationRoot)
  const target = path.join(root, `${opts.artifact.id}-${opts.artifact.sha256}${opts.artifact.extension}`)
  if (existsSync(target)) return await verifyFile(target, opts.artifact)

  // Asked before a single byte is written, so a full volume is reported as a
  // full volume rather than as a corrupt artifact.
  await assertManagedRuntimeDiskSpace({
    path: root,
    bytes: opts.artifact.sizeBytes,
    headroomBytes: opts.headroomBytes,
    statfs: opts.statfs
  })

  const fetcher = opts.fetch ?? fetch
  const attempts = Math.max(1, opts.attempts ?? MAX_TRANSFER_ATTEMPTS)
  const delay = opts.delay ?? ((milliseconds: number) => sleep(milliseconds))

  const temporary = path.join(root, `.${opts.artifact.id}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx')
  const progress = { written: 0 }
  let sha256 = createHash('sha256')
  let sha512 = createHash('sha512')
  let restart = false

  /** Throws away the partial bytes and the digests that describe them, together. */
  const startOver = async (): Promise<void> => {
    await handle.truncate(0)
    progress.written = 0
    sha256 = createHash('sha256')
    sha512 = createHash('sha512')
  }

  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (restart) {
          await startOver()
          restart = false
        }

        const resumeFrom = progress.written
        const { response, body } = await requestArtifactBody(requested, opts.allowedHosts, fetcher, resumeFrom)

        if (resumeFrom > 0 && response.status !== 206) {
          // The origin would not resume. Its `200` body is the whole artifact,
          // so the partial bytes are discarded rather than appended to.
          await startOver()
        } else if (response.status === 206) {
          assertContentRange(response, progress.written, opts.artifact.sizeBytes)
        }

        assertDeclaredLength(response, opts.artifact.sizeBytes - progress.written)
        await drainInto(body, handle, progress, opts.artifact.sizeBytes, sha256, sha512)

        if (progress.written < opts.artifact.sizeBytes) {
          throw new TransientDownloadError(
            `Managed runtime download ended after ${progress.written} of ${opts.artifact.sizeBytes} bytes`
          )
        }
        break
      } catch (error) {
        if (error instanceof RestartDownloadError) {
          restart = true
          if (attempt >= attempts) throw new Error(error.message)
        } else if (!(error instanceof TransientDownloadError) || attempt >= attempts) {
          throw error
        }
        await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
      }
    }

    await handle.sync()
    await handle.close()
    if (sha256.digest('hex') !== opts.artifact.sha256 || sha512.digest('hex') !== opts.artifact.sha512) {
      throw new Error('Managed runtime download failed digest verification')
    }
    await rename(temporary, target)
    return await verifyFile(target, opts.artifact)
  } finally {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}

/** A transient failure whose only safe recovery is to discard the partial bytes. */
class RestartDownloadError extends TransientDownloadError {}

async function requestArtifactBody(
  url: URL,
  allowedHosts: ReadonlySet<string>,
  fetcher: ManagedRuntimeFetch,
  resumeFrom: number
): Promise<{ response: Response; body: NonNullable<Response['body']> }> {
  let response: Response
  try {
    response = await fetchAllowlisted(
      url,
      allowedHosts,
      fetcher,
      resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : undefined
    )
  } catch (error) {
    // An allowlist or redirect refusal is a decision, not a hiccup; only the
    // transport underneath it is worth asking again.
    if (error instanceof Error && /untrusted origin|redirect|not allowed/i.test(error.message)) throw error
    throw new TransientDownloadError('Managed runtime download could not reach its origin', { cause: error })
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    const message = `Managed runtime download failed with HTTP ${response.status}`
    if (RETRYABLE_STATUSES.has(response.status)) throw new TransientDownloadError(message)
    // A range the origin will not serve is not fatal to the artifact, only to
    // this attempt's assumption that it could be resumed.
    if (response.status === 416 && resumeFrom > 0) throw new RestartDownloadError(message)
    throw new Error(message)
  }
  return { response, body: response.body }
}

/** `Content-Range: bytes <first>-<last>/<total>`, checked against what was asked for. */
function assertContentRange(response: Response, resumeFrom: number, sizeBytes: number): void {
  const header = response.headers.get('content-range')
  const match = header ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim()) : null
  if (!match || Number(match[1]) !== resumeFrom || Number(match[3]) !== sizeBytes) {
    throw new RestartDownloadError('Managed runtime download returned a Content-Range it was not asked for')
  }
}

function assertDeclaredLength(response: Response, expected: number): void {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) !== expected) {
    throw new Error('Managed runtime download Content-Length does not match its manifest')
  }
}

/**
 * Streams one response body onto the end of the partial file.
 *
 * Each chunk is written before it is hashed, so an interrupted transfer leaves
 * the digests describing exactly the bytes that reached the disk and the next
 * attempt can pick up from `received` without re-reading anything.
 */
async function drainInto(
  body: NonNullable<Response['body']>,
  handle: Awaited<ReturnType<typeof open>>,
  /**
   * Carried rather than returned: an interrupted transfer still made progress,
   * and a `return` value is exactly the thing a `throw` discards. Losing the
   * count here would silently turn every resume back into a restart.
   */
  progress: { written: number },
  sizeBytes: number,
  sha256: ReturnType<typeof createHash>,
  sha512: ReturnType<typeof createHash>
): Promise<void> {
  const reader = body.getReader()
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await reader.read()
    } catch (error) {
      throw new TransientDownloadError('Managed runtime download was interrupted', { cause: error })
    }
    if (chunk.done) return
    const value = chunk.value
    if (progress.written + value.byteLength > sizeBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Managed runtime download exceeded its manifest size')
    }
    await handle.write(value, 0, value.byteLength, progress.written)
    sha256.update(value)
    sha512.update(value)
    progress.written += value.byteLength
  }
}
