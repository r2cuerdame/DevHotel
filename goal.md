# DevHotel — Product Goal

> **Every project gets its own room.**
>
> **Easy Setup · Easy Change · Easy Check · Easy Undo**

---

## 0. 문서 목적

이 문서는 DevHotel의 제품 목표, 핵심 개념, UX 원칙, MVP 범위, 기술적 경계와 장기 확장 방향을 정의한다.

구현 과정에서 프레임워크나 세부 기술은 변경될 수 있지만 다음 제품 정체성은 유지해야 한다.

> **DevHotel은 웹 프로젝트마다 독립적이고 오래 유지되는 로컬 개발 서버를 하나씩 제공하며, 사용자는 그것을 브라우저처럼 열고 닫는다.**

DevHotel은 Docker, WSL, 컨테이너, 로컬 DNS, 인증서, 포트 매핑, 런타임 설치 같은 기술을 사용자에게 그대로 노출하는 도구가 아니다. 그 기술들을 개발자가 이해하기 쉬운 **Room**이라는 개념으로 압축하는 제품이다.

---

## 1. 해결하려는 문제

웹 프로젝트가 두 개만 되어도 개발자는 다음 문제를 반복해서 겪는다.

- 프로젝트마다 Node.js 버전이 다르다.
- npm, pnpm, yarn, Bun 버전과 전역 패키지가 섞인다.
- 여러 프로젝트가 같은 `3000`, `5432`, `6379` 포트를 사용한다.
- 종료한 줄 알았던 개발 서버와 자식 프로세스가 살아남는다.
- PostgreSQL, MySQL, Redis 등의 데이터와 설정이 프로젝트 사이에서 섞인다.
- `.env`, 로컬 DNS, HTTPS 인증서, reverse proxy 설정을 프로젝트마다 다시 만든다.
- 몇 달 뒤 프로젝트를 다시 열면 어떤 환경이 필요했는지 기억나지 않는다.
- AI agent가 패키지와 도구를 설치한 뒤 무엇을 변경했는지 파악하기 어렵다.
- Docker나 Dev Container로 격리할 수 있지만, 그것을 구성하고 유지하는 것 자체가 또 다른 작업이다.
- 문제가 생기면 Task Manager, Docker UI, WSL, 로그, 포트 도구, 설정 파일을 돌아다녀야 한다.

기존 도구는 대부분 **환경을 정의하는 법**, **컨테이너를 관리하는 법**, **서비스를 설치하는 법**에 집중한다.

DevHotel은 질문을 바꾼다.

> **“개발 서버를 어떻게 구성하지?”가 아니라 “이 프로젝트 방을 열어줘.”**

---

## 2. 제품 한 문장 정의

> **DevHotel은 프로젝트별로 격리된 로컬 개발 서버를 만들고, 유지하고, 빠르게 변경하고, 문제를 확인하고, 변경을 Undo할 수 있는 브라우저형 데스크톱 앱이다.**

더 짧게 표현하면 다음과 같다.

> **A browser for isolated local development servers.**

---

## 3. 제품 모토

### 3.1 Easy Setup

GitHub 저장소나 로컬 폴더를 선택하면 DevHotel이 프로젝트를 분석하고 필요한 환경을 제안한다.

사용자는 Dockerfile, compose network, volume, PATH, reverse proxy 설정을 직접 만들지 않아도 된다.

### 3.2 Easy Change

Node.js 버전, package manager, DB, Redis, 도메인, HTTPS, 시작 명령 같은 자주 바꾸는 요소를 UI에서 빠르게 변경한다.

모든 고급 설정을 UI로 옮기려 하지 않는다. 자주 쓰는 변경만 제품 수준으로 제공하고, 나머지는 Console로 연결한다.

### 3.3 Easy Check

Room이 실행되지 않거나 이상할 때 사용자가 원인 조사를 시작하지 않아도 된다.

DevHotel이 런타임, 의존성, 서비스, 프로세스, 포트, 라우팅, HTTPS, HTTP 응답을 순서대로 검사하고 현재 문제를 요약한다.

### 3.4 Easy Undo

사용자는 과거 시점을 기억하거나 snapshot에 태그를 붙이지 않는다.

사용자가 기억하는 것은 시간보다 행동이다.

- `Node 22 → 24 변경`
- `Redis 추가`
- `PostgreSQL 16 → 17 변경`
- `HTTPS 활성화`
- `Dependencies clean reinstall`

DevHotel은 이 행동을 기록하고, 가능한 변경은 **행동 단위로 Undo**한다.

---

## 4. 반드시 지켜야 할 제품 원칙

### 4.1 Room은 일회용보다 장기 유지가 우선이다

Room은 기본적으로 persistent environment다.

프로젝트를 몇 달 동안 개발하더라도 해당 프로젝트의 런타임, 서비스 데이터, 캐시, 브라우저 세션과 환경 설정이 그대로 유지되어야 한다.

Room을 닫는 것은 삭제가 아니다. 기본 동작은 **Sleep**이며 CPU와 RAM 사용을 멈추되 저장 상태는 유지한다.

### 4.2 사용자는 사이트를 먼저 본다

Room에 들어갔을 때 가장 크게 보여야 하는 것은 관리 대시보드가 아니라 **실행 중인 웹사이트**다.

