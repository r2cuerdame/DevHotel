# DevHotel Agent Runtime — Product and Architecture Direction

**Status:** Core product direction / target architecture

**Scope:** Local-first Windows product, Web Room first

**Implementation status:** Design target. The current Electron developer preview does not yet provide the stable daemon, Hotel service registry, Gateway context model, lease, job, permission, or managed-runtime guarantees defined here. Its `devhotel-mcp` package is an experimental stdio adapter over an Electron-owned loopback control API, not the stable REST adapter described below.

## 1. Core philosophy

> **Give AI a room, not your computer.**

> **Inside the Room, AI is free to act. Outside the Room, permission is required.**

> **DevHotel protects the computer, not by limiting the agent, but by limiting its world.**

> **One Room. One Writer. No Accidental Conflicts.**

> **Everything development needs stays inside the Hotel.**

한국어로는 다음과 같다.

> **AI에게 컴퓨터를 주지 말고, 방을 준다.**
>
> **AI를 제한하는 대신, AI가 활동하는 세계를 격리한다.**
>
> **Room 안에서는 자유롭게 작업하고, Room 밖의 자원에는 명시적인 허가가 필요하다.**
>
> **개발에 필요한 것은 Hotel 안에 둔다. Host를 더럽히지 않는다.**
>
> **Agent들은 실수로 같은 Room을 공유하지 않는다.**

“Room 안에서 자유”는 다른 Room, Host, 공유 디바이스, 비밀 또는 사설 네트워크에 접근할 자유를 뜻하지 않는다. 자유의 범위는 해당 Room이 소유하거나 명시적으로 부여받은 capability로 한정한다.

## 2. Primary user and human role

DevHotel의 1차 실행 주체는 AI Agent다. 사람은 환경 명령을 대신 수행하기보다 다음을 감독한다.

- Room과 Agent 상태 확인
- Host 또는 공유 자원 접근 승인
- 결과와 감사 기록 확인
- Job 취소, Checkout, Take Over와 강제 회수
- 예외 상황의 수동 개입

Agent는 DevHotel API를 통해 Room 생성, checkout, runtime/service 준비, 실행, 테스트, 빌드와 배포 준비를 수행한다. Agent가 Host의 package manager, runtime, database, port, device daemon 또는 전역 환경 변수를 직접 조작하는 경로를 기본 기능으로 제공하지 않는다.

## 3. Stable service and Hotel Service Layer are the product core

Windows GUI는 DevHotel의 유일한 본체가 아니라 stable local service의 client다.

```text
Human / Host Agent / Room Agent
             │
GUI · CLI · DevHotel MCP Adapter · Agent SDK
             │
Stable DevHotel REST API / Agent Gateway
             │
Auth · Context · Permission · Audit
Hotel Service Layer · Job & Lease Coordinator
             │
Room · Workspace · Room Service · Device · Network · Files
```

제품 불변조건:

1. GUI 재시작이나 MCP 연결 종료가 Room, shared service와 Job을 종료하지 않는다.
2. GUI, CLI, DevHotel MCP와 SDK는 같은 REST API, 상태, 권한 및 감사 기록을 사용한다.
3. CLI는 별도 orchestration logic을 가지지 않는 API client다.
4. DevHotel MCP는 foundation이 아니라 stable REST API를 감싸는 교체 가능한 adapter다.
5. Room Service는 한 Room의 environment/state에 귀속되고, Hotel Service는 shared infrastructure로 Hotel Layer가 한 번 소유한다.
6. 설치와 접근은 별개다. service availability는 Host 또는 Room capability를 암시하지 않는다.
7. Host Agent와 Room Agent는 같은 service를 Gateway로 호출하며, Gateway가 매 호출의 context와 grant를 검증한다.
8. Renderer나 MCP process는 isolation runtime의 privileged socket을 직접 받지 않는다.
9. service의 physical runtime placement는 backend-private이며 public API나 일반 UI의 계약이 아니다.
10. Daemon은 기본적으로 per-user local endpoint만 제공하고 LAN에 공개하지 않는다.

