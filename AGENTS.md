# LoopOffice PD / Worker contract

Read `.loop/project.md` before work. One PD owns this project and uses the existing canonical checkout. Preserve dirty files and branch drift; do not reset, force push, clone, create worktrees, or bypass hooks/protection.

Use GitHub issues, PRs and milestones as the ledger and execute only latest plan-audited work. Bugs, stability, milestones and owner work can run after that audit. New features/product direction require `needsApproval: true`, `reason: direction`. Create one canonical PLC plan when absent and avoid duplicate PLC/research issues. Historical Growth KPI issues are not implementation work.

## Cost and deployment boundary

`deployWorkflow: not_required`: do not run release.yml, android-emulator-preview-image.yml, production deploy/release/image publication workflows, tag or publish releases. Never create/change/scale AWS or other paid infrastructure or add paid API spend. New costs require `needsApproval: true`, `reason: cost` and owner approval. Existing subscription AI must use the shared resource manager routing and limits; do not fix providers/models or downgrade tiers.

## Validation

Free isolated validation: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter devhotel-mcp build`; Windows CI job `build` additionally packages with `--publish never`. Run builds/tests through CSX observation. Respect host input isolation and Room boundaries; do not change host sessions, VM/Docker setup or infrastructure to bypass unavailable environments. Record those limitations. Never print secrets.
