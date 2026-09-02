import { describe, expect, it } from 'vitest'
import {
  ANCHOR_IMAGE,
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  NETWORK_AUTHORITY_STARTED_AT_LABEL,
  RELAY_PORT,
  anchorName,
  androidControlNetworkName,
  androidRuntimeAnchorName,
  buildAndroidControlNetworkCreateArgs,
  buildAndroidRuntimeAnchorArgs,
  buildAnchorArgs,
  buildEmulatorArgs,
  buildOneShotArgs,
  buildRoomNetworkCreateArgs,
  buildServiceArgs,
  buildWebCreateArgs,
  cacheVolume,
  depsVolume,
  emulatorAvdOverride,
  parsePortOutput,
  roomNetworkName,
  srcVolume,
  webImage,
  webName,
  isJobName,
  jobName,
  workspaceSnapshotVolume,
  wrapStartCommand,
} from '../backend/naming'
import type { WebSpec } from '../backend/types'

function spec(overrides: Partial<WebSpec> = {}): WebSpec {
  return {
    roomId: 'r1',
    internalPort: 5173,
    nodeMajor: '22',
    sourceType: 'managed-git',
    sourceRef: 'https://example.com/repo.git',
    workspaceMode: 'hotel',
    workspaceVolumeRevision: 0,
    startCommand: 'npm run dev',
    ...overrides,
  }
}

function mounts(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '-v' ? [args[i + 1] ?? ''] : []))
}

function envs(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '-e' ? [args[i + 1] ?? ''] : []))
}

describe('names and images', () => {
  it('derives container, volume, and image names', () => {
    expect(anchorName('r1')).toBe('dh-r1-anchor')
    expect(roomNetworkName('r1')).toBe('dh-r1-net')
    expect(androidControlNetworkName('r1')).toBe('dh-r1-android-control-net')
    expect(androidRuntimeAnchorName('r1')).toBe('dh-r1-android-runtime-anchor')
    expect(webName('r1')).toBe('dh-r1-web')
    expect(srcVolume('r1')).toBe('dh-r1-src')
    expect(depsVolume('r1', '22')).toBe('dh-r1-deps-node22')
    expect(cacheVolume('r1')).toBe('dh-r1-cache')
    expect(webImage('22')).toBe('node:22-bookworm')
    expect(ANCHOR_IMAGE).toBe('alpine/socat')
    expect(RELAY_PORT).toBe(3999)
  })
})

describe('buildRoomNetworkCreateArgs', () => {
  it('creates a labeled user-defined bridge owned by one Room', () => {
    expect(buildRoomNetworkCreateArgs('r1')).toEqual([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      '--label',
      'devhotel.room=r1',
      '--label',
      'devhotel.role=network',
      '--label',
      'devhotel.managed=1',
      'dh-r1-net',
    ])
  })

  it('creates a separately owned Android control bridge', () => {
    expect(buildAndroidControlNetworkCreateArgs('r1')).toEqual([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      '--label',
      'devhotel.room=r1',
      '--label',
      'devhotel.role=network',
      '--label',
      'devhotel.managed=1',
      'dh-r1-android-control-net'
    ])
  })
})

describe('buildAnchorArgs', () => {
  it('gates the loopback-published relay with only a token verifier in the container', () => {
    const verifier = 'b'.repeat(64)
    const args = buildAnchorArgs({ roomId: 'r1', internalPort: 5173 }, verifier)
    expect(args).toEqual(
      expect.arrayContaining([
        '--network',
        'dh-r1-net',
        '--cap-drop',
        'NET_RAW',
        '-p',
        '127.0.0.1:0:3999',
        '-e',
        `DEVHOTEL_RELAY_TOKEN_SHA256=${verifier}`,
        '-e',
        'DEVHOTEL_INTERNAL_PORT=5173',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat',
        'TCP-LISTEN:3999,fork,reuseaddr'
      ])
    )
    expect(args.at(-1)).toBe('EXEC:/tmp/devhotel-relay-gate')
    expect(args).toContain(
      `umask 077; printf '#!/bin/sh\n%s\n' "$DEVHOTEL_RELAY_GATE" > /tmp/devhotel-relay-gate; chmod 500 /tmp/devhotel-relay-gate; exec socat "$0" "$1"`
    )
    const gate = args.find((arg) => arg.startsWith('DEVHOTEL_RELAY_GATE=')) ?? ''
    expect(gate).toContain('read -r -t 2 line')
    expect(gate).toContain('sha256sum')
    expect(gate).toContain('while [ "$i" -lt 64 ]')
    expect(gate).not.toContain('b'.repeat(64).replace(/^/, 'DEVHOTEL/1 '))
  })

  it('rejects malformed relay verifiers before creating a container', () => {
    expect(() => buildAnchorArgs({ roomId: 'r1', internalPort: 5173 }, 'not-a-digest')).toThrow(
      /relay verifier/
    )
  })

  it('places the Android relay anchor on the dedicated control bridge', () => {
    const args = buildAnchorArgs(
      { roomId: 'r1', internalPort: 6080, androidRuntimeIsolation: true },
      'b'.repeat(64),
      androidControlNetworkName('r1')
    )
    expect(args).toEqual(expect.arrayContaining(['--network', 'dh-r1-android-control-net']))
    expect(args).not.toContain('dh-r1-net')
  })
})

