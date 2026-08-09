import { useEffect, useState } from 'react'
import type { McpSetupInfo } from '@devhotel/shared'
import { api } from '../api'
import { useStore } from '../state/store'

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const caStatus = useStore((s) => s.caStatus)
  const [mcp, setMcp] = useState<McpSetupInfo | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api.app.mcpInfo().then(setMcp)
    void api.app.version().then(setVersion)
  }, [])

  async function copy(text: string, what: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    toast('success', `${what} copied`)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="panel-section">
          <h3>MCP — let agents use rooms</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            The DevHotel MCP server lets Claude Code and other agents create, run, and change rooms instead of installing
            things on your PC. Every agent change shows up in the room's Changes list and can be undone.
          </p>
          {mcp && !mcp.available && (
            <p className="small" style={{ color: 'var(--warn)' }}>
              MCP server script not found — run <code>pnpm --filter devhotel-mcp build</code> in the repo first.
            </p>
          )}
          {mcp?.available && (
            <>
              <div className="field">
                <label>Claude Code — one command</label>
                <div className="row">
                  <input className="mono" readOnly value={mcp.claudeCommand} style={{ flex: 1 }} />
                  <button className="btn" onClick={() => void copy(mcp.claudeCommand, 'Command')}>
                    Copy
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Any MCP client — mcpServers config</label>
                <div className="row" style={{ alignItems: 'stretch' }}>
                  <pre
                    className="mono"
                    style={{
                      flex: 1,
                      margin: 0,
                      background: 'var(--ink)',
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      fontSize: 11,
                      overflow: 'auto'
                    }}
                  >
                    {mcp.configJson}
                  </pre>
                  <button className="btn" onClick={() => void copy(mcp.configJson, 'Config')}>
                    Copy
                  </button>
                </div>
              </div>
              <p className="small muted">
                {mcp.controlPort
                  ? `The MCP server talks to this app on 127.0.0.1:${mcp.controlPort} — DevHotel must be running.`
                  : 'DevHotel must be running for MCP tools to work.'}
              </p>
            </>
          )}
        </div>

        <div className="panel-section">
          <h3>HTTPS certificates</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Room previews trust DevHotel's local certificates automatically. Trust the DevHotel Local CA in Windows to
            avoid warnings in external browsers.
          </p>
          <div className="row">
            <span className="small">
              CA status: <b>{caStatus === 'trusted' ? 'trusted' : caStatus === 'untrusted' ? 'not trusted' : 'not created yet'}</b>
            </span>
            {caStatus !== 'trusted' ? (
              <button
                className="btn"
                onClick={() => {
                  void api.ca
                    .trust()
                    .then(() => toast('success', 'DevHotel Local CA trusted for your Windows user'))
                    .catch((err: unknown) => toast('error', String(err)))
                }}
              >
                Trust CA
              </button>
            ) : (
              <button
                className="btn danger"
                onClick={() => {
                  void api.ca
                    .untrust()
                    .then(() => toast('success', 'DevHotel Local CA removed from Windows trust'))
                    .catch((err: unknown) => toast('error', String(err)))
                }}
              >
                Remove trust
              </button>
            )}
          </div>
        </div>

        <div className="panel-section">
          <h3>About</h3>
          <p className="small muted" style={{ margin: 0 }}>
            DevHotel {version} — every project gets its own room.
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
