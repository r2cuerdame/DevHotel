import { useEffect, useMemo, useState } from 'react'
import type { RegistryPackageInfo, RoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { useStore, useT } from '../state/store'

type StoreTab = 'packages' | 'services'
type CategoryId = 'featured' | 'frontend' | 'backend' | 'testing' | 'tooling' | 'data'

const CATEGORIES: { id: CategoryId; query: string }[] = [
  { id: 'featured', query: 'keywords:web' },
  { id: 'frontend', query: 'keywords:frontend' },
  { id: 'backend', query: 'keywords:backend' },
  { id: 'testing', query: 'keywords:testing' },
  { id: 'tooling', query: 'keywords:build-tool' },
  { id: 'data', query: 'keywords:orm' }
]

const SERVICES: { id: 'postgres' | 'redis'; label: string; version: string; descriptionKey: 'packageStore.postgresDescription' | 'packageStore.redisDescription' }[] = [
  { id: 'postgres', label: 'PostgreSQL', version: '17', descriptionKey: 'packageStore.postgresDescription' },
  { id: 'redis', label: 'Redis', version: '8', descriptionKey: 'packageStore.redisDescription' }
]

function packageKey(pkg: RegistryPackageInfo): string {
  return `${pkg.name}@${pkg.version}`
}

export function PackageStoreModal({ room, onClose }: { room: RoomRecord; onClose: () => void }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
  const [tab, setTab] = useState<StoreTab>('packages')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryPackageInfo[]>([])
  const [categoryResults, setCategoryResults] = useState<Partial<Record<CategoryId, RegistryPackageInfo[]>>>({})
  const [selectedCategory, setSelectedCategory] = useState<CategoryId | null>(null)
  const [loading, setLoading] = useState(false)
  const [browseLoading, setBrowseLoading] = useState(true)
  const [browseFailed, setBrowseFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhaustedCategories, setExhaustedCategories] = useState<Partial<Record<CategoryId, boolean>>>({})
  const [error, setError] = useState<string | null>(null)
  const [devDependency, setDevDependency] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const canInstallPackage = room.workspaceMode === 'hotel'

  useEffect(() => {
    let active = true
    setBrowseLoading(true)
    setBrowseFailed(false)
    void (async () => {
      let loaded = 0
      // npm Registry can rate-limit request bursts. Browse shelves are
      // deliberately fetched one at a time; failures leave successful shelves usable.
      for (const category of CATEGORIES) {
        if (!active) return
        try {
          const items = await api.packages.search(category.query)
          if (!active) return
          setCategoryResults((current) => ({ ...current, [category.id]: items }))
          loaded++
        } catch {
          // A category shelf is optional discovery content; name search remains available.
        }
        if (!active) return
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120))
      }
      if (!active) return
      setBrowseFailed(loaded === 0)
      setBrowseLoading(false)
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      void api.packages
        .search(trimmed)
        .then((items) => {
          if (active) setResults(items)
        })
        .catch((err: unknown) => {
          if (active) {
            setResults([])
            setError(err instanceof Error ? err.message : String(err))
          }
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 350)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !installing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [installing, onClose])

  const searchActive = query.trim().length >= 2
  const selectedPackages = useMemo(
    () => (selectedCategory ? (categoryResults[selectedCategory] ?? []) : []),
    [categoryResults, selectedCategory]
  )

  async function installPackage(pkg: RegistryPackageInfo): Promise<void> {
    setInstalling(packageKey(pkg))
    try {
      await applyChange(room.id, {
        kind: 'package-install',
        name: pkg.name,
        version: pkg.version,
        dev: devDependency
      })
    } finally {
      setInstalling(null)
    }
  }

  async function installService(service: (typeof SERVICES)[number]): Promise<void> {
    setInstalling(`service:${service.id}`)
    try {
      await applyChange(room.id, {
        kind: 'service-add',
        service: service.id,
        version: service.version
      })
    } finally {
      setInstalling(null)
    }
  }

  async function loadMoreCategory(): Promise<void> {
    if (!selectedCategory || loadingMore) return
    const category = CATEGORIES.find((item) => item.id === selectedCategory)
    if (!category) return
    setLoadingMore(true)
    setError(null)
    try {
      const current = categoryResults[selectedCategory] ?? []
      const nextPage = await api.packages.search(category.query, current.length)
      const seen = new Set(current.map(packageKey))
      const unique = nextPage.filter((item) => !seen.has(packageKey(item)))
      setCategoryResults({
        ...categoryResults,
        [selectedCategory]: [...current, ...unique]
      })
      if (nextPage.length < 20 || unique.length === 0) {
        setExhaustedCategories({ ...exhaustedCategories, [selectedCategory]: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const renderPackage = (pkg: RegistryPackageInfo): React.JSX.Element => (
    <article className="package-store-item" key={packageKey(pkg)}>
      <div className="package-store-package">
        <div className="package-store-name">
          <strong>{pkg.name}</strong>
          <span className="mono">{pkg.version}</span>
        </div>
        {pkg.description && <p>{pkg.description}</p>}
        {(pkg.publisher || pkg.updatedAt) && (
          <small>
            {pkg.publisher ? t('packageStore.publisher', { publisher: pkg.publisher }) : ''}
            {pkg.publisher && pkg.updatedAt ? ' · ' : ''}
            {pkg.updatedAt ? new Date(pkg.updatedAt).toLocaleDateString() : ''}
          </small>
        )}
      </div>
      <button
        className="btn primary"
        disabled={!canInstallPackage || installing !== null}
        onClick={() => void installPackage(pkg)}
      >
        {installing === packageKey(pkg) ? t('stack.installing') : t('stack.install')}
      </button>
    </article>
  )

  return (
    <div className="modal-backdrop" onClick={() => !installing && onClose()}>
      <section
        className="modal package-store-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="package-store-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="package-store-heading">
          <div>
            <h2 id="package-store-title">{t('packageStore.title')}</h2>
            <p className="small muted">{t('packageStore.subtitle')}</p>
          </div>
          <button className="icon-btn" aria-label={t('common.close')} disabled={installing !== null} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="package-store-tabs" role="tablist">
          <button className={tab === 'packages' ? 'active' : ''} role="tab" aria-selected={tab === 'packages'} onClick={() => setTab('packages')}>
            {t('packageStore.packages')}
          </button>
          <button className={tab === 'services' ? 'active' : ''} role="tab" aria-selected={tab === 'services'} onClick={() => setTab('services')}>
            {t('packageStore.services')}
          </button>
        </div>

        {tab === 'packages' ? (
          <>
            {room.workspaceMode === 'legacy-host-bind' && <div className="package-store-boundary" role="note">{t('packageStore.linkedBoundary')}</div>}
            {room.workspaceMode === 'empty' && <div className="package-store-boundary" role="note">{t('packageStore.emptyBoundary')}</div>}

            <div className="package-store-controls">
              <input
                autoFocus
                type="search"
                value={query}
                placeholder={t('packageStore.searchPlaceholder')}
                aria-label={t('packageStore.searchLabel')}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSelectedCategory(null)
                }}
              />
              <label className="package-store-dev">
                <input type="checkbox" checked={devDependency} onChange={(event) => setDevDependency(event.target.checked)} />
                devDependency
              </label>
            </div>
            <p className="package-store-catalog-note">{t('packageStore.catalogNote')}</p>
            {canInstallPackage && <div className="package-store-trust-note" role="note">{t('packageStore.installWarning')}</div>}

            <div className="package-store-results" aria-live="polite">
              {loading && <p className="package-store-empty">{t('packageStore.searching')}</p>}
              {(error || (!searchActive && browseFailed)) && <p className="package-store-error">{error ?? t('packageStore.browseFailed')}</p>}
              {searchActive && !loading && !error && results.length === 0 && <p className="package-store-empty">{t('packageStore.noMatches')}</p>}
              {searchActive && !loading && !error && results.map(renderPackage)}

              {!searchActive && selectedCategory && (
                <>
                  <div className="package-store-category-header">
                    <button className="btn" onClick={() => setSelectedCategory(null)}>← {t('packageStore.allCategories')}</button>
                    <strong>{t(`packageStore.category.${selectedCategory}`)}</strong>
                  </div>
                  {selectedPackages.map(renderPackage)}
                  {selectedPackages.length >= 20 && !exhaustedCategories[selectedCategory] && (
                    <div className="package-store-load-more">
                      <button className="btn" disabled={loadingMore} onClick={() => void loadMoreCategory()}>
                        {loadingMore ? t('packageStore.loadingMore') : t('packageStore.loadMore')}
                      </button>
                    </div>
                  )}
                </>
              )}

              {!searchActive && !selectedCategory && browseLoading && <p className="package-store-empty">{t('packageStore.loadingBrowse')}</p>}
              {!searchActive && !selectedCategory && !browseLoading && !browseFailed && (
                <div className="package-store-browse">
                  {CATEGORIES.map((category) => {
                    const packages = categoryResults[category.id] ?? []
                    if (packages.length === 0) return null
                    return (
                      <section className="package-store-shelf" key={category.id}>
                        <div className="package-store-shelf-heading">
                          <h3>{t(`packageStore.category.${category.id}`)}</h3>
                          <button onClick={() => setSelectedCategory(category.id)}>{t('packageStore.viewAll')} →</button>
                        </div>
                        <div className="package-store-grid">
                          {packages.slice(0, 6).map((pkg) => (
                            <button className="package-store-tile" key={packageKey(pkg)} onClick={() => setSelectedCategory(category.id)}>
                              <strong>{pkg.name}</strong>
                              <span>{pkg.description || pkg.version}</span>
                            </button>
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="package-store-results package-store-services" aria-live="polite">
            <p className="package-store-service-note">{t('packageStore.serviceSource')}</p>
            {SERVICES.map((service) => {
              const installed = room.services[service.id]
              return (
                <article className="package-store-item" key={service.id}>
                  <div className="package-store-service-icon">{service.id === 'postgres' ? 'PG' : 'R'}</div>
                  <div className="package-store-package">
                    <div className="package-store-name"><strong>{service.label}</strong><span>{installed?.version ?? service.version}</span></div>
                    <p>{t(service.descriptionKey)}</p>
                  </div>
                  {installed ? (
                    <span className="package-store-installed">✓ {t('packageStore.installed')}</span>
                  ) : (
                    <button className="btn primary" disabled={installing !== null} onClick={() => void installService(service)}>
                      {installing === `service:${service.id}` ? t('stack.installing') : t('stack.install')}
                    </button>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
