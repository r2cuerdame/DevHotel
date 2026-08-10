import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const OWNER_FILE = '.devhotel-owner.json'
const OWNER_SCHEMA = 1
const APP_ID = 'io.devhotel.app'
const APP_DATA_DIR = 'DevHotel'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PARENT_EXIT_TIMEOUT_MS = 45_000
const UNINSTALL_TIMEOUT_MS = 600_000

interface OwnerManifest {
  schema: number
  appId: string
  ownershipId: string
}

function readOwner(file: string): OwnerManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`DevHotel data ownership manifest is unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const owner = parsed as Partial<OwnerManifest>
  if (owner.schema !== OWNER_SCHEMA || owner.appId !== APP_ID || !UUID.test(owner.ownershipId ?? '')) {
    throw new Error('DevHotel data ownership manifest is invalid')
  }
  return owner as OwnerManifest
}

/** Creates once, then returns the process-bound identity for this data directory. */
export function ensureDataOwnership(userData: string): string {
  mkdirSync(userData, { recursive: true })
  const file = join(userData, OWNER_FILE)
  if (existsSync(file)) return readOwner(file).ownershipId

  const manifest: OwnerManifest = { schema: OWNER_SCHEMA, appId: APP_ID, ownershipId: randomUUID() }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return readOwner(file).ownershipId
}

function assertNoReparsePoints(root: string): void {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const stat = lstatSync(current)
    // On Windows, directory junctions and symbolic links are both surfaced as
    // symbolic links by lstat. Never hand one to a recursive removal command.
    if (stat.isSymbolicLink()) throw new Error(`Refusing to remove data containing a reparse point: ${current}`)
    if (!stat.isDirectory()) continue
    for (const entry of readdirSync(current)) pending.push(join(current, entry))
  }
}

/**
 * Revalidates the destructive target immediately before cleanup is scheduled.
 * Returns the canonical, exact DevHotel app-data directory on success.
 */
export function validateCleanRemovalTarget(userData: string, appData: string, expectedOwnershipId: string): string {
  const expected = resolve(appData, APP_DATA_DIR)
  const requested = resolve(userData)
  if (requested.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Refusing to remove unexpected app-data path: ${requested}`)
  }
  if (!existsSync(requested)) throw new Error(`DevHotel app-data path does not exist: ${requested}`)
  if (realpathSync.native(requested).toLowerCase() !== realpathSync.native(expected).toLowerCase()) {
    throw new Error(`Refusing to remove a redirected app-data path: ${requested}`)
  }
  assertNoReparsePoints(requested)
  const owner = readOwner(join(requested, OWNER_FILE))
  if (owner.ownershipId !== expectedOwnershipId) {
    throw new Error('DevHotel data ownership changed while the app was running')
  }
  return requested
}

