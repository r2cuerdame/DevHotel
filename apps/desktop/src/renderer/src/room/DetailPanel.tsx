import { useEffect, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore } from '../state/store'
import { OverviewTab } from './tabs/Overview'
import { StackTab } from './tabs/Stack'
import { ServicesTab } from './tabs/Services'
import { LogsTab } from './tabs/Logs'
import { ChangesTab } from './tabs/Changes'
import { DiagnosticsTab } from './tabs/Diagnostics'
import { ConsoleTab } from './tabs/Console'

const TABS = ['Overview', 'Stack', 'Services', 'Logs', 'Changes', 'Diagnostics', 'Console'] as const
type Tab = (typeof TABS)[number]

export function DetailPanel({ room }: { room: RoomRecord }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('Overview')
  const refreshInspection = useStore((s) => s.refreshInspection)

  useEffect(() => {
    void refreshInspection(room.id)
  }, [room.id, refreshInspection])

  return (
    <aside className="detail-panel">
      <nav className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} className="panel-tab" data-active={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="panel-content">
        {tab === 'Overview' && <OverviewTab room={room} />}
        {tab === 'Stack' && <StackTab room={room} />}
        {tab === 'Services' && <ServicesTab room={room} />}
        {tab === 'Logs' && <LogsTab room={room} />}
        {tab === 'Changes' && <ChangesTab room={room} />}
        {tab === 'Diagnostics' && <DiagnosticsTab room={room} />}
        {tab === 'Console' && <ConsoleTab room={room} />}
      </div>
    </aside>
  )
}
