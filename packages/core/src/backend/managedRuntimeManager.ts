import path from 'node:path'
import {
  ManagedHyperVRuntime,
  NamedPipeHyperVGuestTransport,
  type ManagedHyperVRuntimeObservation
} from './managedHyperVRuntime'
import {
  ManagedRuntimeBootstrap,
  type ManagedRuntimeCommandRunner,
  type ManagedRuntimeManifest,
  type ManagedRuntimeObservation
} from './managedRuntime'
import {
  downloadManagedRuntimeArtifact,
  type ManagedRuntimeDownloadedArtifact,
  type ManagedRuntimeFetch,
  type ManagedRuntimeRemoteArtifact
} from './managedRuntimeArtifact'

export const MANAGED_HYPERV_RUNTIME_VERSION = '0.1.0'

/**
 * Official Alpine UEFI image used as the immutable Linux substrate. DevHotel
 * adds its per-install identity and private serial daemon through a CIDATA
 * seed disk; the upstream bytes remain independently reproducible.
 */
export const MANAGED_HYPERV_BASE_IMAGE: ManagedRuntimeRemoteArtifact = {
  id: 'alpine-3.22.5-hyperv-base',
  url: 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/cloud/aws_alpine-3.22.5-x86_64-uefi-tiny-r0.vhd',
  sha256: '9f042de9c7ab3c99093cbfaa46946b0c73138035f0fba382bbf5a3794dc67c83',
  sha512:
    'ba667c2b2d6a67183efe08fc1ce007bb6a0dcdbaffe673a72a9e0ce09abb0ab431fa2817733bb083db74774893bf04787724e6e6f97baf6a42dc2aea2b572b43',
  sizeBytes: 148_898_304,
  extension: '.vhd'
}

type DownloadArtifact = (opts: {
  artifact: ManagedRuntimeRemoteArtifact
  destinationRoot: string
  allowedHosts: ReadonlySet<string>
  fetch?: ManagedRuntimeFetch
}) => Promise<ManagedRuntimeDownloadedArtifact>

export interface ManagedRuntimeBootstrapController {
  support(): ReturnType<ManagedRuntimeBootstrap['support']>
  observe(): ReturnType<ManagedRuntimeBootstrap['observe']>
  readManifest(): ReturnType<ManagedRuntimeBootstrap['readManifest']>
  beginProvision(runtimeVersion: string): ReturnType<ManagedRuntimeBootstrap['beginProvision']>
  verifyRelease(...args: Parameters<ManagedRuntimeBootstrap['verifyRelease']>): ReturnType<ManagedRuntimeBootstrap['verifyRelease']>
  advance(...args: Parameters<ManagedRuntimeBootstrap['advance']>): ReturnType<ManagedRuntimeBootstrap['advance']>
  markReady(runtimeId: string): ReturnType<ManagedRuntimeBootstrap['markReady']>
  markBroken(runtimeId: string, failure: string): ReturnType<ManagedRuntimeBootstrap['markBroken']>
}

export interface ManagedRuntimeProviderController {
  observe(): ReturnType<ManagedHyperVRuntime['observe']>
  provision(...args: Parameters<ManagedHyperVRuntime['provision']>): ReturnType<ManagedHyperVRuntime['provision']>
  repair(...args: Parameters<ManagedHyperVRuntime['repair']>): ReturnType<ManagedHyperVRuntime['repair']>
  stop(): ReturnType<ManagedHyperVRuntime['stop']>
}

export interface ManagedRuntimeManagerOptions {
  userData: string
  installId: string
  platform?: NodeJS.Platform
  runner?: ManagedRuntimeCommandRunner
  fetch?: ManagedRuntimeFetch
  bootstrap?: ManagedRuntimeBootstrapController
  downloadArtifact?: DownloadArtifact
  providerFactory?: (manifest: ManagedRuntimeManifest) => ManagedRuntimeProviderController
}

/** Coordinates resumable bootstrap state with the concrete Hyper-V provider. */
export class ManagedRuntimeManager {
  private readonly userData: string
  private readonly bootstrap: ManagedRuntimeBootstrapController
  private readonly fetch?: ManagedRuntimeFetch
  private readonly downloadArtifact: DownloadArtifact
  private readonly providerFactory: (manifest: ManagedRuntimeManifest) => ManagedRuntimeProviderController
  private preparation: Promise<ManagedRuntimeObservation> | null = null

  constructor(opts: ManagedRuntimeManagerOptions) {
    this.userData = path.resolve(opts.userData)
    this.bootstrap =
      opts.bootstrap ??
      new ManagedRuntimeBootstrap({
        userData: this.userData,
        installId: opts.installId,
        platform: opts.platform,
        runner: opts.runner
      })
    this.fetch = opts.fetch
    this.downloadArtifact = opts.downloadArtifact ?? downloadManagedRuntimeArtifact
    this.providerFactory =
      opts.providerFactory ??
      ((manifest) =>
        new ManagedHyperVRuntime({
          userData: this.userData,
          installId: manifest.installId,
          runtimeId: manifest.runtimeId,
          runtimeVersion: manifest.runtimeVersion,
          runner: opts.runner,
          guest: new NamedPipeHyperVGuestTransport()
        }))
  }

