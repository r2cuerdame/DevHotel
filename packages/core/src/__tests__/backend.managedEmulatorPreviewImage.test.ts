import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MANAGED_EMULATOR_PREVIEW_BASE_IMAGE,
  MANAGED_EMULATOR_PREVIEW_DOCKERFILE,
  MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256,
  MANAGED_EMULATOR_PREVIEW_IMAGE_REF,
  MANAGED_EMULATOR_PREVIEW_REPOSITORY,
  MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL,
  buildManagedEmulatorPreviewBuildArgs,
  managedEmulatorPreviewImageIsUsable,
  managedEmulatorPreviewInspectArgs,
  managedEmulatorPreviewStageDir
} from '../backend/managedEmulatorPreviewImage'
import { MANAGED_EMULATOR_PREVIEW_IMAGE } from '../backend/androidEmulatorLaunch'
import { MANAGED_RUNTIME_GUEST_STAGE_ROOT } from '../backend/managedRuntimeGuestAgent'
import { ManagedRoomBackend } from '../backend/managedRoomBackend'
import { ManagedRuntimeIngress } from '../backend/managedRuntimeIngress'
import type { ManagedRuntimeEngine } from '../backend/managedRuntimeEngine'
import type { ExecResult } from '../backend/types'
import type { RunDockerOpts } from '../backend/cli'

const COMMITTED_DOCKERFILE = resolve(__dirname, '../../../../images/android-emulator-preview/Dockerfile')

describe('the embedded Dockerfile tracks the committed one', () => {
  it('is byte-identical to images/android-emulator-preview/Dockerfile', () => {
    // Normalised to LF because a Windows checkout with core.autocrlf=true holds
    // the same Dockerfile with different bytes. The embedded copy is always LF,
    // which is what keeps the content-addressed tag the same on every platform.
    const onDisk = readFileSync(COMMITTED_DOCKERFILE, 'utf8').replace(/\r\n/g, '\n')
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE).toBe(onDisk)
  })

  it('kept the line continuations a cooked template literal would have eaten', () => {
    // String.raw is load-bearing here: in a plain template literal a backslash
    // followed by a newline is a line continuation that deletes the newline, so
    // the apt-get block would silently collapse into one line with no separator.
    // This asserts the trap did not spring rather than trusting that it did not.
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE).toContain('apt-get update -qq \\\n')
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE).not.toContain('apt-get update -qq     &&')
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE.split('\n').length).toBeGreaterThan(50)
  })

  it('builds from the anonymously pullable base image the pin names', () => {
    // The whole no-credentials claim rests on this layer being fetchable without
    // a login, so the FROM and the constant have to agree.
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE).toContain(`FROM ${MANAGED_EMULATOR_PREVIEW_BASE_IMAGE}`)
    expect(MANAGED_EMULATOR_PREVIEW_BASE_IMAGE).toMatch(/^ubuntu:22\.04@sha256:[a-f0-9]{64}$/)
  })

  it('reads nothing from the build context', () => {
    // buildManagedEmulatorPreviewBuildArgs sends a directory holding only the
    // Dockerfile. That is only honest while the Dockerfile has no COPY/ADD.
    const instructions = MANAGED_EMULATOR_PREVIEW_DOCKERFILE.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(COPY|ADD)\s/i.test(line))
    expect(instructions).toEqual([])
  })
})

