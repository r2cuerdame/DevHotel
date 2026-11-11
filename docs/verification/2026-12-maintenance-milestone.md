# 2026-12 maintenance milestone — completion conditions and verification plan

Status: **draft plan**, first written 2026-11-11 against `main@2bca7bf` and
refreshed the same day against `main@68a414d`, the merge of PR #190, and again
against `main@5239c0b`, the merge of PR #194. It defines
what has to be true, and what has to be recorded, before the December
maintenance milestone can close. It claims no result: every row below starts
unproven and is closed only by evidence on the accepted commit.

## Period and goal

The milestone runs from **2026-12-01 to 2026-12-31**, due 2026-12-31. Its goal
is stability and maintenance of the existing isolated development runtime for
Windows 11: bugs, stability fixes, regressions and closeout of work carried over
from milestone #3 (2026-11).

It is not a feature milestone. New features and product-direction changes are
proposed with `needsApproval: true`, `reason: direction`, and anything that adds
cost with `needsApproval: true`, `reason: cost`; neither is assigned to this
milestone until the owner approves it. The canonical version stays `0.5.4`, and
the milestone ships no release (see *Closeout record*).

When the GitHub milestone is opened, assign it the carried-over issues listed
below and the maintenance issues selected for December. As of 2026-11-11 no open
issue is assigned to a December milestone.

## Carried over from milestone #3

Read from the GitHub ledger through the manager `/github` gate on 2026-11-11,
against `main@5239c0b`. Recheck before December starts; this table is a
snapshot, not a substitute for the ledger.

| Item | State on 2026-11-11 | What it means for December |
|---|---|---|
| #175 PLC record, PR #176 | #175 open, labelled `blocked`, in milestone #3. PR #176 open and unmerged at head `e3427b5`; its `build` check succeeded on that head. #175 has no comments, and #177, the `repair_exhausted` lesson for its review, is still open. `.loop/plc.md` is not on `main@5239c0b`. | The November review has not finished, so milestone #3 stays open (see *November review*). |
| PR #176 scope | The PR was cut from `2e88ef6`. Besides `.loop/plc.md`, it carries a `Set-Acl` traversal grant, a fixed 600 s provisioning timeout and a temporary `-File` runner without a BOM. Each of those hunks overlaps code PR #188 has since changed on `main`: the BOM-prefixed `-File` runner, the bounded `provisioningTimeoutMs` option, and the explicit traverse-only ACL rule. Its ACL hunk also predates PR #194. It counts an inherited or inherit-only allow as the grant, never looks for a deny, and writes each ancestor's ACL before judging the next. The missing deny check is the #193 defect PR #194 removed. #175's acceptance is the PLC record only. | The runtime work was separated into #187 and #193 and delivered by PR #188 and PR #194. A PLC review does not cover runtime code, and a merge of PR #176 must not undo either of them (see *November review*). |
| #187, PR #188 | Closed; PR #188 merged as `6564329` on 2026-11-11. It separately delivered bounded VM-creation timeout and explicit traversal-only ACL handling while preserving the current BOM-prefixed script runner. | Complete. Its tests keep the 2-minute default, allow up to 10 minutes, reject a higher value, and verify the ACL script is explicit, non-inheriting and does not call `icacls`. The manager `/github` check reports `build: success`. |
| #189, PR #190 | Closed. PR #190 merged as `68a414d` on 2026-11-11; the manager `/github` check reports `build: success`. It recorded #187 and PR #188 in `2026-11-milestone-3-closeout.md` and in this plan. | Done. `68a414d` was the base of the previous refresh (#191). |
| #181, PR #182 | Closed. PR #182 merged as `5edfa56`, which `main@5239c0b` contains. | Done. Its regression tests stay part of `pnpm test`. |
| #183, PR #184 | Closed. PR #184 merged as `2bca7bf`. | Done. `2026-11-milestone-3-closeout.md` stays the November record. |
| #185, PR #186 | Closed. PR #186 merged as `f3ed447` and put this plan on `main`. | Complete. |
| #191, PR #192 | Closed. PR #192 merged as `c7f2258` on 2026-11-11; the manager `/github` check reports `build: success`. It refreshed this plan against `main@68a414d` and added the #193 row. | Done. |
| #193, PR #194 | Closed. PR #194 merged as `5239c0b` on 2026-11-11; the manager `/github` check reports `build: success`. Provisioning now reads every required ancestor's ACL first. A deny for the VM account, explicit or inherited, stops it with an error naming each denied directory before any ACL is written. Only an explicit allow that applies to the directory itself counts as the grant. The non-inheriting traverse rule is added only where missing, and an existing grant is left alone. PR #188's four cases still pass on `5239c0b`. | Done. It is November stability work, not part of the PLC review. Its two Windows-only cases join the cases a PR #176 merge must keep passing (see *November review*). |
| #195 (this refresh) | Open, assigned to milestone #3. | Closes with this update. #175 then remains the only open issue in milestone #3. |

