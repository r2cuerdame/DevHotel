import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { zBackupId, type ChangeEntry, type ServiceKind } from '@devhotel/shared'
import { SERVICE_DB_NAME, SERVICE_DB_USER, SERVICE_DEFAULT_VERSIONS } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const SERVICE_LABEL: Record<ServiceKind, string> = { postgres: 'PostgreSQL', redis: 'Redis' }
const SERVICE_ALLOWED_VERSIONS: Record<ServiceKind, readonly string[]> = {
  postgres: ['15', '16', '17'],
  redis: ['7', '8']
}

function assertAllowedServiceVersion(service: ServiceKind, version: string): void {
  if (!SERVICE_ALLOWED_VERSIONS[service].includes(version)) {
    throw new Error(`Unsupported ${SERVICE_LABEL[service]} version: ${version}`)
  }
}

function assertNotPostgresDowngrade(service: ServiceKind, from: string, to: string): void {
  if (service !== 'postgres' || Number(to) >= Number(from)) return
  throw new Error(
    `PostgreSQL ${from} cannot be switched down to ${to} — a ${from} backup does not load into an older PostgreSQL. Keep ${from}, or restore a backup made on ${to} or earlier into a fresh ${to}.`
  )
}

// The official image's first-boot init server listens on the Unix socket only, then shuts down; TCP answers only from the real server.
const POSTGRES_READY_PROBE = ['pg_isready', '-h', '127.0.0.1', '-U', SERVICE_DB_USER]

const POSTGRES_DUMP_HEADER_BYTES = 8192

export function postgresDumpMajorVersion(file: string): number | null {
  let header: string
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(POSTGRES_DUMP_HEADER_BYTES)
      header = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const majors = [...header.matchAll(/^-- Dumped (?:from database|by pg_dump) version (\d+)/gm)].map((m) => Number(m[1]))
  return majors.length ? Math.max(...majors) : null
}

function assertPostgresBackupFits(file: string, backupId: string, current: string): void {
  const dumped = postgresDumpMajorVersion(file)
  if (dumped === null || dumped <= Number(current)) return
  throw new Error(
    `Backup ${backupId} was made on PostgreSQL ${dumped} and cannot be restored into PostgreSQL ${current}. Switch this Room to PostgreSQL ${dumped} first, then restore it.`
  )
}

