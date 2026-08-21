import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { RoomPlan } from '@devhotel/shared'
import { resolveVmrunExecutable } from '../backend/windowsVm'
import type { WebSpec } from '../backend/types'
import { slugifyDomain, type DetectOptions } from '../detect/detector'
import type { RoomProvider, RoomProviderInfo } from './types'

function workstationInstalled(): boolean {
  if (process.platform !== 'win32') return false
  const executable = resolveVmrunExecutable()
  return isAbsolute(executable) && existsSync(executable)
}

/** VMware-backed Windows lifecycle. Guest exec/file ingress is intentionally a later capability. */
export class WindowsRoomProvider implements RoomProvider {
  constructor(
    private readonly availableProbe: () => boolean = workstationInstalled,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get info(): RoomProviderInfo {
    const supported = this.platform === 'win32'
    const available = supported && this.availableProbe()
    return {
      kind: 'windows',
      label: 'Windows Room (VMware)',
      available,
      ...(available
        ? {}
        : {
            unavailableReason: supported
              ? 'Install VMware Workstation Pro to create Windows Rooms'
              : 'Windows Rooms require DevHotel on a Windows host'
          }),
      execution: 'build-only',
      preview: 'none',
      requiresKvm: false
    }
  }

  async detect(_src: unknown, opts: DetectOptions): Promise<RoomPlan> {
    return {
      project: opts.project,
      framework: 'windows-vm',
      runtime: { kind: 'windows', value: '11', source: 'VMware template' },
      packageManager: { value: 'none', source: 'VMware template' },
      startCommand: { value: 'VMware guest boot', source: 'VMware lifecycle' },
      internalPort: { value: 0, source: 'no embedded preview' },
      domain: slugifyDomain(opts.project, opts.nickname),
      https: false,
      warnings: [
        'The first VMware Room is offline by default: clipboard, drag-and-drop, shared folders, USB and networking are disabled.',
        'Terminal, source import and agent commands require the forthcoming Windows guest agent.'
      ]
    }
  }

  buildSpec(): WebSpec {
    throw new Error('Windows Rooms use the VMware lifecycle, not an OCI WebSpec')
  }

  components(): string[] {
    return ['Windows', 'VMware Workstation', 'Clean snapshot', 'Offline isolation policy']
  }
}
