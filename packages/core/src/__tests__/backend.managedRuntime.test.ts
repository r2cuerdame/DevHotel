import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ManagedRuntimeBootstrap,
  probeManagedRuntimeSupport,
  type ManagedRuntimeCommandRunner
} from '../backend/managedRuntime'

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-managed-runtime-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function probeRunner(payload: object, code = 0): ManagedRuntimeCommandRunner {
  return async () => ({ code, stdout: JSON.stringify(payload), stderr: code === 0 ? '' : 'probe failed' })
}

const artifactBytes = Buffer.from('pinned managed runtime artifact')
const artifactDigest = createHash('sha256').update(artifactBytes).digest('hex')

async function stageArtifact(): Promise<string> {
  const staging = await tempDir()
  await writeFile(path.join(staging, 'runtime.bin'), artifactBytes)
  return staging
}

function release(sha256 = artifactDigest) {
  return {
    runtimeVersion: '0.1.0',
    artifacts: [{ id: 'linux-runtime', file: 'runtime.bin', sha256, sizeBytes: artifactBytes.byteLength }]
  }
}
describe('managed runtime support probe', () => {
  it('rejects non-Windows hosts', async () => {
    const result = await probeManagedRuntimeSupport({ platform: 'linux' })
    expect(result).toMatchObject({ supported: false, code: 'unsupported-platform' })
  })

  it('accepts an active Windows hypervisor', async () => {
    const result = await probeManagedRuntimeSupport({
      platform: 'win32',
      runner: probeRunner({
        HypervisorPresent: true,
        VirtualizationFirmwareEnabled: false,
        SecondLevelAddressTranslationExtensions: false,
        HyperVPowerShellAvailable: true
      })
    })
    expect(result).toMatchObject({ supported: true, code: 'ready', hypervisorPresent: true })
  })

  it('does not report the selected Hyper-V provider ready when its management tooling is absent', async () => {
    const result = await probeManagedRuntimeSupport({
      platform: 'win32',
      runner: probeRunner({
        HypervisorPresent: true,
        VirtualizationFirmwareEnabled: true,
        SecondLevelAddressTranslationExtensions: true,
        HyperVPowerShellAvailable: false
      })
    })
    expect(result).toMatchObject({ supported: true, code: 'virtualization-ready', hyperVPowerShellAvailable: false })
  })

  it('recognizes hardware that can be provisioned', async () => {
    const result = await probeManagedRuntimeSupport({
      platform: 'win32',
      runner: probeRunner({
        HypervisorPresent: false,
        VirtualizationFirmwareEnabled: true,
        SecondLevelAddressTranslationExtensions: true
      })
    })
    expect(result).toMatchObject({ supported: true, code: 'virtualization-ready' })
  })

  it('fails closed when virtualization is unavailable', async () => {
    const result = await probeManagedRuntimeSupport({
      platform: 'win32',
      runner: probeRunner({
        HypervisorPresent: false,
        VirtualizationFirmwareEnabled: false,
        SecondLevelAddressTranslationExtensions: false
      })
    })
    expect(result).toMatchObject({ supported: false, code: 'virtualization-disabled' })
  })
})