DevHotel은 Docker Desktop처럼 시작해서는 안 된다. 브라우저처럼 보여야 한다.

### 4.3 격리는 보이지 않아야 한다

Docker, WSL, OCI, network namespace, volume, container ID, port mapping은 구현 세부사항이다.

일반 UI에는 다음 개념만 보여준다.

- Runtime
- Package Manager
- Web Server
- Database
- Redis
- Domain
- HTTPS
- Environment Variables
- Storage
- Health
- Changes

### 4.4 UI는 요약하고 Console은 전부 보여준다

DevHotel은 모든 세부 설정을 위한 GUI를 만들지 않는다.

UI는 상태 확인과 Quick Change에 집중한다. 상세 로그, 원본 설정, 고급 명령, 예외적인 조작은 Console 또는 해당 원본 도구로 연결한다.

> **UI는 길을 줄이고, Console은 자유를 보장한다.**

### 4.5 변경은 의미 단위로 기록한다

사용자에게 `18,421 files changed`만 보여주지 않는다.

가능하면 다음처럼 표시한다.

- Node.js `22.12 → 24.1`
- Redis `8` added
- PostgreSQL data `284 MB` restored
- HTTPS enabled for `loopoffice.localhost`
- `pnpm install` rebuilt dependency volume

Raw filesystem diff는 필요할 때 펼쳐보는 상세정보다.

### 4.6 앱 업데이트와 Room 업데이트는 분리한다

DevHotel 앱은 자동 업데이트할 수 있다.

그러나 앱 업데이트가 Room의 Node.js, DB, Redis, package manager 버전을 자동 변경해서는 안 된다.

Room 환경은 사용자의 명시적인 변경 또는 프로젝트 선언에 의해서만 변경된다.

### 4.7 Local-first

초기 제품은 로컬에서 완결되어야 한다.

- 계정 없이 사용할 수 있어야 한다.
- 사용자의 source, `.env`, DB 데이터, 로그를 외부 서버로 전송하지 않는다.
- LLM API를 필수 의존성으로 두지 않는다.
- 진단 결과는 클립보드로 복사해 사용자가 원하는 LLM에 붙일 수 있다.

### 4.8 Web first, provider architecture

첫 번째 제품은 Web Room만 구현한다.

장기적으로 Android Room을 추가할 수 있도록 provider 구조를 사용하되, 초기부터 Android 기능을 함께 구현하지 않는다.

---

## 5. 핵심 개념

### 5.1 Hotel

DevHotel 앱 전체다.

### 5.2 Lobby

앱의 첫 화면이다.

현재 생성된 Room을 카드 형태로 보여주며, 새 Room을 만드는 `+` 카드가 존재한다.

### 5.3 Project

Git 저장소 또는 로컬 source folder다.

하나의 Project는 여러 Room을 가질 수 있다.

### 5.4 Room

프로젝트 하나를 실행하는 독립적인 로컬 개발 서버 환경이다.

Room은 다음 상태를 독립적으로 가진다.

- Source workspace 또는 linked source folder
- Runtime과 package manager
- Dependency/cache layer
- Environment variables와 secrets
- Web server process tree
- Network namespace와 내부 포트
- Database/Redis 등의 service data
- Local domain과 HTTPS 설정
- Browser profile, cookies, localStorage, IndexedDB
- Health state
- Change/Undo history
- Logs와 diagnostic data

### 5.5 Room Nickname

같은 프로젝트를 여러 환경으로 운영할 수 있도록 Room에 별칭을 붙인다.

예시:

- `LoopOffice / dev`
- `LoopOffice / stage`
- `LoopOffice / node24-test`
- `LoopOffice / claude`
- `LoopOffice / codex`

Room number는 호텔 메타포를 위한 보조 표기이며, 실제 식별에는 프로젝트명과 nickname이 더 중요하다.

### 5.6 Component

Room을 구성하는 의미 단위다.

초기 Component 예시:

- Node.js
- npm / pnpm / yarn
- Web process
- PostgreSQL
- Redis
- Domain
- HTTPS
- Env profile
- Dependency volume
- Browser profile

### 5.7 Change

DevHotel을 통해 수행된 의미 있는 환경 변경이다.

각 Change는 다음 정보를 가진다.

- 사람이 읽을 수 있는 제목
- 실행 시각
- 요청한 주체: User / DevHotel / Agent
- 영향을 받은 Component
- Before / After
- 실행한 내부 작업
- 검증 결과
- Undo 가능 여부
- Undo 전략
- Raw log reference

### 5.8 Check

Component 또는 Room의 현재 상태를 검사하는 표준 동작이다.

각 Check는 다음 결과 중 하나를 반환한다.

- Healthy
- Warning
- Broken
- Unknown

---

## 6. Room 상태

Room 카드와 상단 바에서는 복잡한 지표 대신 다음 상태를 사용한다.

- **Preparing** — 생성, 설치, 변경 또는 복구 중
- **Running** — 웹 서버와 필수 서비스가 실행 중
- **Ready** — 실행 준비가 완료됐거나 정상적으로 실행됨
- **Sleeping** — 프로세스는 정지됐지만 환경과 데이터는 유지됨
- **Needs Attention** — 일부 Check가 실패했지만 Room은 사용 가능할 수 있음
- **Broken** — 시작 또는 핵심 Health Check 실패

