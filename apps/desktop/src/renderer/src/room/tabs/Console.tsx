import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { RoomRecord } from '@devhotel/shared'
import { IPC } from '@devhotel/shared'
import { api } from '../../api'

export function ConsoleTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 12,
      theme: { background: '#10141a', foreground: '#e8e4dc', cursor: '#c9a35c' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    let termId: string | null = null
    let disposed = false
    const offData = api.on(IPC.evTermData, (id: string, data: string) => {
      if (id === termId) term.write(data)
    })
    const offExit = api.on(IPC.evTermExit, (id: string) => {
      if (id === termId) term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n')
    })

    void api.term
      .open(room.id)
      .then(({ termId: id }) => {
        if (disposed) {
          api.term.close(id)
          return
        }
        termId = id
        api.term.resize(id, term.cols, term.rows)
        term.onData((data) => api.term.input(id, data))
        term.onResize(({ cols, rows }) => api.term.resize(id, cols, rows))
      })
      .catch((err: unknown) => {
        term.write(`\x1b[31mCould not open a terminal in this room: ${String(err)}\x1b[0m\r\n`)
        term.write('\x1b[90mThe room must be awake for a terminal session.\x1b[0m\r\n')
      })

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      offData()
      offExit()
      if (termId) api.term.close(termId)
      term.dispose()
    }
  }, [room.id])

  return (
    <div className="console-tab">
      <div ref={hostRef} className="term-host" />
      <p className="small muted" style={{ margin: 0 }}>
        This shell runs inside the room, not on your PC. Installs and tools stay in the room.
      </p>
    </div>
  )
}
