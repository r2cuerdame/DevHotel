import { describe, expect, it } from 'vitest'
import {
  isAllowedRoomNavigation,
  isAllowedPreviewRequest,
  isPreviewableRoom,
  mobilePreviewUserAgent,
  roomPreviewPartition
} from './previewSecurity'

describe('preview boundary policy', () => {
  const home = 'https://room-201.localhost:7443/'

  it('allows only HTTP(S) navigation on the exact Room gateway origin', () => {
    expect(isAllowedRoomNavigation('https://room-201.localhost:7443/settings?q=1', home)).toBe(true)
    expect(isAllowedRoomNavigation('http://room-201.localhost:7443/', home)).toBe(false)
    expect(isAllowedRoomNavigation('https://room-202.localhost:7443/', home)).toBe(false)
    expect(isAllowedRoomNavigation('https://example.com/', home)).toBe(false)
    expect(isAllowedRoomNavigation('file:///C:/Windows/System32/drivers/etc/hosts', home)).toBe(false)
  })

  it('requires a localhost Room gateway even when candidate and home otherwise match', () => {
    expect(isAllowedRoomNavigation('https://example.com/a', 'https://example.com/')).toBe(false)
  })

  it('allows its exact Room origin and public resources but blocks local and cross-Room requests', () => {
    expect(isAllowedPreviewRequest('https://room-201.localhost:7443/app.js', home)).toBe(true)
    expect(isAllowedPreviewRequest('wss://room-201.localhost:7443/socket', home)).toBe(true)
    expect(isAllowedPreviewRequest('https://cdn.example.com/app.js', home)).toBe(true)
    expect(isAllowedPreviewRequest('https://room-202.localhost:7443/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://localhost:3000/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://127.0.0.1:3000/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://10.20.30.40/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://172.16.4.2/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://192.168.1.8/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://169.254.1.8/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://[::1]/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://[::ffff:7f00:1]/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://[::ffff:a00:1]/api', home)).toBe(false)
    expect(isAllowedPreviewRequest('http://printer.local/status', home)).toBe(false)
    expect(isAllowedPreviewRequest('file:///C:/Users/me/secret.txt', home)).toBe(false)
  })

  it('applies exact Room-origin policy to main frames', () => {
    expect(isAllowedPreviewRequest('https://room-201.localhost:7443/next', home, true)).toBe(true)
    expect(isAllowedPreviewRequest('https://cdn.example.com/', home, true)).toBe(false)
  })

  it('uses a mobile Android user agent for the portrait pane', () => {
    expect(mobilePreviewUserAgent('140.0.0.0')).toContain('Android 14')
    expect(mobilePreviewUserAgent('140.0.0.0')).toContain('Mobile Safari')
  })

  it('derives one exact persistent session partition for both Room panes', () => {
    expect(roomPreviewPartition('room1abc')).toBe('persist:room-room1abc')
  })

  it('permits native preview attachment only for live Web Rooms', () => {
    expect(isPreviewableRoom({ provider: 'web', status: 'ready' })).toBe(true)
    expect(isPreviewableRoom({ provider: 'web', status: 'attention' })).toBe(true)
    expect(isPreviewableRoom({ provider: 'web', status: 'sleeping' })).toBe(false)
    expect(isPreviewableRoom({ provider: 'android', status: 'ready' })).toBe(false)
    expect(isPreviewableRoom(undefined)).toBe(false)
  })
})
