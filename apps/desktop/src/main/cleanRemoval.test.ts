import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanRemovalCoordinatorScript,
  cleanRemovalConfirmation,
  encodedCleanRemovalCoordinatorCommand,
  ensureDataOwnership,
  isTrustedRendererUrl,
  launchCleanRemovalCoordinator,
  type CleanRemovalCoordinatorInput,
  validateCleanRemovalUninstaller,
  validateCleanRemovalTarget
} from './cleanRemoval'

const roots: string[] = []

function tempRoot(): string {
  const root = join(process.cwd(), `.clean-removal-test-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function coordinatorFixture(): CleanRemovalCoordinatorInput {
  const appData = tempRoot()
  const target = join(appData, 'DevHotel')
  const ownershipId = ensureDataOwnership(target)
  const installDir = join(tempRoot(), 'program')
  mkdirSync(installDir)
  const uninstaller = join(installDir, 'Uninstall DevHotel.exe')
  writeFileSync(uninstaller, 'test executable placeholder')
  return {
    parentPid: process.pid,
    appData,
    target,
    ownershipId,
    uninstaller,
    failureLog: join(appData, 'DevHotel-cleanup-error.log')
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('clean-removal safety helpers', () => {
  it('requires the exact canonical DevHotel directory and the process-bound ownership id', () => {
    const appData = tempRoot()
    const userData = join(appData, 'DevHotel')
    const owner = ensureDataOwnership(userData)

    expect(validateCleanRemovalTarget(userData, appData, owner)).toBe(userData)
    expect(() => validateCleanRemovalTarget(join(appData, 'Other'), appData, owner)).toThrow(/unexpected app-data path/)
    expect(() => validateCleanRemovalTarget(userData, appData, '00000000-0000-4000-8000-000000000000')).toThrow(
      /ownership changed/
    )
  })

  it('refuses a child junction rather than scheduling recursive traversal', () => {
    const appData = tempRoot()
    const userData = join(appData, 'DevHotel')
    const outside = join(appData, 'outside')
    mkdirSync(outside)
    const owner = ensureDataOwnership(userData)
    symlinkSync(outside, join(userData, 'redirected'), 'junction')

    expect(() => validateCleanRemovalTarget(userData, appData, owner)).toThrow(/reparse point/)
  })

  it('binds IPC to the expected renderer origin and makes cancellation the default', () => {
    const packagedUrl = 'file:///C:/Program%20Files/DevHotel/index.html'
    expect(isTrustedRendererUrl(packagedUrl, true, undefined, packagedUrl)).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/Users/me/evil.html', true, undefined, packagedUrl)).toBe(false)
    expect(isTrustedRendererUrl('https://attacker.test/', true, undefined, packagedUrl)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/settings', false, 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/settings', false, 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl(packagedUrl, false, undefined, packagedUrl)).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/Users/me/evil.html', false, undefined, packagedUrl)).toBe(false)
    const options = cleanRemovalConfirmation(3)
    expect(options.cancelId).toBe(0)
    expect(options.defaultId).toBe(0)
    expect(options.buttons[1]).toContain('3 Rooms')
  })

  it('validates one exact regular uninstaller inside the install directory', () => {
    const fixture = coordinatorFixture()
    expect(validateCleanRemovalUninstaller(join(fixture.uninstaller, '..'), 'Uninstall DevHotel.exe')).toBe(
      fixture.uninstaller
    )
    expect(() => validateCleanRemovalUninstaller(join(fixture.uninstaller, '..'), '..\\Uninstall DevHotel.exe')).toThrow(
      /name is invalid/
    )
  })

  it('uses one coordinator with a bounded PID wait before the silent uninstaller', () => {
    const input = coordinatorFixture()
    const script = cleanRemovalCoordinatorScript(input)
    const decoded = Buffer.from(encodedCleanRemovalCoordinatorCommand(input), 'base64').toString('utf16le')
    expect(decoded).toBe(script)
    expect(script).toContain('$parent.WaitForExit($parentExitTimeoutMs)')
    expect(script).toContain('Timed out waiting for DevHotel process')
    expect(script).toContain("Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru")
    expect(script.indexOf('$parent.WaitForExit')).toBeLessThan(script.indexOf('Start-Process -FilePath $uninstaller'))
  })

  it('checks uninstaller success before deleting the exact owned target and logs failures outside it', () => {
    const input = coordinatorFixture()
    const script = cleanRemovalCoordinatorScript(input)
    expect(script).toContain('if ($uninstall.ExitCode -ne 0)')
    expect(script).toContain('DevHotel uninstaller failed with exit code')
    expect(script.indexOf('if ($uninstall.ExitCode -ne 0)')).toBeLessThan(
      script.indexOf('Remove-Item -LiteralPath $target -Recurse')
    )
    expect(dirname(input.failureLog)).toBe(input.appData)
    expect(script).toContain(`$failureLog = '${input.failureLog.replaceAll("'", "''")}'`)
    expect(script).toContain('Set-Content -LiteralPath $failureLog')
  })

  it('rejects a coordinator spawn error instead of reporting removal as scheduled', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const scheduled = launchCleanRemovalCoordinator(
      coordinatorFixture(),
      () => child as unknown as ChildProcess
    )
    child.emit('error', new Error('spawn ENOENT'))

    await expect(scheduled).rejects.toThrow(/clean-removal coordinator.*spawn ENOENT/)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('does not resolve until the detached coordinator emits spawn', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    let resolved = false
    const scheduled = launchCleanRemovalCoordinator(
      coordinatorFixture(),
      () => child as unknown as ChildProcess
    ).then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('spawn')
    await scheduled
    expect(child.unref).toHaveBeenCalledTimes(1)
  })
})