describe('the image reference is content-addressed and local', () => {
  it('names the Dockerfile digest it was built from', () => {
    const expected = createHash('sha256').update(MANAGED_EMULATOR_PREVIEW_DOCKERFILE, 'utf8').digest('hex')
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256).toBe(expected)
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE_REF).toBe(
      `${MANAGED_EMULATOR_PREVIEW_REPOSITORY}:${expected.slice(0, 12)}`
    )
  })

  it('names no registry at all', () => {
    // This is the #111 blocker in one assertion: a clean Windows VM has no
    // credential, so the managed emulator path must not reference a registry
    // that could ask for one.
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE_REF).not.toContain('ghcr.io')
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE_REF).not.toContain('docker.io')
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE_REF).not.toContain('@sha256:')
  })

  it('is still not docker-android', () => {
    // #136's contract, which this change must not regress on its way past GHCR.
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE_REF).not.toContain('budtmo')
    expect(MANAGED_EMULATOR_PREVIEW_DOCKERFILE).not.toContain('budtmo')
  })

  it('is the reference the emulator launch path actually uses', () => {
    expect(MANAGED_EMULATOR_PREVIEW_IMAGE).toBe(MANAGED_EMULATOR_PREVIEW_IMAGE_REF)
  })

  it('is what the inspect probe asks about', () => {
    const args = managedEmulatorPreviewInspectArgs()
    expect(args.slice(0, 2)).toEqual(['image', 'inspect'])
    expect(args[args.length - 1]).toBe(MANAGED_EMULATOR_PREVIEW_IMAGE_REF)
    expect(args[args.indexOf('--format') + 1]).toContain(MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL)
  })
})

describe('buildManagedEmulatorPreviewBuildArgs', () => {
  const stageDir = `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/android-emulator-preview-t`

  it('builds the staged Dockerfile into the content-addressed tag', () => {
    const args = buildManagedEmulatorPreviewBuildArgs(stageDir)
    expect(args[0]).toBe('build')
    expect(args[args.indexOf('--file') + 1]).toBe(`${stageDir}/Dockerfile`)
    expect(args[args.indexOf('--tag') + 1]).toBe(MANAGED_EMULATOR_PREVIEW_IMAGE_REF)
    expect(args[args.length - 1]).toBe(stageDir)
  })

  it('stamps the Dockerfile digest into a label so a cache hit can be proved', () => {
    const args = buildManagedEmulatorPreviewBuildArgs(stageDir)
    expect(args).toContain(`${MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL}=${MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256}`)
    expect(args).toContain('devhotel.managed=1')
    expect(args).toContain('devhotel.image=android-emulator-preview')
  })

  it('never pulls', () => {
    expect(buildManagedEmulatorPreviewBuildArgs(stageDir)).not.toContain('pull')
  })
})

describe('managedEmulatorPreviewImageIsUsable', () => {
  it('accepts exactly the digest the build stamped', () => {
    expect(managedEmulatorPreviewImageIsUsable(MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256)).toBe(true)
    expect(managedEmulatorPreviewImageIsUsable(`${MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256}\n`)).toBe(true)
  })

  it('refuses the shapes Docker prints for an image that cannot prove itself', () => {
    // `--format {{index .Config.Labels "..."}}` prints "<no value>" when the
    // label is missing and an empty line when it is set to "". Neither is the
    // digest, and a tag by itself proves nothing about what is under it.
    expect(managedEmulatorPreviewImageIsUsable('<no value>')).toBe(false)
    expect(managedEmulatorPreviewImageIsUsable('')).toBe(false)
    expect(managedEmulatorPreviewImageIsUsable('   ')).toBe(false)
    expect(managedEmulatorPreviewImageIsUsable('f'.repeat(64))).toBe(false)
  })
})