Room 삭제는 Sleep과 명확히 분리한다. 삭제는 모든 managed storage와 service data를 제거하는 명시적인 파괴 작업이다.

---

## 7. 핵심 UX

## 7.1 Lobby — 카드형 첫 화면

첫 화면은 Trello와 비슷한 카드형 Lobby다.

```text
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ Room 201             │  │ Room 202             │  │          +           │
│ LoopOffice           │  │ LoopOffice           │  │      New Room        │
│ dev                  │  │ stage                │  │                      │
│                      │  │                      │  │                      │
│ [live thumbnail]     │  │ [last thumbnail]     │  │                      │
│                      │  │                      │  │                      │
│ ● Running            │  │ ○ Sleeping           │  │                      │
│ Node 22 · PostgreSQL │  │ Node 24 · Redis      │  │                      │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

Room 카드에 기본 표시할 정보:

- 프로젝트명
- Room nickname
- 현재 또는 마지막 preview thumbnail
- Running / Sleeping / Broken 상태
- 핵심 stack 한 줄
- 마지막 사용 시각

CPU, RAM, container ID, 전체 포트 목록 같은 정보는 Lobby 기본 카드에 노출하지 않는다.

## 7.2 New Room

새 Room 생성 방식은 세 가지로 시작한다.

1. **GitHub Repository**
2. **Local Folder**
3. **Empty Room**

기본 흐름:

```text
Source 선택
→ 프로젝트 자동 분석
→ 간단한 Room Plan 표시
→ 필요한 항목만 수정
→ Check In
→ 사이트 실행
```

Room Plan 예시:

```text
Project          Next.js
Runtime          Node 22
Package Manager  pnpm 10
Start Command    pnpm dev
Internal Port    3000
Database         PostgreSQL 17 (suggested)
Redis            Not detected
Domain           loopoffice.localhost
HTTPS            On
```

설정 화면을 wizard 지옥으로 만들지 않는다. 자동 감지 결과가 정상이라면 한 번의 확인으로 Room을 만든다.

## 7.3 Room View — 브라우저형 2-way View

Room 내부는 3-way 고정 화면이 아니다.

기본은 다음 두 영역이다.

1. **Main Browser View** — 사이트 화면
2. **Optional Detail Panel** — 필요할 때만 여는 Room 상세

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Lobby  ◀ ▶  ⟳  https://loopoffice.localhost  ● Ready  ⋯  │
├───────────────────────────────────────────────┬──────────────┤
│                                               │ Overview     │
│                                               │ Stack        │
│              Running Website                  │ Services     │
│                                               │ Logs         │
│                                               │ Changes      │
│                                               │ Diagnostics  │
│                                               │              │
└───────────────────────────────────────────────┴──────────────┘
```

Detail Panel은 접을 수 있어야 하며 기본 상태에서는 사이트가 화면 대부분을 차지한다.

### Browser bar의 최소 기능

- Lobby로 돌아가기
- Back / Forward
- Reload
- 현재 Room domain
- Room health
- Start / Stop / Restart
- Detail Panel 열기
- 외부 기본 브라우저에서 열기

DevHotel은 범용 웹 브라우저가 아니다. 북마크, 일반 검색, 확장 프로그램 스토어 같은 기능은 만들지 않는다.

## 7.4 Detail Panel

초기 탭은 다음 정도로 제한한다.

### Overview

- Room status
- Start command
- 현재 URL
- Runtime / package manager
- 주요 서비스 상태
- 최근 Change
- Undo 가능한 마지막 Change

### Stack

- Node.js
- Package manager
- Environment profile
- Dependency 상태
- Domain / HTTPS

### Services

- Web process
- PostgreSQL
- Redis
- 각 서비스의 health, storage, uptime

### Logs

- Web stdout/stderr
- Service logs
- DevHotel orchestration log
- 필터와 raw console 열기

### Changes

- 의미 단위 Change 목록
- Before / After
- Undo 가능 여부
- 관련 raw log

### Diagnostics

- 자동 Check 결과
- 제안된 Quick Fix
- Copy Diagnostic

## 7.5 Console — Advanced Mode

별도의 복잡한 Expert UI를 만들지 않는다.

다음 escape hatch를 제공한다.

- Open Room Terminal
- View Raw Logs
- Open Generated Config
- Open Source Folder
- Copy Command
- Copy Diagnostic

Console에서 수행된 명령도 가능한 범위에서 기록하지만, 모든 임의 명령에 완전한 의미 기반 Undo를 보장하지 않는다.

---

## 8. Quick Start

## 8.1 자동 감지 대상

Web Room은 최소한 다음 파일을 분석한다.

- `package.json`
- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- `bun.lock` / `bun.lockb`
- `.nvmrc`
- `.node-version`
- Volta 설정
- `package.json#engines`
- `.env.example`
- `.env.sample`
- `docker-compose.yml` / `compose.yml` — 참고용
- framework config
- README의 실행 명령 — 보조 정보

## 8.2 감지 우선순위

Runtime 버전 우선순위:

1. Room에서 사용자가 명시한 override
2. DevHotel project config
3. Volta / `.nvmrc` / `.node-version`
4. `package.json#engines`
5. 지원 중인 안정 LTS 기본값

Package manager 우선순위:

1. lockfile
2. `packageManager` field
3. 사용자 선택
4. npm 기본값

Start command 우선순위:

