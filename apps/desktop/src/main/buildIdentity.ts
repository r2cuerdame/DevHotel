import { zBuildIdentity, type BuildIdentity } from '@devhotel/shared'

declare const __DEVHOTEL_BUILD_IDENTITY__: unknown

/** Replaced with literals by electron-vite; no runtime environment can alter it. */
export const BUILD_IDENTITY: BuildIdentity = Object.freeze(
  zBuildIdentity.parse(__DEVHOTEL_BUILD_IDENTITY__)
)

export function assertPackagedVersion(identity: BuildIdentity, runtimeVersion: string): void {
  if (identity.version !== runtimeVersion) {
    throw new Error(
      `Packaged version ${runtimeVersion} does not match embedded build identity ${identity.version}`
    )
  }
}