Windows Service가 반드시 필요한 것은 아니다. 권한과 설치 부담이 더 작은 per-user daemon을 우선 검토하되, GUI와 독립된 lifecycle과 crash recovery는 반드시 제공한다. 실제 작업 process는 DevHotel-owned runtime 안에서 지속될 수 있어야 한다.

## 4. API principles

API는 resource와 asynchronous operation을 중심으로 설계한다.

예시:

```text
POST   /v1/rooms
POST   /v1/rooms/{roomId}/check-ins
POST   /v1/rooms/{roomId}/commands
POST   /v1/rooms/{roomId}/services
POST   /v1/rooms/{roomId}/clones
POST   /v1/jobs/{jobId}/cancel
GET    /v1/jobs/{jobId}
GET    /v1/jobs/{jobId}/events
POST   /v1/devices/{deviceId}/reservations
```

- 모든 mutation은 runtime schema로 검증한다.
- 재시도 가능한 요청은 idempotency key를 지원한다.
- 응답은 operation/job ID와 현재 resource version을 반환한다.
- 권한은 Room ID, Agent identity, lease와 capability grant를 함께 확인한다.
- state-changing request는 audit actor와 origin(GUI/CLI/MCP/SDK)을 기록한다.
- linked Host folder, secret, public URL, device와 private network 접근은 별도 grant를 요구한다.

Agent Gateway 요청은 명시적인 `AgentContext`를 가진다. 최소 필드는 Agent identity, origin, `host | room` context kind, optional Room ID, requested capability, grant reference이며 Room mutation에는 lease와 fencing token이 추가된다. Room Agent의 context는 해당 Room 경계를 넘을 수 없고, Host Agent context도 승인된 Host/shared capability만 가진다. MCP service process가 보낸 Room ID나 scope만 신뢰하지 않고 Gateway가 credential과 grant에서 다시 계산한다.

공개 계약은 service ID/version, tool, health, context와 authorization 결과다. service가 Windows process, managed runtime, microVM 또는 Room 인접 sidecar 중 어디에서 실행되는지는 내부 배치 결정이며 client가 topology를 선택하거나 privileged endpoint를 받지 않는다.

## 5. Check-in, Room Key, lease and fencing

### 5.1 Human-readable Room Key

Check-in 시 사용자가 식별하고 복사할 수 있는 Room Key를 보여준다.

```text
Room 203
Checked in: Codex
Key: DH-203-K7F2
[Copy] [Rotate] [Checkout] [Take Over]
```

`DH-203-K7F2` 같은 값은 UX identifier다. 실제 인증 credential은 충분히 긴 무작위 secret이어야 하며 로그, 진단, URL 또는 화면 공유에 노출하지 않는다. Key Rotate/Checkout/Take Over는 기존 credential을 즉시 revoke한다.

### 5.2 One Room, one writer

기본 정책은 Room당 하나의 exclusive writer lease다. 다른 Agent의 mutation은 `occupied`로 거부하지만, 정책에 따라 read-only 관찰은 허용할 수 있다.

동시에 여러 Agent가 작업해야 한다면 같은 Room을 공유하는 대신 Clone을 기본 제안한다.

```text
Main Room
├─ Clone → Codex Room
└─ Clone → Claude Room
```

### 5.3 Lease recovery and stale-writer protection

Lease는 heartbeat, expiry, manual checkout, force checkout와 take over를 지원한다. 단순 timeout lock만으로는 부족하다. 각 lease에 단조 증가하는 **fencing token**을 발급하고 모든 mutation과 worker handoff에서 확인한다. Take Over 이후 늦게 도착한 이전 Agent 요청은 유효한 credential을 들고 있어도 낮은 fencing token 때문에 거부된다.

## 6. Durable jobs

Build, test, device reservation, deployment preparation와 긴 변경은 client session이 아니라 persistent Job으로 실행한다.

Job은 최소한 다음을 저장한다.

- ID, type, Room, actor와 origin
- requested capability와 approval reference
- immutable input/revision/environment reference
- queued/running/succeeded/failed/cancelled/interrupted 상태
- progress, structured events, logs와 artifacts
- creation/start/end time, retry와 cancellation state
- worker identity와 fencing token

