/**
 * Host input isolation contract.
 *
 * A Room is supposed to be a place an Agent can act freely without the Host
 * paying for it. Real mouse, real keyboard and the foreground window are Host
 * resources like any other: a test running inside a Room must not move the
 * Host cursor, change Host keyboard state, or take the Host foreground window.
 *
 * Every control path DevHotel offers is Room-local by construction — Room
 * commands run through the isolation backend, Android input goes through the
 * Room's own `adb`, and Room web content is previewed in a session with no
 * Host capability at all. The Host-input capabilities that remain are named
 * here rather than left implicit: each one says what the Host gives up, who is
 * allowed to invoke it, and the line it writes to the Room log so that the
 * takeover is visible after the fact.
 *
 * See `docs/host-input-isolation.md` for the audit and platform limits.
 */

/**
 * Control paths that stay inside the Room, in the order they should be
 * preferred. Anything not on this list is a Host-input capability and needs an
 * entry in {@link HOST_INPUT_CAPABILITIES}.
 */
export const ROOM_LOCAL_CONTROL_PATHS = [
  'room-exec',
  'android-adb',
  'room-browser-preview',
  'room-virtual-display'
] as const
export type RoomLocalControlPath = (typeof ROOM_LOCAL_CONTROL_PATHS)[number]

/**
 * Web-platform permissions that would hand Room content the Host cursor,
 * keyboard, screen or foreground window. Room preview sessions deny every
 * permission, but these are the ones whose denial is load-bearing for the
 * isolation contract, so they are enumerated and regression-tested by name.
 */
export const HOST_INPUT_PERMISSIONS = [
  'pointerLock',
  'keyboardLock',
  'fullscreen',
  'display-capture',
  'window-management',
  'idle-detection',
  'hid',
  'serial',
  'usb'
] as const
export type HostInputPermission = (typeof HOST_INPUT_PERMISSIONS)[number]

export function isHostInputPermission(permission: string): permission is HostInputPermission {
  return (HOST_INPUT_PERMISSIONS as readonly string[]).includes(permission)
}

/** What the Host gives up while a Host-input capability is in use. */
export type HostInputSurface = 'cursor' | 'keyboard' | 'foreground'

export interface HostInputCapability {
  id: string
  label: string
  surrenders: readonly HostInputSurface[]
  /**
   * The only actor allowed to invoke it. `'user'` means an Agent can never
   * reach it — not through MCP, not through the control API.
   */
  requiresActor: 'user'
  /** Written to the Room's orchestrator log on every use, so it is observable. */
  auditLine: string
}

/**
 * Every path DevHotel still has that can take Host input or foreground focus.
 * Adding one without adding it here fails the Host-input boundary test.
 */
export const HOST_INPUT_CAPABILITIES: readonly HostInputCapability[] = [
  {
    id: 'host-input:vmware-console',
    label: 'Open a Windows Room in the VMware Workstation console',
    surrenders: ['cursor', 'keyboard', 'foreground'],
    requiresActor: 'user',
    auditLine:
      'open the VMware Workstation console — while that window has focus the Room holds the Host cursor and keyboard'
  }
]

export function hostInputCapability(id: string): HostInputCapability | null {
  return HOST_INPUT_CAPABILITIES.find((capability) => capability.id === id) ?? null
}

export const VMWARE_CONSOLE_CAPABILITY = 'host-input:vmware-console'
