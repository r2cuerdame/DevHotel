import { describe, expect, it } from 'vitest'
import { calculatePreviewBounds, PREVIEW_SPLIT_GUTTER, previewScale } from './previewLayout'

describe('responsive preview geometry', () => {
  it('uses a 62/38 desktop-mobile split while leaving an eight-pixel renderer gutter', () => {
    const result = calculatePreviewBounds({ x: 10, y: 20, width: 1000, height: 700 }, 'split', false)
    expect(result).toEqual({
      left: { x: 10, y: 20, width: 615, height: 700 },
      right: { x: 10 + 615 + PREVIEW_SPLIT_GUTTER, y: 20, width: 377, height: 700 },
      devtools: null
    })
  })

  it('splits inside the existing 60% content area when DevTools is docked', () => {
    const result = calculatePreviewBounds({ x: 0, y: 0, width: 1000, height: 600 }, 'split', true)
    expect(result.left.width).toBe(367)
    expect(result.right).toEqual({ x: 375, y: 0, width: 225, height: 600 })
    expect(result.devtools).toEqual({ x: 600, y: 0, width: 400, height: 600 })
  })

  it('fills the content area in single mode and caps emulation scale at one', () => {
    const result = calculatePreviewBounds({ x: 3, y: 4, width: 900, height: 700 }, 'single', false)
    expect(result.left).toEqual({ x: 3, y: 4, width: 900, height: 700 })
    expect(result.right).toBeNull()
    expect(previewScale(result.left, { width: 1440, height: 900 })).toBeCloseTo(0.625)
    expect(previewScale(result.left, { width: 320, height: 480 })).toBe(1)
  })
})
