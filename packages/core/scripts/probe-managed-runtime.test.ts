import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  MANAGED_HYPERV_BASE_IMAGE,
  downloadManagedRuntimeArtifact,
  probeManagedRuntimeSupport
} from '../src/index'

it('records the local managed-runtime capability and optional pinned-artifact evidence', async () => {
  const support = await probeManagedRuntimeSupport()
  const result: Record<string, unknown> = { support }
  expect(support.code).toBeTruthy()

  if (process.env['DEVHOTEL_RUNTIME_PROBE_DOWNLOAD'] === '1') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'devhotel-managed-runtime-probe-'))
    try {
      const artifact = await downloadManagedRuntimeArtifact({
        artifact: MANAGED_HYPERV_BASE_IMAGE,
        destinationRoot: root,
        allowedHosts: new Set(['dl-cdn.alpinelinux.org'])
      })
      result['artifact'] = {
        id: artifact.id,
        sha256: artifact.sha256,
        sha512: artifact.sha512,
        sizeBytes: artifact.sizeBytes
      }
      expect(result['artifact']).toMatchObject({
        sha256: MANAGED_HYPERV_BASE_IMAGE.sha256,
        sha512: MANAGED_HYPERV_BASE_IMAGE.sha512,
        sizeBytes: MANAGED_HYPERV_BASE_IMAGE.sizeBytes
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  process.stdout.write(`MANAGED_RUNTIME_PROBE ${JSON.stringify(result)}\n`)
}, 180_000)
