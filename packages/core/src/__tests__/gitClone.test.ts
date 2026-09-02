import { describe, expect, it } from 'vitest'
import { gitCloneRun, splitGitCredential } from '../backend/gitClone'

describe('splitGitCredential', () => {
  it('lifts an inline secret out of the URL that gets persisted', () => {
    const { url, credential } = splitGitCredential('https://me:github_pat_123@github.com/acme/private.git')
    expect(url).toBe('https://github.com/acme/private.git')
    expect(credential).toEqual({ username: 'me', secret: 'github_pat_123' })
  })

  it('decodes percent-encoded credentials', () => {
    const { credential } = splitGitCredential('https://a%40b.com:p%3Fss@example.test/x.git')
    expect(credential).toEqual({ username: 'a@b.com', secret: 'p?ss' })
  })

  it('leaves a secret-free URL untouched, including a bare username and ssh remotes', () => {
    for (const url of [
      'https://github.com/acme/public.git',
      'https://me@github.com/acme/public.git',
      'git@github.com:acme/public.git'
    ]) {
      expect(splitGitCredential(url)).toEqual({ url, credential: null })
    }
  })
})

describe('gitCloneRun', () => {
  const mount = ['-v', 'dh-room1-src:/workspace', '-w', '/workspace']

  it('clones anonymously without stdin when there is no credential', () => {
    const run = gitCloneRun(mount, 'https://github.com/acme/public.git', ['--depth', '1'], null)
    expect(run.input).toBeUndefined()
    expect(run.args).toEqual([
      'run', '--rm', ...mount, 'alpine/git', 'clone', '--depth', '1', 'https://github.com/acme/public.git', '.'
    ])
  })

  it('never puts the secret in argv — it arrives on stdin, one line each', () => {
    const secret = 'github_pat_supersecret'
    const run = gitCloneRun(mount, 'https://github.com/acme/private.git', [], { username: 'me', secret })
    expect(run.args.join(' ')).not.toContain(secret)
    expect(run.args.join(' ')).not.toContain('me\n')
    expect(run.input).toBe(`me\n${secret}\n`)
    expect(run.args).toContain('-i')
    // the helper must stay single-quoted so `sh` cannot expand it into git's argv
    const script = run.args[run.args.indexOf('-c') + 1] ?? ''
    expect(script).toContain("'credential.helper=!f() { echo \"username=$DH_GIT_USER\"")
    expect(run.args.at(-1)).toBe('.')
  })

  it('refuses a credential carrying whitespace rather than corrupting the stdin protocol', () => {
    expect(() => gitCloneRun(mount, 'https://example.test/x.git', [], { username: 'me', secret: 'a b' })).toThrow(
      /whitespace/
    )
  })
})