describe('ManagedRoomBackend.ensureEmulatorPreviewImage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-preview-image-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function engineWith(answers: (args: string[]) => ExecResult | null) {
    const runs: string[][] = []
    const puts: { hostPath: string; guestPath: string }[] = []
    const engine = {
      endpoint: 'managed-linux:test-runtime',
      runs,
      puts,
      run: async (args: string[], _opts?: RunDockerOpts): Promise<ExecResult> => {
        runs.push(args)
        return answers(args) ?? { code: 0, stdout: '', stderr: '' }
      },
      spawn: () => {
        throw new Error('not used')
      },
      putFile: async (hostPath: string, guestPath: string) => {
        puts.push({ hostPath, guestPath })
      },
      getFile: async () => undefined
    }
    return engine as unknown as ManagedRuntimeEngine & typeof engine
  }

  function backendWith(engine: ReturnType<typeof engineWith>) {
    const backend = new ManagedRoomBackend({
      engine,
      ingress: new ManagedRuntimeIngress(),
      guestAddress: '172.30.1.5',
      identityFile: join(dir, 'engine.json')
    })
    // Reading a private member is the point: this is the seam that decides
    // whether the runtime reaches a registry at all.
    return backend as unknown as { ensureEmulatorPreviewImage(): Promise<void> }
  }

  const labelled = (digest: string): ExecResult => ({ code: 0, stdout: `${digest}\n`, stderr: '' })

  it('builds nothing when the runtime already holds the image it expects', async () => {
    const engine = engineWith((args) =>
      args[0] === 'image' ? labelled(MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256) : null
    )
    await backendWith(engine).ensureEmulatorPreviewImage()

    expect(engine.runs.map((args) => args[0])).not.toContain('build')
    expect(engine.puts).toEqual([])
  })

  it('builds the image from the staged Dockerfile when it is absent', async () => {
    let built = false
    const engine = engineWith((args) => {
      if (args[0] === 'build') {
        built = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'image') {
        return built
          ? labelled(MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256)
          : { code: 1, stdout: '', stderr: 'No such image' }
      }
      return null
    })
    await backendWith(engine).ensureEmulatorPreviewImage()

    const build = engine.runs.find((args) => args[0] === 'build')
    expect(build).toBeDefined()
    // The Dockerfile crossed the hypervisor boundary explicitly: a Host path
    // handed to the guest engine would have resolved inside the guest.
    expect(engine.puts).toHaveLength(1)
    expect(engine.puts[0]!.guestPath).toMatch(/^android-emulator-preview-[0-9a-f-]+\/Dockerfile$/)
    const stageDir = engine.puts[0]!.guestPath.replace(/\/Dockerfile$/, '')
    expect(build![build!.indexOf('--file') + 1]).toBe(
      `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${stageDir}/Dockerfile`
    )
    expect(build![build!.length - 1]).toBe(`${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${stageDir}`)
  })

  it('rebuilds over a tag whose label does not prove it is ours', async () => {
    // A tag is not evidence. Something else sitting on DevHotel's tag is
    // replaced by a build, never adopted.
    let built = false
    const engine = engineWith((args) => {
      if (args[0] === 'build') {
        built = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'image') {
        return built ? labelled(MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256) : labelled('f'.repeat(64))
      }
      return null
    })
    await backendWith(engine).ensureEmulatorPreviewImage()

    expect(engine.runs.map((args) => args[0])).toContain('build')
  })

  it('fails with the build output when the build fails', async () => {
    const engine = engineWith((args) => {
      if (args[0] === 'build') return { code: 1, stdout: '', stderr: 'no space left on device' }
      if (args[0] === 'image') return { code: 1, stdout: '', stderr: 'No such image' }
      return null
    })
    await expect(backendWith(engine).ensureEmulatorPreviewImage()).rejects.toThrow(/no space left on device/)
  })

  it('refuses an image the build claims to have made but cannot prove', async () => {
    // A build that exits 0 without leaving a usable image fails here, where the
    // cause is still visible, rather than at docker create against a missing tag.
    const engine = engineWith((args) => {
      if (args[0] === 'build') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'image') return { code: 1, stdout: '', stderr: 'No such image' }
      return null
    })
    await expect(backendWith(engine).ensureEmulatorPreviewImage()).rejects.toThrow(
      /does not carry the expected Dockerfile digest/
    )
  })

  it('discards the staged Dockerfile even when the build fails', async () => {
    const engine = engineWith((args) => {
      if (args[0] === 'build') return { code: 1, stdout: '', stderr: 'boom' }
      if (args[0] === 'image') return { code: 1, stdout: '', stderr: 'No such image' }
      return null
    })
    await expect(backendWith(engine).ensureEmulatorPreviewImage()).rejects.toThrow()

    const cleanup = engine.runs.find((args) => args[0] === 'run' && args.includes('--rm'))
    expect(cleanup).toBeDefined()
    expect(cleanup!.join(' ')).toContain('android-emulator-preview-')
  })
})

describe('managedEmulatorPreviewStageDir', () => {
  it('stays inside the staging root and carries the token', () => {
    const dirName = managedEmulatorPreviewStageDir('abc-123')
    expect(dirName).toBe('android-emulator-preview-abc-123')
    expect(dirName).not.toContain('..')
    expect(dirName.startsWith('/')).toBe(false)
  })
})
