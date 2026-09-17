<#
.SYNOPSIS
    Builds the clean Windows 11 VM that #106 acceptance has to be proven on.

.DESCRIPTION
    #106 requires a Windows 11 host with nothing preinstalled -- no Docker
    Desktop, Node, adb, Android Studio or database -- on which DevHotel enables
    Hyper-V, survives the reboot that needs, provisions its managed Linux
    runtime and proves guest health. That cannot be shown on a developer
    machine, and it has to be reproducible rather than hand-built, or the
    evidence means nothing.

    This creates that VM deterministically from free Microsoft evaluation
    media. Everything that makes the result valid is asserted rather than
    assumed:

      * the installation media is verified against a recorded SHA-256, so the
        VM is built from exactly the bytes the evidence names;
      * Generation 2 with Secure Boot and a virtual TPM, because Windows 11
        requires both -- the alternative is a registry bypass, which would make
        the guest something other than a clean supported install;
      * nested virtualization exposed, because the guest must run Hyper-V
        itself, and static memory, which Hyper-V requires alongside it;
      * an unattended answer file, so no human makes a choice that the next run
        makes differently.

    It creates nothing outside -VmRoot and removes nothing it did not create.

.PARAMETER IsoPath
    Windows 11 Enterprise Evaluation ISO. Free, no licence key, 90-day
    evaluation, from https://www.microsoft.com/evalcenter -- see the
    acceptance procedure for how it is recorded.

.PARAMETER IsoSha256
    Expected digest of -IsoPath. Microsoft rotates the download, so the digest
    is pinned per acceptance run rather than hard-coded here, and whatever is
    used gets recorded in the evidence.

.PARAMETER Remove
    Deletes the VM and its disks. Refuses any VM this script did not create.

.EXAMPLE
    .\New-CleanWindowsAcceptanceVm.ps1 -IsoPath D:\win11-eval.iso -IsoSha256 <digest>

.EXAMPLE
    .\New-CleanWindowsAcceptanceVm.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string] $IsoPath,
    [string] $IsoSha256,
    [string] $VmName = 'DevHotel-Acceptance-106',
    [string] $VmRoot = (Join-Path $env:ProgramData 'DevHotel\acceptance\issue-106'),
    [int]    $MemoryGB = 8,
    [int]    $CpuCount = 4,
    [int]    $DiskGB = 100,
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This VM is DevHotel's own acceptance fixture. The tag goes in Notes so
# -Remove can tell it apart from anything else on the Host and refuse to touch
# a VM a human made.
$OwnerTag = 'devhotel-acceptance-issue-106'

function Assert-HyperV {
    if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
        throw 'Hyper-V PowerShell is unavailable. Enable Microsoft-Hyper-V-All on the Host first; this script never changes Host features.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Hyper-V management requires an elevated session.'
    }
}

function Get-OwnedVm {
    $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
    if (-not $vm) { return $null }
    if ($vm.Notes -ne $OwnerTag) {
        throw "A VM named '$VmName' exists that this script did not create. Refusing to touch it."
    }
    return $vm
}

