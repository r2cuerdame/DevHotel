# Clean-Windows acceptance procedure — GitHub #106

Status: **not yet run.** This is the procedure and the evidence matrix it has
to fill. #106 stays open until every row below says PASS with durable evidence.

#106's claim is narrow and unusually easy to fake: that a clean Windows 11
machine, with no Docker Desktop, Node, adb, Android Studio or database
preinstalled, reaches a healthy DevHotel-managed Linux runtime. Anything run on
a developer machine proves nothing about it, because the machine already has
what the claim says is unnecessary. So the environment is built from verified
media by [`New-CleanWindowsAcceptanceVm.ps1`](../../scripts/acceptance/issue-106/New-CleanWindowsAcceptanceVm.ps1)
rather than assembled by hand.

## What already holds, and what this is for

Proven, and not re-litigated here:

- the guest bootstrap, on a real boot of the pinned ISO — apkovl discovery,
  `modloop`, OpenRC starting the agent, COM2 answering with the exact identity
  and nonce, and answering across repeated disconnects. See
  [managed-runtime-hyperv.md](../managed-runtime-hyperv.md).
- the pinned image carries the Hyper-V drivers this path needs
  (`CONFIG_HYPERV=y`, `hv_storvsc` in the initramfs with its `vmbus:` aliases,
  `sr_mod`, `vfat`).

That evidence came from QEMU. It says the guest is correct; it says nothing
about Hyper-V, the Windows feature gate, elevation, reboot resume, or repair.
Those are what this procedure is for.

## Host prerequisites

The **Host** needs Hyper-V (`Microsoft-Hyper-V-All`) enabled, which needs
elevation and a reboot. That is a change to the machine running the test, not
to the machine under test. The guest is what must be clean.

Nested virtualization is required, since the guest runs Hyper-V itself. It is
supported on Intel VT-x/EPT, and on AMD from Windows 11 22H2. Note that Hyper-V
does not stack three levels: a Host that is itself a VM cannot provide this.

## 1. Media

Windows 11 Enterprise Evaluation, free and unlicensed for 90 days, from
<https://www.microsoft.com/evalcenter>. Microsoft rotates the download, so the
digest is measured per run and recorded rather than hard-coded — and Microsoft
publishes no digest for this file at all, so the value in the matrix below is one
DevHotel measured.

Fetching and measuring it is scripted rather than done by hand, because the
hand-done version is what differs between attempts and leaves no record of which
bytes the evidence came from:

```powershell
.\scripts\acceptance\issue-106\Get-Windows11EvaluationIso.ps1
```

It resolves the Evaluation Center's own fwlink (no account, no form, no paid
resource), refuses any origin that is not a Microsoft download host and any media
that is not an `ENTERPRISEEVAL` image, caches the ISO under
`%LOCALAPPDATA%\DevHotel\acceptance-media`, and writes a `.provenance.json`
sidecar naming every redirect hop it followed plus the measured SHA-256/SHA-512.
It prints the exact `New-CleanWindowsAcceptanceVm.ps1` line to run next.

A second machine confirms it has the same bytes the evidence names with
`-ExpectedSha256 <digest>`, which fails rather than silently re-fetching.

**Cached for this attempt** (2026-09-17):

| | |
|---|---|
| File | `26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso` |
| Build | 26200.6584 (25H2), Enterprise Evaluation, x64, en-US |
| Size | 7,092,807,680 bytes |
| SHA-256 | `a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9` |
| SHA-512 | `d9880aa30635de940f27bd2892727650dbc957a4c688d7c937f2ee8cda97a910eae43f034901a818519c55ddb11465b2ca68bbf780b170deb1b5ebef205ff6c0` |

Both digests were measured on this Host on 2026-09-17 and re-confirmed by a second
run with `-ExpectedSha256`, which read the cached file back rather than trusting
the value the first run printed. Passing a deliberately wrong digest was also
checked, and it refuses rather than re-fetching.

Record the digest in the matrix below. The VM script refuses to build from media
whose digest does not match what the run declares.

## 2. Build the VM

```powershell
# elevated, on the Host
.\scripts\acceptance\issue-106\New-CleanWindowsAcceptanceVm.ps1 `
    -IsoPath <iso> -IsoSha256 <digest>