describe('ManagedRuntimeBootstrap ownership', () => {
  it('creates a fenced provisioning manifest and preserves identity', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({
      userData,
      platform: 'win32',
      runner: probeRunner({}),
      runtimeId: () => 'runtime-1',
      installId: 'install-1',
      now: () => new Date('2026-09-15T13:40:00Z')
    })

    const manifest = await bootstrap.beginProvision('0.1.0')
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      owner: 'devhotel',
      backend: 'managed-linux',
      installId: 'install-1',
      runtimeId: 'runtime-1',
      status: 'provisioning',
      phase: 'checking-windows-capabilities'
    })
    expect((await bootstrap.beginProvision('0.1.0')).runtimeId).toBe('runtime-1')
  })

  it('moves only the expected runtime identity to ready or broken', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({ userData, runtimeId: () => 'runtime-2' })
    await bootstrap.beginProvision('0.1.0')

    await expect(bootstrap.markReady('other-runtime')).rejects.toThrow('identity changed')
    await bootstrap.verifyRelease('runtime-2', release(), await stageArtifact())
    await bootstrap.advance('runtime-2', 'starting-private-daemon')
    await bootstrap.advance('runtime-2', 'health-checking')
    expect(await bootstrap.markReady('runtime-2')).toMatchObject({ status: 'ready', failure: undefined })
    expect(await bootstrap.markBroken('runtime-2', 'boot failed')).toMatchObject({ status: 'broken', failure: 'boot failed' })
  })

  it('verifies pinned artifacts and resumes safely after an interrupted verification', async () => {
    const userData = await tempDir()
    const staging = await stageArtifact()
    const first = new ManagedRuntimeBootstrap({
      userData,
      platform: 'win32',
      runner: probeRunner({ HypervisorPresent: true }),
      installId: 'install-resume',
      runtimeId: () => 'runtime-resume'
    })
    await first.beginProvision('0.1.0')

    await expect(first.verifyRelease('runtime-resume', release('0'.repeat(64)), staging)).rejects.toThrow('digest mismatch')
    expect(await first.readManifest()).toMatchObject({ phase: 'verifying-runtime-manifest', artifactDigests: {} })

    const resumed = new ManagedRuntimeBootstrap({
      userData,
      platform: 'win32',
      runner: probeRunner({ HypervisorPresent: true }),
      installId: 'install-resume'
    })
    expect(await resumed.observe()).toMatchObject({ state: 'preparing', phase: 'verifying-runtime-manifest' })
    expect(await resumed.verifyRelease('runtime-resume', release(), staging)).toMatchObject({
      phase: 'provisioning-runtime-provider',
      artifactDigests: { 'linux-runtime': artifactDigest }
    })
  })

  it('rejects staged artifact traversal and out-of-order readiness', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({ userData, runtimeId: () => 'runtime-order' })
    await bootstrap.beginProvision('0.1.0')

    await expect(bootstrap.markReady('runtime-order')).rejects.toThrow('health check has not completed')
    await expect(
      bootstrap.verifyRelease(
        'runtime-order',
        {
          runtimeVersion: '0.1.0',
          artifacts: [{ id: 'linux-runtime', file: '../runtime.bin', sha256: artifactDigest, sizeBytes: artifactBytes.byteLength }]
        },
        await stageArtifact()
      )
    ).rejects.toThrow('escapes its staging root')
  })

  it('rejects a runtime root owned by a different DevHotel installation', async () => {
    const userData = await tempDir()
    const first = new ManagedRuntimeBootstrap({ userData, installId: 'install-original' })
    await first.beginProvision('0.1.0')

    const collision = new ManagedRuntimeBootstrap({ userData, installId: 'install-other' })
    await expect(collision.readManifest()).rejects.toThrow('installation identity changed')
    await expect(collision.beginProvision('0.1.0')).rejects.toThrow('installation identity changed')
  })

  it('rejects a forged ownership manifest', async () => {
    const userData = await tempDir()
    const root = path.join(userData, 'runtime', 'managed-linux')
    const bootstrap = new ManagedRuntimeBootstrap({ userData })
    await bootstrap.beginProvision('0.1.0')
    await writeFile(path.join(root, 'ownership.json'), JSON.stringify({ owner: 'someone-else' }), 'utf8')
    await expect(bootstrap.readManifest()).rejects.toThrow('ownership manifest is invalid')
  })

  it('writes a readable ownership record under the DevHotel runtime root', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({ userData, runtimeId: () => 'runtime-3' })
    await bootstrap.beginProvision('0.1.0')
    const raw = await readFile(path.join(userData, 'runtime', 'managed-linux', 'ownership.json'), 'utf8')
    expect(raw).toContain('"runtimeId": "runtime-3"')
  })

  it('reports forged ownership as broken without exposing the forged payload', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({
      userData,
      platform: 'win32',
      runner: probeRunner({ HypervisorPresent: true })
    })
    await bootstrap.beginProvision('0.1.0')
    await writeFile(
      path.join(userData, 'runtime', 'managed-linux', 'ownership.json'),
      JSON.stringify({ owner: 'someone-else', failure: 'C:\\private\\secret' }),
      'utf8'
    )

    const observation = await bootstrap.observe()
    expect(observation).toMatchObject({ state: 'broken', phase: 'broken', runtimeId: null, runtimeVersion: null })
    expect(JSON.stringify(observation)).not.toContain('private')
  })
})