  async prepare(): Promise<ManagedRuntimeObservation> {
    if (this.preparation) return await this.preparation
    this.preparation = this.prepareOnce().finally(() => {
      this.preparation = null
    })
    return await this.preparation
  }

  async observe(): Promise<ManagedRuntimeObservation> {
    const bootstrap = await this.bootstrap.observe()
    if (bootstrap.state !== 'ready') return bootstrap
    try {
      const manifest = await this.bootstrap.readManifest()
      if (!manifest) return bootstrap
      const provider = await this.providerFactory(manifest).observe()
      if (
        provider.state === 'ready' &&
        provider.runtimeId === manifest.runtimeId &&
        provider.runtimeVersion === manifest.runtimeVersion &&
        provider.baseImageDigest === MANAGED_HYPERV_BASE_IMAGE.sha256
      ) {
        return bootstrap
      }
      return {
        ...bootstrap,
        state: provider.state === 'stopped' || provider.state === 'preparing' ? 'preparing' : 'broken',
        phase: provider.state === 'stopped' || provider.state === 'preparing' ? 'starting-private-daemon' : 'broken',
        detail:
          provider.state === 'stopped' || provider.state === 'preparing'
            ? 'The DevHotel-managed runtime is starting.'
            : 'The DevHotel-managed runtime needs repair.'
      }
    } catch {
      return {
        ...bootstrap,
        state: 'broken',
        phase: 'broken',
        detail: 'The DevHotel-managed runtime ownership or health proof is invalid.',
        runtimeId: null,
        runtimeVersion: null,
        artifactDigests: {}
      }
    }
  }

  async stop(): Promise<void> {
    const manifest = await this.bootstrap.readManifest()
    if (!manifest) return
    const provider = this.providerFactory(manifest)
    const observation = await provider.observe()
    if (observation.state === 'not-installed' || observation.state === 'broken') return
    await provider.stop()
  }

  private async prepareOnce(): Promise<ManagedRuntimeObservation> {
    const support = await this.bootstrap.support()
    if (support.code !== 'ready') return await this.bootstrap.observe()

    let manifest = await this.bootstrap.beginProvision(MANAGED_HYPERV_RUNTIME_VERSION)
    try {
      const downloaded = await this.downloadArtifact({
        artifact: MANAGED_HYPERV_BASE_IMAGE,
        destinationRoot: path.join(this.userData, 'runtime', 'downloads'),
        allowedHosts: new Set(['dl-cdn.alpinelinux.org']),
        fetch: this.fetch
      })

      if (manifest.phase === 'checking-windows-capabilities' || manifest.phase === 'verifying-runtime-manifest') {
        manifest = await this.bootstrap.verifyRelease(
          manifest.runtimeId,
          {
            runtimeVersion: manifest.runtimeVersion,
            artifacts: [
              {
                id: downloaded.id,
                file: path.basename(downloaded.file),
                sha256: downloaded.sha256,
                sizeBytes: downloaded.sizeBytes
              }
            ]
          },
          path.dirname(downloaded.file)
        )
      }

      const provider = this.providerFactory(manifest)
      const image = { file: downloaded.file, sha256: downloaded.sha256, sizeBytes: downloaded.sizeBytes }
      if (manifest.phase === 'provisioning-runtime-provider') {
        await provider.provision(image)
        manifest = await this.bootstrap.advance(manifest.runtimeId, 'starting-private-daemon')
      }
      if (manifest.phase === 'starting-private-daemon') {
        await provider.repair(image)
        manifest = await this.bootstrap.advance(manifest.runtimeId, 'health-checking')
      }
      if (manifest.phase === 'health-checking') {
        this.assertReady(await provider.observe(), manifest)
        await this.bootstrap.markReady(manifest.runtimeId)
      } else if (manifest.phase === 'ready') {
        this.assertReady(await provider.repair(image), manifest)
      }
      return await this.observe()
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      await this.bootstrap.markBroken(manifest.runtimeId, failure).catch(() => undefined)
      throw error
    }
  }

  private assertReady(observation: ManagedHyperVRuntimeObservation, manifest: ManagedRuntimeManifest): void {
    if (
      observation.state !== 'ready' ||
      observation.runtimeId !== manifest.runtimeId ||
      observation.runtimeVersion !== manifest.runtimeVersion ||
      observation.baseImageDigest !== MANAGED_HYPERV_BASE_IMAGE.sha256
    ) {
      throw new Error('Managed Hyper-V runtime did not produce an exact healthy identity proof')
    }
  }
}
