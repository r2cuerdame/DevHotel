import { execFileSync } from 'node:child_process'

export interface BuildIdentityLiteral {
  version: string
  commit: string
  buildTime: string
  sourceVerified: boolean
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
  const sourceVerified = commit === gitCommit && execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim() === ''
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