1. 사용자 override
2. DevHotel project config
3. `scripts.dev`
4. `scripts.start`
5. 최소 질문

## 8.3 Source 모드

### Managed Checkout

GitHub 저장소를 Room 내부 managed workspace로 clone한다.

- 격리와 성능을 우선한다.
- Room Terminal과 editor integration으로 접근한다.
- Git이 source history를 담당한다.

### Linked Local Folder

기존 로컬 폴더를 Room에 연결한다.

- source 변경은 호스트 폴더에 그대로 반영된다.
- `node_modules`, runtime, cache, DB data는 Room managed layer에 둔다.
- DevHotel의 환경 Undo가 사용자의 source code를 임의로 되돌리지 않는다.

---

## 9. Persistent Room

Room은 앱 종료와 Windows 재부팅 이후에도 유지된다.

유지 대상:

- Runtime selection
- Package manager selection
- Installed dependency layer
- DB와 Redis data
- `.env` profile reference
- Domain / HTTPS
- Browser cookies / localStorage / IndexedDB
- Startup command
- Change history
- Last preview thumbnail

Room을 Sleep하면:

- Web process와 서비스 프로세스를 중지한다.
- CPU와 RAM 사용을 해제한다.
- filesystem, DB, cache, browser profile은 보존한다.

Room을 다시 열면:

- 필요한 backend를 깨운다.
- 필수 서비스를 시작한다.
- web process를 시작한다.
- health check를 수행한다.
- 사이트를 표시한다.

Warm resume은 가능한 빠르게 이루어져야 하며, 매번 dependency 설치나 전체 환경 재생성을 반복해서는 안 된다.

---

## 10. Isolation Model

각 Room은 최소한 다음 경계를 독립적으로 가져야 한다.

### 10.1 Filesystem

- Runtime layer
- Dependencies
- Cache
- Generated files
- Service data
- Logs

### 10.2 Process

Room에서 시작한 web server와 자식 프로세스를 Room 소유로 추적한다.

Room Stop/Sleep 시 해당 process tree를 확실히 종료한다.

### 10.3 Network

각 Room은 독립 network namespace를 가진다.

Room A와 Room B가 모두 내부적으로 다음 포트를 사용할 수 있어야 한다.

- Web `3000`
- PostgreSQL `5432`
- Redis `6379`

호스트에는 Room별 임의 포트를 직접 노출하지 않고, DevHotel Local Gateway가 domain 기준으로 routing한다.

### 10.4 Domain

기본 domain은 충돌과 host 수정이 적은 형태를 사용한다.

예시:

- `loopoffice-dev.localhost`
- `loopoffice-stage.localhost`

사용자는 포트 번호를 기억하지 않는다.

필요한 경우 custom `.test` domain을 지원하되, hosts/DNS 변경은 명시적으로 표시하고 되돌릴 수 있어야 한다.

### 10.5 HTTPS

HTTPS는 한 번의 toggle로 활성화한다.

- local certificate 생성
- local gateway 연결
- browser trust 확인
- health check

Local CA를 호스트에 신뢰시키는 작업은 숨겨진 변경으로 수행하지 않는다. 최초 한 번 명시적으로 설명하고, 제거 방법도 제공한다.

### 10.6 Browser Profile

각 Room은 독립된 browser profile을 가진다.

따라서 Room별로 다음 항목이 섞이지 않는다.

- Cookies
- localStorage
- IndexedDB
- Cache
- Login session
- DevTools storage state

Browser profile reset은 source나 server environment를 건드리지 않는 별도 Quick Change로 제공할 수 있다.

### 10.7 Host Footprint

호스트에 직접 설치되는 것은 최소화한다.

허용되는 호스트 변경:

- DevHotel desktop app
- 선택된 isolation backend
- 선택적인 local CA / gateway integration
- startup entry

Node.js, npm, pnpm, PostgreSQL, Redis 등의 프로젝트 runtime/service는 호스트 전역에 설치하지 않는다.

---

## 11. Quick Change

Quick Change는 DevHotel의 핵심 제품 기능이다.

초기 지원 후보:

| Component | Quick Action |
|---|---|
| Node.js | 버전 변경 |
| Package Manager | npm/pnpm/yarn 선택 및 버전 변경 |
| Web Process | Start / Stop / Restart / Clean Restart |
| Start Command | 변경 |
| Internal Port | 감지 / 변경 |
| Domain | 변경 |
| HTTPS | On / Off |
| Redis | Add / Change Version / Remove / Restart |
| PostgreSQL | Add / Change Version / Backup / Restore / Remove |
| Env Profile | 선택 / 변경 / 누락 확인 |
| Dependencies | Install / Clean Reinstall / Clear Cache |
| Browser Profile | Reset |

모든 항목을 첫 버전에 구현할 필요는 없지만, UI와 adapter 구조는 동일한 문법을 사용해야 한다.

> **Add · Change · Check · Undo**

---

## 12. Change Transaction

DevHotel이 수행하는 Quick Change는 내부적으로 transaction처럼 처리한다.

```text
Request
→ Plan
→ Preflight Check
→ Scoped Safety Capture
→ Apply
→ Restart affected components
→ Verify
→ Commit Change
```

실패 시:

```text
Verify Failed
→ Automatic Rollback when safe
→ Re-check
→ Report result
```

