import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionForSerial, parseAdbPairingServices, resolveAdbExecutable, SpawnedAdbHost } from '../devices/adbHost'

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

describe('Host adb transport classification', () => {
  it.each([
    '192.0.2.20:5555',
    'pixel.example:5555',
    'adb-0W071F0A021046._adb-tls-connect._tcp',
    'adb-0W071F0A021046._adb-tls-connect._tcp.local',
    'adb-0W071F0A021046._ADB-TLS-CONNECT._TCP.LOCAL.',
    '[fe80::1]:5555',
    '[fe80::1%wlan0]:5555',
    '[2001:db8::192.0.2.1%3]:37123'
  ])('classifies %s as wireless', (serial) => {
    expect(connectionForSerial(serial)).toBe('wireless')
  })

  it.each([
    'R5CT30ABCDE',
    'adb-0W071F0A021046._adb-tls-pairing._tcp',
    'adb-0W071F0A021046._adb-tls-connect._udp',
    'adb-0W071F0A021046._adb-tls-connect._tcp.local.example',
    '._adb-tls-connect._tcp',
    'fe80::1:5555',
    '[fe80::1%bad zone]:5555',
    '[not-ip%wlan0]:5555',
    '[fe80::1]:0',
    '[fe80::1]:65536',
    '192.0.2.20:0',
    '192.0.2.20:65536'
  ])('does not classify %s as wireless', (serial) => {
    expect(connectionForSerial(serial)).toBe('usb')
  })

  it('prefers explicit USB transport metadata over an opaque colon-bearing serial', () => {
    expect(connectionForSerial('USB:12345', '1-4')).toBe('usb')
    expect(connectionForSerial('emulator-5554', '1-4')).toBe('emulator')
  })
})

describe('Host adb output isolation', () => {
  it('kills a child when cancellation races spawn and abort-listener registration', async () => {
    const adb = scriptedAdb("setInterval(() => undefined, 10_000)")
    const reason = new Error('exact lease was revoked during spawn')
    let abortedReads = 0
    const signal = {
      get aborted() {
        abortedReads += 1
        return abortedReads >= 2
      },
      reason,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    } as unknown as AbortSignal

    await expect(adb.exec('private-serial', ['get-state'], { signal })).rejects.toBe(reason)
    expect(abortedReads).toBeGreaterThanOrEqual(2)
  })

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

describe('Host adb secure pairing', () => {
  it('parses only strict IPv4 mDNS pairing services and ignores connect, legacy and malformed rows', () => {
    const output = [
      'List of discovered mdns services',
      'adb-private-pair _adb-tls-pairing._tcp 192.0.2.10:37111',
      'adb-private-connect _adb-tls-connect._tcp 192.0.2.10:37222',
      'adb-legacy _adb._tcp 192.0.2.10:5555',
      'adb-private-pair-duplicate _adb-tls-pairing._tcp. 192.0.2.10:37111',
      'adb-bad-port _adb-tls-pairing._tcp 192.0.2.10:65536',
      'adb-bad-host _adb-tls-pairing._tcp attacker.example:37111',
      'too many _adb-tls-pairing._tcp 192.0.2.12:37113 columns'
    ].join('\n')

    expect(parseAdbPairingServices(output)).toEqual([
      { serviceName: 'adb-private-pair', endpoint: '192.0.2.10:37111' }
    ])
  })

  it('passes the code only on stdin, keeps it out of argv, and discards secret-bearing output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-adb-pair-'))
    dirs.push(dir)
    const script = join(dir, 'fake-adb.cjs')
    const capture = join(dir, 'capture.json')
    writeFileSync(
      script,
      [
        "const { writeFileSync } = require('node:fs')",
        "let stdin = ''",
        "process.stdin.on('data', chunk => { stdin += chunk.toString('utf8') })",
        "process.stdin.on('end', () => {",
        "  writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdinOk: stdin === '481516\\n' }))",
        "  process.stdout.write(`Successfully paired to ${process.argv[4]} using ${stdin}`)",
        "  process.stderr.write(`private pairing diagnostic ${process.argv[4]} ${stdin}`)",
        "})"
      ].join('\n')
    )
    const adb = new SpawnedAdbHost({ executable: process.execPath, prefixArgs: [script, capture] })

    const result = await adb.pairWithCode('192.0.2.99:38999', '481516')
    const observed = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdinOk: boolean }

    expect(result).toEqual({ ok: true })
    expect(observed).toEqual({ argv: ['pair', '192.0.2.99:38999'], stdinOk: true })
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.99|38999|481516/)
    expect(observed.argv).not.toContain('481516')
  })

  it('returns a fixed failure bit even when adb writes pairing material on failure', async () => {
    const adb = scriptedAdb(
      "process.stdin.resume(); process.stdout.write('pairing code 112358 endpoint 192.0.2.77:37777'); process.stderr.write('private-token'); process.exitCode = 9"
    )

    const result = await adb.pairWithCode('192.0.2.77:37777', '112358')

    expect(result).toEqual({ ok: false })
    expect(JSON.stringify(result)).not.toMatch(/112358|192\.0\.2\.77|37777|private-token/)
  })
})
