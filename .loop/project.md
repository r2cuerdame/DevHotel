---
stage: 보수/PLC
platform: windows
productStage: released
version: 0.5.4
deployWorkflow: not_required
smokeUrl: https://github.com/r2cuerdame/DevHotel
versionNeedle: DevHotel
---

DevHotel은 Windows 11용 격리 개발 런타임이다. canonical checkout은 `C:\_Project\DevHotel`이며 한 PD와 한 Worker만 사용한다. 기존 dirty 파일과 branch/HEAD drift는 보존하고 임의 reset, 별도 clone/worktree, 강제 push를 하지 않는다. 기본 브랜치는 main, 상태 이슈 제목은 상태, 필수 CI job은 ci.yml의 build다.

GitHub issue/PR/milestone 및 최신 계획 감사를 원장으로 사용한다. 버그·안정성·마일스톤·오너 일감은 계획 감사 뒤 실행하고 새 기능과 제품 방향 변경은 `needsApproval: true`, `reason: direction` 제안으로 오너 승인을 기다린다. PLC가 없으면 singleton 한 장 계획을 먼저 만들며 중복 계획/조사 이슈를 만들지 않는다. 기존 Growth KPI 기록을 구현 일감으로 실행하지 않는다.

배포는 비활성화한다. PD/Worker는 release.yml, android-emulator-preview-image.yml 및 production deploy/release/image publication workflow를 실행하거나 태그/릴리스를 만들지 않는다. AWS/기타 유료 인프라 생성·변경·증설이나 유료 API 지출은 하지 않는다. 새 비용이 필요한 일감은 `needsApproval: true`, `reason: cost`로 제안하고 오너 승인을 기다린다. 기존 구독 AI는 공통 자원 관리자 한도/라우팅만 사용하며 제공자/모델을 고정하거나 강등하지 않는다.

무료 로컬/CI 검증은 pnpm lint, pnpm typecheck, pnpm test, pnpm --filter devhotel-mcp build다. ci.yml build는 Windows 설치 프로그램을 --publish never로 검증한다. 빌드/테스트는 CSX 관찰 경로를 사용한다. 호스트 입력 격리와 기존 Room 경계를 지키며, 테스트를 위해 사용자 세션·VM·Docker·인프라를 임의 변경하지 않는다. 필요한 환경이 없으면 제약을 기록한다.