### 12.1 Scoped Safety Capture

DevHotel의 UX 중심은 Time Machine이 아니다.

다만 안전한 Undo를 위해 구현 내부에서는 변경 대상에 한정된 checkpoint나 backup을 사용할 수 있다.

예시:

- Node version 변경 전 runtime/dependency 상태 보관
- PostgreSQL version 변경 전 DB backup
- HTTPS 변경 전 gateway/certificate 설정 보관
- Env profile 변경 전 이전 값 reference 보관

사용자는 snapshot 시점을 관리하지 않는다. DevHotel이 Undo를 구현하기 위한 내부 안전장치로 사용한다.

---

## 13. Easy Undo

## 13.1 시간보다 행동

Undo UI는 다음처럼 보여야 한다.

```text
↶ Undo: Node 22 → 24
```

Changes 목록:

```text
Node.js 22.12 → 24.1             [Undo]
Redis 8 added                    [Undo]
HTTPS enabled                    [Undo]
Dependencies clean reinstalled  [Undo]
```

`Restore to 14:32` 같은 시점 중심 UX는 기본이 아니다.

## 13.2 부분 Undo

Undo는 가능한 한 해당 Change만 되돌린다.

- Node 변경 Undo가 Redis를 제거해서는 안 된다.
- HTTPS Undo가 DB data를 되돌려서는 안 된다.
- Browser profile reset Undo가 server filesystem을 건드려서는 안 된다.

## 13.3 Source code 경계

DevHotel은 Git을 대체하지 않는다.

- Source code history는 Git이 담당한다.
- 환경 Undo는 기본적으로 source code를 되돌리지 않는다.
- `npm install`처럼 manifest/lockfile과 dependency layer를 동시에 바꾸는 작업은 변경 범위를 명확히 표시한다.
- source 파일 복구가 필요한 경우 Git diff 또는 별도 명시적 선택을 사용한다.

## 13.4 임의 Console 명령

모든 shell 명령에 완전한 inverse operation을 자동 생성할 수는 없다.

정책:

- DevHotel adapter를 통한 Quick Change는 강한 Undo를 보장한다.
- 알려진 package/runtime/service 명령은 의미 단위로 감지할 수 있다.
- 알 수 없는 명령은 명령, exit code, stdout/stderr, coarse environment diff를 기록한다.
- 위험 명령은 실행 전 `Protected Change`로 실행해 환경 layer checkpoint를 만들 수 있다.
- 보장할 수 없는 경우 UI에 `Undo unavailable`을 명확히 표시한다.

과장된 “모든 것을 완벽히 Undo” 약속을 하지 않는다.

---

## 14. Easy Check

Room을 열거나 문제가 발생하면 다음 순서로 자동 검사한다.

1. Isolation backend
2. Room metadata와 storage
3. Source availability
4. Runtime version
5. Package manager
6. Dependency consistency
7. Required environment variables
8. Database / Redis health
9. Start command
10. Process status
11. Internal port listening
12. Local gateway routing
13. DNS / HTTPS
14. HTTP response

결과는 한눈에 보여준다.

```text
Room: LoopOffice / dev

✓ Source
✓ Node 22.12
✓ pnpm 10.4
✓ Dependencies
✓ PostgreSQL 17
✕ Web process exited
✓ Domain
✓ HTTPS
```

### 14.1 Known Fix

DevHotel이 안전하게 해결할 수 있는 문제는 one-click Fix를 제공한다.

예시:

- stale process 종료
- web process 재시작
- runtime version mismatch 수정
- dependency clean reinstall
- stopped Redis/PostgreSQL 시작
- domain route 재생성
- local certificate 재발급
- browser cache/profile reset

Fix도 하나의 Change이며 가능한 경우 Undo할 수 있어야 한다.

### 14.2 Unknown Problem

모르는 문제를 억지로 자동 수정하지 않는다.

대신 **Copy Diagnostic**을 제공한다.

진단 bundle 예시:

```text
DevHotel Diagnostic Bundle

Room
- Project: LoopOffice
- Nickname: dev
- Provider: Web Room

Stack
- Node: 22.12
- Package Manager: pnpm 10.4
- Framework: Next.js
- PostgreSQL: 17 / Healthy
- Redis: Not installed

Routing
- Internal: 3000
- URL: https://loopoffice-dev.localhost
- HTTPS: Healthy

Recent Changes
- Node 20 → 22
- Dependencies clean reinstalled

Failure
- Command: pnpm dev
- Exit Code: 1
- Relevant stderr: ...

Checks Already Performed
- Runtime version: valid
- Port conflict: none inside room
- Database: healthy
- Gateway: healthy

Question
Diagnose why this web development environment fails to start.
```

### 14.3 Secret Redaction

Diagnostic copy 전 반드시 다음을 마스킹한다.

- Password
- API key
- Access token
- Cookie
- Authorization header
- Private key
- `.env` value
- 사용자가 지정한 custom secret pattern

변수 이름과 존재 여부는 보여줄 수 있지만 기본적으로 값은 복사하지 않는다.

---

## 15. 상세정보와 기록

DevHotel은 Room에서 발생한 일을 기록하지만, 모든 syscall을 기본 UI에 쏟아내지 않는다.

### 항상 구조화해서 기록할 것

