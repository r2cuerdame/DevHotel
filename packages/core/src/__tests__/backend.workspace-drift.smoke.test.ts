import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { srcVolume } from '../backend/naming'
import { importHostFolderScript, OciCliBackend } from '../backend/ociCli'
import { diffWorkspaceSnapshots } from '../workspaceDrift'

const ROOM_ID = 'drifttst'
const SOURCE_VOLUME = srcVolume(ROOM_ID, 1)

function write(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('Windows linked-folder to Linux Room drift', () => {
  const backend = new OciCliBackend()
  const source = mkdtempSync(join(tmpdir(), 'devhotel-drift-source-'))

  beforeAll(async () => {
    await runDocker(['volume', 'rm', '-f', SOURCE_VOLUME])
    write(source, '.devhotel-sync-include', 'app/build/generated/\r\n')
    write(source, 'app/src/main/java/App.kt', 'class App\n')
    write(source, 'app/build/generated/tracked.txt', 'tracked generated input\n')
    write(source, 'app/build/outputs/apk/debug/app-debug.apk', 'disposable apk\n')
    write(source, '.gradle/8.0/executionHistory.bin', 'disposable gradle state\n')
    write(source, '.git/HEAD', 'ref: refs/heads/main\n')
    write(source, '.git/index', 'initial index state\n')
    write(source, '.git/refs/heads/main', `${'1'.repeat(40)}\n`)
    write(source, '.git/objects/11/object', 'unreachable object data\n')
  })

  afterAll(async () => {
    await runDocker(['volume', 'rm', '-f', SOURCE_VOLUME])
    rmSync(source, { recursive: true, force: true })
  })

  it('ignores build-only changes, keeps an opted-in generated path, and reports only real source drift', async () => {
    await backend.importHostFolder(ROOM_ID, source, 1)
    const baseline = await backend.snapshotWorkspace(ROOM_ID, 1)
    expect(baseline.entries.map((entry) => entry.path)).toEqual([
      '.devhotel-sync-include',
      'app/build/generated/tracked.txt',
      'app/src/main/java/App.kt'
    ])
    const transactionBaseline = await backend.fingerprintWorkspace(ROOM_ID, 1)

    const mutate = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE_VOLUME}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      "mkdir -p /workspace/.gradle/new /workspace/app/build/outputs/apk/debug /workspace/.git/objects/22; printf disposable > /workspace/.gradle/new/cache.bin; printf apk > /workspace/app/build/outputs/apk/debug/new.apk; printf object > /workspace/.git/objects/22/object"
    ])
    expect(mutate.code, mutate.stderr).toBe(0)
    const buildOnly = await backend.snapshotWorkspace(ROOM_ID, 1)
    expect(buildOnly).toEqual(baseline)
    await expect(backend.fingerprintWorkspace(ROOM_ID, 1)).resolves.toBe(transactionBaseline)

    const optedInEdit = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE_VOLUME}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      "printf 'changed generated input\\n' > /workspace/app/build/generated/tracked.txt"
    ])
    expect(optedInEdit.code, optedInEdit.stderr).toBe(0)
    await expect(backend.fingerprintWorkspace(ROOM_ID, 1)).resolves.not.toBe(transactionBaseline)
    expect(diffWorkspaceSnapshots(baseline, await backend.snapshotWorkspace(ROOM_ID, 1))).toEqual([
      { path: 'app/build/generated/tracked.txt', reason: 'modified' }
    ])

    const restoreOptedIn = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE_VOLUME}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      "printf 'tracked generated input\\n' > /workspace/app/build/generated/tracked.txt"
    ])
    expect(restoreOptedIn.code, restoreOptedIn.stderr).toBe(0)
    await expect(backend.fingerprintWorkspace(ROOM_ID, 1)).resolves.toBe(transactionBaseline)

    const gitControlEdit = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE_VOLUME}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      `printf 'changed index state\\n' > /workspace/.git/index; printf '${'2'.repeat(40)}\\n' > /workspace/.git/refs/heads/main`
    ])
    expect(gitControlEdit.code, gitControlEdit.stderr).toBe(0)
    await expect(backend.fingerprintWorkspace(ROOM_ID, 1)).resolves.not.toBe(transactionBaseline)
    await expect(backend.snapshotWorkspace(ROOM_ID, 1)).resolves.toEqual(baseline)

    const edit = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE_VOLUME}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      "printf 'class AppChanged\\n' > /workspace/app/src/main/java/App.kt; printf more-build-output > /workspace/app/build/outputs/extra.bin"
    ])
    expect(edit.code, edit.stderr).toBe(0)
    const mixed = await backend.snapshotWorkspace(ROOM_ID, 1)
    expect(diffWorkspaceSnapshots(baseline, mixed)).toEqual([
      { path: 'app/src/main/java/App.kt', reason: 'modified' }
    ])
  }, 120_000)
})

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('.devhotel-sync-include Host boundary', () => {
  const SOURCE = 'dh-drifttst-include-source'
  const TARGET = 'dh-drifttst-include-target'

  beforeAll(async () => {
    await runDocker(['volume', 'rm', '-f', SOURCE])
    await runDocker(['volume', 'rm', '-f', TARGET])
    // A linked Host folder whose `app/build` is a symlink pointing out of the
    // folder the human actually granted, plus an include entry that reaches
    // through it. Built inside Linux so the symlink is unambiguous.
    const seed = await runDocker([
      'run',
      '--rm',
      '-v',
      `${SOURCE}:/source`,
      'alpine',
      'sh',
      '-lc',
      [
        'set -eu',
        'mkdir -p /source/app /outside',
        "printf 'HOST SECRET OUTSIDE THE LINKED FOLDER\n' > /outside/secret.txt",
        'ln -s /outside /source/app/build',
        "printf 'class App\n' > /source/app/App.kt",
        "printf 'app/build/secret.txt\n' > /source/.devhotel-sync-include"
      ].join('; ')
    ])
    expect(seed.code, seed.stderr).toBe(0)
  })

  afterAll(async () => {
    await runDocker(['volume', 'rm', '-f', SOURCE])
    await runDocker(['volume', 'rm', '-f', TARGET])
  })

  it('refuses an include entry that reaches outside the linked folder instead of copying it in', async () => {
    const imported = await runDocker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${SOURCE}:/source:ro`,
      '-v',
      `${TARGET}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      importHostFolderScript()
    ])

    expect(imported.code, `import unexpectedly succeeded: ${imported.stdout}`).not.toBe(0)
    expect(imported.stderr).toContain('.devhotel-sync-include')

    const leaked = await runDocker([
      'run',
      '--rm',
      '-v',
      `${TARGET}:/workspace`,
      'alpine',
      'sh',
      '-lc',
      "cat /workspace/app/build/secret.txt 2>/dev/null || echo NO-LEAK"
    ])
    expect(leaked.stdout).toContain('NO-LEAK')
    expect(leaked.stdout).not.toContain('HOST SECRET')
  }, 120_000)
})
