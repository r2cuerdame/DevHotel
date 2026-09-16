import path from 'node:path'
import {
  ManagedHyperVRuntime,
  NamedPipeHyperVGuestTransport,
  type ManagedHyperVGuestChannel,
  type ManagedHyperVRemovalOutcome,
  type ManagedHyperVRuntimeObservation
} from './managedHyperVRuntime'
import {
  ManagedRuntimeBootstrap,
  type ManagedRuntimeCommandRunner,
  type ManagedRuntimeManifest,
  type ManagedRuntimeObservation,
  type ManagedRuntimeUpdateSummary
} from './managedRuntime'
import {
  ManagedRuntimeWindowsFeatureHarness,
  type ManagedRuntimeFeatureObservation
} from './managedRuntimeWindowsFeature'
import {
  downloadManagedRuntimeArtifact,
  type ManagedRuntimeDownloadedArtifact,
  type ManagedRuntimeFetch,
  type ManagedRuntimeRemoteArtifact
} from './managedRuntimeArtifact'
import {
  MANAGED_RUNTIME_ALLOWED_HOSTS,
  MANAGED_RUNTIME_CURRENT_RELEASE,
  findManagedRuntimeRelease,
  type ManagedRuntimeReleaseDescriptor
} from './managedRuntimeRelease'
import {
  ManagedRuntimeUpdateLedger,
  isTerminalManagedRuntimeUpdateStage,
  type ManagedRuntimeUpdateJournal
} from './managedRuntimeUpdate'

export {
  MANAGED_HYPERV_BOOT_ISO,
  MANAGED_HYPERV_RUNTIME_VERSION,
  MANAGED_RUNTIME_ALLOWED_HOSTS,
  MANAGED_RUNTIME_CURRENT_RELEASE,
  MANAGED_RUNTIME_RELEASES,
  findManagedRuntimeRelease,
  type ManagedRuntimeReleaseDescriptor
} from './managedRuntimeRelease'

/**
 * How many times one version change may be attempted before the install is put
 * back on the runtime that worked.
 *
 * A Host that dies mid-update is not a Host that will succeed on the fourth
 * try, and each attempt costs the user a runtime that is down. Two is enough to
 * absorb a single unlucky crash and short enough that an update which is simply
 * wrong for this Host stops costing anything.
 */
const MAX_UPDATE_ATTEMPTS = 2

/** The verified local copy, in the shape the provider takes. */
function releaseImage(downloaded: ManagedRuntimeDownloadedArtifact): { file: string; sha256: string; sizeBytes: number } {
  return { file: downloaded.file, sha256: downloaded.sha256, sizeBytes: downloaded.sizeBytes }
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
  adoptVersion(...args: Parameters<ManagedRuntimeBootstrap['adoptVersion']>): ReturnType<ManagedRuntimeBootstrap['adoptVersion']>
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
  remove(): ReturnType<ManagedHyperVRuntime['remove']>
  roomChannel?(): ReturnType<ManagedHyperVRuntime['roomChannel']>
  /**
   * Optional so a provider that only ever stands up one version stays valid.
   * A manager whose provider cannot migrate reports the update as impossible
   * rather than pretending a re-provision is the same thing.
   */
  migrateFrom?(...args: Parameters<ManagedHyperVRuntime['migrateFrom']>): ReturnType<ManagedHyperVRuntime['migrateFrom']>
  pruneUnreferencedImages?(): ReturnType<ManagedHyperVRuntime['pruneUnreferencedImages']>
}

/**
 * How much of DevHotel a removal is allowed to take with it.
 *
 * `app-only` is the honest half of uninstall: the application goes, and the
 * runtime, its disks and every Room on them stay exactly where they are, so a
 * reinstall finds the work rather than a clean machine. `complete` is the other
 * promise — that nothing DevHotel created outlives it.
 */
export type ManagedRuntimeRemovalScope = 'app-only' | 'complete'

/**
 * `preserved` is what an `app-only` removal reports: the runtime was stopped
 * with its state intact and deliberately left on the Host.
 */
export type ManagedRuntimeRemovalOutcome = ManagedHyperVRemovalOutcome | 'preserved'

export interface ManagedRuntimeWindowsFeatureController {
  observe(): Promise<ManagedRuntimeFeatureObservation>
  enable(): Promise<ManagedRuntimeFeatureObservation>
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
  windowsFeature?: ManagedRuntimeWindowsFeatureController
}