- DevHotel이 실행한 command
- Start/stop/restart lifecycle
- Runtime/package manager 변경
- Service add/change/remove
- Package manifest와 top-level dependency 변화
- Port open/close
- Domain/HTTPS 변경
- DB backup/restore
- Health check 결과
- Change와 Undo 결과
- Process exit와 crash

### 필요할 때만 상세 표시할 것

- 전체 transitive package 목록
- raw stdout/stderr
- filesystem 상세 diff
- process tree 전체
- network connection 상세
- generated proxy/container config

### 기본 UI에서 피할 것

- 의미 없는 실시간 그래프 남발
- container ID 중심 화면
- 시스템 도구와 중복되는 process explorer
- 모든 파일 이벤트의 무한 timeline

기록은 Undo와 진단을 신뢰할 수 있게 만드는 기반이지, 대시보드 자체가 제품 목적은 아니다.

---

## 16. Database와 서비스

## 16.1 PostgreSQL / Redis

각 Room은 자기 서비스 instance와 data를 가진다.

Room A와 Room B는 동일 버전과 동일 내부 포트를 사용해도 서로 영향을 주지 않는다.

UI 예시:

```text
PostgreSQL 17
Healthy · 284 MB · 3 connections
[Backup] [Restore] [Change] [Remove]

Redis 8
Healthy · 42 MB
[Restart] [Change] [Remove]
```

고급 설정과 직접 SQL 관리는 Console 또는 외부 DB tool로 연결한다.

## 16.2 DB Backup / Restore

DB backup은 파일 경로를 먼저 보여주는 UX가 아니라 Room action으로 제공한다.

- Backup now
- Restore backup
- Clone data to another Room
- Start empty

파괴적인 변경 전에는 자동 safety backup을 만들 수 있다.

Backup retention과 storage 사용량은 명확히 표시한다.

## 16.3 Room Clone

같은 Project에서 새로운 nickname Room을 만들 수 있다.

예시:

```text
Clone LoopOffice / dev

Environment   Copy
Dependencies  Copy
Database      Copy / Empty / Do not include
Browser Data  Copy / Empty
New Nickname  stage
```

Room Clone은 장기적으로 중요하지만 최초 vertical slice보다 뒤에 구현할 수 있다.

---

## 17. 시작프로그램, Tray, 자동 업데이트

DevHotel은 WSLPad처럼 설치 후 신경 쓰지 않아도 되는 데스크톱 앱이어야 한다.

필수 제품 기본기:

- Windows 시작 시 tray로 자동 실행
- tray에서 Lobby 열기
- Running Room 빠른 목록
- 모든 Room Sleep
- backend health 확인
- 비정상 종료 후 orphan process/resource 정리
- silent 또는 사용자 친화적 자동 업데이트
- 업데이트 실패 시 안전한 rollback
- Room metadata migration

앱 업데이트 중에도 Room 데이터가 손상되어서는 안 된다.

DevHotel 새 버전이 설치되어도 Room stack은 자동 변경하지 않는다.

---

## 18. 논리 아키텍처

```text
DevHotel Desktop
├─ Lobby / Browser UI
├─ Tray & Auto Updater
├─ Room Orchestrator
│  ├─ Room Lifecycle
│  ├─ Change Transaction Engine
│  ├─ Undo Journal
│  ├─ Health & Diagnostic Engine
│  └─ Crash Recovery
├─ Local Gateway
│  ├─ Domain Routing
│  ├─ HTTPS
│  └─ Room Preview Routing
├─ Provider Layer
│  └─ WebRoomProvider (first)
│     ├─ Runtime Adapters
│     │  ├─ Node
│     │  ├─ Bun (later)
│     │  └─ Deno (later)
│     ├─ Package Manager Adapters
│     │  ├─ npm
│     │  ├─ pnpm
│     │  └─ yarn
│     └─ Service Adapters
│        ├─ PostgreSQL
│        └─ Redis
├─ Isolation Backend
│  └─ Windows-first: WSL2 + OCI-compatible runtime
└─ Local State Store
   ├─ Room manifests
   ├─ Change journal
   ├─ Health history
   ├─ Logs
   └─ Backup metadata
```

### 18.1 Provider Interface

장기 확장을 위해 Room 종류는 provider로 분리한다.

예상 interface:

- Detect source
- Build Room Plan
- Create Room
- Start / Sleep / Stop / Delete
- Get preview endpoint
- Inspect components
- Apply Change
- Undo Change
- Run Checks
- Open Console
- Export Diagnostic

초기에는 WebRoomProvider만 존재한다.

### 18.2 Component Adapter

각 Runtime/Service adapter는 가능한 기능을 명시한다.

- Detect
- Install/Add
- Change version
- Start/Stop/Restart
- Health check
- Diagnostics
- Remove
- Backup/Restore
- Undo capability

지원하지 않는 기능을 UI에서 가짜로 제공하지 않는다.

### 18.3 Room Manifest

각 Room은 사람이 읽을 수 있는 선언 상태를 가진다.

개념 예시:

```yaml
project: loopoffice
nickname: dev
provider: web
source:
  type: managed-git
  repository: r2cuerdame/loopoffice
runtime:
  node: "22"
packageManager:
  type: pnpm
  version: "10"
web:
  command: pnpm dev
  internalPort: 3000
domain:
  host: loopoffice-dev.localhost
  https: true
services:
  postgres:
    version: "17"
  redis: null
```