Start-VM -Name DevHotel-Acceptance-106
```

Generation 2, Secure Boot on, virtual TPM, static memory, nested
virtualization exposed, the adapter on `Default Switch` (override with
`-SwitchName`) so the guest can fetch its runtime image, and an unattended
install that adds nothing beyond Windows. When Windows finishes installing and
before DevHotel touches it — powered off, because Hyper-V cannot checkpoint a
running VM with nested virtualization exposed:

```powershell
Stop-VM -Name DevHotel-Acceptance-106
Checkpoint-VM -Name DevHotel-Acceptance-106 -SnapshotName clean
```

Every attempt starts by restoring `clean`. A retry on a dirtied guest is not
evidence, because the thing being proven is what happens on a machine that has
never seen DevHotel.

Confirm the guest really is clean before continuing — this is the claim itself,
so it is checked rather than assumed:

```powershell
Get-Command docker, node, adb -ErrorAction SilentlyContinue   # expect nothing
Get-Service *docker*, *mysql*, *postgres* -ErrorAction SilentlyContinue
Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All | Select State
```

## 3. Install DevHotel

Copy in only the NSIS installer built by `pnpm build:installer`, and record its
SHA-256 and the version it reports. Nothing else is copied into the guest.

The installer does not have to be built on the Host. CI's `Package (no publish)`
step already runs `electron-builder --win nsis` on every push and uploads the
result as the `devhotel-installer` artifact, so the guest can be fed a build that
is traceable to a commit — which is better evidence than a local build anyway.
It also avoids a Host-specific obstacle: a running Orca holds a lock on its own
`app.asar`, which makes a local NSIS build fail for a reason that has nothing to
do with DevHotel. Record which commit the installer came from either way.

## 4. The matrix

| # | Claim | How it is shown | Result | Evidence |
|---|---|---|---|---|
| 1 | Guest starts clean | No docker/node/adb/DB; `Microsoft-Hyper-V-All` Disabled | | |
| 2 | Capability is reported honestly | DevHotel reports the Hyper-V gate, not a false ready | | |
| 3 | Feature enable is DevHotel-driven | One UAC prompt; only `Microsoft-Hyper-V-All` enabled; `-NoRestart` | | |
| 4 | Reboot is required and surfaced | DISM `EnablePending` reported as restart-required | | |
| 5 | Declining UAC is retryable | Cancel the prompt; DevHotel stays consistent and can retry | | |
| 6 | Reboot resume works | Restart guest; DevHotel resumes from boot-identity change, no second prompt | | |
| 7 | Provisioning completes | ISO fetched and digest-verified; VM, seed and state disks created | | |
| 8 | VM account reaches its attachments | VM starts; no `0x80070005` on any attachment | | |
| 9 | Nested virt is optional, not silent | Provisioning survives refusal, and Settings reports granted / refused rather than silence | | |
| 10 | **Runtime reaches healthy** | COM2 health returns the exact install/runtime/daemon identity and nonce | | |
| 11 | Identity is observable | Settings → Managed Linux runtime shows state, runtime identity/version, verified image digest, and the nested-virtualization outcome | | |
| 12 | Guest reboot recovers | Restart guest; runtime returns to healthy without human repair | | |
| 13 | Partial provision repairs | Kill mid-provision; restart; repair completes | | |
| 14 | **State disk survives repair** | Write a marker into runtime state, force repair, marker still there | | |
| 15 | Ownership is fenced | Tamper with marker/Notes; DevHotel refuses and does not adopt | | |
| 16 | Two managed Web Rooms | Two Rooms reachable on the managed runtime (gates #107) | | |
| 17 | Uninstall is ownership-safe | VM removed before app data; only DevHotel-owned VM and disks; a VM whose Notes were tampered with is refused, not deleted | | |

Row 17 has two halves and both have to be seen: that an owned VM is gone from
`Get-VM` afterwards, and that a VM whose Notes were edited first is still there.
The second half is what stops the first from being a plain `Remove-VM`.

Rows 10 and 14 are the ones #106 turns on. Row 14 is the one most likely to be
skipped and most expensive to get wrong: a repair that silently discards the
state disk costs the user Room data, and it only shows up in a run that
deliberately puts something in there first.

## 5. Recording the result

The guest has no Node, no adb and no shell tooling by design, so the Settings →
Managed Linux runtime card is the readable surface for rows 9, 10, 11 and 12;
screenshot it rather than trying to query the app from outside.

Add a dated verification document beside this one with the filled matrix, the
media digest, the installer digest and version, and the guest's own output for
rows 10, 12 and 14 — the health reply with its nonce, and the state marker read
back after repair. Then comment on #106 with the result.

If any row fails, #106 stays open and the failure is recorded as-is. A partial
pass is a partial pass; the point of the matrix is that it cannot be rounded up.

## 6. Teardown

```powershell
.\scripts\acceptance\issue-106\New-CleanWindowsAcceptanceVm.ps1 -Remove
```

Removes only the VM this script created, identified by its own Notes tag, and
only disks under its own root.
