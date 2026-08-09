import { describe, expect, it } from 'vitest'
import { zCreateRoomInput, zQuickChange } from '../control'

describe('zQuickChange', () => {
  it('accepts every quick-change kind', () => {
    const cases = [
      { kind: 'node-version', version: '24' },
      { kind: 'start-command', command: 'pnpm dev' },
      { kind: 'domain', domain: 'loopoffice-dev.localhost' },
      { kind: 'https', enabled: true },
      { kind: 'internal-port', port: 3000 },
      { kind: 'deps-install', clean: false }
    ]
    for (const c of cases) expect(zQuickChange.parse(c)).toEqual(c)
  })

  it('rejects unknown kinds and bad values', () => {
    expect(zQuickChange.safeParse({ kind: 'reboot-host' }).success).toBe(false)
    expect(zQuickChange.safeParse({ kind: 'node-version', version: 'v24.1.0' }).success).toBe(false)
    expect(zQuickChange.safeParse({ kind: 'domain', domain: 'evil.com' }).success).toBe(false)
    expect(zQuickChange.safeParse({ kind: 'internal-port', port: 0 }).success).toBe(false)
  })
})

describe('zCreateRoomInput', () => {
  it('round-trips a full input', () => {
    const input = {
      sourceType: 'linked-folder',
      sourceRef: 'C:\\code\\loopoffice',
      project: 'loopoffice',
      nickname: 'dev',
      actor: 'user',
      planOverrides: { runtimeVersion: '22', pmKind: 'pnpm', internalPort: 3000, https: true }
    }
    expect(zCreateRoomInput.parse(input)).toEqual(input)
  })

  it('rejects empty nickname', () => {
    expect(
      zCreateRoomInput.safeParse({ sourceType: 'empty', sourceRef: '', project: 'x', nickname: '', actor: 'user' }).success
    ).toBe(false)
  })
})