describe('Android runtime namespace', () => {
  it('keeps the unpublished runtime leader and user workloads off the control bridge', () => {
    const runtime = buildAndroidRuntimeAnchorArgs('r1')
    expect(runtime).toEqual(expect.arrayContaining([
      '--name', 'dh-r1-android-runtime-anchor',
      '--network', 'dh-r1-net',
      '--cap-drop', 'ALL',
      '--read-only',
      'devhotel.role=android-runtime-anchor'
    ]))
    expect(runtime).not.toContain('dh-r1-android-control-net')

    const web = buildWebCreateArgs(spec({ androidRuntimeIsolation: true }))
    expect(web).toEqual(expect.arrayContaining([
      '--network', 'container:dh-r1-android-runtime-anchor'
    ]))
    expect(web).not.toContain('container:dh-r1-anchor')

    const service = buildServiceArgs(
      'r1',
      'redis',
      '8',
      androidRuntimeAnchorName('r1'),
      '11111111-1111-4111-8111-111111111111'
    )
    expect(service).toEqual(expect.arrayContaining([
      '--network', 'container:dh-r1-android-runtime-anchor',
      'devhotel.creation-token=11111111-1111-4111-8111-111111111111'
    ]))
    expect(service).not.toContain('container:dh-r1-anchor')
  })

  it('pins the full network authority generation on every joined workload', () => {
    const authority = {
      id: 'a'.repeat(64),
      sandboxId: 'b'.repeat(64),
      startedAt: '2026-09-02T00:00:00.123456789Z'
    }
    const expectedLabels = [
      `${NETWORK_AUTHORITY_SANDBOX_LABEL}=${authority.sandboxId}`,
      `${NETWORK_AUTHORITY_STARTED_AT_LABEL}=${authority.startedAt}`
    ]
    const web = buildWebCreateArgs(spec({ androidRuntimeIsolation: true }), authority)
    const emulator = buildEmulatorArgs(
      'r1',
      { device: 'Samsung Galaxy S10', version: '14.0' },
      {
        networkNamespace: authority.id,
        networkAuthoritySandboxId: authority.sandboxId,
        networkAuthorityStartedAt: authority.startedAt
      }
    )
    const service = buildServiceArgs(
      'r1',
      'redis',
      '8',
      authority.id,
      '11111111-1111-4111-8111-111111111111',
      authority.sandboxId,
      authority.startedAt
    )

    for (const args of [web, emulator, service]) {
      const network = args.indexOf('--network')
      expect(args[network + 1]).toBe(`container:${authority.id}`)
      const labels = args.flatMap((arg, index) => arg === '-l' ? [args[index + 1] ?? ''] : [])
      expect(labels).toEqual(expect.arrayContaining(expectedLabels))
    }
  })
})

