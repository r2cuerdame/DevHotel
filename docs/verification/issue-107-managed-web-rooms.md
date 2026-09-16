# Web Rooms on the managed runtime — GitHub #107

Status: **implemented, not accepted.** The Host half is built and covered; the
live gate below has not been run, so #107 stays open.

#107 moves the primary Web Room path off an external Docker Engine and onto the
DevHotel-owned Linux runtime, without changing what a Room is. This document
records what the implementation actually is, what is proven, and precisely what
is not — because the claim "Rooms no longer need Docker Desktop" is exactly the
kind of claim that a developer machine cannot test: this machine already has
Docker Desktop installed, which is the thing the claim says is unnecessary.

## The shape of the change

The Room model is unchanged, deliberately. The anchor container that owns a
network namespace, the role containers that join it, per-Room bridge networks
and subnet allocation, owned volume generations for workspace/deps/cache, the
ownership labels re-proved before every destructive operation, and the relay
token that gates ingress are all DevHotel's rules, not Docker's. They are what
make two Rooms able to serve internal port 3000 at once and a Room's state
survive sleep and wake. Reimplementing them against a second engine would mean
maintaining two copies of the rules that keep Rooms isolated, and the first time
the copies drifted, a Room would delete something it did not own.

So the engine moved and the rules did not:

| Layer | File | What it does |
|---|---|---|
| Engine seam | `backend/cli.ts` (`OciEngineExecutor`) | The single choke point every Room operation reaches an engine through. All 105 invocations in `OciCliBackend` go through it. |
| Wire protocol | `backend/managedRuntimeGuestProtocol.ts` | Length-prefixed binary frames with request ids, so binary survives, streams interleave, and a partial read is normal. |
| Host client | `backend/managedRuntimeEngine.ts` | Implements the executor over a channel: argv delivery, stdin, streamed stdout/stderr, output caps, `outputFile`, `onLine`, timeouts, aborts, reconnection, and `put`/`get` file staging. |
| Guest agent | `backend/managedRuntimeGuestAgent.ts` | Serves that protocol in the guest. Runs one pinned engine, never a shell string, and writes only beneath the staging root. |
| Guest bootstrap | `backend/managedRuntimeGuestOverlay.ts` | apkovl now also carries the container engine, the persistent state disk, the private NIC and the agent, as ordered OpenRC services. |
| Ingress | `backend/managedRuntimeIngress.ts` | One Host loopback forwarder per Room, so the Gateway keeps routing to `127.0.0.1:<port>` exactly as before. |
| Assembly | `backend/managedRoomBackend.ts` | `OciCliBackend` subclass overriding only ingress, Host-path crossings and teardown. |
| Selection | `backend/roomRuntimeSelection.ts` | Prefers the managed runtime, falls back to the compatibility engine, and reports which one it got. |

Three decisions are worth stating because they are where this could have gone
wrong quietly:

**The serial line survived.** #106's COM2 channel cannot carry Room traffic — an
emulated UART is nowhere near enough for log follow or file transfer — but it is
the only channel private to the Host *by construction*. So it bootstraps the
other one: `channel:<nonce>` returns the guest's address, the agent port and this
boot's token. Both are per-boot facts (DHCP address, regenerated token), so
neither is cached, and the token never travels anywhere a Room can observe.

**Host paths are staged, never passed.** `docker cp <host path>` and `-v <host
path>` against an engine inside a VM do not fail — they resolve *inside the
guest*, and succeed against the wrong filesystem. That is the most dangerous
failure mode in this change, so every Host-path crossing is an explicit
`put`/`get` through the agent's staging root, and a test asserts no Host path
ever appears in guest argv.

**The engine pin moved to the runtime identity.** A Room's volumes live in
exactly one engine. The durable engine pin now records `managed-linux:<runtimeId>`
rather than a Docker context, so a Room created on one runtime can never be
silently attributed to another that happens to answer the same address.

## What is proven, and how

`pnpm --filter @devhotel/core test` — 1543 passing, 0 failing. New coverage:

- `backend.engineExecutor.test.ts` — every engine invocation reaches the injected
  executor and never the Host CLI; the identity pin follows the executor
  endpoint; a pin presented a different endpoint is refused; the default path is
  byte-for-byte the old one, including call arity.
- `backend.managedRuntimeEngine.test.ts` (21) — the protocol against a real
  in-process guest: frames reassembled a byte at a time, several frames in one
  chunk, an oversize declared length refused without allocating it; argv
  delivered unchanged; a credential on stdin and never in argv; chunk sinks,
  byte caps, `onLine`, `outputFile`; timeout and abort both cancelling the guest
  request and running the caller's cleanup; a dropped connection failing every
  in-flight call rather than hanging, and the next call reconnecting;
  concurrent operations kept on their own streams.
- `backend.managedRuntimeIngress.test.ts` (8) — real sockets: a Host loopback
  connection reaching the guest port, the relay preamble passed through
  untouched, two Rooms getting two Host ports, loopback-only binding, revoke on
  sleep, replacement on wake, release on shutdown.
- `backend.managedRuntimeRoomAgent.test.ts` (15) — the agent runs one pinned
  engine with no `shell=True`/`os.system`/`eval`; authorization is checked before
  operation dispatch; the token is install-bound, per-boot and `0600`; transfer
  paths are `realpath`-resolved before the staging-root check; the generated
  Python compiles; the overlay's service order cannot let a Room command precede
  a ready engine; the engine's data root is on the persistent disk; a disk is
  formatted only when blank and found again only by DevHotel's label.
