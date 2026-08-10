import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl } from './cleanRemoval'

export type RendererIpcEvent = IpcMainEvent | IpcMainInvokeEvent

/** Every renderer IPC entry point is bound to the one trusted main frame. */
export function assertTrustedMainFrame(
  event: RendererIpcEvent,
  win: BrowserWindow,
  packaged: boolean,
  developmentUrl?: string,
  packagedUrl?: string
): void {
  const trusted =
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    isTrustedRendererUrl(event.senderFrame?.url ?? '', packaged, developmentUrl, packagedUrl)
  if (!trusted) throw new Error('IPC request rejected: caller is not the trusted DevHotel main frame')
}