Daemon 또는 Windows 앱 재시작 후에도 Job 상태를 복구한다. Room mutation은 직렬화하고, read-only Job은 선언된 자원 한도 안에서 병렬화할 수 있다.

Build와 test Job은 가변 Room workspace를 직접 읽지 않고, 요청 시 캡처한 immutable `StateRevision`을 입력으로 사용한다. 따라서 Job 실행 중에도 Room은 계속 변경할 수 있으며 결과에는 source, resolved environment, optional service-data revision과 Job provenance가 남는다.

Lease expiry가 실행 중인 Job을 무조건 죽이지는 않는다. Job은 시작 시 승인된 execution grant를 별도로 보유하며 계속 실행할 수 있지만, 새로운 mutation은 현재 lease가 필요하다. Take Over 화면은 진행 중 Job을 보여주고 `계속`, `취소 후 회수`, `완료 후 회수`를 명시적으로 선택하게 한다. 공유 디바이스 reservation은 자체 lease와 timeout을 가진다.

## 7. Room-owned working state and Host boundary

### Room-owned Working State

Git clone, local folder 또는 archive 중 어디에서 시작했든 실행 source는 DevHotel 영역의 Room-owned working state로 가져온다. source, dependencies, generated files와 tools가 Host 개발 stack과 분리되며, Room process는 Host source folder를 live working-directory bind로 받지 않는다.

### Host Source Link

기존 local folder는 Room의 실행 filesystem이 아니라 명시적으로 연결한 ingress/sync endpoint다. 최초 import와 incremental Host-to-Room sync는 Room-owned tree에 적용한다. Room-to-Host 변경은 `Apply to Host`, `Export` 또는 `Commit` 같은 별도 action과 scoped capability가 있을 때만 수행한다.

- 사용자가 선택한 canonical directory만 endpoint로 등록한다.
- drive root, profile root와 다른 broad path는 기본 거부한다.
- symlink/junction/reparse escape를 검사한다.
- Host source path를 Room runtime에 mount하지 않는다.
- inbound sync와 outbound apply 권한을 분리한다.
- UI와 audit log에 grant scope, direction, conflicts와 write 결과를 표시한다.

세부 상태, 충돌, revision과 migration 계약은 [Room Working State / Sync / Build 설계](./2026-08-10-devhotel-working-state-design.md)를 따른다.

> **Current Preview limitation:** 신규 Local Folder Room은 Room-owned import를 사용한다. 기존 direct-bind Room은 명시적 migration 전까지 `legacy-host-bind` compatibility mode이며, Agent-native Hotel Service assignment와 full permission Gateway는 아직 구현되지 않았다.

## 8. Room Services, Hotel Services, contexts and permissions

서비스 명칭은 ownership boundary를 따른다.

- **Room Service:** PostgreSQL, Redis, Web, Build, Test, local HTTPS와 backup처럼 한 Room의 environment, version, mutable data와 lifecycle에 귀속되는 capability/runtime다. 구현 중 queue, registry 또는 credential broker 같은 Hotel infrastructure를 사용할 수 있어도 소유권은 Room에 남는다.
- **Hotel Service:** GitHub, MCP/Skills, Device Pool, credential/permission broker, queue/scheduler와 registry/update처럼 DevHotel이 한 번 소유하고 여러 Room/Agent context에 제공하는 shared infrastructure다. Hotel Service를 Room에서 사용한다는 것은 package를 Room에 설치하는 것이 아니라 binding과 grant를 만드는 것이다.

Room과 Hotel Infra는 독립적이다. Hotel Service는 `hotel | host-project | room` context를 지원할 수 있으며 Room이 없어도 사용할 수 있다. 다만 Host context도 selected project/folder/credential/device scope가 명시적으로 승인되어야 한다. Installation, recommendation, enablement와 live permission은 서로 다른 상태다. **Hotel prepares and maintains. The guest decides and uses.**

따라서 사람을 위한 Room App Store와 Hotel Service catalog는 같은 목록이 아니다. Room Service 설치/변경은 Room state mutation이고 lease/revision/Undo 정책을 따른다. Hotel Service installation/availability와 live authorization은 별도 resource다.

