import { ANDROID_API_LEVELS, ANDROID_SYSTEM_IMAGES } from '../backend/androidSdkPin'

/**
 * Keeps `UnpinnedAndroidSystemImageError` tested now that nothing triggers it.
 *
 * Every Android version the Stack tab offers has a pinned system image, so the
 * "known version, no pinned image" refusal has no live case. Deleting its tests
 * along with its last caller would be the wrong move: the branch is exactly what
 * catches the *next* version added to `ANDROID_API_LEVELS` without a matching
 * entry in `ANDROID_SYSTEM_IMAGES`, which is the mistake that would otherwise
 * route a managed Room at a system image that was never fetched.
 *
 * So the tests register a synthetic version for the duration of one assertion
 * instead. Both tables are asserted to be untouched by the choice, so this can
 * never accidentally shadow a real pin, and the entry is removed in a `finally`
 * so one test cannot leak a fake version into the next.
 */
export function withUnpinnedAndroidVersion<T>(version: string, apiLevel: number, body: () => T): T {
  const levels = ANDROID_API_LEVELS as Record<string, number>
  if (levels[version] !== undefined) {
    throw new Error(`${version} is a real offered version — pick one that is not, or this test proves nothing`)
  }
  if (ANDROID_SYSTEM_IMAGES[apiLevel]) {
    throw new Error(`API ${apiLevel} has a pinned system image — pick one that does not`)
  }
  levels[version] = apiLevel
  try {
    return body()
  } finally {
    delete levels[version]
  }
}

/**
 * An API level DevHotel does not offer and has not pinned, for the helper above.
 * Android 15 / API 35 is deliberate: if it is ever offered and pinned, the guard
 * in `withUnpinnedAndroidVersion` fails loudly rather than silently testing a
 * path that no longer exists.
 */
export const UNPINNED_TEST_VERSION = '15.0'
export const UNPINNED_TEST_API_LEVEL = 35
