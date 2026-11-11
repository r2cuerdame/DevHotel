# 2026-11 milestone #3 closeout

Status: **open**. This page defines the evidence required to close milestone #3;
it does not turn a local test pass into clean-Windows acceptance.

## Scope

Milestone #3 is the 2026-11 product-lifecycle and Hyper-V runtime-stability
milestone. Its due date is 2026-11-30. Close it only when every issue assigned
to milestone #3 is closed and the checks below have evidence on the accepted
change.

The clean-Windows release gates in #106, #107 and #111 are tracked separately
under milestone #1. Their acceptance rows must remain explicitly unproven until
the required clean Windows 11 environment produces the evidence described in
their verification documents. Host unit tests and CI do not satisfy those rows.

## Closeout checks

| Area | Completion condition | Verification evidence | Current finding |
|---|---|---|---|
| PLC record (#175) | The one-page lifecycle plan is present on the accepted base and its review is complete. | Check #175 and its pull request in the GitHub ledger; confirm the canonical `.loop/plc.md` exists in the accepted commit. | Rechecked 2026-11-11 through the manager `/github` gate against `main@5239c0b`: #175 remains open, labelled `blocked`, with no comments; PR #176 remains open and unmerged at head `e3427b52350a9d2a7109d6611bb88423f7da3047` (`build: success`); `.loop/plc.md` is not on `main@5239c0b`. PR #188 and PR #194 separately merged runtime hardening, but neither completes #175's PLC review. PR #176 was cut from `2e88ef6`, before both, and its runtime hunks replace the same ACL step; a merge must keep their tests passing (see *November review* in `2026-12-maintenance-milestone.md`). Milestone #3 stays open; if still unresolved when December starts, #175 carries over under that plan. |
| Hyper-V stability (#181) | Before a VM has ever been recorded, an owned `provisioning` marker with no VM reports `preparing` and runtime identity. A forged VM or a missing VM whose identity was already recorded remains `broken`. The fix must be merged into the accepted base. | The regression tests cover initial VM-creation failure, a forged VM appearing during provisioning, and a previously recorded VM going missing. Check PR #182's merge state and its `build` result against the accepted commit. | The handoff records #181 complete and the manager check for PR #182 reports `build: success`; the merge state must still be confirmed in the ledger before milestone closeout. Confirmed 2026-11-11: #181 is closed and PR #182 merged as `5edfa56`, which `main@2bca7bf` contains. |
| Hyper-V provisioning and ACL hardening (#187) | Keep the 2-minute default while allowing a bounded VM-creation timeout up to 10 minutes; grant the VM identity only an explicit, non-inheriting traverse rule on required ancestors; retain the BOM-prefixed PowerShell `-File` runner. | Review the implementation and regression tests on the accepted base; check PR #188's `build` result. | Confirmed on `main@6564329`: #187 was delivered separately as PR #188, preserving the current BOM-prefixed runner. The fake-Hyper-V tests cover default and maximum timeout forwarding, reject values above the maximum, and inspect the narrow ACL rule. The manager `/github` check reports PR #188 `build: success`; the full local check set is recorded on the current closeout candidate. |
| Traverse-deny handling (#193) | Provisioning reads every required ancestor's ACL before changing any. A deny for the VM account, explicit or inherited, stops provisioning with an error that names each denied directory, and no ACL is written. Only an explicit allow that applies to the directory itself counts as the grant. The non-inheriting traverse rule is added only where it is missing, and an existing grant is not rewritten. The fix must be merged into the accepted base. | Review `packages/core/src/backend/managedHyperVRuntime.ts` and its regression tests on the accepted base; check PR #194's `build` result. | Confirmed on `main@5239c0b`: #193 is closed and PR #194 merged as `5239c0b`; the manager `/github` check reports `build: success`. The generated script classifies each ancestor as `denied`, `missing` or `granted` and throws on any deny before the first `Set-Acl`. Two Windows-only cases in `packages/core/src/__tests__/backend.managedHyperVRuntime.test.ts` run the generated PowerShell against in-memory ACLs and touch nothing on disk. *distinguishes denied, missing, and granted traverse access* covers 14 rule shapes and checks that a deny is left unchanged and that a repeat grant is a no-op. *fails before writing any ancestor ACL when one denies the VM account traversal* runs the whole grant step with `Get-Acl`/`Set-Acl` shadowed: an explicit deny on a middle ancestor and an inherited deny on the leaf each fail with zero writes; a missing middle grant writes that directory alone; fully granted and repeated runs write nothing. On 2026-11-11 the file passed 34 of 34 on this Windows host, both cases included. A run that skips them, as any non-Windows run does, is not evidence. |
| Plan records (#191, #195) | Both milestone pages match the ledger on the accepted base. | Read the pages on the accepted commit and compare them with the ledger. | PR #192 (#191) merged as `c7f2258` (`build: success`). It refreshed the December plan against `main@68a414d` and recorded #193 as open. #195 refreshes both pages against `main@5239c0b` to record PR #192 and PR #194, and adds PR #194's tests to the cases a PR #176 merge must keep passing. #195 stays open until its change merges. #175 then remains the only open issue in milestone #3. |
| Local validation | The accepted code passes the required workspace checks. | Record results for `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm --filter devhotel-mcp build` against the accepted commit. | Recheck against the closeout candidate; do not infer from a different commit. #195 changes documentation only, so its candidate carries `main@5239c0b`'s code; it still runs all four checks. |
| CI validation | The required Windows `build` job succeeds on the accepted pull request commit. | Read the GitHub check for that exact commit and record its conclusion. The workflow packages with `--publish never`. | The required job is `build`; verify the final candidate's check before closing. |
| Separate release gates (#106/#107/#111) | Keep each clean-Windows matrix open until its own required rows have durable evidence. | Use the dated evidence matrix required by each issue's verification document. | These issues belong to milestone #1 and are not claimed complete by milestone #3 checks. |

## Closure decision

If any milestone #3 issue remains open, any required local or CI check is not
green on the accepted commit, or the #175 review is still pending, leave
milestone #3 open and record the exact remaining issue or evidence. Do not
create a release, tag, deployment or new infrastructure as part of this
closeout; deployment is disabled for this project.

## Evidence sources

- GitHub milestone #3: 2026-11, due 2026-11-30.
- GitHub #175 and PR #176: lifecycle-plan review and merge state.
- GitHub #181 and PR #182: preparing observation fix and required build check.
- GitHub #187 and PR #188: bounded provisioning timeout, traversal ACL hardening and required build check.
- GitHub #193 and PR #194: traverse-deny handling, merged as `5239c0b`, and required build check.
- GitHub #191 and PR #192: December plan refresh, merged as `c7f2258`, and required build check.
- GitHub #195: this record of PR #192 and PR #194 on both milestone pages.
- `docs/verification/issue-106-clean-windows-acceptance.md`.
- `docs/verification/issue-107-managed-web-rooms.md`.
- `docs/verification/issue-111-release-gate-readiness.md`.
- `.github/workflows/ci.yml`: required Windows `build` job and no-publish packaging.
- `docs/verification/2026-12-maintenance-milestone.md`: carry-over rules for
  anything still open when milestone #3 is evaluated.