Hotel Service는 core switch문이 아니라 versioned manifest와 adapter로 등록한다. 공통 manifest는 stable service/adapter ID, category, native interface, resolved version/digest와 pin/update/rollback policy, supported `hotel | host-project | room` contexts, permission/risk/approval descriptors, health/lifecycle support, runtime requirement와 injection ownership strategy를 선언한다. Service-specific operation/tool schema는 adapter가 소유하고 core는 discover/install/update/enable/disable/assign/status/get-connection/revoke/remove만 공통화한다.

```text
Hotel Service Registry
├─ GitHub Service           (first concrete service)
├─ Credential / Permission Broker
├─ Device Pool · Queue / Scheduler · Registry / Update
└─ Later: MCP Services · Skills
        │
        └─ Agent Gateway
           ├─ Host Agent context + explicit Host/shared grants
           ├─ Room dev context + repository/branch mutation grant
           └─ Room stage context + repository read grant
```

설치 상태, access binding과 live grant는 서로 다른 resource다.

- **Installation:** package identity, resolved version/digest, health, update and removal lifecycle; Hotel-owned.
- **Context binding:** 어떤 Host/Room context에서 어떤 tool을 요청할 수 있는지에 대한 선언; 권한 자체가 아니다.
- **Permission grant:** actor, target resource, operations, expiry와 revocation을 가진 실제 authorization.

예시 capability:

- Room: `runtime.node`, `service.postgres`, `service.redis`, `web.run`, `job.build`, `job.test`, `https.local`, `backup.room`
- Hotel: `github.repository.read`, `github.branch.push`, `github.pull-request.mutate`
- `device.android`, `network.public-url`
- `secret.read:<name>`, `host-source.read:<link-id>`, `host-source.apply:<link-id>`

Room 내부 Node와 PostgreSQL 같은 runtime/service는 Room state에 속한다. 이를 조작하거나 관찰하는 추후 MCP/Skill package는 Hotel Service일 수 있지만 Room에 중복 설치하지 않는다. MCP/Skills binding이 Room Service 자체를 shared state로 바꾸지는 않는다.

### 8.1 GitHub Service — first Hotel Service vertical slice

첫 concrete Hotel Service는 GitHub Service다. 목표 구현은 pinned/checksum-verified `gh` build와 private encrypted credential을 DevHotel-owned storage에서 관리한다. Host에 `gh`를 별도 설치하거나 Host global login/PATH를 준비하게 하지 않는다. DevHotel은 lifecycle, health, credential, assignment, permission과 connection을 관리하고 실제 GitHub 동작은 GitHub Service의 native interface/adapter가 소유한다.

- Agent adapter가 native GitHub interface를 해당 Agent convention에 맞게 연결하며 사용 여부는 Agent/사용자가 선택한다.
- repository/credential scope를 검증하고 credential을 Room filesystem이나 repository config에 직접 복사하지 않는다.
- remote mutation authority는 explicit credential/grant policy와 audit로 통제하지만 각 GitHub operation을 DevHotel core/MCP tool로 다시 구현하지 않는다.
- Room writer lease는 Room Working State mutation을 보호한다. GitHub grant는 remote side effect를 별도로 보호하며 어느 쪽도 다른 권한을 암시하지 않는다.
- service update는 pinned build/digest를 명시적으로 바꾸며 Room runtime version을 변경하지 않는다.

모든 CLI를 Hotel Service로 만들지는 않는다. `gh`, `glab`, `aws`, `gcloud`, `vercel`, `kubectl`처럼 shared external infrastructure/credential을 broker하는 CLI는 Hotel CLI Service 후보가 될 수 있다. Node, pnpm, Vite, Prisma와 compiler처럼 project version과 reproducibility에 영향을 주는 도구는 Room-owned다. 공통 Control Plane은 service-specific command를 복제하지 않고 manifest, lifecycle, assignment, permission, health와 connection만 이해한다.

Room Agent는 해당 Room의 filesystem, browser, database와 network handle만 받을 수 있다. Host Agent도 Host folder, USB/device, GPU, 중요 secret, public ingress와 사설망에 명시적 grant가 필요하다. Host와 다른 Room의 internal endpoint는 기본적으로 접근할 수 없어야 한다. Clone은 Hotel service package를 복제하지 않으며 Host/secret grant를 자동 상속하지 않는다.

