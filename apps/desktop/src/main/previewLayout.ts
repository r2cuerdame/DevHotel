import type { PreviewLayout, PreviewViewport } from '@devhotel/shared'

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CalculatedPreviewBounds {
  left: PreviewBounds
  right: PreviewBounds | null
  devtools: PreviewBounds | null
}

export const PREVIEW_SPLIT_GUTTER = 8

/** Pure geometry shared by the native responsive panes and its focused tests. */
export function calculatePreviewBounds(
  area: PreviewBounds,
  mode: PreviewLayout['mode'],
  devtoolsOpen: boolean
): CalculatedPreviewBounds {
  const contentWidth = devtoolsOpen ? Math.round(area.width * 0.6) : area.width
  const devtoolsWidth = area.width - contentWidth
  const devtools = devtoolsOpen
    ? { x: area.x + contentWidth, y: area.y, width: devtoolsWidth, height: area.height }
    : null

  if (mode === 'single' || contentWidth < 3) {
    return {
      left: { x: area.x, y: area.y, width: contentWidth, height: area.height },
      right: null,
      devtools
    }
  }

  const gutter = Math.min(PREVIEW_SPLIT_GUTTER, contentWidth - 2)
  const panesWidth = contentWidth - gutter
  const leftWidth = Math.floor(panesWidth * 0.62)
  const rightWidth = contentWidth - gutter - leftWidth
  return {
    left: { x: area.x, y: area.y, width: leftWidth, height: area.height },
    right: { x: area.x + leftWidth + gutter, y: area.y, width: rightWidth, height: area.height },
    devtools
  }
}

export function previewScale(bounds: PreviewBounds, viewport: PreviewViewport): number {
  return Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height)
}
