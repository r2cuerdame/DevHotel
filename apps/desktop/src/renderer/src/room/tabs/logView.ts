import type { ProviderKind } from '@devhotel/shared'

export type LogKind = 'web' | 'orchestrator'

export type PrimaryLogLabelKey = 'logs.web' | 'logs.android'

export interface FilteredLogs {
  lines: string[]
  matched: number
  total: number
  query: string
}

export const DEFAULT_LOG_BOTTOM_THRESHOLD_PX = 24

export function filterLogLines(lines: readonly string[], rawQuery: string): FilteredLogs {
  const query = rawQuery.trim()
  if (query.length === 0) {
    const copy = lines.slice()
    return { lines: copy, matched: copy.length, total: lines.length, query: '' }
  }
  const needle = query.toLowerCase()
  const matchedLines = lines.filter((line) => line.toLowerCase().includes(needle))
  return {
    lines: matchedLines,
    matched: matchedLines.length,
    total: lines.length,
    query
  }
}

export function isNearLogBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx: number = DEFAULT_LOG_BOTTOM_THRESHOLD_PX
): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollHeight)) {
    return true
  }
  const safeThreshold =
    Number.isFinite(thresholdPx) && thresholdPx >= 0 ? thresholdPx : DEFAULT_LOG_BOTTOM_THRESHOLD_PX
  const remaining = scrollHeight - (scrollTop + clientHeight)
  return remaining <= safeThreshold
}

export function defaultLogKind(provider: ProviderKind): LogKind {
  return provider === 'windows' ? 'orchestrator' : 'web'
}

export function primaryLogLabelKey(provider: ProviderKind): PrimaryLogLabelKey | null {
  if (provider === 'windows') return null
  return provider === 'android' ? 'logs.android' : 'logs.web'
}
