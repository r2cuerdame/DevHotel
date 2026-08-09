# DevHotel

> **Every project gets its own room.**
>
> Easy Setup · Easy Change · Easy Check · Easy Undo

DevHotel is a browser-like desktop app that gives every web project its own isolated, persistent local development server — a **Room**. Open a room like a browser tab; DevHotel handles the runtime, isolation, domains, HTTPS, and undo behind the scenes.

**Status: early development.** See [goal.md](./goal.md) for the full product definition.

## Development

Requirements: Node ≥ 22, pnpm ≥ 10, Docker Engine (Docker Desktop with WSL2 on Windows).

```bash
pnpm install
pnpm dev              # run the desktop app in dev mode
pnpm test             # unit tests
pnpm build:installer  # build the Windows NSIS installer into apps/desktop/release
```

## License

[MIT](./LICENSE)
