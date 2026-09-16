import { createHash } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadManagedRuntimeArtifact,
  type ManagedRuntimeRemoteArtifact
} from '../backend/managedRuntimeArtifact'

const temps: string[] = []
const bytes = Buffer.from('immutable-runtime-vhd')

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-runtime-download-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function artifact(overrides: Partial<ManagedRuntimeRemoteArtifact> = {}): ManagedRuntimeRemoteArtifact {
  return {
    id: 'alpine-hyperv-base',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.22/runtime.vhd',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    extension: '.vhd',
    ...overrides
  }
}

const allowedHosts = new Set(['dl-cdn.alpinelinux.org'])

describe('downloadManagedRuntimeArtifact', () => {
  it('downloads an allowlisted HTTPS artifact and verifies two digests plus size', async () => {
    const destinationRoot = await tempDir()
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }))

    const result = await downloadManagedRuntimeArtifact({
      artifact: artifact(),
      destinationRoot,
      allowedHosts,
      fetch: fetcher
    })

    expect(result).toMatchObject({
      id: 'alpine-hyperv-base',
      sizeBytes: bytes.byteLength,
      sha256: artifact().sha256,
      sha512: artifact().sha512
    })
    expect(path.dirname(result.file)).toBe(await realpath(destinationRoot))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('downloads a .zip but still refuses a format it cannot own', async () => {
    // `.zip` was added for the pinned Android SDK components (#108). It must
    // widen the allowed set by exactly one entry, not turn the guard off.
    const destinationRoot = await tempDir()
    const fetcher = vi.fn(async () => new Response(bytes))

    const zip = await downloadManagedRuntimeArtifact({
      artifact: artifact({ id: 'android-platform-tools', extension: '.zip' }),
      destinationRoot,
      allowedHosts,
      fetch: fetcher
    })
    expect(path.extname(zip.file)).toBe('.zip')

    for (const extension of ['.exe', '.tar.gz', '.msi', '']) {
      await expect(
        downloadManagedRuntimeArtifact({
          artifact: artifact({ extension: extension as '.iso' }),
          destinationRoot,
          allowedHosts,
          fetch: fetcher
        })
      ).rejects.toThrow(/format is invalid/)
    }
  })

  it('reuses only an existing file whose full evidence still matches', async () => {
    const destinationRoot = await tempDir()
    const expected = artifact()
    const target = path.join(destinationRoot, `${expected.id}-${expected.sha256}.vhd`)
    await writeFile(target, bytes)
    const fetcher = vi.fn()

    await expect(
      downloadManagedRuntimeArtifact({ artifact: expected, destinationRoot, allowedHosts, fetch: fetcher })
    ).resolves.toMatchObject({ file: await realpath(target) })
    expect(fetcher).not.toHaveBeenCalled()

    await writeFile(target, Buffer.from('forged'))
    await expect(
      downloadManagedRuntimeArtifact({ artifact: expected, destinationRoot, allowedHosts, fetch: fetcher })
    ).rejects.toThrow('failed verification')
  })

  it('refuses untrusted origins and redirects before publishing an artifact', async () => {
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact({ url: 'http://dl-cdn.alpinelinux.org/runtime.vhd' }),
        destinationRoot: await tempDir(),
        allowedHosts
      })
    ).rejects.toThrow('origin is not allowed')

    const redirectFetcher = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.invalid/runtime.vhd' } })
    )
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: redirectFetcher
      })
    ).rejects.toThrow('redirected to an untrusted origin')
    expect(redirectFetcher).toHaveBeenCalledOnce()

    const redirected = new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
    Object.defineProperty(redirected, 'url', { value: 'https://example.invalid/runtime.vhd' })
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: async () => redirected
      })
    ).rejects.toThrow('untrusted origin')
  })

  it('removes partial bytes when size or digest verification fails', async () => {
    const destinationRoot = await tempDir()
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact({ sha256: '0'.repeat(64) }),
        destinationRoot,
        allowedHosts,
        fetch: async () => new Response(bytes)
      })
    ).rejects.toThrow('digest verification')

    expect((await readdir(destinationRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact({ sizeBytes: bytes.byteLength - 1 }),
        destinationRoot,
        allowedHosts,
        fetch: async () => new Response(bytes)
      })
    ).rejects.toThrow('exceeded its manifest size')
    expect((await readdir(destinationRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to start when the volume cannot hold the artifact', async () => {
    // Without this the first symptom of a full disk is a truncated file, which
    // the digest check then reports as a corrupt download -- a true statement
    // about the bytes and a useless one about the cause.
    const fetcher = vi.fn()
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: fetcher,
        headroomBytes: 1024,
        statfs: vi.fn(async () => ({ bsize: 512, bavail: 1 })) as never
      })
    ).rejects.toThrow('Not enough disk space')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