function backupsDir(ctx: ChangeCtx): string {
  const dir = join(ctx.userData, 'rooms', ctx.roomId, 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function serviceForBackupId(id: string): ServiceKind | null {
  if (!zBackupId.safeParse(id).success) return null
  if (id.startsWith('postgres-') && id.endsWith('.sql')) return 'postgres'
  if (id.startsWith('redis-') && id.endsWith('.rdb')) return 'redis'
  return null
}

export function resolveRoomBackupFile(
  userData: string,
  roomId: string,
  service: ServiceKind,
  backupId: string
): string {
  if (basename(backupId) !== backupId || serviceForBackupId(backupId) !== service) {
    throw new Error(`Invalid ${SERVICE_LABEL[service]} backup ID`)
  }
  const root = resolve(userData)
  const roomDir = resolve(root, 'rooms', roomId)
  const dir = resolve(roomDir, 'backups')
  const file = resolve(dir, backupId)
  const rel = relative(dir, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || comparable(dirname(file)) !== comparable(dir)) {
    throw new Error('Backup ID escapes the Room backups directory')
  }
  if (!existsSync(file)) throw new Error(`Backup not found in this Room: ${backupId}`)

  for (const item of [root, resolve(root, 'rooms'), roomDir, dir, file]) {
    if (!existsSync(item)) throw new Error(`Backup path is incomplete: ${backupId}`)
    if (lstatSync(item).isSymbolicLink()) {
      throw new Error(`Backup path contains a symbolic link or junction: ${backupId}`)
    }
  }
  const canonicalDir = realpathSync.native(dir)
  const canonicalFile = realpathSync.native(file)
  if (comparable(dirname(canonicalFile)) !== comparable(canonicalDir)) {
    throw new Error('Backup resolved outside the Room backups directory')
  }
  const stat = statSync(canonicalFile)
  if (!stat.isFile() || stat.size === 0) throw new Error(`Backup is not a non-empty regular file: ${backupId}`)
  return canonicalFile
}

export async function pingService(
  ctx: ChangeCtx,
  svc: ServiceKind,
  timeoutMs = 60_000
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const state = await ctx.backend.serviceState(ctx.roomId, svc)
    if (state === 'missing') return { ok: false, detail: `${SERVICE_LABEL[svc]} container missing` }
    if (state === 'running') {
      const res =
        svc === 'postgres'
          ? await ctx.backend.execInService(ctx.roomId, svc, POSTGRES_READY_PROBE, { timeoutMs: 10_000 })
          : await ctx.backend.execInService(ctx.roomId, svc, ['redis-cli', 'ping'], { timeoutMs: 10_000 })
      if (res.code === 0 && (svc === 'postgres' || res.stdout.includes('PONG'))) {
        return { ok: true, detail: `${SERVICE_LABEL[svc]} answering on its in-room port` }
      }
      last = (res.stderr || res.stdout).trim().slice(0, 120)
    }
    await sleep(1500)
  }
  return { ok: false, detail: `${SERVICE_LABEL[svc]} not answering${last ? `: ${last}` : ''}` }
}

export async function validatePostgresLogicalClone(ctx: ChangeCtx): Promise<void> {
  const databases = await ctx.backend.execInService(
    ctx.roomId,
    'postgres',
    [
      'psql',
      '-At',
      '-U',
      SERVICE_DB_USER,
      '-d',
      'postgres',
      '-c',
      `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', '${SERVICE_DB_NAME}') ORDER BY 1;`
    ],
    { timeoutMs: 30_000 }
  )
  if (databases.code !== 0) throw new Error(`PostgreSQL clone validation failed: ${databases.stderr.slice(-300)}`)
  const extraDatabases = databases.stdout.trim()
  if (extraDatabases) {
    throw new Error(`PostgreSQL has unmanaged databases that an awake logical clone cannot copy: ${extraDatabases.replaceAll('\n', ', ')}`)
  }

  const roles = await ctx.backend.execInService(
    ctx.roomId,
    'postgres',
    [
      'psql',
      '-At',
      '-U',
      SERVICE_DB_USER,
      '-d',
      'postgres',
      '-c',
      `SELECT rolname FROM pg_roles WHERE rolname <> '${SERVICE_DB_USER}' AND rolname !~ '^pg_' ORDER BY 1;`
    ],
    { timeoutMs: 30_000 }
  )
  if (roles.code !== 0) throw new Error(`PostgreSQL clone validation failed: ${roles.stderr.slice(-300)}`)
  const extraRoles = roles.stdout.trim()
  if (extraRoles) {
    throw new Error(`PostgreSQL has unmanaged roles that an awake logical clone cannot copy: ${extraRoles.replaceAll('\n', ', ')}`)
  }
}

const REDIS_SAVE_BUDGET_MS = 300_000
const REDIS_BGSAVE_POLL_MS = 1_000
const REDIS_BGSAVE_IN_PROGRESS = 'Background save already in progress'

function redisReply(res: { stdout: string; stderr: string }): string {
  return [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join(' / ').slice(-300)
}

async function saveRedisSnapshot(ctx: ChangeCtx): Promise<void> {
  const deadline = Date.now() + REDIS_SAVE_BUDGET_MS
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('redis SAVE failed: a background save was still in progress when the backup time ran out')
    const save = await ctx.backend.execInService(ctx.roomId, 'redis', ['redis-cli', 'save'], { timeoutMs: remaining })
    if (save.code === 0 && save.stdout.trim() === 'OK') return
    const reply = redisReply(save)
    if (!reply.includes(REDIS_BGSAVE_IN_PROGRESS)) {
      throw new Error(`redis SAVE failed: ${reply || `exit code ${save.code} with no reply`}`)
    }
    await waitForRedisBackgroundSave(ctx, deadline)
  }
}

async function waitForRedisBackgroundSave(ctx: ChangeCtx, deadline: number): Promise<void> {
  let last = ''
  while (Date.now() < deadline) {
    const info = await ctx.backend.execInService(ctx.roomId, 'redis', ['redis-cli', 'info', 'persistence'], {
      timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now()))
    })
    const flag = /rdb_bgsave_in_progress:(\d+)/.exec(info.stdout)?.[1]
    if (info.code === 0 && flag === '0') return
    last = flag === undefined ? redisReply(info) : `rdb_bgsave_in_progress:${flag}`
    await sleep(Math.max(0, Math.min(REDIS_BGSAVE_POLL_MS, deadline - Date.now())))
  }
  throw new Error(
    `redis SAVE failed: a background save was still in progress when the backup time ran out${last ? ` (${last})` : ''}`
  )
}

