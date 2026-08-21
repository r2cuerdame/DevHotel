import type { GitCredential } from './types'

export const CLONE_IMAGE = 'alpine/git'

/**
 * Reads the username and the secret from stdin, so a credential never appears in the
 * container's argv (which `docker inspect` and any process listing expose), in its
 * environment, on disk, or inside the remote URL that DevHotel persists and logs.
 * The helper stays single-quoted so `sh` does not expand the values into git's argv;
 * git runs the helper itself and reads them from the exported environment.
 */
const CREDENTIAL_CLONE_SCRIPT = [
  'set -e',
  'IFS= read -r DH_GIT_USER',
  'IFS= read -r DH_GIT_SECRET',
  'export DH_GIT_USER DH_GIT_SECRET',
  'exec git -c credential.helper= -c ' +
    '\'credential.helper=!f() { echo "username=$DH_GIT_USER"; echo "password=$DH_GIT_SECRET"; }; f\' ' +
    'clone "$@"'
].join('\n')

/** One line each, in the order the script reads them; both are whitespace-free by contract. */
function credentialStdin(credential: GitCredential): string {
  if (/\s/.test(credential.username) || /\s/.test(credential.secret)) {
    throw new Error('git credential must not contain whitespace')
  }
  return `${credential.username}\n${credential.secret}\n`
}

/**
 * One `docker run` that clones `gitUrl` into `/workspace`, with or without a credential.
 * `mountArgs` decides where `/workspace` comes from — a Room volume or a temp bind.
 */
export function gitCloneRun(
  mountArgs: string[],
  gitUrl: string,
  cloneArgs: string[],
  credential?: GitCredential | null
): { args: string[]; input?: string } {
  const clone = [...cloneArgs, gitUrl, '.']
  if (!credential) return { args: ['run', '--rm', ...mountArgs, CLONE_IMAGE, 'clone', ...clone] }
  return {
    args: [
      'run',
      '--rm',
      '-i',
      ...mountArgs,
      '--entrypoint',
      'sh',
      CLONE_IMAGE,
      '-c',
      CREDENTIAL_CLONE_SCRIPT,
      'devhotel-clone',
      ...clone
    ],
    input: credentialStdin(credential)
  }
}

/**
 * A repository URL may be pasted with `user:secret@` in it. DevHotel uses that secret for
 * the one clone and then drops it: the Room record, manifest.yaml, the diagnostics bundle
 * and every log line keep the clean URL. A bare `user@` carries no secret and is left alone.
 */
export function splitGitCredential(gitUrl: string): { url: string; credential: GitCredential | null } {
  let parsed: URL
  try {
    parsed = new URL(gitUrl)
  } catch {
    return { url: gitUrl, credential: null }
  }
  if (parsed.password === '') return { url: gitUrl, credential: null }
  const credential = {
    username: decodeURIComponent(parsed.username),
    secret: decodeURIComponent(parsed.password)
  }
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.toString(), credential }
}
