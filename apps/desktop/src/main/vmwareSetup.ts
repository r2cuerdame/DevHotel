import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveVmrunExecutable, type WindowsVmBackend } from '@devhotel/core'
import type { VmwareSetupStatusInfo } from '@devhotel/shared'

/** Renderer code cannot replace this URL with an arbitrary destination. */
export const VMWARE_WORKSTATION_DOWNLOAD_URL =
  'https://knowledge.broadcom.com/external/article/368734/download-desktop-hypervisor-workstation.html'

export interface VmwareSetupProbeOptions {
  windowsVm: Pick<WindowsVmBackend, 'health' | 'isConfiguredFor'>
  platform?: NodeJS.Platform
  resolveExecutable?: () => string
  fileExists?: (candidate: string) => boolean
}

/**
 * Re-resolve vmrun for every call. The backend intentionally pins its executable
 * at bootstrap, so a fresh install is reported separately until a safe relaunch.
 */
export async function detectVmwareSetup(
  options: VmwareSetupProbeOptions
): Promise<VmwareSetupStatusInfo> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return {
      state: 'unsupported',
      supported: false,
      installed: false,
      ready: false,
      detail: 'Windows Rooms require DevHotel on Windows.'
    }
  }

  const resolved = (options.resolveExecutable ?? resolveVmrunExecutable)()
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const discovered = pathApi.isAbsolute(resolved) && (options.fileExists ?? existsSync)(resolved)
  const health = await options.windowsVm.health()

  if (health.ok) {
    return {
      state: 'ready',
      supported: true,
      installed: true,
      ready: true,
      detail: 'VMware Workstation Pro is ready.'
    }
  }

  if (discovered) {
    if (options.windowsVm.isConfiguredFor(resolved)) {
      return {
        state: 'unavailable',
        supported: true,
        installed: true,
        ready: false,
        detail: 'VMware is installed, but vmrun is not responding. Repair or restart VMware Workstation.'
      }
    }
    return {
      state: 'relaunch-required',
      supported: true,
      installed: true,
      ready: false,
      detail: 'VMware was detected. Relaunch DevHotel to activate it.'
    }
  }

  return {
    state: 'missing',
    supported: true,
    installed: false,
    ready: false,
    detail: 'VMware Workstation Pro with vmrun was not detected.'
  }
}

export async function openOfficialVmwareDownload(
  openExternal: (url: string) => Promise<void>
): Promise<void> {
  await openExternal(VMWARE_WORKSTATION_DOWNLOAD_URL)
}
