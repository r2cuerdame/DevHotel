import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

export interface VmwareTemplateGrant {
  grantId: string
  label: string
  vmxPath: string
}

/**
 * Process-local grants keep arbitrary Host paths out of renderer-controlled
 * create payloads. A grant names exactly the canonical .vmx selected by the
 * native file picker and disappears when DevHotel exits.
 */
export class VmwareTemplateGrants {
  private readonly approved = new Map<string, string>()

  grant(selectedPath: string): VmwareTemplateGrant {
    const canonical = realpathSync.native(selectedPath)
    if (!statSync(canonical).isFile() || extname(canonical).toLowerCase() !== '.vmx') {
      throw new Error('Choose a VMware .vmx file')
    }
    const grantId = randomUUID()
    this.approved.set(grantId, canonical)
    return { grantId, label: basename(canonical, extname(canonical)), vmxPath: canonical }
  }

  resolve(grantId: string): string {
    const vmxPath = this.approved.get(grantId)
    if (!vmxPath) throw new Error('Choose the VMware template again')
    return vmxPath
  }

  revoke(grantId: string): void {
    this.approved.delete(grantId)
  }
}
