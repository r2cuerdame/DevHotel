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
        SecondLevelAddressTranslationExtensions: false
      })
    })
    expect(result).toMatchObject({ supported: true, code: 'ready', hypervisorPresent: true })
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
      now: () => new Date('2026-09-15T13:40:00Z')
    })

    const manifest = await bootstrap.beginProvision('0.1.0')
    expect(manifest).toMatchObject({ owner: 'devhotel', backend: 'managed-linux', runtimeId: 'runtime-1', status: 'provisioning' })
    expect((await bootstrap.beginProvision('0.1.0')).runtimeId).toBe('runtime-1')
  })

  it('moves only the expected runtime identity to ready or broken', async () => {
    const userData = await tempDir()
    const bootstrap = new ManagedRuntimeBootstrap({ userData, runtimeId: () => 'runtime-2' })
    await bootstrap.beginProvision('0.1.0')

    await expect(bootstrap.markReady('other-runtime')).rejects.toThrow('identity changed')
    expect(await bootstrap.markReady('runtime-2')).toMatchObject({ status: 'ready', failure: undefined })
    expect(await bootstrap.markBroken('runtime-2', 'boot failed')).toMatchObject({ status: 'broken', failure: 'boot failed' })
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
})
