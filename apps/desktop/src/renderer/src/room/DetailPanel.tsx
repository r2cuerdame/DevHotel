import { useEffect, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../state/store'
import type { Translation } from '../i18n'
import { OverviewTab } from './tabs/Overview'
import { StackTab } from './tabs/Stack'
import { LogsTab } from './tabs/Logs'
import { ChangesTab } from './tabs/Changes'
import { DiagnosticsTab } from './tabs/Diagnostics'
import { ConsoleTab } from './tabs/Console'

const TABS: { id: Tab; icon: string; key: keyof Translation }[] = [
  { id: 'overview', icon: '⌂', key: 'tabs.overview' },
  { id: 'stack', icon: '⬢', key: 'tabs.stack' },
  { id: 'activity', icon: '≡', key: 'tabs.activity' },
  { id: 'health', icon: '✚', key: 'tabs.health' },
  { id: 'console', icon: '❯', key: 'tabs.console' }
]
type Tab = 'overview' | 'stack' | 'activity' | 'health' | 'console'

export function DetailPanel({ room }: { room: RoomRecord }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const refreshInspection = useStore((s) => s.refreshInspection)
  const t = useT()

  useEffect(() => {
    void refreshInspection(room.id)
  }, [room.id, refreshInspection])

  return (
    <aside className="detail-panel">
      <nav className="panel-tabs">
        {TABS.map(({ id, icon, key }) => (
          <button key={id} className="panel-tab" data-active={tab === id} onClick={() => setTab(id)}>
            <span className="tab-icon" aria-hidden>
              {icon}
            </span>
            {t(key)}
          </button>
        ))}
      </nav>
      <div className="panel-content">
        {tab === 'overview' && <OverviewTab room={room} onShowHealth={() => setTab('health')} />}
        {tab === 'stack' && <StackTab room={room} />}
        {tab === 'activity' && <ActivityTab room={room} />}
        {tab === 'health' && <DiagnosticsTab room={room} />}
        {tab === 'console' && <ConsoleTab room={room} />}
      </div>
    </aside>
  )
}

function ActivityTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const [mode, setMode] = useState<'changes' | 'logs'>('changes')
  const t = useT()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="seg">
        <button data-active={mode === 'changes'} onClick={() => setMode('changes')}>
          {t('tabs.changes')}
        </button>
        <button data-active={mode === 'logs'} onClick={() => setMode('logs')}>
          {t('tabs.logs')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: mode === 'changes' ? 'auto' : 'hidden' }}>
        {mode === 'changes' ? <ChangesTab room={room} /> : <LogsTab room={room} />}
      </div>
    </div>
  )
}