/** Coordinates resumable bootstrap state with the concrete Hyper-V provider. */
export class ManagedRuntimeManager {
  private readonly userData: string
  private readonly bootstrap: ManagedRuntimeBootstrapController
  private readonly fetch?: ManagedRuntimeFetch
  private readonly downloadArtifact: DownloadArtifact
  private readonly providerFactory: (manifest: ManagedRuntimeManifest) => ManagedRuntimeProviderController
  private readonly windowsFeature: ManagedRuntimeWindowsFeatureController
  private readonly platform: NodeJS.Platform
  private readonly updates: ManagedRuntimeUpdateLedger
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
    this.platform = opts.platform ?? process.platform
    this.windowsFeature =
      opts.windowsFeature ??
      new ManagedRuntimeWindowsFeatureHarness({
        userData: this.userData,
        installId: opts.installId,
        platform: opts.platform,
        runner: opts.runner
      })
    this.fetch = opts.fetch
    // The journal sits beside the ownership manifest on purpose: they answer
    // the same question from two sides — what this install has, and what it was
    // in the middle of changing it to — and a reboot has to find both or
    // neither.
    this.updates = new ManagedRuntimeUpdateLedger({
      root: path.join(this.userData, 'runtime', 'managed-linux'),
      installId: opts.installId
    })
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

  /**
   * Turns on the Windows features the provider needs, through one consented
   * elevation. This is deliberately caller-driven: DevHotel never opens a UAC
   * prompt on its own during launch.
   */
  async enableWindowsFeatures(): Promise<ManagedRuntimeObservation> {
    if (this.platform !== 'win32') return await this.observe()
    await this.windowsFeature.enable()
    // Provisioning downloads and boots a runtime and can take minutes. Start it
    // the same way launch does — without blocking — so the caller gets the gate
    // back immediately instead of a frozen button.
    void this.prepare().catch(() => undefined)
    return await this.observe()
  }

  async observe(): Promise<ManagedRuntimeObservation> {
    const bootstrap = await this.bootstrap.observe()
    const gate = await this.windowsGate()
    const update = await this.updateSummary()
    if (gate && bootstrap.state !== 'ready') {
      return {
        ...bootstrap,
        state: gate.stage === 'unsupported-edition' ? 'unsupported' : bootstrap.state,
        detail: gate.detail,
        update,
        windowsFeature: gate
      }
    }
    if (bootstrap.state !== 'ready') return gate ? { ...bootstrap, update, windowsFeature: gate } : { ...bootstrap, update }
    try {
      const manifest = await this.bootstrap.readManifest()
      if (!manifest) return { ...bootstrap, update }
      const provider = await this.providerFactory(manifest).observe()
      if (
        provider.state === 'ready' &&
        provider.runtimeId === manifest.runtimeId &&
        provider.runtimeVersion === manifest.runtimeVersion &&
        provider.baseImageDigest === findManagedRuntimeRelease(manifest.runtimeVersion)?.bootImage.sha256
      ) {
        return { ...bootstrap, nestedVirtualization: provider.nestedVirtualization, update }
      }
      return {
        ...bootstrap,
        state: provider.state === 'stopped' || provider.state === 'preparing' ? 'preparing' : 'broken',
        phase: provider.state === 'stopped' || provider.state === 'preparing' ? 'starting-private-daemon' : 'broken',
        detail:
          provider.state === 'stopped' || provider.state === 'preparing'
            ? 'The DevHotel-managed runtime is starting.'
            : 'The DevHotel-managed runtime needs repair.',
        update
      }
    } catch {
      return {
        ...bootstrap,
        state: 'broken',
        phase: 'broken',
        detail: 'The DevHotel-managed runtime ownership or health proof is invalid.',
        runtimeId: null,
        runtimeVersion: null,
        artifactDigests: {},
        update
      }
    }
  }

  /**
   * The update worth telling the user about, or `null`.
   *
   * A committed update is not one of them: it ended on the version it aimed
   * for, which is the unremarkable case and is cleared from the journal anyway.
   */
  private async updateSummary(): Promise<ManagedRuntimeUpdateSummary | null> {
    const journal = await this.updates.read().catch(() => null)
    if (!journal || journal.stage === 'committed') return null
    return {
      stage: journal.stage,
      fromVersion: journal.fromVersion,
      toVersion: journal.toVersion,
      attempts: journal.attempts,
      detail:
        journal.stage === 'rolled-back'
          ? `The DevHotel-managed runtime stayed on ${journal.fromVersion}: the update to ${journal.toVersion} could not be made healthy and was rolled back with Room data intact.`
          : journal.stage === 'failed'
            ? `The DevHotel-managed runtime update from ${journal.fromVersion} to ${journal.toVersion} could not be completed or undone, and needs repair.`
            : `The DevHotel-managed runtime is updating from ${journal.fromVersion} to ${journal.toVersion}.`,
      failure: journal.failure
    }
  }