function Remove-AcceptanceVm {
    $vm = Get-OwnedVm
    if (-not $vm) { Write-Host 'Nothing to remove.'; return }
    if (-not $PSCmdlet.ShouldProcess($VmName, 'Remove acceptance VM and its disks')) { return }

    if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
    # Read the disk paths off the VM itself, so only what this VM actually
    # owned is deleted -- never a guessed path.
    $disks = @(Get-VMHardDiskDrive -VM $vm | Select-Object -ExpandProperty Path)
    Remove-VM -VM $vm -Force
    foreach ($disk in $disks) {
        if ($disk -and (Test-Path -LiteralPath $disk) -and $disk.StartsWith($VmRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $disk -Force
        }
    }
    Write-Host "Removed $VmName."
}

function New-AnswerFileDisk {
    param([string] $Path)

    $answerFile = Join-Path $PSScriptRoot 'autounattend.xml'
    if (-not (Test-Path -LiteralPath $answerFile)) { throw "Missing answer file: $answerFile" }

    # Windows Setup looks for autounattend.xml at the root of every attached
    # volume, so a small FAT32 disk delivers it without rebuilding the ISO
    # (which would need oscdimg from the ADK, and would change the media whose
    # digest the evidence pins).
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    New-VHD -Path $Path -Dynamic -SizeBytes 64MB | Out-Null
    $disk = Mount-VHD -Path $Path -Passthru
    try {
        $disk | Initialize-Disk -PartitionStyle MBR -PassThru | Out-Null
        $partition = $disk | New-Partition -UseMaximumSize -AssignDriveLetter
        $volume = $partition | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'ANSWER' -Confirm:$false
        Copy-Item -LiteralPath $answerFile -Destination ($volume.DriveLetter + ':\autounattend.xml') -Force
    } finally {
        Dismount-VHD -Path $Path -ErrorAction SilentlyContinue
    }
}

Assert-HyperV

if ($Remove) { Remove-AcceptanceVm; return }

if (-not $IsoPath)   { throw 'Provide -IsoPath (Windows 11 Enterprise Evaluation ISO).' }
if (-not $IsoSha256) { throw 'Provide -IsoSha256. Unverified media makes the acceptance evidence unverifiable.' }
if (-not (Test-Path -LiteralPath $IsoPath)) { throw "No such ISO: $IsoPath" }

Write-Host 'Verifying installation media...'
$measured = (Get-FileHash -LiteralPath $IsoPath -Algorithm SHA256).Hash
if ($measured -ne $IsoSha256.ToUpperInvariant()) {
    throw "ISO digest mismatch. Expected $($IsoSha256.ToUpperInvariant()), measured $measured."
}
Write-Host "Media verified: SHA-256 $measured"

if (Get-OwnedVm) { throw "$VmName already exists. Run with -Remove first." }

New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null
$systemDisk = Join-Path $VmRoot "$VmName-system.vhdx"
$answerDisk = Join-Path $VmRoot "$VmName-answer.vhdx"
foreach ($stale in @($systemDisk, $answerDisk)) {
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
}

if (-not $PSCmdlet.ShouldProcess($VmName, 'Create clean Windows 11 acceptance VM')) { return }

Write-Host 'Building the unattended answer disk...'
New-AnswerFileDisk -Path $answerDisk

Write-Host 'Creating the VM...'
New-VHD -Path $systemDisk -Dynamic -SizeBytes ($DiskGB * 1GB) | Out-Null
$vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) -VHDPath $systemDisk -Path $VmRoot
Add-VMDvdDrive -VM $vm -Path $IsoPath
Add-VMHardDiskDrive -VM $vm -Path $answerDisk

# Windows 11 requires Secure Boot and TPM 2.0. Meeting them honestly keeps the
# guest a clean supported install; bypassing them would make the acceptance
# evidence describe a configuration users do not have.
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'
Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
Enable-VMTPM -VM $vm

# The guest runs Hyper-V itself, which needs exposed virtualization
# extensions; Hyper-V in turn refuses those alongside dynamic memory.
Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ($MemoryGB * 1GB)
Set-VMProcessor -VM $vm -Count $CpuCount -ExposeVirtualizationExtensions $true
Set-VMNetworkAdapter -VM $vm -MacAddressSpoofing On

# Boot the DVD first for the install; afterwards Windows' own boot entry wins.
$dvd = Get-VMDvdDrive -VM $vm
Set-VMFirmware -VM $vm -FirstBootDevice $dvd
Set-VM -VM $vm -Notes $OwnerTag -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Disabled

Write-Host ''
Write-Host "Created $VmName."
Write-Host "  media SHA-256 : $measured"
Write-Host "  root          : $VmRoot"
Write-Host "  memory/cpu    : ${MemoryGB}GB static / $CpuCount"
Write-Host "  nested virt   : enabled (the guest runs Hyper-V)"
Write-Host ''
Write-Host "Start it with:  Start-VM -Name $VmName"
Write-Host "Then follow docs/verification/issue-106-clean-windows-acceptance.md."
Write-Host "Take a checkpoint named 'clean' once Windows is installed, before DevHotel touches the guest."
