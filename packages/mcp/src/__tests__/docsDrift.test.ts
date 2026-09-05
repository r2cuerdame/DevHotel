import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zAgentCreateRoomInput } from '@devhotel/shared'
import { MCP_METADATA } from '../metadata'
import { makeTools } from '../tools'

describe('documentation and capability drift', () => {
  const repoRoot = resolve(__dirname, '../../../../')
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf-8')
  const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf-8')
  const controlApiDoc = readFileSync(resolve(repoRoot, 'docs/control-api.md'), 'utf-8')
  const rootPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }

  const tools = makeTools(async () => ({} as any))
  const toolNames = tools.map((t) => t.name)

  it('keeps MCP metadata version in sync with package.json and control-api discovery', () => {
    expect(MCP_METADATA.version).toBe(rootPackageJson.version)
    expect(controlApiDoc).toContain(`"version": "${rootPackageJson.version}"`)
  })

  it('proves the exact MCP tool count matches across implementation, README, and CHANGELOG', () => {
    expect(tools).toHaveLength(52)
    expect(new Set(toolNames).size).toBe(52)

    // README documents the exact count
    expect(readme).toContain(`MCP tool surface (52 tools)`)
    expect(readme).toContain(`52 tools across the complete development lifecycle`)

    // CHANGELOG 0.5.0 documents the full 52-tool surface without stale counts
    expect(changelog).toContain(`Fifty-two MCP tools are now available`)
    expect(changelog).not.toContain(`Thirty tools now`)
  })

  it('references the updated 15-step check pipeline and contains no stale 14-step claim', () => {
    expect(readme).toContain(`15-step check pipeline`)
    expect(readme).not.toContain(`14-step check pipeline`)
    expect(readme).not.toContain(`14-step check`)
    expect(controlApiDoc).toContain(`15-step check report`)
  })

  it('preserves provider alignment: Web and Android for agents, Windows for desktop UI setup', () => {
    // README documents all three providers
    expect(readme).toContain(`**Web**`)
    expect(readme).toContain(`**Android**`)
    expect(readme).toContain(`**Windows (VMware)**`)

    // Agent create schema permits only web and android
    const base = {
      sourceType: 'managed-git',
      sourceRef: 'https://github.com/example/test.git',
      project: 'test',
      nickname: 'dev'
    }
    expect(zAgentCreateRoomInput.safeParse({ ...base, provider: 'web' }).success).toBe(true)
    expect(zAgentCreateRoomInput.safeParse({ ...base, provider: 'android' }).success).toBe(true)
    expect(zAgentCreateRoomInput.safeParse({ ...base, provider: 'windows' }).success).toBe(false)

    // README documents this exact agent boundary
    expect(readme).toContain(`provider: 'web'`)
    expect(readme).toContain(`provider: 'android'`)
    expect(readme).toContain("`provider: 'windows'` is reserved for desktop setup")
  })

  it('documents core guarantees: host input isolation, device broker non-destructive release, safe resync', () => {
    expect(readme).toContain(`./docs/host-input-isolation.md`)
    expect(readme).toContain(`./docs/android-device-broker.md`)
    expect(readme).toContain(`./docs/android-acceptance-reports.md`)
    expect(readme).toContain(`./docs/android-locale-matrix.md`)
    expect(readme).toContain(`safe_resync_from_host`)
    expect(readme).toContain(`verified builds stay installed`)
  })
})