GitHub와 추후 MCP/Skills package 및 runtime dependency를 Host global PATH에 설치하지 않는다. Hotel Layer가 install, update, health와 cleanup을 소유한다. service runtime을 Host helper, managed runtime process 또는 sidecar 중 어디에 둘지는 capability와 위협 모델에 따라 내부적으로 선택하되, 어떤 배치도 Gateway authorization을 우회하거나 privileged runtime socket을 client에게 노출할 수 없다.

**DevHotel MCP**는 이 shared service model의 얇은 Concierge다. `services.list/describe/install/enable/disable/status/get_connection`, `permissions.request`, `assignments.list` 같은 공통 Control Plane만 stable REST API로 변환하며 Serena나 GitHub의 실제 tool surface를 흉내 내지 않는다. 현재 Preview의 stdio package와 Electron-owned loopback control API는 이 목표의 실험적 선행 구현이며 완전한 Host/Room context binding과 permission enforcement를 아직 제공하지 않는다.

## 9. Shared physical resource broker

Android Device, emulator, GPU, USB, 라이선스와 외부 장비는 Room 격리만으로 해결되지 않는다. Agent가 `adb kill-server` 같은 Host-wide 조작을 직접 실행하지 않고 DevHotel resource broker를 사용한다.

Reservation은 owner Room, Agent, fencing token, queue position, expiry와 cleanup hook을 가진다. Agent가 죽거나 Room이 삭제되면 broker가 자원을 회수하고 다음 waiter에 넘긴다.

## 10. Persistent development and clean execution

DevHotel은 두 실행 형태를 분리한다.

- **Persistent Room:** 빠른 반복 개발을 위한 Room-owned mutable Working State. dependencies, caches, database와 service state를 유지한다.
- **Clean Run / Suite Room:** immutable `StateRevision`으로 만드는 일회성 build/test instance. artifact와 log를 보존하고 instance는 정책에 따라 폐기한다.

Clean Run은 숨겨진 일반 Room/StateRevision/Job/Lease/Capability primitive로 구현할 수 있다. `Suite Room`은 유용한 UX 용어지만 별도 backend 개념을 강제하지 않는다. Revision 캡처 뒤에는 mutable Room을 잠그지 않으며, 각 Job은 read-only base와 독립적인 writable scratch를 사용한다.

## 11. Reproducibility and clone fidelity

Room manifest는 major version이나 floating tag만 저장해서는 안 된다. 선택한 친화적 버전과 함께 실제 image digest, component build ID, lockfile/source revision과 migration state를 기록한다. Clone과 Clean Run은 이 immutable reference를 그대로 사용한다.

Clone, action-based Undo와 Suite는 각자 다른 복사 체계를 만들지 않고 같은 immutable revision capture/fork/restore primitive를 사용한다. 각 결과는 `stateRevisionId`, source/dirty-tree provenance, `environmentRevisionId`, optional service-data revision IDs와 `jobId`로 추적할 수 있어야 한다.

Agent가 Room 안에 설치한 OS package, global tool과 configuration도 persistence와 Clone 경계에 포함되어야 한다. 이를 위해 다음 중 하나를 제품 정책으로 확정한다.

- 선언된 package/tool layer를 다시 빌드하고 digest로 고정하거나
- Room별 persistent overlay/image를 관리하고 검증된 방식으로 복제한다.

현재처럼 container writable layer를 wake 때 버리는 구현은 “persistent complete environment”로 표현하지 않는다.

현재 Preview의 일반 Web command/build/test는 sealed revision이 아니라 mutable live workspace를 읽는다. Android Clean Build만 Room-owned source를 짧게 pause해 immutable snapshot을 캡처하고, live Room을 즉시 다시 연 뒤 해당 snapshot과 disposable SDK/Gradle state에서 실행한다. 이 Android 경로도 아직 daemon-owned durable Job이 아니므로 공통 immutable Job input이나 모든 Room 변경과 완전히 독립된 병렬 build/test가 구현됐다고 표현하지 않는다. 상세 계약과 acceptance gate는 [Room Working State / Sync / Build 설계](./2026-08-10-devhotel-working-state-design.md)에 정의한다.

