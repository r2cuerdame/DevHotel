import { useEffect } from 'react'
import { useStore } from './state/store'
import { Lobby } from './lobby/Lobby'
import { RoomView } from './room/RoomView'

export function App(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)
  const init = useStore((s) => s.init)

  useEffect(() => {
    init()
  }, [init])

  return (
    <>
      {view.name === 'lobby' ? <Lobby /> : <RoomView key={view.roomId} roomId={view.roomId} />}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <button key={t.id} className="toast" data-kind={t.kind} onClick={() => dismissToast(t.id)}>
            {t.text}
          </button>
        ))}
      </div>
    </>
  )
}
