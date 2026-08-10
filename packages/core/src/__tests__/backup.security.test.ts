import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRoomBackupFile, serviceForBackupId } from '../changes/definitions/services'

const ROOM_ID = 'room1abc'
const POSTGRES_ID = 'postgres-2026-08-10T12-30-00-deadbeef.sql'
const roots: string[] = []

function roomRoot(): { userData: string; backups: string } {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-backup-security-'))
  roots.push(userData)
  const backups = join(userData, 'rooms', ROOM_ID, 'backups')
  mkdirSync(backups, { recursive: true })
  return { userData, backups }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Room-scoped backup IDs', () => {
  it('resolves a non-empty owned backup without exposing an arbitrary path', () => {
    const { userData, backups } = roomRoot()
    const file = join(backups, POSTGRES_ID)
    writeFileSync(file, 'CREATE TABLE example(id int);\n')

    expect(serviceForBackupId(POSTGRES_ID)).toBe('postgres')
    expect(resolveRoomBackupFile(userData, ROOM_ID, 'postgres', POSTGRES_ID)).toBe(realpathSync.native(file))
  })

  it('rejects traversal, wrong-service files, empty files and arbitrary Host paths', () => {
    const { userData, backups } = roomRoot()
    const redis = 'redis-2026-08-10T12-30-00-deadbeef.rdb'
    writeFileSync(join(backups, redis), 'redis')
    writeFileSync(join(backups, POSTGRES_ID), '')

    expect(() => resolveRoomBackupFile(userData, ROOM_ID, 'postgres', '../secret.sql')).toThrow(/Invalid/)
    expect(() => resolveRoomBackupFile(userData, ROOM_ID, 'postgres', 'C:\\Users\\me\\secret.txt')).toThrow(/Invalid/)
    expect(() => resolveRoomBackupFile(userData, ROOM_ID, 'postgres', redis)).toThrow(/Invalid/)
    expect(() => resolveRoomBackupFile(userData, ROOM_ID, 'postgres', POSTGRES_ID)).toThrow(/non-empty/)
  })

  it('rejects a backups directory redirected through a junction or symlink', () => {
    const { userData, backups } = roomRoot()
    const outside = join(userData, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, POSTGRES_ID), 'SELECT 1;')
    rmSync(backups, { recursive: true })
    symlinkSync(outside, backups, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => resolveRoomBackupFile(userData, ROOM_ID, 'postgres', POSTGRES_ID)).toThrow(/symbolic link or junction/)
  })
})