실제 schema와 저장 형식은 구현 단계에서 결정할 수 있지만, Room 상태는 재현 가능하고 migration 가능해야 한다.

### 18.4 State Store

Room metadata, Change journal, Check 결과와 update migration을 안정적으로 처리할 수 있는 local state store를 사용한다.

권장 특성:

- Transactional
- Schema versioning
- Crash-safe
- Queryable history
- Room data와 앱 metadata 분리

SQLite 같은 embedded store가 적합하지만 구현 프레임워크에 따라 최종 결정한다.

---

## 19. Windows-first 구현 방향

첫 번째 지원 OS는 Windows 11이다.

초기 격리 backend의 현실적인 방향은 다음과 같다.

- WSL2를 Linux web runtime 기반으로 사용
- Room마다 독립 OCI container 또는 이에 준하는 namespace 제공
- Room별 persistent volumes
- Local gateway 하나가 Room domain을 routing
- WebView2 또는 동등한 embedded browser 사용

중요한 것은 특정 Docker 제품에 종속되는 것이 아니라 provider/backend abstraction을 유지하는 것이다.

Docker Desktop이 설치되어 있으면 활용할 수 있지만, 장기적으로 특정 상용 runtime을 강제하지 않는 구조가 바람직하다.

---

## 20. MCP와 AI 연동

MCP는 초기 핵심 UX 이후 추가한다.

목적은 agent가 호스트를 직접 더럽히지 않고 Room만 사용하게 만드는 것이다.

예상 기능:

- list_rooms
- create_room
- start_room
- sleep_room
- inspect_room
- run_in_room
- check_room
- apply_quick_change
- undo_change
- copy_diagnostic

정책:

- Agent는 기본적으로 호스트 명령을 실행하지 않는다.
- Agent가 수행한 Change는 주체를 표시한다.
- 위험 변경은 transaction과 safety capture를 거친다.
- 사용자가 Changes에서 Agent 작업을 확인하고 Undo할 수 있다.

MCP가 없어도 DevHotel의 핵심 제품은 완전해야 한다.

---

## 21. MVP 범위

## 21.1 Vertical Slice — 반드시 먼저 증명할 것

다음 데모가 완성되기 전에는 기능을 넓히지 않는다.

1. Windows에서 DevHotel 설치
2. GitHub repo 또는 local folder로 Node web Room 생성
3. Room이 내부 `3000` 포트로 실행
4. `project.localhost` 형태로 브라우저 preview 표시
5. 두 번째 Room도 내부 `3000`을 사용하면서 동시에 실행
6. Room을 Sleep하고 다시 열었을 때 환경과 상태 유지
7. Room별 process tree가 확실히 종료됨
8. 호스트 전역 Node/npm 설치가 필요 없음

이 데모가 DevHotel의 존재 이유다.

## 21.2 MVP Release

### Desktop 기본기

- Windows installer
- Tray
- Windows startup option
- Auto update
- Crash recovery

### Lobby

- Room card
- Preview thumbnail
- `+ New Room`
- Rename nickname
- Running / Sleeping / Broken 표시

### Room 생성

- GitHub URL
- Local Folder
- package.json/lockfile 감지
- Node version 감지
- npm/pnpm 지원
- start command 감지

### Room 실행

- Persistent isolated environment
- Start / Sleep / Restart / Delete
- 독립 process/network/storage
- stable `.localhost` URL
- embedded browser preview
- Room별 browser profile

### Quick Change

- Node version 변경
- Start command 변경
- Domain 변경
- HTTPS toggle
- Dependencies install / clean reinstall

### Easy Check

- Runtime
- Package manager
- Dependencies
- Web process
- Port
- Gateway
- HTTPS
- HTTP response
- Copy Diagnostic with secret redaction

### Easy Undo

- DevHotel UI에서 수행한 Node version change Undo
- Domain / HTTPS change Undo
- start command change Undo
- dependency reinstall safety rollback
- Change 목록과 상세

### Console

- Room terminal
- Raw logs
- Generated config 보기

## 21.3 MVP 이후 Web 확장

- PostgreSQL adapter
- Redis adapter
- DB backup / restore / clone
- Room clone
- Env profile UI
- yarn / Bun / Deno
- Framework-specific detection 개선
- MCP
- protected arbitrary command transaction
- cross-machine Room recipe export/import

## 21.4 장기 확장

- Android Room provider
- Desktop app Room
- Team-shared Room recipes
- Remote/hosted Room provider
- CI validation Room

Android는 Web Room이 실제로 매일 사용 가능한 수준이 된 뒤 시작한다.

---

## 22. 명시적 Non-goals

DevHotel 초기 버전은 다음을 목표로 하지 않는다.

- 범용 웹 브라우저 대체
- IDE 또는 code editor 제작
- production hosting 또는 deployment platform
- Docker Desktop 전체 기능 대체
- Kubernetes 관리
- 모든 Linux package와 service를 위한 GUI
- 모든 shell 명령의 완전한 Undo
- source code version control 대체
- 일반 소비자용 PC Doctor
- 모든 오류를 LLM으로 자동 수정
- 클라우드 계정과 서버 필수화
- Android와 Web 동시 구현
- 화려한 실시간 모니터링 대시보드

기능이 이 경계를 넘어가면 Console, plugin, provider 또는 외부 도구 연동으로 해결한다.

