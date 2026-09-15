import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
    expect(path.dirname(result.file)).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(destinationRoot)))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('reuses only an existing file whose full evidence still matches', async () => {
    const destinationRoot = await tempDir()
    const expected = artifact()
    const target = path.join(destinationRoot, `${expected.id}-${expected.sha256}.vhd`)
    await writeFile(target, bytes)
    const fetcher = vi.fn()

    await expect(
      downloadManagedRuntimeArtifact({ artifact: expected, destinationRoot, allowedHosts, fetch: fetcher })
    ).resolves.toMatchObject({ file: target })
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
})