export async function backupServiceToFile(ctx: ChangeCtx, svc: ServiceKind): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
  const unique = randomUUID().slice(0, 8)
  if (svc === 'postgres') {
    const file = join(backupsDir(ctx), `postgres-${stamp}-${unique}.sql`)
    const partial = `${file}.${randomUUID()}.partial`
    try {
      const res = await ctx.backend.execInServiceToFile(
        ctx.roomId,
        'postgres',
        ['pg_dump', '-U', SERVICE_DB_USER, '-d', SERVICE_DB_NAME],
        partial,
        { timeoutMs: 600_000 }
      )
      if (res.code !== 0) throw new Error(`pg_dump failed: ${res.stderr.slice(-300)}`)
      if (statSync(partial).size === 0) throw new Error('pg_dump produced an empty backup')
      renameSync(partial, file)
      return file
    } finally {
      rmSync(partial, { force: true })
    }
  }
  const file = join(backupsDir(ctx), `redis-${stamp}-${unique}.rdb`)
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await saveRedisSnapshot(ctx)
    await ctx.backend.copyFromService(ctx.roomId, 'redis', '/data/dump.rdb', partial)
    if (statSync(partial).size === 0) throw new Error('Redis SAVE produced an empty backup')
    renameSync(partial, file)
    return file
  } finally {
    rmSync(partial, { force: true })
  }
}

export async function withWebPaused<T>(ctx: ChangeCtx, fn: () => Promise<T>): Promise<T> {
  const shouldPause = ctx.isAwake()
    && (await ctx.backend.webState(ctx.roomId)) === 'running'
    && !(await ctx.backend.webPaused(ctx.roomId))
  if (!shouldPause) return fn()
  try {
    await ctx.backend.pauseWeb(ctx.roomId)
  } catch (pauseError) {
    throw new Error(
      `Could not pause the Room app before replacing its data: ${pauseError instanceof Error ? pauseError.message : String(pauseError)}`,
      { cause: pauseError }
    )
  }
  let result: T | undefined
  let failed = false
  let failure: unknown
  try {
    result = await fn()
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await ctx.backend.unpauseWeb(ctx.roomId)
  } catch (unpauseError) {
    ctx.log(`Room app resume failed, recreating it: ${unpauseError instanceof Error ? unpauseError.message : String(unpauseError)}`)
    try {
      await ctx.backend.recreateWeb(ctx.webSpec())
    } catch (recreateError) {
      throw new AggregateError(
        failed ? [failure, unpauseError, recreateError] : [unpauseError, recreateError],
        'Could not resume or recreate the Room app after replacing its data'
      )
    }
  }
  if (failed) throw failure
  return result as T
}

export async function restoreServiceFromFile(ctx: ChangeCtx, svc: ServiceKind, file: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`Backup file not found: ${file}`)
  if (svc === 'postgres') {
    // separate -c calls: psql runs a multi-statement -c in one transaction, which DROP DATABASE refuses
    const drop = await ctx.backend.execInService(
      ctx.roomId,
      'postgres',
      ['psql', '-U', SERVICE_DB_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${SERVICE_DB_NAME} WITH (FORCE);`],
      { timeoutMs: 120_000 }
    )
    if (drop.code !== 0) throw new Error(`database reset failed: ${drop.stderr.slice(-300)}`)
    const create = await ctx.backend.execInService(
      ctx.roomId,
      'postgres',
      ['psql', '-U', SERVICE_DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE ${SERVICE_DB_NAME};`],
      { timeoutMs: 120_000 }
    )
    if (create.code !== 0) throw new Error(`database reset failed: ${create.stderr.slice(-300)}`)
    const res = await ctx.backend.execInServiceFromFile(
      ctx.roomId,
      'postgres',
      ['psql', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', SERVICE_DB_USER, '-d', SERVICE_DB_NAME],
      file,
      { timeoutMs: 600_000 }
    )
    if (res.code !== 0) throw new Error(`psql restore failed: ${res.stderr.slice(-300)}`)
    return
  }
  await ctx.backend.stopService(ctx.roomId, 'redis')
  try {
    await ctx.backend.copyToService(ctx.roomId, 'redis', file, '/data/dump.rdb')
  } catch (copyError) {
    await ctx.backend.startService(ctx.roomId, 'redis').catch((startError: unknown) => {
      ctx.log(`Redis restart after a failed restore copy failed: ${startError instanceof Error ? startError.message : String(startError)}`)
    })
    throw copyError
  }
  await ctx.backend.startService(ctx.roomId, 'redis')
}

