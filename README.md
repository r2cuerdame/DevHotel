# DevHotel

> **Every project gets its own room.**
>
> Easy Setup · Easy Change · Easy Check · Easy Undo

DevHotel is a browser-like desktop app that gives every web project its own **isolated, persistent local development server** — a **Room**. Open a room like a browser tab. DevHotel handles the runtime, isolation, domains, HTTPS, health checks, and undo behind the scenes.

- Two rooms can both use internal port `3000` (and later `5432`, `6379`) at the same time — each room has its own network namespace.
- Rooms are reached by stable domains like `https://my-project-dev.localhost`, never by port numbers.
- Sleeping a room stops every process it owns and frees CPU/RAM; its dependencies, data, and browser session survive app restarts and reboots.
- Quick Changes (Node version, start command, domain, HTTPS, dependencies) run as verified transactions with **action-level Undo**: `↶ Undo: Node 22 → 24`.
- When something breaks, a 14-step check pipeline tells you *which* layer failed, and **Copy Diagnostic** produces a secret-redacted bundle you can paste into an issue or an LLM.
- No Node, npm, or pnpm needed on your host — rooms bring their own.

See [goal.md](./goal.md) for the full product definition (Korean).

## Requirements

- Windows 11 (first supported OS)
- Docker Engine — Docker Desktop with the WSL2 backend, or any engine exposing the `docker` CLI

## Install

Download the installer from [GitHub Releases](../../releases) and run it. DevHotel auto-updates from Releases; app updates never change your rooms' runtimes or data.

## MCP — let agents use rooms

DevHotel ships an MCP server so Claude Code and other agents work inside rooms instead of dirtying your host. Open **Settings (⚙) → MCP** in the app and copy either:

- the one-line `claude mcp add devhotel …` command, or
- the `mcpServers` JSON for any MCP client.

Tools: `list_rooms`, `create_room`, `start_room`, `sleep_room`, `inspect_room`, `run_in_room`, `check_room`, `apply_quick_change`, `undo_change`, `copy_diagnostic`. Agent changes are labeled in the room's Changes list and can be undone from the UI. The DevHotel app must be running.

## Development

Requirements: Node ≥ 22, pnpm ≥ 10, Docker.

```bash
pnpm install
pnpm dev              # run the desktop app in dev mode
pnpm test             # unit tests (117+)
pnpm typecheck
pnpm build:installer  # NSIS installer into apps/desktop/release
```

Live backend smoke test (talks to your local Docker):

```powershell
$env:DEVHOTEL_SMOKE='1'; pnpm --filter @devhotel/core exec vitest run src/__tests__/backend.smoke.test.ts --testTimeout=180000
```

### Architecture

```text
apps/desktop      Electron app — UI (React), embedded per-room browser views,
                  tray, auto-update, loopback control API
packages/core     Orchestrator — OCI room-pod backend (docker CLI), local
                  gateway (*.localhost + SNI TLS + local CA), SQLite store,
                  change-transaction engine with undo, check pipeline,
                  diagnostics with secret redaction
packages/mcp      devhotel-mcp — stdio MCP server over the control API
packages/shared   Types and contracts
```

Each room is a pod: an **anchor** container owns the network namespace and publishes one ephemeral loopback port (via a socat relay), and the **web** container joins that namespace. The gateway routes `<project>-<nickname>.localhost` domains to rooms — port numbers stay invisible. Dependency volumes are keyed by Node major (`…-deps-node22`, `…-deps-node24`), which is why a Node version change undoes instantly.

## License

[MIT](./LICENSE)
