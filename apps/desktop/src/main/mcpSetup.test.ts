import { describe, expect, it } from 'vitest'
import { makeMcpSetupInfo } from './mcpSetup'

describe('packaged MCP launcher', () => {
  it('uses the app executable as Node instead of requiring host node', () => {
    const executablePath = 'C:\\Program Files\\DevHotel\\DevHotel.exe'
    const serverPath = 'C:\\Program Files\\DevHotel\\resources\\mcp\\index.js'
    const info = makeMcpSetupInfo({ executablePath, serverPath, available: true, controlPort: 43123 })
    const config = JSON.parse(info.configJson) as {
      mcpServers: { devhotel: { type: string; command: string; args: string[]; env: Record<string, string> } }
    }

    expect(config.mcpServers.devhotel).toEqual({
      type: 'stdio',
      command: executablePath,
      args: [serverPath],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(info.claudeCommand).toContain('--env ELECTRON_RUN_AS_NODE=1')
    expect(info.claudeCommand).toContain(`"${executablePath}"`)
    expect(info.claudeCommand).not.toMatch(/--\s+node(?:\.exe)?\s/i)
  })
})
