import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { connect, type ControlClient } from './client'
import { makeTools } from './tools'

let cached: ControlClient | null = null
async function getClient(): Promise<ControlClient> {
  if (cached) return cached
  cached = await connect()
  return cached
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'devhotel', version: '0.1.0' })
  for (const tool of makeTools(getClient)) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler)
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('devhotel-mcp: ready (stdio)')
}

main().catch((err) => {
  console.error('devhotel-mcp: fatal:', err)
  process.exit(1)
})
