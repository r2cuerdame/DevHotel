import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAdbExecutable, SpawnedAdbHost } from '../devices/adbHost'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scriptedAdb(source: string, limits: { text?: number; binary?: number; stderr?: number } = {}): SpawnedAdbHost {
  const dir = mkdtempSync(join(tmpdir(), 'devhotel-adb-host-'))
  dirs.push(dir)
  const script = join(dir, 'fake-adb.cjs')
  writeFileSync(script, source)
  return new SpawnedAdbHost({
    executable: process.execPath,
    prefixArgs: [script],
    textStdoutLimitBytes: limits.text ?? 128,
    binaryStdoutLimitBytes: limits.binary ?? 192,
    stderrLimitBytes: limits.stderr ?? 96
  })
}

describe('Host adb discovery', () => {
  it.each(['ANDROID_SDK_ROOT', 'ANDROID_HOME'] as const)(
    'uses %s even when that SDK root is also the inferred home value',
    (variable) => {
      const sdk = 'C:\\Android\\Sdk'
      const expected = 'C:\\Android\\Sdk\\platform-tools\\adb.exe'

      expect(
        resolveAdbExecutable({
          env: { PATH: '', [variable]: sdk },
          platform: 'win32',
          fileExists: (candidate) => candidate === expected
        })
      ).toBe(expected)
    }
  )

  it('deduplicates SDK candidates without dropping a root equal to the explicit home', () => {
    const sdk = 'C:\\Android\\Sdk'
    const expected = 'C:\\Android\\Sdk\\platform-tools\\adb.exe'
    const checked: string[] = []

    expect(
      resolveAdbExecutable({
        env: { PATH: '', ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk },
        platform: 'win32',
        home: sdk,
        fileExists: (candidate) => {
          checked.push(candidate)
          return candidate === expected
        }
      })
    ).toBe(expected)
    expect(checked.filter((candidate) => candidate === expected)).toHaveLength(1)
  })
})

describe('Host adb output isolation', () => {
  it('terminates text and binary commands at strict byte caps with an explicit error', async () => {
    const adb = scriptedAdb("process.stdout.write(Buffer.alloc(8192, 0x78))")

    const text = await adb.exec('private-serial', ['large-text'])
    expect(text.code).toBe(-1)
    expect(Buffer.byteLength(text.stdout)).toBe(128)
    expect(text.stderr).toMatch(/stdout exceeded the 128-byte Host safety limit/)

    const binary = await adb.execBinary('private-serial', ['large-binary'])
    expect(binary.code).toBe(-1)
    expect(binary.stdout).toHaveLength(192)
    expect(binary.outputLimitExceeded).toBe(true)
    expect(binary.stderr).toMatch(/stdout exceeded the 192-byte Host safety limit/)
  })

  it('bounds stderr too instead of retaining a child-process flood', async () => {
    const adb = scriptedAdb("process.stderr.write(Buffer.alloc(8192, 0x79))")

    const result = await adb.exec('private-serial', ['large-stderr'])

    expect(result.code).toBe(-1)
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(300)
    expect(result.stderr).toMatch(/stderr exceeded the 96-byte Host safety limit/)
  })

  it('never republishes raw inventory output when adb devices fails', async () => {
    const adb = scriptedAdb(
      "process.stdout.write('List of devices attached\\nSECRET-SERIAL\\tdevice\\n'); process.stderr.write(\"device 'SECRET-SERIAL' failed\"); process.exitCode = 7"
    )

    let message = ''
    try {
      await adb.devices()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('exit code 7')
    expect(message).not.toContain('SECRET-SERIAL')
  })

  it('never republishes raw output or executable paths when the availability probe fails', async () => {
    const failed = scriptedAdb(
      "process.stdout.write('Installed as C:\\\\private-sdk\\\\adb.exe\\n'); process.stderr.write('SECRET-HOST-PATH'); process.exitCode = 9"
    )

    const failedResult = await failed.available()
    expect(failedResult).toEqual({
      ok: false,
      detail: 'Host ADB probe failed with exit code 9; inspect Host diagnostics locally'
    })
    expect(JSON.stringify(failedResult)).not.toMatch(/SECRET-HOST-PATH|private-sdk/i)

    const missing = new SpawnedAdbHost({ executable: join(tmpdir(), 'private-sdk', 'missing-adb.exe') })
    const missingResult = await missing.available()
    expect(missingResult).toEqual({
      ok: false,
      detail: 'No usable Host ADB could be launched. Set DEVHOTEL_ADB_PATH or install platform-tools.'
    })
    expect(JSON.stringify(missingResult)).not.toMatch(/private-sdk|missing-adb/i)

    for (const operation of [
      () => missing.exec('private-serial', ['get-state']),
      () => missing.execBinary('private-serial', ['exec-out', 'screencap', '-p'])
    ]) {
      let message = ''
      try {
        await operation()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe('Host ADB process could not be launched; inspect Host diagnostics locally')
      expect(message).not.toMatch(/private-sdk|missing-adb/i)
    }
  })
})
