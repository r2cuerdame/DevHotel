import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resilientClient, type ControlClient } from './client'
import { makeTools } from './tools'
import { MCP_METADATA } from './metadata'

// Survives DevHotel app restarts (new control port/token) without an MCP restart.
const client = resilientClient()
async function getClient(): Promise<ControlClient> {
  return client
}

async function main(): Promise<void> {
  const server = new McpServer(MCP_METADATA)
  for (const tool of makeTools(getClient)) {
    if (tool.strictInputSchema) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.strictInputSchema },
        tool.handler
      )
    } else {
      server.tool(tool.name, tool.description, tool.schema, tool.handler)
    }
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('devhotel-mcp: ready (stdio)')
}

main().catch((err) => {
  console.error('devhotel-mcp: fatal:', err)
  process.exit(1)
})