async function materializeService(ctx: ChangeCtx, svc: ServiceKind, version: string): Promise<void> {
  await ctx.backend.removeService(ctx.roomId, svc, { volume: false })
  await ctx.backend.createService(ctx.roomId, svc, version)
}

export const serviceAddChange: ChangeDefinition<{ service: ServiceKind; version?: string }> = {
  kind: 'service-add',
  plan(ctx, p) {
    const version = p.version ?? SERVICE_DEFAULT_VERSIONS[p.service]
    return {
      title: `${SERVICE_LABEL[p.service]} ${version} added`,
      component: SERVICE_LABEL[p.service],
      before: null,
      after: { version },
      undoable: true,
      undoStrategy: 'remove-service',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    assertAllowedServiceVersion(p.service, p.version ?? SERVICE_DEFAULT_VERSIONS[p.service])
    if (room.provider !== 'web') throw new Error('Services are available in Web rooms')
    if (room.services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} already exists in this room`)
  },
  async capture(_ctx, p) {
    return { service: p.service }
  },
  async apply(ctx, p, steps) {
    const version = p.version ?? SERVICE_DEFAULT_VERSIONS[p.service]
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [p.service]: { version } } })
    if (ctx.isAwake()) {
      steps.push(`Start ${SERVICE_LABEL[p.service]} ${version} inside the room`)
      await materializeService(ctx, p.service, version)
    } else {
      steps.push('Recorded — starts on next wake')
    }
  },
  async verify(ctx, p) {
    if (!ctx.isAwake()) return { ok: true, detail: 'starts on next wake (room is asleep)' }
    return pingService(ctx, p.service)
  },
  async undo(ctx, entry) {
    const service = addedService(entry)
    const services = { ...ctx.room().services }
    delete services[service]
    ctx.rooms.update(ctx.roomId, { services })
    await ctx.backend.removeService(ctx.roomId, service, { volume: true })
  },
  async verifyUndo(ctx, entry) {
    const service = addedService(entry)
    const label = SERVICE_LABEL[service]
    if (ctx.room().services[service]) return { ok: false, detail: `${label} is still recorded in this room` }
    const state = await ctx.backend.serviceState(ctx.roomId, service)
    return state === 'missing'
      ? { ok: true, detail: `${label} removed with its data volume` }
      : { ok: false, detail: `${label} container still exists` }
  }
}

function addedService(entry: ChangeEntry): ServiceKind {
  return (entry.captured as { service: ServiceKind } | null)?.service ?? inferService(entry.title)
}

function inferService(title: string): ServiceKind {
  return title.startsWith('Redis') ? 'redis' : 'postgres'
}

interface RemoveCaptured {
  version: string
  backupFile: string
}

function removeCapturedBackup(captured: unknown): string | null {
  const blob = captured as { backupFile?: unknown } | null
  return typeof blob?.backupFile === 'string' && blob.backupFile ? blob.backupFile : null
}

export const serviceRemoveChange: ChangeDefinition<{ service: ServiceKind }> = {
  kind: 'service-remove',
  plan(ctx, p) {
    const current = ctx.room().services[p.service]
    return {
      title: `${SERVICE_LABEL[p.service]}${current ? ` ${current.version}` : ''} removed`,
      component: SERVICE_LABEL[p.service],
      before: current ?? null,
      after: null,
      undoable: true,
      undoStrategy: 'safety-backup-restore',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!ctx.room().services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake() || (await ctx.backend.serviceState(ctx.roomId, p.service)) !== 'running') {
      throw new Error(
        `Start the room and its ${SERVICE_LABEL[p.service]} app before removing it — the safety backup needs it running`
      )
    }
  },
  async capture(ctx, p): Promise<RemoveCaptured> {
    const version = ctx.room().services[p.service]!.version
    const backupFile = await backupServiceToFile(ctx, p.service)
    if (!existsSync(backupFile)) throw new Error(`${SERVICE_LABEL[p.service]} safety backup was not written: ${backupFile}`)
    ctx.log(`safety backup: ${backupFile}`)
    return { version, backupFile }
  },
  async apply(ctx, p, steps) {
    const services = { ...ctx.room().services }
    delete services[p.service]
    ctx.rooms.update(ctx.roomId, { services })
    steps.push(`Remove ${SERVICE_LABEL[p.service]} and its data volume`)
    await ctx.backend.removeService(ctx.roomId, p.service, { volume: true })
  },
  canRollbackApplyFailure(_ctx, _p, captured) {
    return removeCapturedBackup(captured) !== null
  },
  async verify(ctx, p, captured) {
    const state = await ctx.backend.serviceState(ctx.roomId, p.service)
    if (state !== 'missing') return { ok: false, detail: `${SERVICE_LABEL[p.service]} container still exists` }
    const backupFile = removeCapturedBackup(captured)
    if (!backupFile || !existsSync(backupFile)) {
      return { ok: false, detail: `${SERVICE_LABEL[p.service]} removed but its safety backup is missing` }
    }
    return {
      ok: true,
      detail: `${SERVICE_LABEL[p.service]} removed; safety backup ${basename(backupFile)} kept in the room's backups folder`
    }
  },
  async undo(ctx, entry) {
    const service = inferService(entry.title)
    const label = SERVICE_LABEL[service]
    const captured = entry.captured as Partial<RemoveCaptured> | null
    const backupFile = removeCapturedBackup(captured)
    if (!backupFile || !existsSync(backupFile)) {
      throw new Error(
        `${label} safety backup is missing — undo cannot restore its data; add ${label} again and restore a backup you still have`
      )
    }
    if (!ctx.isAwake()) throw new Error(`Wake the room first — restoring ${label} from its safety backup needs it running`)
    const version = captured?.version ?? SERVICE_DEFAULT_VERSIONS[service]
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [service]: { version } } })
    await withWebPaused(ctx, async () => {
      await materializeService(ctx, service, version)
      const ping = await pingService(ctx, service)
      if (!ping.ok) throw new Error(ping.detail)
      await restoreServiceFromFile(ctx, service, backupFile)
    })
  },
  verifyUndo(ctx, entry) {
    return pingService(ctx, inferService(entry.title))
  }
}

