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
    claudeCommand:
      `claude mcp add --transport stdio --env ELECTRON_RUN_AS_NODE=1 devhotel -- ` +
      `${quoteCliArg(command)} ${quoteCliArg(opts.serverPath)}`,
    configJson: JSON.stringify(
      { mcpServers: { devhotel: { type: 'stdio', command, args: [opts.serverPath], env } } },
      null,
      2
    ),
    controlPort: opts.controlPort
  }
}