/** A body that delivers `upTo` bytes and then drops the connection. */
function interrupted(upTo: number): ReadableStream<Uint8Array> {
  // The bytes have to be *delivered* before the stream faults. Erroring inside
  // `start` discards the queue, which would make every attempt resume from
  // zero and quietly turn this into a test of the non-resuming path.
  let delivered = false
  return new ReadableStream({
    pull(controller) {
      if (delivered) {
        controller.error(new Error('connection reset by peer'))
        return
      }
      delivered = true
      controller.enqueue(new Uint8Array(bytes.subarray(0, upTo)))
    }
  })
}

function rangeHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.range
}

describe('downloadManagedRuntimeArtifact resume', () => {
  const noDelay = async (): Promise<void> => undefined

  it('resumes from the bytes it already has instead of starting over', async () => {
    const destinationRoot = await tempDir()
    const cut = 8
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (rangeHeader(init) === undefined) return new Response(interrupted(cut))
      expect(rangeHeader(init)).toBe(`bytes=${cut}-`)
      return new Response(bytes.subarray(cut), {
        status: 206,
        headers: {
          'content-range': `bytes ${cut}-${bytes.byteLength - 1}/${bytes.byteLength}`,
          'content-length': String(bytes.byteLength - cut)
        }
      })
    })

    const result = await downloadManagedRuntimeArtifact({
      artifact: artifact(),
      destinationRoot,
      allowedHosts,
      fetch: fetcher,
      delay: noDelay
    })

    expect(result).toMatchObject({ sha256: artifact().sha256, sizeBytes: bytes.byteLength })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await readdir(destinationRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('starts over rather than doubling the file when the origin ignores Range', async () => {
    const destinationRoot = await tempDir()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      rangeHeader(init) === undefined ? new Response(interrupted(8)) : new Response(bytes)
    )

    const result = await downloadManagedRuntimeArtifact({
      artifact: artifact(),
      destinationRoot,
      allowedHosts,
      fetch: fetcher,
      delay: noDelay
    })

    expect(result.sizeBytes).toBe(bytes.byteLength)
    expect(result.sha256).toBe(artifact().sha256)
  })

  it('discards partial bytes when the origin rejects the range outright', async () => {
    const destinationRoot = await tempDir()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (rangeHeader(init) === undefined) return new Response(interrupted(8))
      // 416 on the first resume, then a clean whole-body answer.
      return fetcher.mock.calls.length === 2 ? new Response(null, { status: 416 }) : new Response(bytes)
    })

    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot,
        allowedHosts,
        fetch: fetcher,
        delay: noDelay
      })
    ).resolves.toMatchObject({ sha256: artifact().sha256, sizeBytes: bytes.byteLength })
  })

  it('retries a status that means "ask again" and gives up on one that does not', async () => {
    const flaky = vi.fn(async () =>
      flaky.mock.calls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes)
    )
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: flaky,
        delay: noDelay
      })
    ).resolves.toMatchObject({ sizeBytes: bytes.byteLength })
    expect(flaky).toHaveBeenCalledTimes(2)

    const gone = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: gone,
        delay: noDelay
      })
    ).rejects.toThrow('HTTP 404')
    expect(gone).toHaveBeenCalledOnce()
  })

  it('never retries an integrity failure, because a retry cannot make it true', async () => {
    // Retrying a bad pin four times turns a clear answer into a slow one.
    const fetcher = vi.fn(async () => new Response(bytes))
    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact({ sha256: '0'.repeat(64) }),
        destinationRoot: await tempDir(),
        allowedHosts,
        fetch: fetcher,
        delay: noDelay
      })
    ).rejects.toThrow('digest verification')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('gives up after its attempt budget and leaves nothing behind', async () => {
    const destinationRoot = await tempDir()
    const fetcher = vi.fn(async () => new Response(interrupted(4)))

    await expect(
      downloadManagedRuntimeArtifact({
        artifact: artifact(),
        destinationRoot,
        allowedHosts,
        fetch: fetcher,
        attempts: 3,
        delay: noDelay
      })
    ).rejects.toThrow(/interrupted|ended after/)

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await readdir(destinationRoot)).toEqual([])
  })
})
