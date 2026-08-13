import type { McpSetupInfo } from '@devhotel/shared'

export interface McpSetupOptions {
  serverPath: string
  executablePath: string
  available: boolean
  controlPort: number | null
}

function quoteCliArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

/** Launches the bundled MCP server with Electron's embedded Node runtime. */
export function makeMcpSetupInfo(opts: McpSetupOptions): McpSetupInfo {
  const command = opts.executablePath
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  return {
    serverPath: opts.serverPath,
    available: opts.available,
    // The server name must precede the flags: `-e/--env` is variadic, so
    // `--env KEY=1 devhotel` makes the CLI read the name as another variable
    // and reject the command. User scope keeps the Hotel reachable from every
    // project, and absolute paths keep it resolvable for already-running agents.
    claudeCommand:
      `claude mcp add devhotel -s user -e ELECTRON_RUN_AS_NODE=1 -- ` +
      `${quoteCliArg(command)} ${quoteCliArg(opts.serverPath)}`,
    configJson: JSON.stringify(
      { mcpServers: { devhotel: { type: 'stdio', command, args: [opts.serverPath], env } } },
      null,
      2
    ),
    controlPort: opts.controlPort
  }
}
