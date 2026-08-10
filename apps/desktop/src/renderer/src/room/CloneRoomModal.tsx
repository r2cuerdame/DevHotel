import { useMemo, useState } from 'react'
import type { CloneServiceMode, RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../state/store'

function nextNickname(room: RoomRecord, rooms: RoomRecord[]): string {
  const taken = new Set(
    rooms.filter((candidate) => candidate.project === room.project).map((candidate) => candidate.nickname.toLocaleLowerCase())
  )
  const base = `${room.nickname}-copy`
  if (!taken.has(base.toLocaleLowerCase())) return base
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate
  }
  return `${base}-${Date.now().toString().slice(-4)}`
}

export function CloneRoomModal({ room, onClose }: { room: RoomRecord; onClose: () => void }): React.JSX.Element {
  const rooms = useStore((s) => s.rooms)
  const cloneRoom = useStore((s) => s.cloneRoom)
  const t = useT()
  const [nickname, setNickname] = useState(() => nextNickname(room, rooms))
  const [copyDependencies, setCopyDependencies] = useState(true)
  const hasServices = Object.keys(room.services).length > 0
  const [services, setServices] = useState<CloneServiceMode>(hasServices ? 'copy' : 'exclude')
  const [cloning, setCloning] = useState(false)

  const normalized = nickname.trim()
  const nicknameTaken = useMemo(
    () =>
      rooms.some(
        (candidate) =>
          candidate.project === room.project && candidate.nickname.toLocaleLowerCase() === normalized.toLocaleLowerCase()
      ),
    [normalized, room.project, rooms]
  )
  const nicknameError = !normalized ? t('clone.nicknameRequired') : nicknameTaken ? t('clone.nicknameTaken') : null

  async function submit(): Promise<void> {
    if (nicknameError || cloning) return
    setCloning(true)
    const cloned = await cloneRoom(room.id, { nickname: normalized, copyDependencies, services })
    if (cloned) {
      onClose()
      return
    }
    setCloning(false)
  }

  return (
    <div className="modal-backdrop" onClick={() => !cloning && onClose()}>
      <form
        className="modal clone-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2>{t('clone.title')}</h2>
        <p className="clone-source">
          <span>{t('clone.from')}</span>
          <strong>
            № {room.roomNumber} · {room.project} / {room.nickname}
          </strong>
        </p>

        <div className="field">
          <label htmlFor="clone-nickname">{t('wizard.nickname')}</label>
          <input
            id="clone-nickname"
            value={nickname}
            maxLength={60}
            aria-invalid={!!nicknameError}
            aria-describedby={nicknameError ? 'clone-nickname-error' : undefined}
            onChange={(event) => setNickname(event.target.value)}
            autoFocus
          />
          {nicknameError && (
            <small id="clone-nickname-error" className="field-error">
              {nicknameError}
            </small>
          )}
        </div>

        <label className="clone-option">
          <input
            type="checkbox"
            checked={copyDependencies}
            onChange={(event) => setCopyDependencies(event.target.checked)}
          />
          <span>
            <b>{t('clone.copyDependencies')}</b>
            <small>{t('clone.copyDependenciesHint')}</small>
          </span>
        </label>

        <fieldset className="clone-services" disabled={!hasServices}>
          <legend>{t('clone.serviceMode')}</legend>
          {hasServices ? (
            <>
              {(
                [
                  ['copy', 'clone.servicesCopy'],
                  ['empty', 'clone.servicesEmpty'],
                  ['exclude', 'clone.servicesExclude']
                ] as [CloneServiceMode, 'clone.servicesCopy' | 'clone.servicesEmpty' | 'clone.servicesExclude'][]
              ).map(([value, key]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="clone-services"
                    value={value}
                    checked={services === value}
                    onChange={() => setServices(value)}
                  />
                  {t(key)}
                </label>
              ))}
              <small>{t('clone.servicesCopyHint')}</small>
            </>
          ) : (
            <small>{t('clone.noServices')}</small>
          )}
        </fieldset>

        <div className="modal-actions">
          <button type="button" className="btn" disabled={cloning} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!!nicknameError || cloning}>
            {cloning ? t('busy.cloning') : t('clone.submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