export function isTrustedRendererUrl(
  url: string,
  packaged: boolean,
  developmentUrl?: string,
  packagedUrl?: string
): boolean {
  try {
    const actual = new URL(url)
    if (packaged) {
      if (actual.protocol !== 'file:' || !packagedUrl) return false
      const expected = new URL(packagedUrl)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    }
    if (!developmentUrl) {
      if (actual.protocol !== 'file:' || !packagedUrl) return false
      const expected = new URL(packagedUrl)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    }
    return actual.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}

export function cleanRemovalConfirmation(roomCount: number): {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
} {
  const rooms = `${roomCount} Room${roomCount === 1 ? '' : 's'}`
  return {
    type: 'warning',
    title: 'Remove DevHotel and all data?',
    message: `Permanently delete ${rooms} and uninstall DevHotel?`,
    detail:
      'This deletes Room containers, volumes, databases, backups and app data; removes DevHotel CA trust and autostart; then launches the uninstaller. This cannot be undone.',
    buttons: ['Cancel', `Delete ${rooms} & Uninstall`],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function validateCleanRemovalUninstaller(installDir: string, uninstallerName: string): string {
  if (uninstallerName !== uninstallerName.trim() || !/^Uninstall[^\\/]*\.exe$/i.test(uninstallerName)) {
    throw new Error('DevHotel uninstaller name is invalid')
  }
  const canonicalInstallDir = realpathSync.native(resolve(installDir))
  const candidate = resolve(canonicalInstallDir, uninstallerName)
  if (comparable(dirname(candidate)) !== comparable(canonicalInstallDir)) {
    throw new Error('DevHotel uninstaller escaped the install directory')
  }
  const stat = lstatSync(candidate)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('DevHotel uninstaller is not a regular file')
  const canonical = realpathSync.native(candidate)
  if (comparable(dirname(canonical)) !== comparable(canonicalInstallDir)) {
    throw new Error('DevHotel uninstaller resolved outside the install directory')
  }
  return canonical
}

export interface CleanRemovalCoordinatorInput {
  parentPid: number
  appData: string
  target: string
  ownershipId: string
  uninstaller: string
  failureLog: string
}

function validateCoordinatorInput(input: CleanRemovalCoordinatorInput): void {
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) throw new Error('Invalid DevHotel parent PID')
  if (!UUID.test(input.ownershipId)) throw new Error('Invalid DevHotel data ownership identity')
  if (comparable(input.target) !== comparable(join(input.appData, APP_DATA_DIR))) {
    throw new Error('Clean-removal coordinator target is not the exact DevHotel app-data directory')
  }
  if (comparable(input.failureLog) !== comparable(join(input.appData, 'DevHotel-cleanup-error.log'))) {
    throw new Error('Clean-removal failure log is not the exact out-of-target report path')
  }
  if (isWithin(input.target, input.failureLog)) {
    throw new Error('Clean-removal failure log must be outside the removal target')
  }
}

/**
 * PowerShell -EncodedCommand avoids ambiguous `-Command` parsing. One detached
 * coordinator owns the whole post-exit sequence, so the uninstaller and data
 * deletion cannot race each other.
 */
export function cleanRemovalCoordinatorScript(input: CleanRemovalCoordinatorInput): string {
  validateCoordinatorInput(input)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$parentPid = ${input.parentPid}`,
    `$appData = ${psLiteral(resolve(input.appData))}`,
    `$target = ${psLiteral(resolve(input.target))}`,
    `$ownershipId = ${psLiteral(input.ownershipId)}`,
    `$uninstaller = ${psLiteral(resolve(input.uninstaller))}`,
    `$failureLog = ${psLiteral(resolve(input.failureLog))}`,
    `$parentExitTimeoutMs = ${PARENT_EXIT_TIMEOUT_MS}`,
    `$uninstallTimeoutMs = ${UNINSTALL_TIMEOUT_MS}`,
    'function Assert-ExactOwnedTarget {',
    "  $expected = [IO.Path]::GetFullPath((Join-Path $appData 'DevHotel')).TrimEnd('\\')",
    "  $actual = [IO.Path]::GetFullPath($target).TrimEnd('\\')",
    '  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($expected, $actual)) {',
    "    throw 'DevHotel app-data target changed'",
    '  }',
    '  if (-not (Test-Path -LiteralPath $target -PathType Container)) { return $false }',
    '  $pending = New-Object System.Collections.Generic.Stack[string]',
    '  $pending.Push($target)',
    '  while ($pending.Count -gt 0) {',
    '    $current = $pending.Pop()',
    '    $item = Get-Item -LiteralPath $current -Force',
    '    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {',
    "      throw ('DevHotel app-data contains a reparse point: ' + $current)",
    '    }',
    '    if ($item.PSIsContainer) {',
    '      foreach ($child in (Get-ChildItem -LiteralPath $current -Force)) { $pending.Push($child.FullName) }',
    '    }',
    '  }',
    `  $ownerFile = Join-Path $target ${psLiteral(OWNER_FILE)}`,
    '  $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json',
    `  if ($owner.schema -ne ${OWNER_SCHEMA} -or $owner.appId -ne ${psLiteral(APP_ID)} -or $owner.ownershipId -ne $ownershipId) {`,
    "    throw 'DevHotel data ownership manifest changed'",
    '  }',
    '  return $true',
    '}',
    'try {',
    '  Remove-Item -LiteralPath $failureLog -Force -ErrorAction SilentlyContinue',
    '  $parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
    '  if ($null -ne $parent -and -not $parent.WaitForExit($parentExitTimeoutMs)) {',
    "    throw ('Timed out waiting for DevHotel process ' + $parentPid + ' to exit')",
    '  }',
    '  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {',
    "    throw 'DevHotel uninstaller disappeared before it could run'",
    '  }',
    '  $uninstallerItem = Get-Item -LiteralPath $uninstaller -Force',
    '  if (($uninstallerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or',
    '      -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($uninstaller), [IO.Path]::GetFullPath($uninstallerItem.FullName))) {',
    "    throw 'DevHotel uninstaller path changed before it could run'",
    '  }',
    "  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru",
    '  if (-not $uninstall.WaitForExit($uninstallTimeoutMs)) {',
    '    try { $uninstall.Kill() } catch {}',
    "    throw 'DevHotel uninstaller timed out'",
    '  }',
    '  if ($uninstall.ExitCode -ne 0) {',
    "    throw ('DevHotel uninstaller failed with exit code ' + $uninstall.ExitCode)",
    '  }',
    '  if (-not (Assert-ExactOwnedTarget)) { exit 0 }',
    '  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop',
    "  if (Test-Path -LiteralPath $target) { throw 'DevHotel data directory still exists after removal' }",
    '  Remove-Item -LiteralPath $failureLog -Force -ErrorAction SilentlyContinue',
    '} catch {',
    "  ('DevHotel clean removal failed at ' + [DateTime]::UtcNow.ToString('o') + [Environment]::NewLine + ($_ | Out-String)) | Set-Content -LiteralPath $failureLog -Encoding UTF8",
    '  exit 1',
    '}'
  ].join('\r\n')
  return script
}

export function encodedCleanRemovalCoordinatorCommand(input: CleanRemovalCoordinatorInput): string {
  return Buffer.from(cleanRemovalCoordinatorScript(input), 'utf16le').toString('base64')
}

type CoordinatorSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Resolve only after Windows confirms the detached coordinator process exists. */
export async function launchCleanRemovalCoordinator(
  input: CleanRemovalCoordinatorInput,
  spawnCoordinator: CoordinatorSpawner = spawn
): Promise<void> {
  const child = spawnCoordinator(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedCleanRemovalCoordinatorCommand(input)
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  )
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      resolveSpawn()
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      rejectSpawn(new Error(`Could not start the DevHotel clean-removal coordinator: ${error.message}`))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
  child.unref()
}
