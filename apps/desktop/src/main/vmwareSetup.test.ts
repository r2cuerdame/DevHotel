import { describe, expect, it, vi } from 'vitest'
import {
  VMWARE_WORKSTATION_DOWNLOAD_URL,
  detectVmwareSetup,
  openOfficialVmwareDownload
} from './vmwareSetup'

describe('VMware setup boundary', () => {
  it('reports unsupported without probing vmrun outside Windows', async () => {
    const health = vi.fn(async () => ({ ok: true, detail: 'ignored' }))
    const isConfiguredFor = vi.fn(() => false)

    await expect(detectVmwareSetup({ windowsVm: { health, isConfiguredFor }, platform: 'darwin' })).resolves.toEqual({
      state: 'unsupported',
      supported: false,
      installed: false,
      ready: false,
      detail: 'Windows Rooms require DevHotel on Windows.'
    })
    expect(health).not.toHaveBeenCalled()
    expect(isConfiguredFor).not.toHaveBeenCalled()
  })

  it('distinguishes missing, newly installed, and active vmrun without returning a Host path', async () => {
    const executable = 'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe'
    const missing = await detectVmwareSetup({
      windowsVm: {
        health: async () => ({ ok: false, detail: 'unavailable' }),
        isConfiguredFor: () => false
      },
      platform: 'win32',
      resolveExecutable: () => 'vmrun.exe',
      fileExists: () => false
    })
    const installed = await detectVmwareSetup({
      windowsVm: {
        health: async () => ({ ok: false, detail: 'unavailable' }),
        isConfiguredFor: () => false
      },
      platform: 'win32',
      resolveExecutable: () => executable,
      fileExists: (candidate) => candidate === executable
    })
    const ready = await detectVmwareSetup({
      windowsVm: {
        health: async () => ({ ok: true, detail: 'available' }),
        isConfiguredFor: () => true
      },
      platform: 'win32',
      resolveExecutable: () => executable,
      fileExists: () => true
    })

    expect(missing.state).toBe('missing')
    expect(installed.state).toBe('relaunch-required')
    expect(ready.state).toBe('ready')
    for (const status of [missing, installed, ready]) {
      expect(JSON.stringify(status)).not.toContain(executable)
    }
  })

  it('does not create a relaunch loop when the backend already uses the discovered path', async () => {
    const executable = 'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe'

    const status = await detectVmwareSetup({
      windowsVm: {
        health: async () => ({ ok: false, detail: 'unavailable' }),
        isConfiguredFor: (candidate) => candidate === executable
      },
      platform: 'win32',
      resolveExecutable: () => executable,
      fileExists: () => true
    })

    expect(status.state).toBe('unavailable')
    expect(status.installed).toBe(true)
    expect(status.ready).toBe(false)
  })

  it('opens only the fixed official Broadcom Workstation URL', async () => {
    const openExternal = vi.fn(async (_url: string) => undefined)

    await openOfficialVmwareDownload(openExternal)

    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(VMWARE_WORKSTATION_DOWNLOAD_URL)
    expect(VMWARE_WORKSTATION_DOWNLOAD_URL).toBe(
      'https://knowledge.broadcom.com/external/article/368734/download-desktop-hypervisor-workstation.html'
    )
  })

})