  /**
   * Removes everything this install provisioned on the Host, for uninstall.
   *
   * It runs while DevHotel is still alive and before app data is deleted,
   * because only a live process holds the ownership proof, and a registered VM
   * holds its disks open against the deletion that follows. Ownership is
   * enforced by the provider: an object DevHotel cannot prove it created is
   * reported back rather than deleted.
   */
  async remove(scope: ManagedRuntimeRemovalScope = 'complete'): Promise<ManagedRuntimeRemovalOutcome> {
    const manifest = await this.bootstrap.readManifest().catch(() => null)
    if (!manifest) return 'nothing-owned'
    const provider = this.providerFactory(manifest)
    if (scope === 'app-only') {
      const observation = await provider.observe()
      if (observation.state === 'not-installed') return 'nothing-owned'
      // Saved, never destroyed. An app-only uninstall's entire promise is that
      // the next install finds this runtime and the Room disks under it exactly
      // as they were, so the VM is stopped the same way a normal shutdown stops
      // it and is deliberately left registered.
      await provider.stop()
      return 'preserved'
    }
    return await provider.remove()
  }

  /**
   * Where Rooms are driven, or `null` when this Host has no usable runtime.
   *
   * `null` is an ordinary answer: an unprovisioned Host, a Hyper-V gate not yet
   * passed, a runtime still preparing. The caller falls back to the external
   * compatibility engine and says so, rather than failing a launch on a
   * capability the user has not been given yet.
   */
  async roomChannel(): Promise<{ channel: ManagedHyperVGuestChannel; runtimeId: string } | null> {
    const manifest = await this.bootstrap.readManifest().catch(() => null)
    if (!manifest || manifest.status !== 'ready') return null
    const provider = this.providerFactory(manifest)
    if (!provider.roomChannel) return null
    const channel = await provider.roomChannel().catch(() => null)
    return channel ? { channel, runtimeId: manifest.runtimeId } : null
  }

  async stop(): Promise<void> {
    const manifest = await this.bootstrap.readManifest()
    if (!manifest) return
    const provider = this.providerFactory(manifest)
    const observation = await provider.observe()
    if (observation.state === 'not-installed') return
    // A failed guest health check must not strand an otherwise owned VM during
    // shutdown. The provider re-proves Host marker + Hyper-V object ownership
    // before Save-VM and therefore remains fail-closed on an unowned object.
    await provider.stop()
  }

  private async prepareOnce(): Promise<ManagedRuntimeObservation> {
    const support = await this.bootstrap.support()
    if (support.code !== 'ready') {
      // The provider cannot be provisioned until Windows itself offers Hyper-V.
      // Report the exact gate — approval needed, restart pending, or an edition
      // that will never offer it — instead of a bare capability failure.
      return await this.observe()
    }

    // An update that was cut short — by a crash, a kill, or the reboot that
    // Windows feature work so often brings — is decided here, before anything
    // new is started. Nothing else in this method is safe to run on top of a
    // half-applied version change.
    const resumed = await this.resumeInterruptedUpdate()
    if (resumed) return resumed

    const installed = await this.bootstrap.readManifest().catch(() => null)
    if (installed && installed.runtimeVersion !== MANAGED_RUNTIME_CURRENT_RELEASE.runtimeVersion) {
      if (await this.updateIsBlocked(MANAGED_RUNTIME_CURRENT_RELEASE.runtimeVersion)) {
        // This exact update already failed and was undone. Retrying it every
        // launch would cost the user a working runtime on a loop, so the
        // install stays on the version that works and says so.
        return await this.ensureRunning(installed)
      }
      return await this.update(installed)
    }

    return await this.provisionCurrentRelease()
  }

