import type { RoomPlan, RoomRecord } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import { slugifyDomain, type DetectOptions } from '../detect/detector'
import type { SourceReader } from '../detect/sourceReader'
import type { RoomProvider, RoomProviderInfo } from './types'

/** Validated against a real containerized `gradle assembleDebug` (see examples/hello-android). */
export const ANDROID_IMAGE = 'thyrlian/android-sdk:latest'
/** Android rooms keep a long-lived container so the terminal and builds have a home. */
export const ANDROID_KEEPALIVE_COMMAND = 'sleep 2147483647'
export const ANDROID_DEFAULT_BUILD_COMMAND = 'gradle assembleDebug --no-daemon'

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
    available: true
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
      internalPort: { value: 0, source: 'not used by build rooms' },
      domain: slugifyDomain(opts.project, opts.nickname),
      https: false,
      warnings
    }
  }

  buildSpec(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
    return {
      roomId: room.id,
      internalPort: room.internalPort || 0,
      nodeMajor: room.runtime.version,
      sourceType: room.sourceType,
      sourceRef: room.sourceRef,
      startCommand: ANDROID_KEEPALIVE_COMMAND,
      env: { GRADLE_USER_HOME: '/cache/gradle' },
      imageOverride: ANDROID_IMAGE,
      standalone: true,
      noDepsVolume: true,
      ...overrides
    }
  }

  components(): string[] {
    return ['JDK', 'Android SDK', 'Gradle', 'Build']
  }
}
