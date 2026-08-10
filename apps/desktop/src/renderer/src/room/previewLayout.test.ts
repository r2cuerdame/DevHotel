import { describe, expect, it } from 'vitest'
import {
  createSplitPreviewLayout,
  DEFAULT_DESKTOP_TABLET_PRESET,
  DEFAULT_MOBILE_PRESET,
  DESKTOP_TABLET_PRESETS,
  MOBILE_PRESETS,
  loadPreviewPresetId,
  resolvePreviewPreset,
  savePreviewPresetId
} from './previewLayout'

describe('dual preview layout', () => {
  it('starts with a laptop view and a tall mobile view', () => {
    expect(createSplitPreviewLayout(DEFAULT_DESKTOP_TABLET_PRESET, DEFAULT_MOBILE_PRESET)).toEqual({
      mode: 'split',
      leftViewport: { width: 1366, height: 768 },
      rightViewport: { width: 390, height: 844 }
    })
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
