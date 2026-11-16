# LoopOffice PD / Worker contract

Read `.loop/project.md` before work. One PD owns this project and uses the existing canonical checkout. Preserve dirty files and branch drift; do not reset, force push, clone, create worktrees, or bypass hooks/protection.

Use GitHub issues, PRs and milestones as the ledger and execute only latest plan-audited work. Bugs, stability, milestones and owner work can run after that audit. New features/product direction require `needsApproval: true`, `reason: direction`. Create one canonical PLC plan when absent and avoid duplicate PLC/research issues. Historical Growth KPI issues are not implementation work.

## Cost and deployment boundary

`deployWorkflow: not_required`: do not run release.yml, android-emulator-preview-image.yml, production deploy/release/image publication workflows, tag or publish releases. Never create/change/scale AWS or other paid infrastructure or add paid API spend. New costs require `needsApproval: true`, `reason: cost` and owner approval. Existing subscription AI must use the shared resource manager routing and limits; do not fix providers/models or downgrade tiers.

## Validation

Free isolated validation: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter devhotel-mcp build`; Windows CI job `build` additionally packages with `--publish never`. Run builds/tests through CSX observation. Respect host input isolation and Room boundaries; do not change host sessions, VM/Docker setup or infrastructure to bypass unavailable environments. Record those limitations. Never print secrets.

## 로컬 웹 QA 도구 (Playwright CLI, #235 · LoopOffice #397)

- DevHotel과 로컬 웹 QA의 기본 도구는 **Playwright CLI**(`@playwright/cli@latest`, 로컬 스킬 `.claude/skills/playwright-cli`)다.
  - 설치·확인: `npm install -g @playwright/cli@latest` 후 `playwright-cli --help`, 스킬 등록: `playwright-cli install --skills`
  - **기본은 헤드리스**다. 집 PC에서 의종이 보는 창을 띄우거나(`--headed` 금지) 의종의 마우스·키보드·창을 조작하지 않는다.
  - 대안: Playwright MCP(`https://github.com/microsoft/playwright-mcp`).
  - 보조 유지: `agent-browser` / `agent-desktop`(LoopOffice #383)은 도우미로 유지하며 제거하거나 대체하지 않는다.
- 금지: Browserbase, Steel, Hyperbrowser, browser-use cloud, Lightpanda 등 유료·클라우드 브라우저 및 새 유료 플랜.
- 되돌리기: 창 침범·불안정·작업 방해가 발생하면 `npm uninstall -g @playwright/cli` 및 `.claude/skills/playwright-cli` 제거로 즉시 원복한다.

## 문서·주석 원칙 (nocomment-rule-1116, 의종 2026-11-16 20:14 결정, 춈스케 전달)

코드를 설명하는 문서와 주석은 쓰지 않는다.
- 이유: 문서·주석도 관리 대상이 되어 코드·문서·주석이 따로 놀고, 코딩마다 셋을 다 갱신해야 해서 문제가 생긴다.
- 문서: 사용법, 가이드, 방향성 같은 기획 문서만 둔다. 코드 구조나 동작을 따라 적는 문서는 만들지 않는다.
- 주석: 기본 금지. 코드만 봐서는 알 수 없는 예외(외부 버그 우회, 의도적인 특이 동작 등)만 짧게 쓴다.
- 리뷰(체크 항목): 새 PR에 이 원칙을 어긴 문서·주석이 있으면 지적한다. 기존 코드는 그 파일을 고칠 때 같이 정리한다. 대청소 PR은 만들지 않는다.
