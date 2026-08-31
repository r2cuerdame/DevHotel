import { describe, expect, it } from 'vitest'
import {
  androidLocaleScreenshotFilename,
  canonicalAndroidLocaleTags,
  zAndroidLocaleFilenamePrefix,
  zAndroidLocaleScreenshotMatrixBody,
  zAndroidLocaleMatrixTags,
  zAndroidLocaleReadinessTimeoutMs,
  zAndroidLocaleTag
} from '../androidLocales'

describe('Android locale contracts', () => {
  it('canonicalizes bounded BCP 47 tags before they cross a command boundary', () => {
    expect(zAndroidLocaleTag.parse('ko-kr')).toBe('ko-KR')
    expect(zAndroidLocaleTag.parse('EN-us')).toBe('en-US')
    expect(zAndroidLocaleTag.parse('zh-hant-tw')).toBe('zh-Hant-TW')
    expect(zAndroidLocaleTag.parse('iw-IL')).toBe('he-IL')
    expect(zAndroidLocaleTag.parse('en-US-u-nu-latn')).toBe('en-US-u-nu-latn')
  })

  it.each([
    '',
    'und',
    'en_US',
    ' en-US',
    'en-US ',
    'x-private',
    'en-US;getprop',
    `en-${'a'.repeat(64)}`
  ])('rejects unsafe or non-actionable locale tag %j', (locale) => {
    expect(zAndroidLocaleTag.safeParse(locale).success).toBe(false)
  })

  it('accepts one to sixteen canonical unique matrix locales', () => {
    expect(zAndroidLocaleMatrixTags.parse(['ko-kr', 'en-us'])).toEqual(['ko-KR', 'en-US'])
    expect(zAndroidLocaleMatrixTags.safeParse([]).success).toBe(false)
    expect(zAndroidLocaleMatrixTags.safeParse(['en-us', 'en-US']).success).toBe(false)
    expect(zAndroidLocaleMatrixTags.safeParse(
      Array.from({ length: 17 }, (_, index) => `en-${100 + index}`)
    ).success).toBe(false)
    expect(canonicalAndroidLocaleTags([], { allowEmpty: true })).toEqual([])
  })

  it('builds portable collision-free locale screenshot names', () => {
    expect(androidLocaleScreenshotFilename('release-42', 'ko-KR')).toBe('release-42-ko-kr.png')
    expect(() => androidLocaleScreenshotFilename('../escape', 'en-US')).toThrow()
    expect(zAndroidLocaleFilenamePrefix.safeParse('matrix path').success).toBe(false)
  })

  it('bounds the eventual readiness deadline', () => {
    expect(zAndroidLocaleReadinessTimeoutMs.parse(30_000)).toBe(30_000)
    expect(zAndroidLocaleReadinessTimeoutMs.safeParse(999).success).toBe(false)
    expect(zAndroidLocaleReadinessTimeoutMs.safeParse(120_001).success).toBe(false)
  })

  it('parses one strict composite matrix request and defaults target in Core', () => {
    expect(zAndroidLocaleScreenshotMatrixBody.parse({
      applicationId: 'com.example.app',
      locales: ['ko-kr', 'EN-us'],
      filenamePrefix: 'release-42',
      readinessTimeoutMs: 30_000
    })).toEqual({
      applicationId: 'com.example.app',
      locales: ['ko-KR', 'en-US'],
      filenamePrefix: 'release-42',
      readinessTimeoutMs: 30_000
    })
    expect(zAndroidLocaleScreenshotMatrixBody.safeParse({
      applicationId: 'com.example.app',
      locales: ['ko-KR'],
      filenamePrefix: 'release-42',
      serial: 'emulator-5554'
    }).success).toBe(false)
    expect(zAndroidLocaleScreenshotMatrixBody.parse({
      applicationId: 'com.example.app',
      locales: ['ko-KR'],
      filenamePrefix: 'release-42',
      target: { kind: 'emulator' }
    }).target).toEqual({ kind: 'emulator' })
    expect(zAndroidLocaleScreenshotMatrixBody.safeParse({
      applicationId: 'com.example.app',
      locales: ['ko-KR'],
      filenamePrefix: 'release-42',
      target: { kind: 'auto' }
    }).success).toBe(false)
    expect(zAndroidLocaleScreenshotMatrixBody.safeParse({
      applicationId: 'com.example.app',
      locales: ['ko-KR'],
      filenamePrefix: 'release-42',
      target: { kind: 'physical', deviceId: `d${'a'.repeat(32)}` }
    }).success).toBe(false)
  })
})