---

## 23. 성공 기준

### UX

- backend 준비 이후 repo 선택부터 사이트 표시까지 사용자 조작 3회 이하
- 기본 Room 생성에 Dockerfile 작성 불필요
- Room 내부에서 사이트가 화면의 대부분을 차지함
- Node 버전 변경과 Undo를 각각 두세 번의 클릭 안에 수행
- 문제 발생 시 한 화면에서 실패한 Check를 확인

### Isolation

- 서로 다른 두 Room이 내부 `3000`, `5432`, `6379`를 동시에 사용할 수 있음
- 한 Room의 Node/DB/Redis 변경이 다른 Room에 영향 없음
- Room Stop/Sleep 후 orphan process가 남지 않음
- Room 삭제 시 managed storage와 resource를 정리하고 회수 용량을 표시

### Persistence

- Windows 재부팅 후 Room 목록과 환경 유지
- DB와 browser profile 유지
- DevHotel 업데이트 후 Room runtime version 유지

### Undo

- Node version change 실패 후 이전 상태로 안전하게 복구
- Undo가 관련 없는 서비스와 source code를 되돌리지 않음
- Undo 불가능한 작업은 실행 전에 또는 Changes에서 명확히 표시

### Easy Check

- web process가 뜨지 않을 때 최소한 runtime/dependency/process/port/gateway 단계 중 실패 위치를 식별
- Copy Diagnostic이 secret을 포함하지 않음

---

## 24. North Star Demo

DevHotel의 핵심을 가장 짧게 보여주는 데모다.

```text
1. DevHotel Lobby에서 LoopOffice repo 추가
2. 자동 감지: Node 22 / pnpm / PostgreSQL / port 3000
3. Room 201 · LoopOffice / dev 실행
4. https://loopoffice-dev.localhost 표시

5. 다른 repo 추가
6. 두 번째 Room도 내부 port 3000, PostgreSQL 5432 사용
7. 두 사이트가 충돌 없이 동시에 실행

8. Room 201의 Node를 22 → 24로 Quick Change
9. 서버 시작 실패
10. 화면에 “Last change: Node 22 → 24” 표시
11. [Undo]
12. Node 22로 복구되고 사이트 정상 실행

13. Windows 재부팅
14. Lobby에 두 Room이 Sleeping 상태로 그대로 표시
15. Room 클릭 후 기존 데이터와 브라우저 세션으로 재개
```

이 데모가 자연스럽고 빠르게 동작한다면 DevHotel의 핵심 가치는 성립한다.

---

## 25. 오픈소스와 제품 전략

DevHotel은 우선 실제 사용 가능한 오픈소스 개발도구로 성장시킨다.

초기 우선순위:

1. 개발자가 매일 쓰는 품질
2. 쉬운 설치와 삭제
3. 신뢰할 수 있는 격리
4. 명확한 host 변경 내역
5. 빠른 Room resume
6. Quick Change와 Undo의 안정성
7. 문서와 contribution 구조

초기에는 결제, 계정, 라이선스 제한보다 사용성과 신뢰를 우선한다.

장기적으로 상업화가 필요해지면 core local experience를 훼손하지 않는 다음 영역을 검토할 수 있다.

- Remote/hosted Rooms
- Team Room templates와 sync
- Shared stage environments
- Hosted Android/Windows Rooms
- Enterprise policy와 secrets integration
- Managed backups

이 항목들은 현재 MVP 목표가 아니다.

---

## 26. 제품 드리프트 방지 결정사항

다음 결정은 현재 DevHotel 방향의 핵심이다.

1. **Web부터 시작한다.**
2. **Room은 persistent가 기본이다.**
3. **첫 화면은 카드형 Lobby다.**
4. **Room 화면은 브라우저 중심 2-way View다.**
5. **상세 패널은 필요할 때만 연다.**
6. **UI는 Quick Start와 Quick Change에 집중한다.**
7. **상세 조작은 Console로 연결한다.**
8. **포트 번호보다 stable local domain을 보여준다.**
9. **Time Machine보다 행동 중심 Undo를 우선한다.**
10. **자동 snapshot은 UX가 아니라 Undo의 내부 구현 수단이다.**
11. **모든 것을 자동 고치겠다고 약속하지 않는다.**
12. **아는 문제는 Check/Fix, 모르는 문제는 Diagnostic Copy로 처리한다.**
13. **DevHotel 업데이트가 Room 환경을 바꾸지 않는다.**
14. **격리 backend의 전문용어를 기본 UI에 노출하지 않는다.**
15. **Android는 Web이 안정된 뒤 provider로 확장한다.**

---

## 27. 최종 정의

DevHotel은 단순한 sandbox manager도, Docker GUI도, local stack installer도 아니다.

> **개발자는 코드를 관리하고, DevHotel은 프로젝트가 살아가는 환경을 관리한다.**

각 프로젝트는 자기 Room을 가진다.

그 Room은 오래 유지되고, 다른 Room을 건드리지 않으며, 브라우저처럼 쉽게 열리고, 필요한 환경을 빠르게 바꿀 수 있고, 문제가 생기면 어디가 잘못됐는지 확인할 수 있으며, 방금 한 환경 변경을 Undo할 수 있어야 한다.

> **Easy Setup · Easy Change · Easy Check · Easy Undo**
