import { describe, expect, it } from 'vitest'
import { LOCALES, translate } from '../../i18n'
import {
  DEFAULT_LOG_BOTTOM_THRESHOLD_PX,
  defaultLogKind,
  filterLogLines,
  isNearLogBottom,
  primaryLogLabelKey
} from './logView'

describe('filterLogLines', () => {
  const sample = [
    '[info] server listening on port 3000',
    '[warn] Slow query detected',
    '[ERROR] Connection timeout after 5000ms',
    'timeout retry succeeded'
  ]

  it('returns all lines when query is empty or whitespace', () => {
    expect(filterLogLines(sample, '')).toEqual({
      lines: sample,
      matched: 4,
      total: 4,
      query: ''
    })
    expect(filterLogLines(sample, '   \t ')).toEqual({
      lines: sample,
      matched: 4,
      total: 4,
      query: ''
    })
  })

  it('matches case-insensitively and trims outer whitespace', () => {
    expect(filterLogLines(sample, '  TIMEOUT  ')).toEqual({
      lines: ['[ERROR] Connection timeout after 5000ms', 'timeout retry succeeded'],
      matched: 2,
      total: 4,
      query: 'TIMEOUT'
    })
  })

  it('preserves internal spaces in search terms', () => {
    expect(filterLogLines(sample, 'port 3000')).toEqual({
      lines: ['[info] server listening on port 3000'],
      matched: 1,
      total: 4,
      query: 'port 3000'
    })
  })

  it('returns zero matched lines while preserving total count on miss', () => {
    expect(filterLogLines(sample, 'nonexistent')).toEqual({
      lines: [],
      matched: 0,
      total: 4,
      query: 'nonexistent'
    })
  })

  it('handles empty log buffers without mutating the source array', () => {
    const empty: string[] = []
    expect(filterLogLines(empty, 'error')).toEqual({
      lines: [],
      matched: 0,
      total: 0,
      query: 'error'
    })
    const result = filterLogLines(sample, '')
    result.lines.push('mutated')
    expect(sample).toHaveLength(4)
  })
})

describe('isNearLogBottom', () => {
  it('returns true when content does not overflow', () => {
    expect(isNearLogBottom(0, 400, 250)).toBe(true)
    expect(isNearLogBottom(0, 400, 400)).toBe(true)
  })

  it('evaluates the bottom threshold boundary accurately', () => {
    const scrollHeight = 1000
    const clientHeight = 300
    const exactBottom = scrollHeight - clientHeight

    expect(isNearLogBottom(exactBottom, clientHeight, scrollHeight)).toBe(true)
    expect(
      isNearLogBottom(exactBottom - DEFAULT_LOG_BOTTOM_THRESHOLD_PX, clientHeight, scrollHeight)
    ).toBe(true)
    expect(
      isNearLogBottom(exactBottom - DEFAULT_LOG_BOTTOM_THRESHOLD_PX - 1, clientHeight, scrollHeight)
    ).toBe(false)
  })

  it('supports custom thresholds including zero', () => {
    expect(isNearLogBottom(700, 300, 1000, 0)).toBe(true)
    expect(isNearLogBottom(699, 300, 1000, 0)).toBe(false)
    expect(isNearLogBottom(650, 300, 1000, 50)).toBe(true)
  })

  it('fails open to following when measurements are non-finite', () => {
    expect(isNearLogBottom(Number.NaN, 300, 1000)).toBe(true)
  })
})

describe('room provider log configuration', () => {
  it('selects default log kind per provider', () => {
    expect(defaultLogKind('web')).toBe('web')
    expect(defaultLogKind('android')).toBe('web')
    expect(defaultLogKind('windows')).toBe('orchestrator')
  })

  it('selects primary log label key per provider', () => {
    expect(primaryLogLabelKey('web')).toBe('logs.web')
    expect(primaryLogLabelKey('android')).toBe('logs.android')
    expect(primaryLogLabelKey('windows')).toBeNull()
  })

  it('provides localized labels for all supported locales', () => {
    const keys = [
      'logs.web',
      'logs.android',
      'logs.empty',
      'logs.filterPlaceholder',
      'logs.clearFilter',
      'logs.noMatches',
      'logs.follow',
      'logs.paused',
      'logs.copied',
      'logs.copyFailed'
    ] as const

    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(translate(locale.id, key).trim().length).toBeGreaterThan(0)
      }
      expect(translate(locale.id, 'logs.matchCount', { matched: 3, total: 10 })).toBe('3 / 10')
    }
  })
})
