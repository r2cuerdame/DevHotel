import { execFileSync } from 'node:child_process'

export interface BuildIdentityLiteral {
  version: string
  commit: string
  buildTime: string
  sourceVerified: boolean
}

export function buildIdentityForViteCommand(identity: BuildIdentityLiteral, command: 'build' | 'serve'): BuildIdentityLiteral {
  return command === 'serve' ? { ...identity, sourceVerified: false } : identity
}

function sourceTreeClean(repoRoot: string): boolean {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  if (!status) return true
  // Vite briefly writes this config bundle before evaluating the config. It is
  // tooling state, not a build input; the package hook separately requires the
  // full unfiltered tree to be clean before and after the build.
  return status.split(/\r?\n/).every((line) =>
    /^\?\? apps\/desktop\/electron\.vite\.config\.\d+\.mjs$/.test(line)
  )
}

export function resolveBuildIdentity(
  repoRoot: string,
  packageVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): BuildIdentityLiteral {
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim().toLowerCase()
  const commit = (env.DEVHOTEL_BUILD_COMMIT || gitCommit).trim().toLowerCase()
  const sourceVerified = commit === gitCommit && sourceTreeClean(repoRoot)
  const buildTime = env.DEVHOTEL_BUILD_TIME || (env.SOURCE_DATE_EPOCH
    ? new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : now().toISOString())

  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(packageVersion)) {
    throw new Error('Desktop package version is not semantic')
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Build commit must be a full lowercase Git SHA')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(buildTime) || new Date(buildTime).toISOString() !== buildTime) {
    throw new Error('Build time must be canonical UTC ISO-8601')
  }
  return { version: packageVersion, commit, buildTime, sourceVerified }
}
