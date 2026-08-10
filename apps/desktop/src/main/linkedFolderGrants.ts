import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

export interface LinkedFolderGrantOptions {
  home: string
  /** Trees which must never be exposed (AppData, install/runtime data, system roots). */
  deniedTrees: string[]
  maxEntries?: number
}

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function canonicalExisting(path: string): string {
  if (!existsSync(path)) throw new Error(`Selected folder does not exist: ${path}`)
  const requested = resolve(path)
  const root = parse(requested).root
  let current = root
  for (const segment of relative(root, requested).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment)
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Linked folders cannot pass through a symbolic link or junction: ${current}`)
    }
  }
  return realpathSync.native(requested)
}

function scanForReparsePoints(root: string, maxEntries: number): void {
  const pending = [root]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      visited += 1
      if (visited > maxEntries) {
        throw new Error(`Selected folder is too broad to validate safely (more than ${maxEntries} entries)`)
      }
      const full = resolve(current, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new Error(`Linked folder contains a symbolic link or junction that could escape the grant: ${full}`)
      }
      if (stat.isDirectory()) pending.push(full)
    }
  }
}

/**
 * Process-local host-folder grants. Only the native folder picker calls grant();
 * renderer plan/create requests can merely present an already granted exact path.
 */
export class LinkedFolderGrants {
  private readonly approved = new Set<string>()
  private readonly home: string
  private readonly deniedTrees: string[]
  private readonly maxEntries: number

  constructor(opts: LinkedFolderGrantOptions) {
    this.home = canonicalExisting(opts.home)
    this.deniedTrees = opts.deniedTrees.filter(existsSync).map(canonicalExisting)
    this.maxEntries = opts.maxEntries ?? 100_000
  }

  grant(selectedPath: string): string {
    const canonical = this.validateProjectFolder(selectedPath)
    this.approved.add(comparable(canonical))
    return canonical
  }

  requireApproved(requestedPath: string): string {
    const canonical = this.validateProjectFolder(requestedPath)
    if (!this.approved.has(comparable(canonical))) {
      throw new Error('Local Folder access was not approved by the native folder picker')
    }
    return canonical
  }

  private validateProjectFolder(selectedPath: string): string {
    const canonical = canonicalExisting(selectedPath)
    const stat = lstatSync(canonical)
    if (!stat.isDirectory()) throw new Error(`Local Folder source must be a directory: ${canonical}`)

    const root = parse(canonical).root
    const segments = relative(root, canonical).split(/[\\/]+/).filter(Boolean)
    if (comparable(canonical) === comparable(root) || segments.length < 2) {
      throw new Error(`Selected folder is too broad to expose to a Room: ${canonical}`)
    }

    // Reject the profile itself and anything broad enough to contain it, while
    // still allowing an ordinary project below the current user's profile.
    if (isWithin(canonical, this.home)) {
      throw new Error(`Select a project folder, not the user profile or one of its parents: ${canonical}`)
    }
    const profilesRoot = dirname(this.home)
    if (isWithin(profilesRoot, canonical) && !isWithin(this.home, canonical)) {
      throw new Error(`Folders from another user profile cannot be exposed: ${canonical}`)
    }
    for (const denied of this.deniedTrees) {
      if (overlaps(denied, canonical)) {
        throw new Error(`Protected application or system data cannot be exposed to a Room: ${canonical}`)
      }
    }

    scanForReparsePoints(canonical, this.maxEntries)
    return canonical
  }
}

/** Restricts shell.openPath to an existing path inside one of the supplied roots. */
export function requirePathWithinRoots(requestedPath: string, roots: string[]): string {
  const canonical = canonicalExisting(requestedPath)
  if (!lstatSync(canonical).isDirectory()) throw new Error('Only Host directories can be opened')
  const allowed = roots
    .filter(existsSync)
    .map((root) => realpathSync.native(resolve(root)))
    .some((root) => isWithin(root, canonical))
  if (!allowed) throw new Error('The requested Host path is outside DevHotel-owned or user-approved folders')
  return canonical
}
