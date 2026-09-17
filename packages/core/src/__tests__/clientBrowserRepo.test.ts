import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientBrowserSessionRecord } from '@devhotel/shared'
import { openDb, type Db } from '../store/db'
import { clientBrowserRepo } from '../store/clientBrowserRepo'
import { hashClientBrowserToken } from '../browser/clientBrowserManager'
import { roomsRepo } from '../store/roomsRepo'
import { makeRoom, tempDir } from './fakes'

const roots: string[] = []
const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function record(overrides: Partial<ClientBrowserSessionRecord>): ClientBrowserSessionRecord {
  const now = new Date().toISOString()
  return {
    id: 'cbr_0123456789abcdef',
    roomId: 'room1234',
    tokenHash: hashClientBrowserToken('cbt_00000000000000000000000000000000'),
    status: 'starting',
    pid: null,
    devtoolsPort: null,
    browserKind: null,
    headless: true,
    profileMode: 'ephemeral',
    profilePath: 'C:\\data\\client-browsers\\cbr_0123456789abcdef',
    runtimeGeneration: 'gen-1',
    createdAt: now,
    lastActiveAt: now,
    ...overrides
  }
}

describe('ClientBrowserRepo', () => {
  it('stores only the token digest and walks a session through launch, touch and delete', () => {
    const dir = tempDir()
    roots.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    roomsRepo(db).create(makeRoom({ id: 'room1234' }))
    const repo = clientBrowserRepo(db)

    repo.create(record({}))
    const created = repo.get('cbr_0123456789abcdef')
    expect(created).toMatchObject({ status: 'starting', pid: null, devtoolsPort: null, headless: true })
    expect(created?.tokenHash).toHaveLength(64)
    expect(JSON.stringify(created)).not.toContain('cbt_')
    expect(repo.listLive().map((row) => row.id)).toEqual(['cbr_0123456789abcdef'])

    repo.markLaunched('cbr_0123456789abcdef', { pid: 4242, devtoolsPort: 51234, browserKind: 'chrome' }, '2026-09-18T10:00:00.000Z')
    expect(repo.get('cbr_0123456789abcdef')).toMatchObject({
      status: 'ready',
      pid: 4242,
      devtoolsPort: 51234,
      browserKind: 'chrome',
      lastActiveAt: '2026-09-18T10:00:00.000Z'
    })

    repo.touch('cbr_0123456789abcdef', '2026-09-18T10:05:00.000Z')
    expect(repo.get('cbr_0123456789abcdef')?.lastActiveAt).toBe('2026-09-18T10:05:00.000Z')

    repo.updateStatus('cbr_0123456789abcdef', 'failed', '2026-09-18T10:06:00.000Z')
    expect(repo.listLive()).toHaveLength(0)
    expect(repo.listAll()).toHaveLength(1)

    repo.delete('cbr_0123456789abcdef')
    expect(repo.get('cbr_0123456789abcdef')).toBeNull()
  })

  it('lists per Room and cascades when the Room row goes', () => {
    const dir = tempDir()
    roots.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    roomsRepo(db).create(makeRoom({ id: 'room5678' }))
    roomsRepo(db).create(makeRoom({ id: 'room9999', nickname: 'other', domain: 'other.localhost' }))
    const repo = clientBrowserRepo(db)
    repo.create(record({ id: 'cbr_aaaaaaaaaaaaaaaa', roomId: 'room5678' }))
    repo.create(record({ id: 'cbr_bbbbbbbbbbbbbbbb', roomId: 'room9999' }))

    expect(repo.listByRoom('room5678').map((row) => row.id)).toEqual(['cbr_aaaaaaaaaaaaaaaa'])
    roomsRepo(db).delete('room5678')
    expect(repo.listByRoom('room5678')).toHaveLength(0)
    expect(repo.listAll().map((row) => row.id)).toEqual(['cbr_bbbbbbbbbbbbbbbb'])
  })
})
