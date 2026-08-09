import type { RoomRecord } from '@devhotel/shared'
import { useT } from '../state/store'
import type { Translation } from '../i18n'
import { OverviewTab } from './tabs/Overview'
import { StackTab } from './tabs/Stack'
import { ActivityTab } from './tabs/Activity'
import { SystemTab } from './tabs/System'
import { DiagnosticsTab } from './tabs/Diagnostics'
import { ConsoleTab } from './tabs/Console'

export type RoomPage = 'site' | 'overview' | 'stack' | 'activity' | 'system' | 'health' | 'console'

export const ROOM_PAGES: { id: Exclude<RoomPage, 'site'>; icon: string; key: keyof Translation }[] = [
  { id: 'overview', icon: '⌂', key: 'tabs.overview' },
  { id: 'stack', icon: '⬢', key: 'tabs.stack' },
  { id: 'system', icon: '⌘', key: 'tabs.system' },
  { id: 'activity', icon: '≡', key: 'tabs.activity' },
  { id: 'health', icon: '✚', key: 'tabs.health' },
  { id: 'console', icon: '❯', key: 'tabs.console' }
]

/**
 * Full-page room screens — like a browser's internal pages. The site and these
 * pages take turns covering the whole view; nothing squeezes the site.
 */
export function RoomPages({
  room,
  page,
  onNavigate
}: {
  room: RoomRecord
  page: Exclude<RoomPage, 'site'>
  onNavigate: (page: RoomPage) => void
}): React.JSX.Element {
  const t = useT()
  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'

  return (
    <div className="room-page">
      <nav className="panel-tabs page-nav">
        <button className="panel-tab" data-active={false} disabled={!running} onClick={() => onNavigate('site')} title={room.domain}>
          <span className="tab-icon" aria-hidden>
            ◉
          </span>
          {t('tabs.site')}
        </button>
        <span className="page-nav-sep" />
        {ROOM_PAGES.map(({ id, icon, key }) => (
          <button key={id} className="panel-tab" data-active={page === id} onClick={() => onNavigate(id)}>
            <span className="tab-icon" aria-hidden>
              {icon}
            </span>
            {t(key)}
          </button>
        ))}
      </nav>
      <div className="room-page-inner">
        {page === 'overview' && <OverviewTab room={room} onShowHealth={() => onNavigate('health')} />}
        {page === 'stack' && <StackTab room={room} />}
        {page === 'system' && <SystemTab room={room} />}
        {page === 'activity' && <ActivityTab room={room} />}
        {page === 'health' && <DiagnosticsTab room={room} />}
        {page === 'console' && <ConsoleTab room={room} />}
      </div>
    </div>
  )
}
