import { useState } from 'react'
import type { ResetServiceMode, RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../state/store'

/**
 * The mirror of Clone: Clone carries a Room's state forward, Reset gives back
 * everything the Room can rebuild for itself. Source code is never touched —
 * restoring code stays Sync from Host / Git (goal.md §13.3).
 */
export function ResetRoomModal({ room, onClose }: { room: RoomRecord; onClose: () => void }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
  const android = room.provider === 'android'
  const hasServices = Object.keys(room.services).length > 0
  const awake = room.status === 'running' || room.status === 'ready' || room.status === 'attention'

  const [reinstallDependencies, setReinstallDependencies] = useState(room.sourceType !== 'empty' && !android)
  const [clearCaches, setClearCaches] = useState(true)
  const [services, setServices] = useState<ResetServiceMode>('keep')
  const [clearBrowserData, setClearBrowserData] = useState(!android)
  const [confirmation, setConfirmation] = useState('')
  const [resetting, setResetting] = useState(false)

  const nothingChosen = !reinstallDependencies && !clearCaches && services === 'keep' && !clearBrowserData
  const confirmed = confirmation.trim().toLocaleLowerCase() === room.nickname.toLocaleLowerCase()

  async function submit(): Promise<void> {
    if (nothingChosen || !confirmed || resetting) return
    setResetting(true)
    const entry = await applyChange(room.id, {
      kind: 'room-reset',
      reinstallDependencies,
      clearCaches,
      services,
      clearBrowserData
    })
    if (entry) {
      onClose()
      return
    }
    setResetting(false)
  }

  return (
    <div className="modal-backdrop" onClick={() => !resetting && onClose()}>
      <form
        className="modal clone-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2>{t('reset.title')}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {t('reset.rule')}
        </p>

        <label className="clone-option">
          <input
            type="checkbox"
            checked={reinstallDependencies}
            disabled={room.sourceType === 'empty' || android}
            onChange={(event) => setReinstallDependencies(event.target.checked)}
          />
          <span>
            <b>{t('reset.dependencies')}</b>
            <small>{t('reset.dependenciesHint')}</small>
          </span>
        </label>

        <label className="clone-option">
          <input type="checkbox" checked={clearCaches} onChange={(event) => setClearCaches(event.target.checked)} />
          <span>
            <b>{android ? t('reset.cachesAndroid') : t('reset.caches')}</b>
            <small>{t('reset.cachesHint')}</small>
          </span>
        </label>

        <label className="clone-option">
          <input
            type="checkbox"
            checked={clearBrowserData}
            disabled={android}
            onChange={(event) => setClearBrowserData(event.target.checked)}
          />
          <span>
            <b>{t('reset.browser')}</b>
            <small>{t('reset.browserHint')}</small>
          </span>
        </label>

        <fieldset className="clone-services" disabled={!hasServices || !awake}>
          <legend>{t('clone.serviceMode')}</legend>
          <div className="row wrap">
            {(
              [
                ['keep', 'reset.servicesKeep'],
                ['empty', 'reset.servicesEmpty'],
                ['remove', 'reset.servicesRemove']
              ] as [ResetServiceMode, 'reset.servicesKeep' | 'reset.servicesEmpty' | 'reset.servicesRemove'][]
            ).map(([value, key]) => (
              <label key={value} className="row small" style={{ gap: 6 }}>
                <input
                  type="radio"
                  name="reset-services"
                  value={value}
                  checked={services === value}
                  onChange={() => setServices(value)}
                />
                {t(key)}
              </label>
            ))}
          </div>
          {hasServices ? (
            <small>{awake ? t('reset.servicesHint') : t('reset.servicesAsleep')}</small>
          ) : (
            <small>{t('clone.noServices')}</small>
          )}
        </fieldset>

        <div className="field">
          <label htmlFor="reset-confirm">{t('reset.confirmLabel', { nickname: room.nickname })}</label>
          <input
            id="reset-confirm"
            value={confirmation}
            autoFocus
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" disabled={resetting} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn danger" disabled={nothingChosen || !confirmed || resetting}>
            {resetting ? t('reset.resetting') : t('reset.submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
