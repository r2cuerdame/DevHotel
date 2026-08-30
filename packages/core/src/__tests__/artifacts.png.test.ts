import { describe, expect, it } from 'vitest'
import { validateAndSanitizeScreenshotPng } from '../artifacts/png'
import { screenshotPng } from './pngFixture'

describe('screenshot PNG validation', () => {
  it('validates pixels and strips textual metadata before storage', () => {
    const secret = 'pairing-code=123456'
    const input = screenshotPng(2, 3, { text: secret })

    const validated = validateAndSanitizeScreenshotPng(input)

    expect(validated).toMatchObject({ width: 2, height: 3, orientation: 'portrait' })
    expect(validated.png.byteLength).toBeLessThan(input.byteLength)
    expect(validated.png.toString('utf8')).not.toContain(secret)
    expect(validateAndSanitizeScreenshotPng(validated.png).png).toEqual(validated.png)
  })

  it('rejects corrupt, truncated, oversized-dimension and invalid-filter PNGs', () => {
    const corrupt = screenshotPng()
    corrupt[corrupt.length - 5] = (corrupt[corrupt.length - 5] ?? 0) ^ 1
    expect(() => validateAndSanitizeScreenshotPng(corrupt)).toThrow(/checksum/)

    expect(() => validateAndSanitizeScreenshotPng(screenshotPng().subarray(0, -2))).toThrow(/truncated|incomplete/)
    expect(() => validateAndSanitizeScreenshotPng(screenshotPng(8193, 1))).toThrow(/dimensions/)
    expect(() => validateAndSanitizeScreenshotPng(screenshotPng(1, 1, { filter: 5 }))).toThrow(/filter/)
  })

  it('rejects content appended after the image terminator', () => {
    expect(() => validateAndSanitizeScreenshotPng(Buffer.concat([screenshotPng(), Buffer.from('hidden')]))).toThrow(
      /IEND|after/
    )
  })
})
