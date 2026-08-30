import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogLineEvent } from '../logs'
import { LogHub } from '../logs'
import { registerSensitiveSecrets } from '../diagnostics/redact'
import { androidDevicesRepo } from '../store/androidDevicesRepo'
import { openDb } from '../store/db'
import { FakeBackend } from './fakes'

const dirs: string[] = []
const dbs: { close(): void }[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('central pairing redaction at persisted and live sinks', () => {
  it('redacts LogHub files, tails and emitted lines before any consumer sees them', () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-pairing-log-'))
    dirs.push(userData)
    const logs = new LogHub(userData, new FakeBackend())
    const endpoint = '192.0.2.55:37555'
    const release = registerSensitiveSecrets([endpoint])
    let emitted: LogLineEvent | null = null
    logs.on('line', (line: LogLineEvent) => {
      emitted = line
    })

    logs.orchestrator('room1abc', `Pairing code: 654321 at ${endpoint}`)
    release()
    // Simulate a line left by an older build: reads are protected too.
    appendFileSync(logs.logFile('room1abc', 'orchestrator'), 'pairing token: legacy-private-token\n', 'utf8')

    const tail = logs.tail('room1abc', 'orchestrator')
    expect(tail).toHaveLength(2)
    expect(tail.join('\n')).not.toMatch(/654321|192\.0\.2\.55|37555|legacy-private-token/)
    expect(emitted).not.toBeNull()
    expect((emitted as unknown as LogLineEvent).line).not.toMatch(/654321|192\.0\.2\.55|37555/)
    logs.dispose()
  })

  it('redacts device-event details before the SQLite write and public status read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-pairing-event-'))
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    const repo = androidDevicesRepo(db)

    const event = repo.recordEvent({
      deviceId: null,
      roomId: null,
      kind: 'pairing-failed',
      detail: 'pairing endpoint: 192.0.2.56:37556 pairing code: 112358',
      at: '2026-08-31T00:00:00.000Z'
    })

    expect(event.detail).not.toMatch(/192\.0\.2\.56|37556|112358/)
    db.sqlite
      .prepare('INSERT INTO android_device_events (id, device_id, room_id, kind, detail, at) VALUES (?, NULL, NULL, ?, ?, ?)')
      .run(
        '11111111-2222-4333-8444-555555555555',
        'pairing-failed',
        'pairing token: legacy-private-token',
        '2026-08-31T00:01:00.000Z'
      )
    const recent = repo.recentEvents()
    expect(recent[0]!.detail).not.toContain('legacy-private-token')
    expect(recent[1]!.detail).toBe(event.detail)
  })
})
