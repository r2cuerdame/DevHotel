import type { IpcApi } from '@devhotel/shared'

declare global {
  interface Window {
    devhotel: IpcApi
  }
}

export const api: IpcApi = window.devhotel
