import { describe, expect, it, vi } from 'vitest'
import { updateTrayMenuItem } from './updateTrayMenu'

describe('update tray menu item', () => {
  it('always offers an update action while idle', () => {
    const check = vi.fn()
    const item = updateTrayMenuItem({ state: 'idle' }, check, vi.fn())

    expect(item.label).toBe('Check for updates')
    item.click?.()
    expect(check).toHaveBeenCalledOnce()
  })

  it('shows progress states without allowing duplicate checks', () => {
    const check = vi.fn()

    expect(updateTrayMenuItem({ state: 'checking' }, check, vi.fn())).toEqual({
      label: 'Checking for updates…',
      enabled: false
    })
    expect(updateTrayMenuItem({ state: 'downloading', detail: '42%' }, check, vi.fn())).toEqual({
      label: 'Downloading update…',
      enabled: false
    })
    expect(check).not.toHaveBeenCalled()
  })

  it('installs a ready update from the tray', () => {
    const install = vi.fn()
    const item = updateTrayMenuItem({ state: 'ready', version: '0.5.0' }, vi.fn(), install)

    expect(item.label).toBe('Restart to update to 0.5.0')
    item.click?.()
    expect(install).toHaveBeenCalledOnce()
  })

  it('allows a failed check to be retried', () => {
    const check = vi.fn()
    const item = updateTrayMenuItem({ state: 'error', detail: 'offline' }, check, vi.fn())

    expect(item.label).toBe('Update check failed · Retry')
    item.click?.()
    expect(check).toHaveBeenCalledOnce()
  })
})