export const serviceVersionChange: ChangeDefinition<{ service: ServiceKind; version: string }> = {
  kind: 'service-version',
  plan(ctx, p) {
    const current = ctx.room().services[p.service]?.version
    return {
      title: `${SERVICE_LABEL[p.service]} ${current ?? '?'} → ${p.version}`,
      component: SERVICE_LABEL[p.service],
      before: { version: current },
      after: { version: p.version },
      undoable: true,
      undoStrategy: 'backup-recreate-restore',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const current = ctx.room().services[p.service]
    assertAllowedServiceVersion(p.service, p.version)
    if (!current) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (current.version === p.version) throw new Error(`${SERVICE_LABEL[p.service]} is already on ${p.version}`)
    assertNotPostgresDowngrade(p.service, current.version, p.version)
    if (!ctx.isAwake()) throw new Error('Wake the room first — the data is backed up before switching')
  },
  async apply(ctx, p, steps) {
    const prevVersion = ctx.room().services[p.service]!.version
    steps.push('Back up the current data')
    const backupFile = await backupServiceToFile(ctx, p.service)
    steps.setCaptured({ prevVersion, backupFile })
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [p.service]: { version: p.version } } })
    steps.push(`Recreate ${SERVICE_LABEL[p.service]} ${p.version} with a fresh data volume`)
    await withWebPaused(ctx, async () => {
      await ctx.backend.removeService(ctx.roomId, p.service, { volume: true })
      await ctx.backend.createService(ctx.roomId, p.service, p.version)
      const ping = await pingService(ctx, p.service)
      if (!ping.ok) throw new Error(ping.detail)
      steps.push('Restore the data into the new version')
      await restoreServiceFromFile(ctx, p.service, backupFile)
    })
  },
  canRollbackApplyFailure(_ctx, _p, captured) {
    const backup = captured as { prevVersion?: unknown; backupFile?: unknown } | null
    return typeof backup?.prevVersion === 'string' && typeof backup.backupFile === 'string'
  },
  async verify(ctx, p) {
    return pingService(ctx, p.service)
  },
  async undo(ctx, entry) {
    const captured = entry.captured as { prevVersion?: string; backupFile?: unknown } | null
    const service = inferService(entry.title)
    const label = SERVICE_LABEL[service]
    const backupFile = removeCapturedBackup(captured)
    if (!backupFile || !existsSync(backupFile)) {
      throw new Error(
        `${label} safety backup is missing — undo would leave an empty older ${label}; restore a backup you still have instead`
      )
    }
    if (!ctx.isAwake()) throw new Error(`Wake the room first — switching ${label} back restores its data from the safety backup`)
    const prevVersion = captured?.prevVersion ?? (entry.before as { version?: string } | null)?.version ?? SERVICE_DEFAULT_VERSIONS[service]
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [service]: { version: prevVersion } } })
    await withWebPaused(ctx, async () => {
      await ctx.backend.removeService(ctx.roomId, service, { volume: true })
      await ctx.backend.createService(ctx.roomId, service, prevVersion)
      const ping = await pingService(ctx, service)
      if (!ping.ok) throw new Error(ping.detail)
      await restoreServiceFromFile(ctx, service, backupFile)
    })
  },
  verifyUndo(ctx, entry) {
    return pingService(ctx, inferService(entry.title))
  }
}