## Completion conditions

| # | Area | Completion condition | Verification evidence |
|---|---|---|---|
| 1 | Period and scope | Work lands between 2026-12-01 and 2026-12-31 and is stability or maintenance on the existing runtime. Unapproved features, direction changes and new costs are not in the milestone. | The milestone's issue list in the ledger; each issue's approval marker. |
| 2 | November review | The #175 review has finished: PR #176 merged or closed, with the outcome recorded on #175, and `.loop/plc.md` present on the accepted base if it merged. | #175, PR #176 and the accepted commit's tree. If PR #176 merged, PR #188's and PR #194's runtime tests pass on that merge commit in a Windows run. |
| 3 | Selected code changes | Every code change merged under this milestone adds or updates a regression test that fails without the change, and the pull request names it. The required checks pass on that pull request's head commit. | `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm --filter devhotel-mcp build` results, plus the CI `build` conclusion read for that exact head SHA. The merged hardening from #187/#188 and #193/#194 is evidence for the November work; it does not close #175. |
| 4 | Clean-Windows gates (#106/#107/#111) | Kept separate and open until a real clean Windows 11 environment fills each required row. | The dated matrices required by `issue-106-clean-windows-acceptance.md`, `issue-107-managed-web-rooms.md` and `issue-111-release-gate-readiness.md`. |
| 5 | Closeout record | A dated closeout document lists every remaining issue with its reason and every piece of evidence with its commit SHA. The version stays `0.5.4` and no deployment work is done. | The closeout document; `.loop/project.md` and the package manifests still at `0.5.4`. |

### November review (row 2)

At the start of December, read #175 and PR #176 in the ledger.

- If the review has finished, record the outcome and the merge commit (or the
  closing reason) in `2026-11-milestone-3-closeout.md`, then apply that page's
  closure decision to milestone #3.
- If PR #176 merged, check that the merge commit still holds the runtime
  behaviour of PR #188 and PR #194 in
  `packages/core/src/backend/managedHyperVRuntime.ts`:
  - from PR #188: the BOM-prefixed `-File` runner, `provisioningTimeoutMs`
    with its 2-minute default and 10-minute ceiling, and the explicit
    non-inheriting traverse rule;
  - from PR #194: every ancestor's ACL is read and judged `denied`, `missing`
    or `granted` before the first `Set-Acl`. Any applicable deny, explicit or
    inherited, throws an error naming the denied directories and leaves the
    deny unchanged. Only an explicit allow that applies to the directory
    itself counts as the grant, the rule is added only where it is `missing`,
    and an existing grant is never rewritten.

  These cases in
  `packages/core/src/__tests__/backend.managedHyperVRuntime.test.ts` must pass
  on that commit:
  - from PR #188: *executes a BOM-prefixed UTF-8 script from a non-ASCII user
    profile path*, *lets the Hyper-V VM account traverse to its attachments,
    and no more*, *keeps the default VM creation timeout at two minutes and
    allows an explicit ten-minute ceiling* and *rejects a VM creation timeout
    above ten minutes*. PR #194 extended *lets the Hyper-V VM account traverse
    to its attachments, and no more* to check that the deny check runs before
    the first `Set-Acl`.
  - from PR #194: *distinguishes denied, missing, and granted traverse access*
    and *fails before writing any ancestor ACL when one denies the VM account
    traversal*.

  The two PR #194 cases run only on Windows
  (`it.runIf(process.platform === 'win32')`) and are skipped elsewhere. A
  skipped case is not a pass. Read them as passed in a Windows run: a local
  run with a per-test reporter, or the CI `build` job on `windows-latest` for
  the merge commit.

  A merge that carries only `.loop/plc.md` leaves all six untouched. PR #176 as
  cut from `2e88ef6` does not. Taking its side of `managedHyperVRuntime.ts`
  would drop the deny check, the BOM and `provisioningTimeoutMs`, and fix the
  timeout at 600 s. Taking its side of the test file would drop the cases
  above. Those hunks are outside #175's scope; resolve them to `main`'s side
  or remove them before the merge.
- If it has not finished, leave milestone #3 open. Record in the November
  closeout which item is still open and why (on 2026-11-11: review pending, and
  PR #176 carries runtime code outside #175's scope that overlaps the merged
  hardening of PR #188 and PR #194). Then carry #175 into the
  December milestone, where row 2 keeps December open on the same terms.

Do not close a milestone to make the calendar line up. An open milestone with a
written reason is the correct state.

### Code changes and required checks (row 3)

A change is selected for December when it fixes a reproduced defect or hardens
existing behaviour without changing product direction. For each one:

- The regression test reproduces the failure first. For managed-runtime code the
  `FakeHyperV` harness in
  `packages/core/src/__tests__/backend.managedHyperVRuntime.test.ts` is the
  pattern: PR #182 added cases for a forged VM that appears during provisioning
  and for a recorded VM that has gone missing, next to the fix in
  `packages/core/src/backend/managedHyperVRuntime.ts`. For generated
  PowerShell that changes host ACLs, PR #194 is the pattern: it runs the
  generated step in real PowerShell with `Get-Acl` and `Set-Acl` shadowed over
  in-memory ACLs, so what is written is observed and nothing on disk changes.
- The four workspace checks run through the CSX observation path, against the
  pull request's head commit:

  ```
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm --filter devhotel-mcp build
  ```

  Documentation-only changes run them too. They are cheap compared with a
  missed regression, and CI runs them anyway.
- The CI `build` job in `.github/workflows/ci.yml` must succeed on the same head
  SHA. It repeats the checks on `windows-latest` and packages the NSIS
  installer with `--publish never`. A success on an earlier head does not count
  for a later one.
- A host fake or unit test proves the host-side contract only. It is not
  evidence for any clean-Windows row (row 4).

### Clean-Windows gates (row 4)

#106, #107 and #111 belong to milestone #1 and stay there. December work may
make their code paths more robust, but closing them takes the dated
clean-Windows matrices their own verification documents describe. Host unit
tests, the CI `build` job and `FakeHyperV` runs do not fill those rows. The
December closeout lists each gate as open, with the reason it is still
unproven, unless a real run filled its required rows. A partial run is
recorded as partial.

### Closeout record (row 5)

Write `docs/verification/2026-12-milestone-closeout.md` when the milestone is
evaluated. It contains:

- the remaining open issues in the milestone, each with its reason;
- for each merged change: the pull request, its head and merge SHAs, the
  regression test it added, and the four local results and the CI `build`
  conclusion for that head;
- the state of #175 (row 2) and of #106/#107/#111 (row 4), as read from the
  ledger on the closeout date;
- confirmation that `.loop/project.md` and the package manifests still read
  `0.5.4`.

Deployment is disabled (`deployWorkflow: not_required`). The milestone does not
run `release.yml`, `android-emulator-preview-image.yml` or any other deploy,
release or image-publication workflow. It also creates no tag or release, and
neither creates nor changes paid infrastructure.

## Closure decision

Close the December milestone only when rows 1, 2, 3 and 5 hold and the closeout
document records row 4 accurately. Otherwise leave it open and record the exact
issue or missing evidence that keeps it open. Rows 2 and 4 are where a
milestone is most often rounded up, and neither may be.

## Evidence sources

- GitHub milestone #3 (2026-11, due 2026-11-30) and the December milestone once
  opened.
- GitHub #175, PR #176 and #177: PLC review state, scope and lesson record.
- GitHub #181 and PR #182: the merged `preparing` observation fix and its tests.
- GitHub #187 and PR #188: merged timeout and ACL hardening, its regression tests and CI check.
- GitHub #185 and PR #186: this plan's first version, merged as `f3ed447`.
- GitHub #189 and PR #190: the #187 record in both milestone pages, merged as
  `68a414d`, and its CI check.
- GitHub #191 and PR #192: the refresh of this plan against `main@68a414d`,
  merged as `c7f2258`, and its CI check.
- GitHub #193 and PR #194: traverse-deny handling during VM provisioning,
  merged as `5239c0b`, its regression tests and CI check.
- GitHub #195: this refresh of the plan against `main@5239c0b`.
- `docs/verification/2026-11-milestone-3-closeout.md`.
- `docs/verification/issue-106-clean-windows-acceptance.md`.
- `docs/verification/issue-107-managed-web-rooms.md`.
- `docs/verification/issue-111-release-gate-readiness.md`.
- `.loop/project.md`: canonical version `0.5.4`, deployment disabled.
- `.github/workflows/ci.yml`: required Windows `build` job, no-publish packaging.
