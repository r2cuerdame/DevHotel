import { useEffect, useMemo, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore, useT } from '../../state/store'
import {
  defaultLogKind,
  filterLogLines,
  isNearLogBottom,
  primaryLogLabelKey,
  type LogKind
} from './logView'

export function LogsTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const primaryLabelKey = primaryLogLabelKey(room.provider)
  const [kindSelection, setKindSelection] = useState<{ roomId: string; kind: LogKind }>(() => ({
    roomId: room.id,
    kind: defaultLogKind(room.provider)
  }))
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const effectiveKind: LogKind =
    primaryLabelKey === null
      ? 'orchestrator'
      : kindSelection.roomId === room.id
        ? kindSelection.kind
        : defaultLogKind(room.provider)
  const key = `${room.id}:${effectiveKind}`
  const lines = useStore((s) => s.logs[key] ?? [])
  const appendLog = useStore((s) => s.appendLog)
  const clearLog = useStore((s) => s.clearLog)
  const toast = useStore((s) => s.toast)
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => filterLogLines(lines, query), [lines, query])

  useEffect(() => {
    setKindSelection({ roomId: room.id, kind: defaultLogKind(room.provider) })
    setQuery('')
    setFollow(true)
  }, [room.id, room.provider])

  useEffect(() => {
    setFollow(true)
    let active = true
    clearLog(key)
    void api.logs.tailStart(room.id, effectiveKind).then(({ lines: initial }) => {
      if (active) appendLog(key, initial)
    })
    return () => {
      active = false
      void api.logs.tailStop(room.id, effectiveKind)
    }
  }, [room.id, effectiveKind, key, appendLog, clearLog])

  useEffect(() => {
    if (!follow) return
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered.lines, follow])

  const handleScroll = (): void => {
    const el = boxRef.current
    if (!el) return
    const nearBottom = isNearLogBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    setFollow((prev) => (prev === nearBottom ? prev : nearBottom))
  }

  const handleToggleFollow = (): void => {
    if (follow) {
      setFollow(false)
      return
    }
    setFollow(true)
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const handleCopy = async (): Promise<void> => {
    if (filtered.lines.length === 0) return
    try {
      await navigator.clipboard.writeText(filtered.lines.join('\n'))
      toast('success', t('logs.copied'))
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('logs.copyFailed'))
    }
  }

  return (
    <div className="logs-tab">
      <div className="row wrap logs-toolbar">
        {primaryLabelKey && (
          <button
            type="button"
            className="btn"
            data-active={effectiveKind === 'web'}
            onClick={() => setKindSelection({ roomId: room.id, kind: 'web' })}
            style={effectiveKind === 'web' ? { borderColor: 'var(--brass)' } : undefined}
          >
            {t(primaryLabelKey)}
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-active={effectiveKind === 'orchestrator'}
          onClick={() => setKindSelection({ roomId: room.id, kind: 'orchestrator' })}
          style={effectiveKind === 'orchestrator' ? { borderColor: 'var(--brass)' } : undefined}
        >
          DevHotel
        </button>
        <div className="logs-filter">
          <input
            type="search"
            className="logs-filter-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('logs.filterPlaceholder')}
            aria-label={t('logs.filterPlaceholder')}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="icon-btn logs-filter-clear"
              onClick={() => setQuery('')}
              aria-label={t('logs.clearFilter')}
              title={t('logs.clearFilter')}
            >
              ×
            </button>
          )}
        </div>
        <span className="logs-count mono muted">
          {t('logs.matchCount', { matched: filtered.matched, total: filtered.total })}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          data-active={follow}
          aria-pressed={follow}
          onClick={handleToggleFollow}
          style={follow ? { borderColor: 'var(--brass)' } : undefined}
        >
          {follow ? t('logs.follow') : t('logs.paused')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={filtered.lines.length === 0}
          onClick={() => void handleCopy()}
        >
          {t('common.copy')}
        </button>
        <button type="button" className="btn" onClick={() => clearLog(key)}>
          {t('common.clear')}
        </button>
      </div>
      <div ref={boxRef} className="log-box" onScroll={handleScroll}>
        {lines.length === 0 ? (
          <span className="muted">{t('logs.empty')}</span>
        ) : filtered.lines.length === 0 ? (
          <span className="muted">{t('logs.noMatches')}</span>
        ) : (
          filtered.lines.join('\n')
        )}
      </div>
    </div>
  )
}
