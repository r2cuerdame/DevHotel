import type { RoomPlan, RoomRecord } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import { slugifyDomain, type DetectOptions } from '../detect/detector'
import type { SourceReader } from '../detect/sourceReader'
import type { RoomProvider, RoomProviderInfo } from './types'

/**
 * Validated against a real containerized `gradle assembleDebug` (see examples/hello-android):
 * Gradle 8.10.2, JDK 17, licenses pre-accepted so AGP auto-installs SDK components.
 * Digest-pinned — the tag's Gradle version constrains the viable AGP range.
 */
export const ANDROID_IMAGE =
  'thyrlian/android-sdk@sha256:bb9ed3686968550d927228777bca787dd7913e679f1e73e85525ba0094ea170d'
/** Android rooms keep a long-lived container so the terminal and builds have a home. */
export const ANDROID_KEEPALIVE_COMMAND = 'sleep 2147483647'
export const ANDROID_DEFAULT_BUILD_COMMAND =
  'if [ -f ./gradlew ]; then sh ./gradlew assembleDebug --no-daemon; else gradle assembleDebug --no-daemon; fi'

const GRADLE_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']

/**
 * Android build rooms (design doc v1): containerized JDK + SDK + Gradle with
 * per-room caches — build APKs without touching the host. Managed emulator and
 * preview are v2 (docs/superpowers/specs/2026-08-10-android-room-provider-design.md).
 */
export class AndroidRoomProvider implements RoomProvider {
  readonly info: RoomProviderInfo = {
    kind: 'android',
    label: 'Android Room (build)',
    available: true,
    execution: 'build-only',
    preview: 'none',
    requiresKvm: false
  }

  async detect(src: SourceReader, opts: DetectOptions): Promise<RoomPlan> {
    const warnings: string[] = []
    let hasGradle = false
    for (const file of GRADLE_FILES) {
      if (await src.exists(file)) {
        hasGradle = true
        break
      }
    }
    if (!hasGradle) warnings.push('No Gradle project detected — the room still opens, but builds will fail until one exists.')
    return {
      project: opts.project,
      framework: 'android',
      runtime: { kind: 'jdk', value: '17', source: 'sdk image' },
      packageManager: { value: 'gradle', source: 'gradle project' },
      startCommand: { value: opts.overrides?.startCommand ?? ANDROID_DEFAULT_BUILD_COMMAND, source: opts.overrides?.startCommand ? 'user override' : 'default' },
      // RoomRecord still carries a legacy port-shaped field, but build-only
      // Android Rooms never publish or route it.
      internalPort: { value: 6080, source: 'build-only compatibility metadata' },
      domain: slugifyDomain(opts.project, opts.nickname),
      https: false,
      warnings
    }
  }

  buildSpec(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
    return {
      roomId: room.id,
      // Build-only Rooms own a network but never create an anchor, published
      // port, browser preview, or KVM-backed emulator.
      internalPort: room.internalPort || 6080,
      nodeMajor: room.runtime.version,
      sourceType: room.sourceType,
      sourceRef: room.sourceRef,
      workspaceMode: room.workspaceMode,
      workspaceVolumeRevision: room.workspaceVolumeRevision,
      startCommand: ANDROID_KEEPALIVE_COMMAND,
      env: { GRADLE_USER_HOME: '/cache/gradle' },
      imageOverride: ANDROID_IMAGE,
      standalone: true,
      noDepsVolume: true,
      // persists AGP's auto-installed platforms/build-tools across container recreates;
      // docker seeds the volume from the image (cmdline-tools + pre-accepted licenses)
      extraVolumes: [{ volume: `dh-${room.id}-sdk`, path: '/opt/android-sdk' }],
      ...overrides
    }
  }

  components(): string[] {
    return ['JDK', 'Android SDK', 'Gradle', 'Build']
  }
}
