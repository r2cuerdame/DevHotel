import { describe, expect, it } from 'vitest'
import { resolveAdbExecutable } from '../devices/adbHost'

describe('Host adb discovery', () => {
  it.each(['ANDROID_SDK_ROOT', 'ANDROID_HOME'] as const)(
    'uses %s even when that SDK root is also the inferred home value',
    (variable) => {
      const sdk = 'C:\\Android\\Sdk'
      const expected = 'C:\\Android\\Sdk\\platform-tools\\adb.exe'

      expect(
        resolveAdbExecutable({
          env: { PATH: '', [variable]: sdk },
          platform: 'win32',
          fileExists: (candidate) => candidate === expected
        })
      ).toBe(expected)
    }
  )

  it('deduplicates SDK candidates without dropping a root equal to the explicit home', () => {
    const sdk = 'C:\\Android\\Sdk'
    const expected = 'C:\\Android\\Sdk\\platform-tools\\adb.exe'
    const checked: string[] = []

    expect(
      resolveAdbExecutable({
        env: { PATH: '', ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk },
        platform: 'win32',
        home: sdk,
        fileExists: (candidate) => {
          checked.push(candidate)
          return candidate === expected
        }
      })
    ).toBe(expected)
    expect(checked.filter((candidate) => candidate === expected)).toHaveLength(1)
  })
})
