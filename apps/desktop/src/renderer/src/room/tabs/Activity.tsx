import { useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useT } from '../../state/store'
import { ChangesTab } from './Changes'
import { LogsTab } from './Logs'

export function ActivityTab({ room }: { room: RoomRecord }): React.JSX.Element {
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
