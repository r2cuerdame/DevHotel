import type { Session } from 'electron'

/**
 * A Room's web content gets no Host capability at all.
 *
 * This is deliberately a blanket denial rather than an allow-list with holes:
 * Pointer Lock, Keyboard Lock and fullscreen are the three ways a page takes
 * the Host cursor, keyboard and foreground window, and all three arrive
 * through the same permission surface as harmless-sounding requests. Denying
 * the surface as a whole is what keeps a future "allow just notifications"
 * change from quietly reopening them.
 *
 * Kept out of PreviewManager so the wiring itself — not just the intent — is
 * covered by `hostInputBoundary.test.ts`.
 */
export function hardenRoomSession(roomSession: Session): void {
  roomSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  roomSession.setPermissionCheckHandler(() => false)
  roomSession.setDevicePermissionHandler(() => false)
  roomSession.on('will-download', (event) => event.preventDefault())
}
