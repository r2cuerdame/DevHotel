import { describe, expect, it } from 'vitest'
import { buildDockerSpawnEnv, createPinnedDockerRuntime, resolveDockerExecutable } from '../backend/cli'

describe('resolveDockerExecutable', () => {
  it('uses DEVHOTEL_DOCKER_PATH before PATH and Docker Desktop', () => {
    const existing = new Set([
      'C:\\tools\\docker.exe',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    ])

    expect(
      resolveDockerExecutable({
        env: {
          DEVHOTEL_DOCKER_PATH: ' "D:\\DevHotel Runtime\\docker.exe" ',
          PATH: 'C:\\tools',
          ProgramFiles: 'C:\\Program Files'
        },
        platform: 'win32',
        fileExists: (candidate) => existing.has(candidate)
      })
    ).toBe('D:\\DevHotel Runtime\\docker.exe')
  })

  it('uses a Docker CLI found on PATH before the Docker Desktop fallback', () => {
    const existing = new Set([
      'D:\\bin\\docker.exe',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    ])

    expect(
      resolveDockerExecutable({
        env: { Path: 'C:\\missing;"D:\\bin"', PROGRAMFILES: 'C:\\Program Files' },
        platform: 'win32',
        fileExists: (candidate) => existing.has(candidate)
      })
    ).toBe('D:\\bin\\docker.exe')
  })

  it('falls back to the standard Docker Desktop CLI path on Windows', () => {
    const expected = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'

    expect(
      resolveDockerExecutable({
        env: { PATH: 'C:\\missing', ProgramW6432: 'C:\\Program Files' },
        platform: 'win32',
        fileExists: (candidate) => candidate === expected
      })
    ).toBe(expected)
  })

  it('returns the platform command name when no concrete executable is found', () => {
    expect(
      resolveDockerExecutable({
        env: { PATH: '/missing:/also-missing' },
        platform: 'linux',
        fileExists: () => false
      })
    ).toBe('docker')
  })

  it('honors the bundled override even when PATH is empty', () => {
    expect(
      resolveDockerExecutable({
        env: { PATH: '', DEVHOTEL_DOCKER_PATH: 'D:\\DevHotel\\runtime\\docker.exe' },
        platform: 'win32',
        fileExists: () => false
      })
    ).toBe('D:\\DevHotel\\runtime\\docker.exe')
  })

  it('drops user endpoint variables and pins one explicit Docker context', () => {
    const env = buildDockerSpawnEnv(
      {
        PATH: 'C:\\tools',
        DOCKER_HOST: 'tcp://remote.example:2376',
        Docker_Context: 'remote',
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: 'C:\\certs',
        KEEP_ME: 'yes'
      },
      'devhotel-runtime'
    )

    expect(env).toMatchObject({ PATH: 'C:\\tools', KEEP_ME: 'yes', DOCKER_CONTEXT: 'devhotel-runtime' })
    expect(Object.keys(env).some((key) => key.toLowerCase() === 'docker_host')).toBe(false)
    expect(Object.keys(env).some((key) => key.toLowerCase() === 'docker_tls_verify')).toBe(false)
    expect(Object.keys(env).some((key) => key.toLowerCase() === 'docker_cert_path')).toBe(false)
  })

  it('prepends the resolved Docker directory so credential helpers work when PATH is absent', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      DEVHOTEL_DOCKER_PATH: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    }
    const runtime = createPinnedDockerRuntime({
      env: sourceEnv,
      platform: 'win32',
      fileExists: () => true
    })

    expect(runtime.env.PATH).toBe('C:\\Program Files\\Docker\\Docker\\resources\\bin')
    expect(sourceEnv.PATH).toBeUndefined()
    expect(
      `C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker-credential-desktop.exe`
    ).toBe(`${runtime.env.PATH}\\docker-credential-desktop.exe`)
  })

  it('uses the existing case-insensitive Windows Path key and preserves its entries', () => {
    const sourceEnv: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32;D:\\tools' }
    const childEnv = buildDockerSpawnEnv(sourceEnv, 'default', {
      executable: 'C:\\Docker\\bin\\docker.exe',
      platform: 'win32'
    })

    expect(childEnv.Path).toBe('C:\\Docker\\bin;C:\\Windows\\System32;D:\\tools')
    expect(childEnv.PATH).toBeUndefined()
    expect(sourceEnv.Path).toBe('C:\\Windows\\System32;D:\\tools')
  })
})
