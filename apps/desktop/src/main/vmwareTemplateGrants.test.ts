import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VmwareTemplateGrants } from './vmwareTemplateGrants'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dh-vmx-grant-'))
}

describe('VmwareTemplateGrants', () => {
  it('returns an opaque grant for the exact canonical .vmx file', () => {
    const root = tempDir()
    const vmx = join(root, 'Windows 11.vmx')
    writeFileSync(vmx, 'config.version = "8"\n')

    const grants = new VmwareTemplateGrants()
    const granted = grants.grant(vmx)

    expect(granted.label).toBe('Windows 11')
    expect(granted.grantId).not.toContain('Windows')
    expect(grants.resolve(granted.grantId)).toBe(granted.vmxPath)
  })

  it('rejects directories, other extensions, and unknown grants', () => {
    const root = tempDir()
    const directory = join(root, 'folder.vmx')
    mkdirSync(directory)
    const text = join(root, 'template.txt')
    writeFileSync(text, 'not a vmx')
    const grants = new VmwareTemplateGrants()

    expect(() => grants.grant(directory)).toThrow('Choose a VMware .vmx file')
    expect(() => grants.grant(text)).toThrow('Choose a VMware .vmx file')
    expect(() => grants.resolve(randomUUID())).toThrow('Choose the VMware template again')
  })
})
