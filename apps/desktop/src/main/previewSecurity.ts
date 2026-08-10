import type { RoomRecord } from '@devhotel/shared'

export function roomPreviewPartition(roomId: string): string {
  return `persist:room-${roomId}`
}

/** Web rooms preview their site; Android rooms preview the relayed emulator screen. */
export function isPreviewableRoom(room: Pick<RoomRecord, 'provider' | 'status'> | null | undefined): boolean {
  return (
    (room?.provider === 'web' || room?.provider === 'android') &&
    ['running', 'ready', 'attention'].includes(room.status)
  )
}

/** Preview navigation remains on the exact Room gateway origin. */
export function isAllowedRoomNavigation(candidate: string, homeUrl: string): boolean {
  try {
    const target = new URL(candidate)
    const home = new URL(homeUrl)
    if (!['http:', 'https:'].includes(target.protocol)) return false
    if (!home.hostname.endsWith('.localhost')) return false
    return target.origin === home.origin
  } catch {
    return false
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  if (url.protocol === 'http:' || url.protocol === 'ws:') return '80'
  if (url.protocol === 'https:' || url.protocol === 'wss:') return '443'
  return ''
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // WHATWG normalizes mapped IPv4 (for example 127.0.0.1) to
  // `::ffff:7f00:1`; deny the entire mapped range instead of reparsing hex.
  if (host.startsWith('::ffff:')) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return true
  if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true
  if (/^fe[89ab]/.test(host)) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const octets = ipv4.slice(1).map(Number)
  if (octets.some((value) => value > 255)) return true
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224
  )
}

/**
 * Keep Room and Host-local network boundaries closed while preserving public
 * CDN/API compatibility for ordinary web previews.
 */
export function isAllowedPreviewRequest(candidate: string, homeUrl: string, mainFrame = false): boolean {
  if (mainFrame) return isAllowedRoomNavigation(candidate, homeUrl)
  try {
    const target = new URL(candidate)
    const home = new URL(homeUrl)
    if (['data:', 'blob:', 'about:'].includes(target.protocol)) return true
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) return false

    const targetHttpProtocol = target.protocol === 'ws:' ? 'http:' : target.protocol === 'wss:' ? 'https:' : target.protocol
    const ownRoom =
      target.hostname === home.hostname &&
      targetHttpProtocol === home.protocol &&
      effectivePort(target) === effectivePort(home)
    if (ownRoom) return true
    return !isPrivateOrLocalHost(target.hostname)
  } catch {
    return false
  }
}

export function mobilePreviewUserAgent(chromeVersion: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36 DevHotelPreview`
}
