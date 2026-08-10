import { useEffect, useState } from 'react'
import type { GitHubServiceStatus, McpRegistryItem } from '@devhotel/shared'
import { api } from '../api'
import { useT } from '../state/store'

type Tab = 'infrastructure' | 'mcp' | 'skills'

export function HotelServicesModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<Tab>('infrastructure')
  const [github, setGithub] = useState<GitHubServiceStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const [query, setQuery] = useState('')
  const [mcp, setMcp] = useState<McpRegistryItem[]>([])
  const [loadingMcp, setLoadingMcp] = useState(false)

  const refresh = (): void => { void api.hotel.githubStatus().then(setGithub).catch((e: unknown) => setError(String(e))) }
  useEffect(refresh, [])
  useEffect(() => {
    if (tab !== 'mcp') return
    const timer = setTimeout(() => {
      setLoadingMcp(true)
      void api.hotel.mcpBrowse(query).then((page) => setMcp(page.items)).catch((e: unknown) => setError(String(e))).finally(() => setLoadingMcp(false))
    }, query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [query, tab])
  const action = (name: string, job: () => Promise<GitHubServiceStatus>): void => {
    setBusy(name); setError(''); void job().then(setGithub).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(''))
  }
  const connect = (): void => {
    const submitted = token
    setToken('')
    action('connect', () => api.hotel.githubConnect(submitted))
  }
  const githubStatus = !github
    ? t('hotelServices.checking')
    : github.installing
      ? t('hotelServices.preparing')
      : !github.installed
        ? t('hotelServices.repair')
        : github.credentialState === 'unavailable'
          ? t('hotelServices.credentialUnavailable')
          : github.credentialState === 'temporarily-unavailable'
            ? t('hotelServices.credentialTemporarilyUnavailable')
            : github.credentialState === 'invalid'
              ? t('hotelServices.credentialInvalid')
              : github.authenticated
                ? t('hotelServices.connected', { account: github.account ?? '' })
                : t('hotelServices.disconnected')

  return (
    <div className="hotel-services-screen">
      <header className="hotel-services-header">
        <div><span className="eyebrow">HOTEL LAYER</span><h1>{t('hotelServices.title')}</h1><p>{t('hotelServices.subtitle')}</p></div>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </header>
      <nav className="hotel-services-tabs">
        <button data-active={tab === 'infrastructure'} onClick={() => setTab('infrastructure')}>{t('hotelServices.infrastructure')}</button>
        <button data-active={tab === 'mcp'} onClick={() => setTab('mcp')}>{t('hotelServices.mcp')}</button>
        <button data-active={tab === 'skills'} onClick={() => setTab('skills')}>{t('hotelServices.skills')}</button>
      </nav>
      {error && <div className="hotel-service-error">{error}</div>}
      <main className="hotel-services-content">
        {tab === 'infrastructure' && <>
          <section className="hotel-service-card featured">
            <div className="hotel-service-icon">GH</div>
            <div className="hotel-service-body">
              <div className="row wrap"><h2>{t('hotelServices.github')}</h2><span className="service-pill">{t('hotelServices.builtIn')}</span><span className="service-pill">CLI</span></div>
              <p>{t('hotelServices.githubDesc')}</p>
              <div className="service-status">{githubStatus}{github?.version ? ` · gh ${github.version}` : ''}</div>
              <p className="small muted">{t('hotelServices.scope')}</p>
              {github?.installed && (github.credentialState === 'disconnected' || github.credentialState === 'invalid') && <div className="github-connect-form">
                <label htmlFor="github-hotel-token">{t('hotelServices.tokenLabel')}</label>
                <input
                  id="github-hotel-token"
                  type="password"
                  value={token}
                  minLength={20}
                  maxLength={512}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!!busy || !github.credentialVaultAvailable}
                  placeholder={t('hotelServices.tokenPlaceholder')}
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && token && !busy && github.credentialVaultAvailable) connect() }}
                />
                <p className="small muted">{t('hotelServices.tokenHint')}</p>
              </div>}
              <div className="row wrap">
                {github?.installed
                  ? github.credentialState !== 'disconnected' && github.credentialState !== 'invalid'
                    ? <button className="btn danger" disabled={!!busy} onClick={() => action('disconnect', () => api.hotel.githubDisconnect())}>{busy === 'disconnect' ? t('hotelServices.disconnecting') : t('hotelServices.disconnect')}</button>
                    : <button className="btn primary" disabled={!!busy || !token || !github.credentialVaultAvailable} onClick={connect}>{busy === 'connect' ? t('hotelServices.connecting') : t('hotelServices.connect')}</button>
                  : <button className="btn" disabled={!!busy} onClick={() => action('provision', () => api.hotel.githubInstall())}>{t('hotelServices.prepare')}</button>}
                <button className="btn" disabled={!!busy} onClick={() => { void api.app.openExternal('https://github.com/settings/personal-access-tokens/new') }}>{t('hotelServices.tokenSettings')}</button>
                <button className="btn" disabled={!!busy} onClick={refresh}>{t('hotelServices.refresh')}</button>
              </div>
              <p className="small muted">{github && !github.credentialVaultAvailable ? t('hotelServices.secureStorageUnavailable') : t('hotelServices.credentials')}</p>
            </div>
          </section>
          <section className="hotel-taxonomy">
            <h3>{t('hotelServices.taxonomy')}</h3>
            <p>{t('hotelServices.hotelTools')}</p><p>{t('hotelServices.roomTools')}</p>
          </section>
        </>}
        {tab === 'mcp' && <>
          <div className="store-discovery-head"><div><h2>{t('hotelServices.registry')}</h2><p>{t('hotelServices.registryHint')}</p></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('hotelServices.searchRegistry')} /></div>
          {loadingMcp && <p className="muted">{t('hotelServices.loadingRegistry')}</p>}
          <div className="hotel-catalog-grid">{mcp.map((item) => <article className="hotel-catalog-card" key={`${item.id}@${item.version}`}><h3>{item.title}</h3><p>{item.description || item.name}</p><div className="small muted">{item.version} · {item.status}</div><div className="row wrap"><span className="service-pill">{item.installMode === 'remote-http' ? 'HTTPS' : `${item.packageKinds.join('/') || 'Package'} · ${t('hotelServices.runtimeRequired')}`}</span><button className="btn" disabled>{t('hotelServices.comingNext')}</button></div></article>)}</div>
        </>}
        {tab === 'skills' && <section className="hotel-taxonomy"><h2>{t('hotelServices.skillsFoundation')}</h2><p>{t('hotelServices.skillsHint')}</p><span className="service-pill">{t('hotelServices.comingNext')}</span></section>}
      </main>
    </div>
  )
}
