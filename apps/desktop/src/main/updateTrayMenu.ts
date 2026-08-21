import type { UpdateStatusInfo } from '@devhotel/shared'

export interface UpdateTrayMenuItem {
  label: string
  enabled?: boolean
  click?: () => void
}

/** Keep updater state visible in the tray instead of showing it only after download. */
export function updateTrayMenuItem(
  status: UpdateStatusInfo,
  checkForUpdates: () => void,
  installUpdate: () => void
): UpdateTrayMenuItem {
  switch (status.state) {
    case 'checking':
      return { label: 'Checking for updates…', enabled: false }
    case 'up-to-date':
      return { label: 'DevHotel is up to date · Check again', click: checkForUpdates }
    case 'available':
      return {
        label: status.version ? `Update ${status.version} found…` : 'Update found…',
        enabled: false
      }
    case 'downloading':
      return { label: 'Downloading update…', enabled: false }
    case 'ready':
      return {
        label: status.version ? `Restart to update to ${status.version}` : 'Restart to install update',
        click: installUpdate
      }
    case 'error':
      return { label: 'Update check failed · Retry', click: checkForUpdates }
    case 'idle':
      return { label: 'Check for updates', click: checkForUpdates }
  }
}
