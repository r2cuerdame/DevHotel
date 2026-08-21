import { describe, expect, it } from 'vitest'
import {
  zAgentCreateRoomInput,
  zCloneRoomInput,
  zCreateRoomInput,
  zPackageSearchOffset,
  zPackageSearchQuery,
  zPreviewLayout,
  zPreviewTarget,
  zQuickChange,
  zRendererCreateRoomInput,
  zRendererPlanRoomInput,
  zRoomId
} from '../control'
import { zGitHubToken, zHotelServiceAssignmentInput, zHotelServiceManifest } from '../hotelServices'

const serviceManifest = {
  schemaVersion: 1 as const,
  id: 'hotel.device-pool',
  title: 'Device Pool',
  description: 'Shared physical device arbitration',
  category: 'device' as const,
  adapterId: 'android-device-pool',
  interface: 'agent-native' as const,
  version: {
    current: '1.0.0',
    pin: { mode: 'exact' as const, value: '1.0.0' },
    update: { mode: 'manual' as const, channel: 'stable' },
    rollback: { supported: false, strategy: 'none' as const }
  },
  lifecycle: { install: false, update: false, start: true, stop: true, restart: false, remove: false, rollback: false },
  supportedContexts: ['hotel', 'room'] as const,
  permissions: [{ id: 'device-use', title: 'Reserve a device', access: 'external-resource' as const, risk: 'medium' as const, approval: 'once' as const }],
  health: { capability: 'status' as const, timeoutMs: 5_000 }
}

describe('Hotel Service control-plane contracts', () => {
  it('strictly validates manifests, lifecycle declarations, and unique contexts', () => {
    expect(zHotelServiceManifest.parse(serviceManifest).category).toBe('device')
    expect(zHotelServiceManifest.safeParse({ ...serviceManifest, implementationCommand: 'adb devices' }).success).toBe(false)
    expect(zHotelServiceManifest.safeParse({ ...serviceManifest, supportedContexts: ['hotel', 'hotel'] }).success).toBe(false)
    expect(zHotelServiceManifest.safeParse({ ...serviceManifest, lifecycle: { install: true } }).success).toBe(false)
  })

  it('supports Room-less Hotel assignment and validates Room references', () => {
    expect(zHotelServiceAssignmentInput.safeParse({
      serviceId: serviceManifest.id,
      scopeKind: 'hotel',
      scopeRef: null,
      agentAdapterId: 'future-agent',
      enabled: true,
      approved: true
    }).success).toBe(true)
    expect(zHotelServiceAssignmentInput.safeParse({
      serviceId: serviceManifest.id,
      scopeKind: 'room',
      scopeRef: null,
      agentAdapterId: 'codex',
      enabled: true,
      approved: true
    }).success).toBe(false)
  })
})

describe('GitHub Hotel credential input', () => {
  it('accepts only bounded non-whitespace GitHub token characters', () => {
    expect(zGitHubToken.parse('github_pat_12345678901234567890')).toBe('github_pat_12345678901234567890')
    expect(zGitHubToken.safeParse('short').success).toBe(false)
    expect(zGitHubToken.safeParse(`github_pat_${'a'.repeat(510)}`).success).toBe(false)
    expect(zGitHubToken.safeParse('github_pat_1234567890 secret').success).toBe(false)
    expect(zGitHubToken.safeParse('github-pat-123456789012345').success).toBe(false)
  })
})