- `backend.managedRoomBackend.test.ts` (7) — Room work reaches only the guest
  engine; the relay gate publishes where the Host can reach it while everything
  else about the gate is identical; the Gateway gets a forwarding Host port that
  really carries bytes; the port is revoked on sleep; file transfer stages both
  ways and cleans up; no Host path ever reaches guest argv.
- `backend.roomRuntimeSelection.test.ts` (6) — fallback when there is no runtime,
  refusal to select managed mode when the guest engine does not answer, selection
  when it does, the pin recorded under the runtime identity, and the token
  handshake including frames that share the handshake's TCP segment.

## What is not proven — the live gate

**None of the guest half has been booted.** Every test above exercises the Host
side against an in-process implementation of the protocol. That is real evidence
about the Host, and it is not evidence that the guest bootstrap works.

The reason is a Host gate, not a choice. On the machine this was built on:

```powershell
Get-Command New-VM          # absent
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent   # True
```

`Microsoft-Hyper-V-All` is **not installed**, so no managed runtime can be
provisioned or started here at all. Enabling it needs elevation *and* a Host
reboot. Separately, this machine has Docker Desktop installed
(`C:\Program Files\Docker\Docker\resources\bin\docker.exe`), so the specific
claim "with Docker Desktop absent" cannot be demonstrated on it under any
circumstances.

#106's own matrix in
[issue-106-clean-windows-acceptance.md](./issue-106-clean-windows-acceptance.md)
is still `not yet run`, and its **row 16 — two managed Web Rooms** is exactly
#107's gate. #107 is therefore blocked behind #106's live run, and both need the
same environment.

### The matrix #107 closes on

Run on the clean Windows 11 VM built by
`scripts/acceptance/issue-106/New-CleanWindowsAcceptanceVm.ps1`, with no Docker
Desktop, Node or adb in the guest, after #106's rows 1–15 pass.

| # | Claim | How it is shown | Result | Evidence |
|---|---|---|---|---|
| 1 | Docker is genuinely absent | `Get-Command docker` finds nothing; no Docker service | | |
| 2 | Managed mode is actually selected | App reports runtime mode `managed`, not compatibility | | |
| 3 | Guest engine reaches ready | Engine answers inside the guest; `devhotel-engine` service started | | |
| 4 | Packages come from the pinned branch | First boot resolves them; **second boot installs from cache with the NIC disconnected** | | |
| 5 | State disk is claimed safely | A blank disk is formatted and labelled; a disk with any filesystem is refused, not reformatted | | |
| 6 | **Room create** | A Web Room is created end to end from a repository | | |
| 7 | **Routed ingress** | `https://<room>.localhost` serves the Room's dev server | | |
| 8 | **Two Rooms, one internal port** | Two Rooms both on internal 3000, both reachable, no collision | | |
| 9 | Exec | `run_in_room` returns the guest command's real exit code and output | | |
| 10 | Logs | Log follow streams for minutes without buffering on the Host | | |
| 11 | File transfer both ways | A Host file lands in the Room; a Room file lands on the Host; byte-identical both ways | | |
| 12 | Stop and start | Room stops; its Host port stops accepting; start restores a working URL | | |
| 13 | **Sleep/wake persistence** | Workspace edit, `node_modules`, and a Postgres row all survive sleep → wake | | |
| 14 | **Host reboot persistence** | The same three survive a Host reboot and the runtime's saved state | | |
| 15 | Delete | Room deleted; volumes gone; reclaimed bytes reported; Host port released | | |
| 16 | Contracts stayed neutral | Control API and MCP responses for 6–15 are indistinguishable from the compatibility backend's | | |
| 17 | No Host path crossed wrongly | A Host-path bind or `cp` never silently resolves inside the guest | | |

Rows 6, 7, 8, 13 and 14 are what #107 turns on. Row 4 is the one most likely to
be skipped and the most expensive to get wrong: a runtime that silently needs
the network on every boot is not the offline-capable runtime this claims to be.
Row 16 is what keeps the backend swap invisible to agents.

Record the filled matrix in a dated document beside this one and comment the
result on #107. A partial pass is a partial pass.

## Known follow-ups, deliberately not in scope here

- **Runtime version `0.2.0`.** The guest bootstrap changed, so the overlay digest
  changed, and the provider refuses to re-seed a different overlay under a
  runtime it already provisioned. Migrating an install already on `0.1.0` is
  #110's explicit update path, not a side effect of this change.
- **The Default Switch is required.** Provisioning refuses rather than creating a
  Host network object, because a DevHotel-owned switch brings its own uninstall
  and collision problems. Owning networking properly is #109.
- **Android Rooms stay on the compatibility backend.** They need KVM in the
  guest, which needs the nested virtualization #106 records but cannot require.
  That is #108.
- **The relay gate publishes on `0.0.0.0` inside the guest.** Wider than the
  compatibility backend's loopback binding, bounded by the Default Switch being a
  NAT'd private network and by the relay token still gating every connection.
  Narrowing it to the runtime's own interface address belongs with #109's
  networking ownership.
