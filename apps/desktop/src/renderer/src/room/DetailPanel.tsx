import { useEffect } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import type { Translation } from '../i18n'
import { useStore, useT } from '../state/store'
import { ActivityTab } from './tabs/Activity'
import { ConsoleTab } from './tabs/Console'
import { DiagnosticsTab } from './tabs/Diagnostics'
import { OverviewTab } from './tabs/Overview'
import { StackTab } from './tabs/Stack'
import { SystemTab } from './tabs/System'

export type ConfigTab = 'overview' | 'stack' | 'system' | 'activity' | 'health' | 'console'

const TABS: { id: ConfigTab; icon: string; key: keyof Translation }[] = [
  { id: 'overview', icon: '⌂', key: 'tabs.overview' },
  { id: 'stack', icon: '⬢', key: 'tabs.stack' },
  { id: 'system', icon: '⌘', key: 'tabs.system' },
  { id: 'activity', icon: '≡', key: 'tabs.activity' },
  { id: 'health', icon: '✚', key: 'tabs.health' },
  { id: 'console', icon: '❯', key: 'tabs.console' }
]

export function RoomConfig({
  room,
  tab,
  onTabChange,
  onClose,
  closable = true
}: {
  room: RoomRecord
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
  onClose: () => void
  closable?: boolean
}): React.JSX.Element {
  const refreshInspection = useStore((s) => s.refreshInspection)
  const t = useT()

  useEffect(() => {
    void refreshInspection(room.id)
  }, [room.id, refreshInspection])

  return (
    <section className="room-config" aria-label={t('bar.roomDetails')}>
      <header className="room-config-head">
        <span className="room-no">№ {room.roomNumber}</span>
        <strong title={`${room.project} / ${room.nickname}`}>
          {room.project} <span>/ {room.nickname}</span>
        </strong>
        {closable && (
          <button className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        )}
      </header>
      <nav className="panel-tabs" aria-label={t('bar.roomDetails')}>
        {TABS.map(({ id, icon, key }) => (
          <button
            key={id}
            className="panel-tab"
            data-active={tab === id}
            title={t(key)}
            onClick={() => onTabChange(id)}
          >
            <span className="tab-icon" aria-hidden>
              {icon}
            </span>
            <span>{t(key)}</span>
          </button>
        ))}
      </nav>
      <div className="panel-content">
        {tab === 'overview' && <OverviewTab room={room} onShowHealth={() => onTabChange('health')} />}
        {tab === 'stack' && <StackTab room={room} />}
        {tab === 'system' && <SystemTab room={room} />}
        {tab === 'activity' && <ActivityTab room={room} />}
        {tab === 'health' && <DiagnosticsTab room={room} />}
        {tab === 'console' && <ConsoleTab room={room} />}
      </div>
    </section>
  )
}
