import { useEffect, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../state/store'
import { OverviewTab } from './tabs/Overview'
import { StackTab } from './tabs/Stack'
import { ServicesTab } from './tabs/Services'
import { LogsTab } from './tabs/Logs'
import { ChangesTab } from './tabs/Changes'
import { DiagnosticsTab } from './tabs/Diagnostics'
import { ConsoleTab } from './tabs/Console'

const TABS = ['overview', 'stack', 'services', 'logs', 'changes', 'diagnostics', 'console'] as const
type Tab = (typeof TABS)[number]

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
        {TABS.map((id) => (
          <button key={id} className="panel-tab" data-active={tab === id} onClick={() => setTab(id)}>
            {t(`tabs.${id}`)}
          </button>
        ))}
      </nav>
      <div className="panel-content">
        {tab === 'overview' && <OverviewTab room={room} />}
        {tab === 'stack' && <StackTab room={room} />}
        {tab === 'services' && <ServicesTab room={room} />}
        {tab === 'logs' && <LogsTab room={room} />}
        {tab === 'changes' && <ChangesTab room={room} />}
        {tab === 'diagnostics' && <DiagnosticsTab room={room} />}
        {tab === 'console' && <ConsoleTab room={room} />}
      </div>
    </aside>
  )
}
