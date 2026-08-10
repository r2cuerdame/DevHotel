import { describe, expect, it } from 'vitest'
import {
  clampSplitRatio,
  createPreviewLayout,
  DEFAULT_DESKTOP_TABLET_PRESET,
  DEFAULT_MOBILE_PRESET,
  DEFAULT_SPLIT_RATIO,
  DESKTOP_TABLET_PRESETS,
  MOBILE_PRESETS,
  loadPreviewPresetId,
  loadSplitEnabled,
  loadSplitRatio,
  resolvePreviewPreset,
  savePreviewPresetId,
  saveSplitEnabled,
  saveSplitRatio,
  splitLeftWidth
} from './previewLayout'

function memoryStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const values = new Map<string, string>()
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    }
  }
}

describe('dual preview layout', () => {
  it('splits into a laptop view and a tall mobile view when the split button is on', () => {
    expect(createPreviewLayout(DEFAULT_DESKTOP_TABLET_PRESET, DEFAULT_MOBILE_PRESET, true, DEFAULT_SPLIT_RATIO)).toEqual({
      mode: 'split',
      leftViewport: { width: 1366, height: 768 },
      rightViewport: { width: 390, height: 844 },
      splitRatio: DEFAULT_SPLIT_RATIO
    })
  })

  it('stays single-pane until the user turns the split on', () => {
    expect(createPreviewLayout(DEFAULT_DESKTOP_TABLET_PRESET, DEFAULT_MOBILE_PRESET, false, 0.5).mode).toBe('single')
  })

  it('persists the split toggle and drag ratio per Room and clamps stale values', () => {
    const storage = memoryStorage()
    expect(loadSplitEnabled(storage, 'room-a')).toBe(false)
    saveSplitEnabled(storage, 'room-a', true)
    saveSplitRatio(storage, 'room-a', 0.4)
    expect(loadSplitEnabled(storage, 'room-a')).toBe(true)
    expect(loadSplitRatio(storage, 'room-a')).toBe(0.4)
    expect(loadSplitEnabled(storage, 'room-b')).toBe(false)
    expect(loadSplitRatio(storage, 'room-b')).toBe(DEFAULT_SPLIT_RATIO)

    saveSplitRatio(storage, 'room-a', 7)
    expect(loadSplitRatio(storage, 'room-a')).toBe(0.85)
    storage.setItem('devhotel.preview.room-a.splitRatio', 'garbage')
    expect(loadSplitRatio(storage, 'room-a')).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampSplitRatio(-1)).toBe(0.15)
  })

  it('computes the same left pane width as the main process geometry', () => {
    // main: gutter 8 → floor((1000 - 8) * 0.62) = 615
    expect(splitLeftWidth(1000, 0.62)).toBe(615)
    expect(splitLeftWidth(1008, 0.5)).toBe(500)
  })

  it('keeps desktop/tablet and mobile discovery sets distinct', () => {
    expect(DESKTOP_TABLET_PRESETS.every((preset) => preset.viewport.width >= 820)).toBe(true)
    expect(MOBILE_PRESETS.every((preset) => preset.viewport.width < preset.viewport.height)).toBe(true)
    expect(new Set([...DESKTOP_TABLET_PRESETS, ...MOBILE_PRESETS].map((preset) => preset.id)).size).toBe(
      DESKTOP_TABLET_PRESETS.length + MOBILE_PRESETS.length
    )
  })

  it('falls back to the first safe preset for stale settings', () => {
    expect(resolvePreviewPreset(MOBILE_PRESETS, 'removed-device')).toBe(MOBILE_PRESETS[0])
  })

  it('persists each Room and pane selection independently', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value)
      }
    }
    savePreviewPresetId(storage, 'room-a', 'left', 'desktop')
    savePreviewPresetId(storage, 'room-a', 'right', 'galaxy')

    expect(loadPreviewPresetId(storage, 'room-a', 'left', DESKTOP_TABLET_PRESETS, 'laptop')).toBe('desktop')
    expect(loadPreviewPresetId(storage, 'room-a', 'right', MOBILE_PRESETS, 'iphone')).toBe('galaxy')
    expect(loadPreviewPresetId(storage, 'room-b', 'left', DESKTOP_TABLET_PRESETS, 'laptop')).toBe('laptop')
  })
})