## 12. Security and audit invariants

1. 다른 Room의 process, network, filesystem과 service data는 기본 접근 불가다.
2. 모든 mutation은 runtime validation, authentication, authorization, lease와 fencing을 통과한다.
3. backup/restore는 Host path가 아니라 Room-scoped opaque artifact ID를 사용한다.
4. destructive cleanup은 durable ownership manifest, labels와 runtime identity를 모두 검증한다.
5. renderer compromise만으로 complete uninstall이나 arbitrary Host mount를 수행할 수 없다.
6. secret은 최소 범위로 전달하고 logs/diagnostics/API errors에서 redact한다.
7. compatibility runtime도 생성 때 pin한 engine identity가 바뀌면 destructive operation을 거부한다.
8. Agent action, permission grant, Job, takeover와 forced cleanup은 append-only audit event를 남긴다.

## 13. Delivery sequence

### Phase 0 — isolation truth

- Room별 network/filesystem/process/service isolation을 실제 공격 관점으로 검증
- Clone, sleep, update와 uninstall의 lifecycle race 제거
- resource ownership과 destructive cleanup 검증
- current preview limitations를 UI와 문서에 명시

### Phase 1 — stable daemon and API

- Electron main에서 orchestration state를 독립 per-user daemon으로 분리
- versioned local REST API와 event stream
- GUI와 최소 CLI를 동일 API client로 전환
- schema validation, actor identity, idempotency와 audit journal

### Phase 2 — Agent check-in

- Room Key UX와 high-entropy credential
- exclusive writer lease, heartbeat, fencing, rotate/revoke/takeover
- Room-scoped command and capability API
- Host Workspace grant boundary

### Phase 3 — durable jobs and resource broker

- persistent build/test Jobs, logs, artifacts, cancellation와 recovery
- Clean Run/Suite UX
- Android/device/GPU reservation primitive

### Phase 4 — adapters and ecosystem

- CLI completeness
- GitHub Service vertical slice: pinned Hotel-managed `gh`, private auth/config, structured repository operations and mutation grants
- DevHotel MCP adapter over the stable REST API
- Agent SDK / IDE integrations
- Later MCP/Skills Hotel Service categories, one-time install/update lifecycle and context bindings
- Host/Room Agent Gateway propagation and permission review

GitHub Service는 첫 Hotel Service slice다. MCP/Skills catalog와 DevHotel MCP adapter가 늦게 제공될 수는 있지만, Agent가 사용할 stable REST API, Gateway context, lease와 job 모델은 제품 foundation으로 먼저 설계한다.

## 14. Acceptance criteria

1. Agent가 Host shell이나 global package manager 없이 Room 생성부터 test/build까지 수행한다.
2. Room 안 tool installation이 Host 또는 다른 Room의 runtime/files에 영향을 주지 않는다.
3. 다른 Room의 internal service IP로 직접 연결을 시도하면 실패한다.
4. 한 Room에 두 writer가 동시에 mutation할 수 없고, Take Over 뒤 stale writer 요청도 실패한다.
5. GUI, CLI 또는 MCP 연결이 끊겨도 accepted Job은 지속되고 다시 조회할 수 있다.
6. Agent가 요청한 Host/shared resource 접근은 명시적인 grant 없이는 거부된다.
7. 두 Agent의 병렬 작업은 독립 Clone과 Git 결과물로 합쳐진다.
8. Clean Run이 기록된 source revision과 component digests로 재현된다.
9. Complete uninstall은 오직 검증된 DevHotel-owned 자원만 지우며 실패 시 재시도 metadata를 남긴다.
10. GitHub Service가 Host `gh` prerequisite 없이 pinned Hotel-managed build/private auth를 사용하고, read와 remote mutation을 서로 다른 structured grant로 집행한다.
11. service process의 runtime placement를 바꿔도 public REST/MCP contract와 authorization 결과가 유지된다.
12. 추후 MCP/Skills Hotel Service 하나를 Hotel에 한 번 설치한 뒤 여러 context가 서로 다른 grant로 사용해도 어떤 context도 다른 context의 handle이나 권한을 재사용할 수 없다.