describe('npm Registry search input', () => {
  it('bounds search text and pagination offsets', () => {
    expect(zPackageSearchQuery.parse('  keywords:frontend  ')).toBe('keywords:frontend')
    expect(zPackageSearchOffset.parse(1000)).toBe(1000)
    expect(zPackageSearchOffset.safeParse(-1).success).toBe(false)
    expect(zPackageSearchOffset.safeParse(1001).success).toBe(false)
    expect(zPackageSearchOffset.safeParse(1.5).success).toBe(false)
  })
})

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
    expect(zQuickChange.safeParse({ kind: 'db-restore', service: 'postgres', file: 'C:\\Users\\me\\secret.txt' }).success).toBe(false)
    expect(
      zQuickChange.safeParse({ kind: 'db-restore', service: 'postgres', backupId: '../postgres-2026.sql' }).success
    ).toBe(false)
    expect(
      zQuickChange.safeParse({
        kind: 'db-restore',
        service: 'postgres',
        backupId: 'postgres-2026-08-10T12-30-00-deadbeef.sql'
      }).success
    ).toBe(true)
  })

  it('accepts registry-only package installs and rejects shell, path, URL and tag specs', () => {
    expect(
      zQuickChange.safeParse({ kind: 'package-install', name: '@vitejs/plugin-react', version: '5.0.1', dev: true }).success
    ).toBe(true)
    for (const name of ['zod;whoami', '../local-package', 'https://example.com/a.tgz', '-evil']) {
      expect(zQuickChange.safeParse({ kind: 'package-install', name, version: '1.2.3', dev: false }).success).toBe(false)
    }
    expect(zQuickChange.safeParse({ kind: 'package-install', name: 'zod', version: 'latest', dev: false }).success).toBe(false)
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

  it('forces renderer actors out of the contract and blocks agent linked-folder creation', () => {
    const linked = {
      sourceType: 'linked-folder' as const,
      sourceRef: 'C:\\code\\loopoffice',
      project: 'loopoffice',
      nickname: 'dev'
    }
    expect(zRendererCreateRoomInput.safeParse({ ...linked, actor: 'agent' }).success).toBe(false)
    expect(zAgentCreateRoomInput.safeParse(linked).success).toBe(false)
    expect(zAgentCreateRoomInput.safeParse({ ...linked, sourceType: 'managed-git', sourceRef: 'https://example.test/repo.git' }).success).toBe(true)
  })

  it('allows desktop-only Windows creation with an opaque VMware picker grant', () => {
    const create = {
      sourceType: 'empty' as const,
      sourceRef: '',
      project: 'demo',
      nickname: 'dev'
    }
    const plan = { sourceType: 'empty' as const, sourceRef: '', nickname: 'dev' }

    expect(zRendererCreateRoomInput.safeParse({ ...create, provider: 'web' }).success).toBe(true)
    expect(zRendererCreateRoomInput.safeParse({ ...create, provider: 'android' }).success).toBe(true)
    expect(zRendererCreateRoomInput.safeParse({ ...create, provider: 'windows' }).success).toBe(false)
    expect(
      zRendererCreateRoomInput.safeParse({
        ...create,
        provider: 'windows',
        windows: { templateGrantId: '11111111-2222-4333-8444-555555555555', snapshot: 'devhotel-clean' }
      }).success
    ).toBe(true)
    expect(
      zRendererCreateRoomInput.safeParse({
        ...create,
        provider: 'windows',
        planOverrides: { internalPort: 3000 },
        windows: { templateGrantId: '11111111-2222-4333-8444-555555555555', snapshot: 'devhotel-clean' }
      }).success
    ).toBe(false)
    expect(
      zCreateRoomInput.safeParse({
        ...create,
        provider: 'windows',
        actor: 'user',
        windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
      }).success
    ).toBe(true)
    expect(zAgentCreateRoomInput.safeParse({ ...create, provider: 'android' }).success).toBe(true)
    expect(zAgentCreateRoomInput.safeParse({ ...create, provider: 'windows' }).success).toBe(false)
    expect(zRendererPlanRoomInput.safeParse({ ...plan, provider: 'android' }).success).toBe(true)
    expect(zRendererPlanRoomInput.safeParse({ ...plan, provider: 'windows' }).success).toBe(true)
    expect(
      zRendererPlanRoomInput.safeParse({
        ...plan,
        provider: 'windows',
        sourceType: 'managed-git',
        sourceRef: 'https://example.test/repo.git'
      }).success
    ).toBe(false)
  })
})

describe('identifier schemas', () => {
  it('rejects traversal and malformed Room IDs', () => {
    expect(zRoomId.safeParse('room1abc').success).toBe(true)
    expect(zRoomId.safeParse('../rooms').success).toBe(false)
    expect(zRoomId.safeParse('room1abc/../../secret').success).toBe(false)
  })
})

describe('responsive preview contracts', () => {
  it('accepts strict split layout and navigation targets', () => {
    expect(
      zPreviewLayout.parse({
        mode: 'split',
        leftViewport: { width: 1440, height: 900 },
        rightViewport: { width: 390, height: 844 }
      })
    ).toMatchObject({ mode: 'split' })
    expect(zPreviewTarget.parse('both')).toBe('both')
  })

  it('rejects malformed dimensions, targets, and unknown fields', () => {
    expect(
      zPreviewLayout.safeParse({
        mode: 'split',
        leftViewport: null,
        rightViewport: { width: 0, height: 844 }
      }).success
    ).toBe(false)
    expect(
      zPreviewLayout.safeParse({
        mode: 'split',
        leftViewport: null,
        rightViewport: { width: 390, height: 844 },
        partition: 'default'
      }).success
    ).toBe(false)
    expect(zPreviewTarget.safeParse('host').success).toBe(false)
  })
})

describe('zCloneRoomInput', () => {
  it('accepts each service-data mode and trims the nickname', () => {
    for (const services of ['copy', 'empty', 'exclude'] as const) {
      expect(
        zCloneRoomInput.parse({
          sourceRoomId: 'room1abc',
          nickname: '  stage  ',
          copyDependencies: true,
          services,
          actor: 'user'
        })
      ).toEqual({ sourceRoomId: 'room1abc', nickname: 'stage', copyDependencies: true, services, actor: 'user' })
    }
  })

  it('rejects empty nicknames and unknown service modes', () => {
    expect(
      zCloneRoomInput.safeParse({
        sourceRoomId: 'room1abc',
        nickname: '   ',
        copyDependencies: true,
        services: 'copy',
        actor: 'user'
      }).success
    ).toBe(false)
    expect(
      zCloneRoomInput.safeParse({
        sourceRoomId: 'room1abc',
        nickname: 'stage',
        copyDependencies: true,
        services: 'snapshot',
        actor: 'user'
      }).success
    ).toBe(false)
  })
})
