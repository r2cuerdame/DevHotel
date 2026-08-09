# Contributing to DevHotel

Thanks for your interest! DevHotel is in early development.

- Product direction lives in [goal.md](./goal.md) — proposals that conflict with its "제품 드리프트 방지" decisions need discussion first.
- Implementation decisions live in `docs/superpowers/specs/`.
- Monorepo: pnpm workspaces. `packages/core` is plain Node (unit-testable), `apps/desktop` is Electron, `packages/mcp` is the MCP server.
- Before opening a PR: `pnpm lint && pnpm typecheck && pnpm test`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