  private async provisionCurrentRelease(): Promise<ManagedRuntimeObservation> {
    const release = MANAGED_RUNTIME_CURRENT_RELEASE
    let manifest = await this.bootstrap.beginProvision(release.runtimeVersion)
    try {
      const downloaded = await this.download(release)

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

  /**
   * Moves this install from the version it has to the version this build
   * ships, and puts it back if that cannot be made healthy.
   *
   * The order is the guarantee. The journal is durable before the download, the
   * download and its digest check happen before anything on the Host is
   * touched, and the manifest only names the new version once the journal says
   * an apply is in progress — so no reboot can leave behind a runtime whose
   * version nobody can name. The Room state disk is carried across by the
   * provider rather than recreated, which is why a rollback costs the user
   * nothing but time.
   */
  private async update(from: ManagedRuntimeManifest): Promise<ManagedRuntimeObservation> {
    const release = MANAGED_RUNTIME_CURRENT_RELEASE
    let journal = await this.updates.begin({
      runtimeId: from.runtimeId,
      fromVersion: from.runtimeVersion,
      toVersion: release.runtimeVersion,
      fromArtifactDigests: from.artifactDigests
    })
    try {
      // Still entirely reversible: a download that fails leaves the install
      // exactly where it was, on a runtime that is still running.
      const downloaded = await this.download(release)
      journal = await this.updates.advance(journal.updateId, 'applying')
      const manifest = await this.bootstrap.adoptVersion(from.runtimeId, release.runtimeVersion, {
        [downloaded.id]: downloaded.sha256
      })
      const provider = this.providerFactory(manifest)
      if (!provider.migrateFrom) throw new Error('Managed runtime provider cannot change versions')
      await provider.migrateFrom(from.runtimeVersion, releaseImage(downloaded))
      journal = await this.updates.advance(journal.updateId, 'verifying')
      await this.bringUp(manifest, releaseImage(downloaded))
      await this.updates.advance(journal.updateId, 'committed')
      // Only now: until the new version is proved healthy, the image the old
      // one booted from is exactly what a rollback would need.
      await provider.pruneUnreferencedImages?.().catch(() => undefined)
      await this.updates.clear(journal.updateId)
      return await this.observe()
    } catch (error) {
      return await this.rollback(journal, error)
    }
  }

  /**
   * Puts the install back on the version it came from.
   *
   * This is the same migration run backwards, which is deliberate: one code
   * path means a rollback is exercised by every update test rather than being
   * the branch nobody runs until it matters. It fails closed — a version this
   * build no longer carries cannot be re-verified, and inventing one would be
   * worse than reporting a runtime that needs repair.
   */
  private async rollback(journal: ManagedRuntimeUpdateJournal, cause: unknown): Promise<ManagedRuntimeObservation> {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const source = findManagedRuntimeRelease(journal.fromVersion)
    if (!source) {
      await this.updates
        .fail(journal.updateId, 'failed', `${reason} (runtime ${journal.fromVersion} is no longer available to roll back to)`)
        .catch(() => undefined)
      await this.bootstrap.markBroken(journal.runtimeId, reason).catch(() => undefined)
      throw cause
    }
    await this.updates.advance(journal.updateId, 'rolling-back').catch(() => undefined)
    try {
      const downloaded = await this.download(source)
      const manifest = await this.bootstrap.adoptVersion(journal.runtimeId, source.runtimeVersion, {
        [downloaded.id]: downloaded.sha256
      })
      const provider = this.providerFactory(manifest)
      // A migration that never reached the Host leaves the provider already on
      // the source version, where this is a no-op that simply provisions it.
      if (provider.migrateFrom) await provider.migrateFrom(journal.toVersion, releaseImage(downloaded))
      await this.bringUp(manifest, releaseImage(downloaded))
      await this.updates.fail(journal.updateId, 'rolled-back', reason)
      return await this.observe()
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      await this.updates.fail(journal.updateId, 'failed', `${reason} (rollback also failed: ${failure})`).catch(() => undefined)
      await this.bootstrap.markBroken(journal.runtimeId, failure).catch(() => undefined)
      throw error
    }
  }

  /**
   * Decides what to do with an update the last run did not finish.
   *
   * Returns an observation when it handled the situation itself, and `null`
   * when the ordinary path should carry on — which is the answer whenever the
   * Host holds nothing half-applied.
   */
  private async resumeInterruptedUpdate(): Promise<ManagedRuntimeObservation | null> {
    const journal = await this.updates.read().catch(() => null)
    if (!journal || isTerminalManagedRuntimeUpdateStage(journal.stage)) return null
    const manifest = await this.bootstrap.readManifest().catch(() => null)
    if (!manifest || manifest.runtimeId !== journal.runtimeId) {
      // The journal outlived the runtime it was opened for, so it authorises
      // nothing: neither half of the version change it names still exists.
      await this.updates
        .fail(journal.updateId, 'failed', 'The runtime this update was opened for is no longer installed.')
        .catch(() => undefined)
      return null
    }
    if (journal.attempts >= MAX_UPDATE_ATTEMPTS) {
      return await this.rollback(
        journal,
        new Error(
          `The update to runtime ${journal.toVersion} was interrupted ${journal.attempts} times before it could be proved healthy.`
        )
      )
    }
    // The version swap itself landed; what is missing is the proof that what it
    // produced is healthy. Finishing forward is cheaper, and less destructive,
    // than undoing a migration that may well have worked.
    if (manifest.runtimeVersion === journal.toVersion) {
      const release = findManagedRuntimeRelease(journal.toVersion)
      if (!release) return await this.rollback(journal, new Error(`Runtime ${journal.toVersion} is not carried by this build.`))
      try {
        const downloaded = await this.download(release)
        // The journal walks the same stages a first-time update walks, so a
        // resumed update and a fresh one leave identical evidence behind.
        let live = journal
        if (live.stage === 'staging') live = await this.updates.advance(live.updateId, 'applying')
        if (live.stage === 'applying') live = await this.updates.advance(live.updateId, 'verifying')
        await this.bringUp(manifest, releaseImage(downloaded))
        await this.updates.advance(live.updateId, 'committed')
        await this.updates.clear(live.updateId)
        return await this.observe()
      } catch (error) {
        return await this.rollback(journal, error)
      }
    }
    // Still on the version it started from: nothing was applied, so the
    // ordinary update path re-opens the journal and counts the attempt.
    return null
  }

  /** Whether this exact target already failed and was undone on this Host. */
  private async updateIsBlocked(toVersion: string): Promise<boolean> {
    const journal = await this.updates.read().catch(() => null)
    return journal !== null && journal.toVersion === toVersion && (journal.stage === 'rolled-back' || journal.stage === 'failed')
  }

  /**
   * Starts the version the install actually has, proves it healthy, and marks
   * the manifest ready. Shared by update, rollback and interrupted-update
   * recovery so all three prove the same things in the same order.
   */
  private async bringUp(
    manifest: ManagedRuntimeManifest,
    image: { file: string; sha256: string; sizeBytes: number }
  ): Promise<void> {
    const provider = this.providerFactory(manifest)
    let current = manifest
    if (current.phase === 'checking-windows-capabilities' || current.phase === 'verifying-runtime-manifest') {
      throw new Error('Managed runtime version change has not reached its provider yet')
    }
    if (current.phase === 'provisioning-runtime-provider') {
      current = await this.bootstrap.advance(current.runtimeId, 'starting-private-daemon')
    }
    this.assertReady(await provider.repair(image), current)
    if (current.phase === 'starting-private-daemon') {
      current = await this.bootstrap.advance(current.runtimeId, 'health-checking')
    }
    if (current.status !== 'ready') await this.bootstrap.markReady(current.runtimeId)
  }

  /** Brings an install that is deliberately staying on an older version up. */
  private async ensureRunning(manifest: ManagedRuntimeManifest): Promise<ManagedRuntimeObservation> {
    const release = findManagedRuntimeRelease(manifest.runtimeVersion)
    if (!release) return await this.observe()
    try {
      const downloaded = await this.download(release)
      const provider = this.providerFactory(manifest)
      this.assertReady(await provider.repair(releaseImage(downloaded)), manifest)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      await this.bootstrap.markBroken(manifest.runtimeId, failure).catch(() => undefined)
    }
    return await this.observe()
  }

  private async download(release: ManagedRuntimeReleaseDescriptor): Promise<ManagedRuntimeDownloadedArtifact> {
    return await this.downloadArtifact({
      artifact: release.bootImage,
      destinationRoot: path.join(this.userData, 'runtime', 'downloads'),
      allowedHosts: MANAGED_RUNTIME_ALLOWED_HOSTS,
      fetch: this.fetch
    })
  }

  /** The Windows feature gate, or `null` when nothing stands in the way. */
  private async windowsGate(): Promise<ManagedRuntimeFeatureObservation | null> {
    if (this.platform !== 'win32') return null
    const gate = await this.windowsFeature.observe().catch(() => null)
    return gate && gate.stage !== 'completed' ? gate : null
  }

  private assertReady(observation: ManagedHyperVRuntimeObservation, manifest: ManagedRuntimeManifest): void {
    // Against the release the manifest names, not against whatever this build
    // happens to ship: an install deliberately left on an older runtime still
    // has to prove it is running that runtime's own pinned substrate.
    const expected = findManagedRuntimeRelease(manifest.runtimeVersion)?.bootImage.sha256 ?? null
    if (
      observation.state !== 'ready' ||
      observation.runtimeId !== manifest.runtimeId ||
      observation.runtimeVersion !== manifest.runtimeVersion ||
      expected === null ||
      observation.baseImageDigest !== expected
    ) {
      throw new Error('Managed Hyper-V runtime did not produce an exact healthy identity proof')
    }
  }
}