describe('buildWebCreateArgs', () => {
  it('managed-git mounts src volume, deps volume, cache volume', () => {
    const args = buildWebCreateArgs(spec())
    expect(args[0]).toBe('create')
    expect(mounts(args)).toEqual([
      'dh-r1-src:/workspace',
      'dh-r1-deps-node22:/workspace/node_modules',
      'dh-r1-cache:/cache',
    ])
  })

  it('linked-folder bind-mounts the host path with deps volume overlay', () => {
    const args = buildWebCreateArgs(
      spec({ sourceType: 'linked-folder', sourceRef: 'C:\\proj\\app', workspaceMode: 'legacy-host-bind' })
    )
    expect(mounts(args)).toEqual([
      'C:\\proj\\app:/workspace',
      'dh-r1-deps-node22:/workspace/node_modules',
      'dh-r1-cache:/cache',
    ])
  })

  it('empty source has no src mount and no deps volume, cache only', () => {
    const args = buildWebCreateArgs(spec({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty' }))
    expect(mounts(args)).toEqual(['dh-r1-cache:/cache'])
  })

  it('joins the anchor network namespace', () => {
    const args = buildWebCreateArgs(spec())
    const i = args.indexOf('--network')
    expect(args[i + 1]).toBe('container:dh-r1-anchor')
    expect(args).not.toContain('--pid')
    expect(args).toContain('NET_RAW')
    expect(args.some((arg) => arg.startsWith('DEVHOTEL_RELAY_'))).toBe(false)
  })

  it('puts standalone build containers on their owned Room network', () => {
    const args = buildWebCreateArgs(spec({ standalone: true }))
    const i = args.indexOf('--network')
    expect(args[i + 1]).toBe('dh-r1-net')
    expect(args).not.toContain('container:dh-r1-anchor')
  })

  it('creates (not runs) the emulator in the anchor netns on the phone-sized screen', () => {
    const args = buildEmulatorArgs('r1', { device: 'Samsung Galaxy S10', version: '14.0' })
    expect(args[0]).toBe('create')
    expect(args).not.toContain('-d')
    const net = args.indexOf('--network')
    expect(args[net + 1]).toBe('container:dh-r1-anchor')
    expect(args).toContain('SCREEN_WIDTH=540')
    expect(args).toContain('SCREEN_HEIGHT=1140')
    expect(args).toContain('EMULATOR_DEVICE=Samsung Galaxy S10')
    expect(args).toContain('EMULATOR_CONFIG_PATH=/home/androidusr/devhotel-avd-override.ini')
    expect(args).toContain('EMULATOR_ADDITIONAL_ARGS=-no-boot-anim -skip-adb-auth')
  })

  it('rotates the X screen and AVD orientation for landscape emulators', () => {
    const args = buildEmulatorArgs('r1', { device: 'Samsung Galaxy S10', version: '14.0', orientation: 'landscape' })
    expect(args).toContain('SCREEN_WIDTH=1140')
    expect(args).toContain('SCREEN_HEIGHT=540')
    // the panel itself must be landscape-shaped: Android reads its orientation
    // from the panel, and qemu keeps the panel aspect no matter the X screen
    const land = emulatorAvdOverride('Samsung Galaxy S10', 'balanced', 'landscape')
    expect(land).toContain('hw.lcd.width=2280')
    expect(land).toContain('hw.lcd.height=1080')
    expect(land).toContain('hw.initialOrientation=landscape')
    // native resolution still has to swap the axes, or landscape does nothing
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'native', 'landscape')).toContain('hw.lcd.width=3040')
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'balanced', 'portrait')).not.toContain('hw.initialOrientation')
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'balanced', 'portrait')).toContain('hw.lcd.width=1080')
    // portrait stays the default
    expect(buildEmulatorArgs('r1', { device: 'Samsung Galaxy S10', version: '14.0' })).toContain('SCREEN_WIDTH=540')
  })

  it('scales the guest LCD per resolution preset for software rendering speed', () => {
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'balanced')).toContain('hw.lcd.width=1080')
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'balanced')).toContain('hw.lcd.height=2280')
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'fast')).toContain('hw.lcd.width=720')
    expect(emulatorAvdOverride('Nexus 5', 'fast')).toContain('hw.lcd.height=960')
    expect(emulatorAvdOverride('Samsung Galaxy S10', 'native')).not.toContain('hw.lcd')
    // default preset is 'balanced'
    expect(emulatorAvdOverride('Samsung Galaxy S10')).toContain('hw.lcd.width=1080')
  })

  it('carries the devhotel labels', () => {
    const args = buildWebCreateArgs(spec())
    const labels = args.flatMap((a, i) => (a === '-l' ? [args[i + 1] ?? ''] : []))
    expect(labels).toEqual(['devhotel.room=r1', 'devhotel.role=web', 'devhotel.managed=1'])
  })

  it('sets cache env, passes extra env, and never sets CI', () => {
    const args = buildWebCreateArgs(spec({ env: { FOO: 'bar' } }))
    expect(envs(args)).toEqual(['npm_config_cache=/cache/npm', 'PNPM_HOME=/cache/pnpm', 'FOO=bar'])
    expect(envs(args).some((e) => e.startsWith('CI='))).toBe(false)
  })

  it('wraps the start command with a tolerant corepack enable and exec', () => {
    const args = buildWebCreateArgs(spec())
    expect(args.slice(-3)).toEqual([
      'sh',
      '-lc',
      wrapStartCommand('npm run dev'),
    ])
    expect(args).toContain('node:22-bookworm')
    const w = args.indexOf('-w')
    expect(args[w + 1]).toBe('/workspace')
  })
})

