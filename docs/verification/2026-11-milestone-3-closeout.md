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
| PLC record (#175) | The one-page lifecycle plan is present on the accepted base and its review is complete. | Check #175 and its pull request in the GitHub ledger; confirm the canonical `.loop/plc.md` exists in the accepted commit. | Rechecked 2026-11-11 through the manager `/github` gate: #175 remains open; PR #176 remains open and unmerged at head `e3427b52350a9d2a7109d6611bb88423f7da3047` (`build: success`). PR #188 separately merged runtime hardening, but does not complete #175's PLC review. Milestone #3 stays open; if still unresolved when December starts, #175 carries over under `2026-12-maintenance-milestone.md`. |
| Hyper-V stability (#181) | Before a VM has ever been recorded, an owned `provisioning` marker with no VM reports `preparing` and runtime identity. A forged VM or a missing VM whose identity was already recorded remains `broken`. The fix must be merged into the accepted base. | The regression tests cover initial VM-creation failure, a forged VM appearing during provisioning, and a previously recorded VM going missing. Check PR #182's merge state and its `build` result against the accepted commit. | The handoff records #181 complete and the manager check for PR #182 reports `build: success`; the merge state must still be confirmed in the ledger before milestone closeout. Confirmed 2026-11-11: #181 is closed and PR #182 merged as `5edfa56`, which `main@2bca7bf` contains. |
| Hyper-V provisioning and ACL hardening (#187) | Keep the 2-minute default while allowing a bounded VM-creation timeout up to 10 minutes; grant the VM identity only an explicit, non-inheriting traverse rule on required ancestors; retain the BOM-prefixed PowerShell `-File` runner. | Review the implementation and regression tests on the accepted base; check PR #188's `build` result. | Confirmed on `main@6564329`: #187 was delivered separately as PR #188, preserving the current BOM-prefixed runner. The fake-Hyper-V tests cover default and maximum timeout forwarding, reject values above the maximum, and inspect the narrow ACL rule. The manager `/github` check reports PR #188 `build: success`; the full local check set is recorded on the current closeout candidate. |
| Local validation | The accepted code passes the required workspace checks. | Record results for `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm --filter devhotel-mcp build` against the accepted commit. | Recheck against the closeout candidate; do not infer from a different commit. |
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
- `docs/verification/issue-106-clean-windows-acceptance.md`.
- `docs/verification/issue-107-managed-web-rooms.md`.
- `docs/verification/issue-111-release-gate-readiness.md`.
- `.github/workflows/ci.yml`: required Windows `build` job and no-publish packaging.
- `docs/verification/2026-12-maintenance-milestone.md`: carry-over rules for
  anything still open when milestone #3 is evaluated.
