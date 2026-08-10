export type PreviewViewport = { width: number; height: number }

export type PreviewPreset = {
  id: string
  label: string
  viewport: PreviewViewport
}

export const DESKTOP_TABLET_PRESETS: readonly PreviewPreset[] = [
  { id: 'laptop', label: 'Laptop · 1366×768', viewport: { width: 1366, height: 768 } },
  { id: 'desktop', label: 'Desktop · 1920×1080', viewport: { width: 1920, height: 1080 } },
  { id: 'tablet-landscape', label: 'iPad · 1180×820', viewport: { width: 1180, height: 820 } },
  { id: 'tablet-portrait', label: 'iPad · 820×1180', viewport: { width: 820, height: 1180 } }
]

export const MOBILE_PRESETS: readonly PreviewPreset[] = [
  { id: 'iphone', label: 'iPhone · 390×844', viewport: { width: 390, height: 844 } },
  { id: 'galaxy', label: 'Galaxy · 412×915', viewport: { width: 412, height: 915 } },
  { id: 'compact', label: 'Compact · 360×800', viewport: { width: 360, height: 800 } }
]

export const DEFAULT_DESKTOP_TABLET_PRESET = DESKTOP_TABLET_PRESETS[0]!.id
export const DEFAULT_MOBILE_PRESET = MOBILE_PRESETS[0]!.id

type PreviewSide = 'left' | 'right'
type PreviewSelectionStorage = Pick<Storage, 'getItem' | 'setItem'>

function previewSelectionKey(roomId: string, side: PreviewSide): string {
  return `devhotel.preview.${roomId}.${side}`
}

export function resolvePreviewPreset(presets: readonly PreviewPreset[], id: string): PreviewPreset {
  const preset = presets.find((candidate) => candidate.id === id) ?? presets[0]
  if (!preset) throw new Error('At least one preview preset is required')
  return preset
}

export function loadPreviewPresetId(
  storage: Pick<PreviewSelectionStorage, 'getItem'>,
  roomId: string,
  side: PreviewSide,
  presets: readonly PreviewPreset[],
  fallback: string
): string {
  try {
    const stored = storage.getItem(previewSelectionKey(roomId, side))
    return stored && presets.some((preset) => preset.id === stored) ? stored : fallback
  } catch {
    return fallback
  }
}

export function savePreviewPresetId(
  storage: Pick<PreviewSelectionStorage, 'setItem'>,
  roomId: string,
  side: PreviewSide,
  presetId: string
): void {
  try {
    storage.setItem(previewSelectionKey(roomId, side), presetId)
  } catch {
    // Preview preferences are convenience state; storage failures must not hide the Room.
  }
}

export function createSplitPreviewLayout(leftPresetId: string, rightPresetId: string): {
  mode: 'split'
  leftViewport: PreviewViewport
  rightViewport: PreviewViewport
} {
  return {
    mode: 'split',
    leftViewport: resolvePreviewPreset(DESKTOP_TABLET_PRESETS, leftPresetId).viewport,
    rightViewport: resolvePreviewPreset(MOBILE_PRESETS, rightPresetId).viewport
  }
}