describe('buildOneShotArgs', () => {
  const jobId = '11111111-2222-4333-8444-555555555555'

  it('uses run --rm with the same mounts and env as the web container', () => {
    const web = buildWebCreateArgs(spec())
    const oneShot = buildOneShotArgs(spec(), 'npm install', jobId)
    expect(oneShot.slice(0, 2)).toEqual(['run', '--rm'])
    expect(mounts(oneShot)).toEqual(mounts(web))
    expect(envs(oneShot)).toEqual(envs(web))
    const network = oneShot.indexOf('--network')
    expect(oneShot[network + 1]).toBe('dh-r1-net')
    expect(oneShot).toContain('NET_RAW')
    expect(oneShot).toContain(jobName('r1', jobId))
    expect(oneShot.flatMap((arg, i) => arg === '-l' ? [oneShot[i + 1]] : [])).toContain('devhotel.role=job')
    expect(oneShot).not.toContain('devhotel.role=web')
    const entrypoint = oneShot.indexOf('--entrypoint')
    expect(oneShot.slice(entrypoint, entrypoint + 3)).toEqual(['--entrypoint', '/bin/sh', 'node:22-bookworm'])
    expect(oneShot.slice(-2)).toEqual(['-lc', wrapStartCommand('npm install')])
  })

  it('overrides image entrypoints so a completed one-shot cannot remain alive behind an image supervisor', () => {
    const oneShot = buildOneShotArgs(spec({ imageOverride: 'budtmo/docker-android:emulator_14.0' }), 'printf done', jobId)
    const image = oneShot.indexOf('budtmo/docker-android:emulator_14.0')
    expect(oneShot.slice(image - 2, image + 3)).toEqual([
      '--entrypoint',
      '/bin/sh',
      'budtmo/docker-android:emulator_14.0',
      '-lc',
      wrapStartCommand('printf done'),
    ])
  })

  it('preserves compound shell programs behind a PID-1 inner shell', () => {
    const command = "if [ -f ./gradlew ]; then sh ./gradlew assembleDebug --no-daemon; else gradle assembleDebug --no-daemon; fi"
    const wrapped = wrapStartCommand(command)
    expect(wrapped).toContain("exec sh -lc 'if [ -f ./gradlew ]; then")
    expect(wrapped).not.toContain('exec if ')
    expect(buildOneShotArgs(spec({ standalone: true }), command, jobId).slice(-1)).toEqual([wrapped])
  })

  it('shell-quotes apostrophes in Room commands', () => {
    expect(wrapStartCommand("printf '%s\\n' ok")).toContain(`exec sh -lc 'printf '"'"'%s\\n'"'"' ok'`)
  })

  it('keeps standalone one-shots off Docker default bridge', () => {
    const args = buildOneShotArgs(spec({ standalone: true }), 'gradle tasks', jobId)
    const network = args.indexOf('--network')
    expect(args[network + 1]).toBe('dh-r1-net')
  })

  it('mounts an immutable build snapshot instead of the live workspace', () => {
    const operationId = '11111111-2222-4333-8444-555555555555'
    const snapshot = workspaceSnapshotVolume('r1', operationId)
    const args = buildOneShotArgs(
      spec({ workspaceVolumeOverride: snapshot, standalone: true, noCacheVolume: true, extraVolumes: [] }),
      'gradle assembleDebug',
      jobId
    )
    expect(args).toContain(`${snapshot}:/workspace`)
    expect(args).not.toContain('dh-r1-src:/workspace')
    expect(args).not.toContain('dh-r1-cache:/cache')
    expect(() => workspaceSnapshotVolume('r1', '../escape')).toThrow(/invalid workspace snapshot operation ID/)
  })

  it('uses a strict Room-scoped UUID job name', () => {
    const name = jobName('r1', jobId)
    expect(name).toBe('dh-r1-job-11111111222243338444555555555555')
    expect(isJobName('r1', name)).toBe(true)
    expect(isJobName('r2', name)).toBe(false)
    expect(isJobName('r1', 'dh-r1-job-not-a-uuid')).toBe(false)
    expect(() => jobName('r1', '../escape')).toThrow(/invalid one-shot job ID/)
  })
})

describe('parsePortOutput', () => {
  it('parses a single ipv4 line', () => {
    expect(parsePortOutput('127.0.0.1:54321\n')).toBe(54321)
  })

  it('prefers the ipv4 loopback line in dual-line ipv6 output', () => {
    expect(parsePortOutput('[::1]:54321\n127.0.0.1:54322\n')).toBe(54322)
    expect(parsePortOutput('127.0.0.1:54322\n[::1]:54321')).toBe(54322)
  })

  it('falls back to any port-suffixed line', () => {
    expect(parsePortOutput('0.0.0.0:49153\n')).toBe(49153)
  })

  it('throws on garbage', () => {
    expect(() => parsePortOutput('')).toThrow()
    expect(() => parsePortOutput('no ports here')).toThrow()
  })
})
