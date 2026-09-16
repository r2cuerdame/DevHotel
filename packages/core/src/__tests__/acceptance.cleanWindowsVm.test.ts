import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The #106 acceptance VM is the whole basis of the claim that a clean Windows
 * 11 machine reaches a healthy managed runtime. If the script that builds it
 * quietly drifts -- media left unverified, Windows 11's requirements bypassed,
 * nested virtualization dropped -- the run still produces a green matrix, and
 * that matrix no longer means what it says.
 *
 * These assertions are deliberately about the properties that make the
 * evidence valid, not about the script's wording.
 */
const root = path.resolve(__dirname, '../../../..')
const scriptPath = path.join(root, 'scripts/acceptance/issue-106/New-CleanWindowsAcceptanceVm.ps1')
const answerPath = path.join(root, 'scripts/acceptance/issue-106/autounattend.xml')
const procedurePath = path.join(root, 'docs/verification/issue-106-clean-windows-acceptance.md')

async function script(): Promise<string> {
  return await readFile(scriptPath, 'utf8')
}

describe('#106 clean-Windows acceptance VM', () => {
  it('refuses to build from unverified installation media', async () => {
    const source = await script()
    // A VM built from unrecorded bytes cannot support evidence about what
    // those bytes do.
    expect(source).toContain('Get-FileHash')
    expect(source).toMatch(/throw "ISO digest mismatch/)
    expect(source).toMatch(/if \(-not \$IsoSha256\)\s*\{ throw/)
  })

  it('meets Windows 11 requirements instead of bypassing them', async () => {
    const source = await script()
    // Bypassing Secure Boot or TPM would make the guest a configuration no
    // supported Windows 11 user has, so the acceptance would describe
    // something other than the product's actual target.
    expect(source).toContain('-EnableSecureBoot On')
    expect(source).toContain('Set-VMKeyProtector')
    expect(source).toContain('Enable-VMTPM')
    expect(source).not.toMatch(/BypassTPMCheck|BypassSecureBootCheck|LabConfig/i)
  })

  it('gives the guest what it needs to run Hyper-V itself', async () => {
    const source = await script()
    expect(source).toContain('-Generation 2')
    expect(source).toContain('-ExposeVirtualizationExtensions $true')
    // Hyper-V refuses exposed virtualization extensions alongside dynamic
    // memory, so this pairing is required, not stylistic.
    expect(source).toContain('-DynamicMemoryEnabled $false')
  })

  it('never enables Host features or reboots the Host by itself', async () => {
    const source = await script()
    // Changing the Host is the operator's decision; this script only builds a
    // guest on a Host that is already capable.
    expect(source).not.toMatch(/Enable-WindowsOptionalFeature|\bdism\b|Restart-Computer/i)
    expect(source).toMatch(/Hyper-V PowerShell is unavailable/)
  })

  it('removes only the VM and disks it created', async () => {
    const source = await script()
    // A teardown that guesses at paths, or matches on name alone, can delete
    // an unrelated VM someone else owns.
    expect(source).toContain("Refusing to touch it.")
    expect(source).toContain('Get-VMHardDiskDrive -VM $vm')
    expect(source).toContain('$disk.StartsWith($VmRoot')
  })

  it('installs Windows and nothing else', async () => {
    const answer = await readFile(answerPath, 'utf8')
    // The claim under test is that none of this has to be present, so the
    // answer file must not quietly install any of it.
    expect(answer).not.toMatch(/docker|nodejs|node\.js|chocolatey|winget|android|mysql|postgres/i)
    expect(answer).toContain('<AcceptEula>true</AcceptEula>')
  })

  it('keeps the procedure honest about not having been run', async () => {
    const procedure = await readFile(procedurePath, 'utf8')
    // The matrix is only worth having if an unrun row cannot read as a pass.
    expect(procedure).toContain('not yet run')
    expect(procedure).toContain('Runtime reaches healthy')
    expect(procedure).toContain('State disk survives repair')
  })
})
