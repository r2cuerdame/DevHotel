import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore, useT } from '../state/store'
import { LOCALES } from '../i18n'
import type { LocaleId } from '../i18n'

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const caStatus = useStore((s) => s.caStatus)
  const lang = useStore((s) => s.lang)
  const setLang = useStore((s) => s.setLang)
  const t = useT()
  const [version, setVersion] = useState('')
  const [footprint, setFootprint] = useState<{ dataDir: string; installDir: string; autostart: boolean } | null>(null)
  const [autostart, setAutostart] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  useEffect(() => {
    void api.app.version().then(setVersion)
    void api.app.footprint().then((f) => {
      setFootprint(f)
      setAutostart(f.autostart)
    })
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings.title')}</h2>

        <div className="panel-section settings-card">
          <h3>🌐 {t('settings.language')}</h3>
          <select value={lang} onChange={(e) => setLang(e.target.value as LocaleId)} style={{ width: 220 }}>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="panel-section settings-card">
          <h3>🔒 {t('settings.httpsTitle')}</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            {t('settings.httpsDesc')}
          </p>
          <div className="row">
            <span className="small">
              {t('settings.caStatus')}{' '}
              <b>{caStatus === 'trusted' ? t('settings.caTrusted') : caStatus === 'untrusted' ? t('settings.caUntrusted') : t('settings.caMissing')}</b>
            </span>
            {caStatus !== 'trusted' ? (
              <button
                className="btn"
                onClick={() => {
                  void api.ca
                    .trust()
                    .then(() => toast('success', t('toast.caTrusted')))
                    .catch((err: unknown) => toast('error', String(err)))
                }}
              >
                {t('settings.trustCa')}
              </button>
            ) : (
              <button
                className="btn danger"
                onClick={() => {
                  void api.ca
                    .untrust()
                    .then(() => toast('success', t('toast.caUntrusted')))
                    .catch((err: unknown) => toast('error', String(err)))
                }}
              >
                {t('settings.untrustCa')}
              </button>
            )}
          </div>
        </div>

        <div className="panel-section settings-card">
          <h3>🧳 {t('footprint.title')}</h3>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('footprint.app')}</li>
            <li>{t('footprint.appData')}</li>
            <li>{t('footprint.docker')}</li>
            <li>{t('footprint.ca')}</li>
            <li>{t('footprint.autostart')}</li>
          </ul>
          <p className="small" style={{ margin: '8px 0 0' }}>
            {t('footprint.nothingElse')}
          </p>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => footprint && void api.app.openPath(footprint.dataDir)}>
              {t('footprint.openData')}
            </button>
            <button className="btn" onClick={() => footprint && void api.app.openPath(footprint.installDir)}>
              {t('footprint.openApp')}
            </button>
            <label className="row small" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={autostart}
                onChange={(e) => {
                  setAutostart(e.target.checked)
                  void api.app.setAutostart(e.target.checked)
                }}
              />
              {t('footprint.autostart')}
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn danger"
              disabled={cleaning}
              onClick={() => {
                if (window.confirm(t('footprint.cleanUninstallConfirm'))) {
                  setCleaning(true)
                  void api.app
                    .cleanUninstall()
                    .then((scheduled) => {
                      if (!scheduled) setCleaning(false)
                    })
                    .catch((error: unknown) => {
                      setCleaning(false)
                      toast('error', error instanceof Error ? error.message : String(error))
                    })
                }
              }}
            >
              {cleaning ? t('footprint.cleaning') : t('footprint.cleanUninstall')}
            </button>
          </div>
        </div>

        <div className="panel-section settings-card">
          <h3>ⓘ {t('settings.about')}</h3>
          <p className="small muted" style={{ margin: 0 }}>
            {t('settings.aboutLine', { version })}
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