export const serviceRestartChange: ChangeDefinition<{ service: ServiceKind }> = {
  kind: 'service-restart',
  plan(ctx, p) {
    return {
      title: `${SERVICE_LABEL[p.service]} restarted`,
      component: SERVICE_LABEL[p.service],
      before: null,
      after: null,
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!ctx.room().services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake()) throw new Error('Wake the room first')
  },
  async apply(ctx, p, steps) {
    steps.push(`Restart ${SERVICE_LABEL[p.service]}`)
    await ctx.backend.stopService(ctx.roomId, p.service)
    await ctx.backend.startService(ctx.roomId, p.service)
  },
  verify(ctx, p) {
    return pingService(ctx, p.service)
  }
}

export const dbBackupChange: ChangeDefinition<{ service: ServiceKind }> = {
  kind: 'db-backup',
  plan(ctx, p) {
    return {
      title: `${SERVICE_LABEL[p.service]} backup created`,
      component: SERVICE_LABEL[p.service],
      before: null,
      after: null,
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!ctx.room().services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake()) throw new Error('Wake the room first')
  },
  async apply(ctx, p, steps) {
    const file = await backupServiceToFile(ctx, p.service)
    steps.push(`Backup written: ${file}`)
  },
  async verify(ctx, p) {
    const { readdirSync } = await import('node:fs')
    const dir = backupsDir(ctx)
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(p.service))
      .sort()
    const latest = files[files.length - 1]
    if (!latest) return { ok: false, detail: 'no backup file produced' }
    const size = statSync(join(dir, latest)).size
    return size > 0
      ? { ok: true, detail: `${latest} (${size} bytes)` }
      : { ok: false, detail: `${latest} is empty` }
  }
}

export const dbRestoreChange: ChangeDefinition<{ service: ServiceKind; backupId: string }> = {
  kind: 'db-restore',
  plan(ctx, p) {
    return {
      title: `${SERVICE_LABEL[p.service]} data restored`,
      component: SERVICE_LABEL[p.service],
      before: null,
      after: { backupId: p.backupId },
      undoable: true,
      undoStrategy: 'safety-backup-restore',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const current = ctx.room().services[p.service]
    if (!current) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake()) throw new Error('Wake the room first')
    const file = resolveRoomBackupFile(ctx.userData, ctx.roomId, p.service, p.backupId)
    if (p.service === 'postgres') assertPostgresBackupFits(file, p.backupId, current.version)
  },
  async capture(ctx, p) {
    const backupFile = await backupServiceToFile(ctx, p.service)
    ctx.log(`safety backup before restore: ${backupFile}`)
    return { backupFile }
  },
  async apply(ctx, p, steps) {
    const file = resolveRoomBackupFile(ctx.userData, ctx.roomId, p.service, p.backupId)
    steps.push(`Restore ${SERVICE_LABEL[p.service]} from ${p.backupId}`)
    await withWebPaused(ctx, () => restoreServiceFromFile(ctx, p.service, file))
  },
  verify(ctx, p) {
    return pingService(ctx, p.service)
  },
  async undo(ctx, entry) {
    const service = inferService(entry.title)
    const label = SERVICE_LABEL[service]
    const backupFile = removeCapturedBackup(entry.captured)
    if (!backupFile || !existsSync(backupFile)) {
      throw new Error(`${label} safety backup is missing — undo cannot bring back the data from before the restore`)
    }
    if (!ctx.isAwake()) throw new Error(`Wake the room first — restoring ${label} from its safety backup needs it running`)
    await withWebPaused(ctx, () => restoreServiceFromFile(ctx, service, backupFile))
  },
  verifyUndo(ctx, entry) {
    return pingService(ctx, inferService(entry.title))
  }
}
