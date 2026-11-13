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
| PLC record (#175) | The one-page lifecycle plan is present on the accepted base and its review is complete. | Check #175 and its pull request in the GitHub ledger; confirm the canonical `.loop/plc.md` exists in the accepted commit. If PR #176 merges, run the six regression cases named under *November review* in `2026-12-maintenance-milestone.md` on the merge commit. | Rechecked 2026-11-11 through the manager `/github` gate against `main@8ef148b`: #175 remains open with no comments; PR #176 remains open and unmerged at head `e3427b52350a9d2a7109d6611bb88423f7da3047` (`build: success`), and `.loop/plc.md` is not on `main@8ef148b`. PR #188 separately merged runtime hardening, but does not complete #175's PLC review. PR #176 was cut from `2e88ef6`, before PR #188 and PR #194. Besides `.loop/plc.md` it edits `managedHyperVRuntime.ts`, `managedRuntime.ts` and `backend.managedHyperVRuntime.test.ts`, and its test expects a 600 s timeout on the default VM-creation script. If it merges, the merge commit must keep both PRs' runtime behaviour and pass the six cases with their assertions unchanged: PR #188's four (BOM-prefixed runner, traverse-only ACL rule, 2-minute default with 10-minute ceiling, rejection above ten minutes) and PR #194's two (denied/missing/granted classification, no ACL write when any ancestor denies). PR #194's two cases run only on Windows, so they must run in a Windows per-test run or the merge commit's CI `build` job; a skipped case is not a pass. Milestone #3 stays open; if still unresolved when December starts, #175 carries over under `2026-12-maintenance-milestone.md`. |
| Hyper-V stability (#181) | Before a VM has ever been recorded, an owned `provisioning` marker with no VM reports `preparing` and runtime identity. A forged VM or a missing VM whose identity was already recorded remains `broken`. The fix must be merged into the accepted base. | The regression tests cover initial VM-creation failure, a forged VM appearing during provisioning, and a previously recorded VM going missing. Check PR #182's merge state and its `build` result against the accepted commit. | The handoff records #181 complete and the manager check for PR #182 reports `build: success`; the merge state must still be confirmed in the ledger before milestone closeout. Confirmed 2026-11-11: #181 is closed and PR #182 merged as `5edfa56`, which `main@2bca7bf` contains. |
| Hyper-V provisioning and ACL hardening (#187) | Keep the 2-minute default while allowing a bounded VM-creation timeout up to 10 minutes; grant the VM identity only an explicit, non-inheriting traverse rule on required ancestors; retain the BOM-prefixed PowerShell `-File` runner. | Review the implementation and regression tests on the accepted base; check PR #188's `build` result. | Confirmed on `main@6564329`: #187 was delivered separately as PR #188, preserving the current BOM-prefixed runner. PR #190 (#189) later recorded this result on both milestone pages and merged as `68a414d`; its check reported `build: success`. The fake-Hyper-V tests cover default and maximum timeout forwarding, reject values above the maximum, and inspect the narrow ACL rule. |
| Traverse-deny handling (#193) | Provisioning must classify every required ancestor before changing any ACL. Any applicable explicit or inherited deny stops provisioning before the first ACL write and leaves the deny unchanged. Add only a non-inheriting traverse rule where permission is missing; leave an existing grant alone. | Review the merged implementation and regression tests; check PR #194's `build` result. | Confirmed on `main@5239c0b`: #193 and PR #194 are complete; PR #194 merged as `5239c0b` with `build: success`. Its tests distinguish denied, missing and granted access, verify no ACL writes when any ancestor denies traversal, add only the missing rule, and keep repeat runs unchanged. Rechecked 2026-11-11 for #203: `5239c0b..8ef148b` (PR #200 and PR #202) changes only the two milestone pages, so the runtime code on `main@8ef148b` is PR #194's. A Windows per-test run of `backend.managedHyperVRuntime.test.ts` on that code passed all 34 cases, and both Windows-only PR #194 cases ran rather than being skipped. This is separate runtime stability work and does not complete #175's PLC review. |
| Plan records (#189/#190, #191/#192, #195/#196, #197/#198, #199/#200, #201/#202, #203/#204) | The milestone pages record completed plan refreshes without implying that an open review or unverified check is complete. | Compare the dated page entries with the GitHub ledger and the accepted commit. | PR #190 (`68a414d`) recorded #187/#188; PR #192 (`c7f2258`) refreshed the December plan against `68a414d`; PR #194 (`5239c0b`) completed #193. #199 is closed: PR #200 merged as `b96aab3` with `build: success` and recorded PR #194's protection criteria on both pages. Rechecked 2026-11-11 through the manager `/github` gate: #195/PR #196 and #197/PR #198 stay open, and the required `build` check failed on both PR heads. #201 is closed: PR #202 merged as `8ef148b` with `build: success` on its head `75d3fd1` and refreshed the page history against `main@b96aab3`. Issue #203, with PR #204, is the current refresh against `main@8ef148b`. On that date the ledger showed milestone #3 with 10 closed and 4 open issues: #175, #195, #197 and #203. Keep the milestone open while any assigned issue or required evidence remains open. |
| Local validation | The accepted code passes the required workspace checks. | Record results for `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm --filter devhotel-mcp build` against the accepted commit. | Recheck against the closeout candidate; do not infer from a different commit. Documentation-only changes run all four checks on their own candidate. |
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
- GitHub #189 and PR #190: both milestone pages' record of #187/#188, merged as `68a414d` with its `build` check.
- GitHub #191 and PR #192: December plan refresh, merged as `c7f2258` with its `build` check.
- GitHub #193 and PR #194: traverse-deny handling and regression tests, merged as `5239c0b` with its `build` check.
- GitHub #199 and PR #200: both pages' record of PR #194's protection criteria, merged as `b96aab3` with its `build` check.
- GitHub #195/PR #196 and #197/PR #198: outstanding milestone-document work; both PR heads failed the required `build` check on 2026-11-11, so recheck the exact PR head and `build` result in the ledger before closeout.
- GitHub #201 and PR #202: the page-history refresh against `main@b96aab3`, merged as `8ef148b` with its `build` check.
- GitHub #203 and PR #204: this refresh against `main@8ef148b`; confirm its accepted head and `build` result before closeout.
- `docs/verification/issue-106-clean-windows-acceptance.md`.
- `docs/verification/issue-107-managed-web-rooms.md`.
- `docs/verification/issue-111-release-gate-readiness.md`.
- `.github/workflows/ci.yml`: required Windows `build` job and no-publish packaging.
- `docs/verification/2026-12-maintenance-milestone.md`: carry-over rules for
  anything still open when milestone #3 is evaluated.
