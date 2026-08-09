import { contextBridge, ipcRenderer } from 'electron'

// Placeholder bridge; replaced by the typed IpcApi in the main-process wiring task.
contextBridge.exposeInMainWorld('devhotel', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
})
