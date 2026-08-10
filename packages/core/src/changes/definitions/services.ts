import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { zBackupId, type ServiceKind } from '@devhotel/shared'
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

/** Resolve a public opaque backup ID only inside its owning Room's plain backups directory. */
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
          ? await ctx.backend.execInService(ctx.roomId, svc, ['pg_isready', '-U', SERVICE_DB_USER], { timeoutMs: 10_000 })
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

/**
 * Awake clones use a portable logical dump of DevHotel's managed database.
 * Reject whole-instance state which that format cannot faithfully represent;
 * sleeping clones use a stopped full-volume copy and therefore need no check.
 */
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
      // A completed dump becomes visible atomically; crashes and disk errors
      // leave at most a uniquely named .partial file which finally removes.
      renameSync(partial, file)
      return file
    } finally {
      rmSync(partial, { force: true })
    }
  }
  const file = join(backupsDir(ctx), `redis-${stamp}-${unique}.rdb`)
  const partial = `${file}.${randomUUID()}.partial`
  try {
    const save = await ctx.backend.execInService(ctx.roomId, 'redis', ['redis-cli', 'save'], { timeoutMs: 300_000 })
    if (save.code !== 0) throw new Error(`redis SAVE failed: ${save.stderr.slice(-300)}`)
    await ctx.backend.copyFromService(ctx.roomId, 'redis', '/data/dump.rdb', partial)
    if (statSync(partial).size === 0) throw new Error('Redis SAVE produced an empty backup')
    renameSync(partial, file)
    return file
  } finally {
    rmSync(partial, { force: true })
  }
}

export async function restoreServiceFromFile(ctx: ChangeCtx, svc: ServiceKind, file: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`Backup file not found: ${file}`)
  if (svc === 'postgres') {
    // separate -c invocations: DROP DATABASE refuses to run inside the implicit
    // transaction psql wraps around a single multi-statement -c
    const drop = await ctx.backend.execInService(
      ctx.roomId,
      'postgres',
      ['psql', '-U', SERVICE_DB_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${SERVICE_DB_NAME};`],
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
  await ctx.backend.copyToService(ctx.roomId, 'redis', file, '/data/dump.rdb')
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
    const service = (entry.captured as { service: ServiceKind } | null)?.service ?? inferService(entry.title)
    const services = { ...ctx.room().services }
    delete services[service]
    ctx.rooms.update(ctx.roomId, { services })
    await ctx.backend.removeService(ctx.roomId, service, { volume: true })
  }
}

function inferService(title: string): ServiceKind {
  return title.startsWith('Redis') ? 'redis' : 'postgres'
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
  },
  async capture(ctx, p) {
    const version = ctx.room().services[p.service]!.version
    if (ctx.isAwake() && (await ctx.backend.serviceState(ctx.roomId, p.service)) === 'running') {
      const backupFile = await backupServiceToFile(ctx, p.service)
      ctx.log(`safety backup: ${backupFile}`)
      return { version, backupFile }
    }
    return { version, backupFile: null }
  },
  async apply(ctx, p, steps) {
    const services = { ...ctx.room().services }
    delete services[p.service]
    ctx.rooms.update(ctx.roomId, { services })
    steps.push(`Remove ${SERVICE_LABEL[p.service]} and its data volume`)
    await ctx.backend.removeService(ctx.roomId, p.service, { volume: true })
  },
  async verify(ctx, p) {
    const state = await ctx.backend.serviceState(ctx.roomId, p.service)
    return state === 'missing'
      ? { ok: true, detail: `${SERVICE_LABEL[p.service]} removed; safety backup kept in the room's backups folder` }
      : { ok: false, detail: `${SERVICE_LABEL[p.service]} container still exists` }
  },
  async undo(ctx, entry) {
    const captured = entry.captured as { version: string; backupFile: string | null } | null
    const service = inferService(entry.title)
    const version = captured?.version ?? SERVICE_DEFAULT_VERSIONS[service]
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [service]: { version } } })
    if (ctx.isAwake()) {
      await materializeService(ctx, service, version)
      const ping = await pingService(ctx, service)
      if (!ping.ok) throw new Error(ping.detail)
      if (captured?.backupFile) await restoreServiceFromFile(ctx, service, captured.backupFile)
    }
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
    if (!ctx.isAwake()) throw new Error('Wake the room first — the data is backed up before switching')
  },
  async apply(ctx, p, steps) {
    const prevVersion = ctx.room().services[p.service]!.version
    steps.push('Back up the current data')
    const backupFile = await backupServiceToFile(ctx, p.service)
    steps.setCaptured({ prevVersion, backupFile })
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [p.service]: { version: p.version } } })
    steps.push(`Recreate ${SERVICE_LABEL[p.service]} ${p.version} with a fresh data volume`)
    await ctx.backend.removeService(ctx.roomId, p.service, { volume: true })
    await ctx.backend.createService(ctx.roomId, p.service, p.version)
    const ping = await pingService(ctx, p.service)
    if (!ping.ok) throw new Error(ping.detail)
    steps.push('Restore the data into the new version')
    await restoreServiceFromFile(ctx, p.service, backupFile)
  },
  canRollbackApplyFailure(_ctx, _p, captured) {
    const backup = captured as { prevVersion?: unknown; backupFile?: unknown } | null
    return typeof backup?.prevVersion === 'string' && typeof backup.backupFile === 'string'
  },
  async verify(ctx, p) {
    return pingService(ctx, p.service)
  },
  async undo(ctx, entry) {
    const captured = entry.captured as { prevVersion: string; backupFile: string } | null
    const service = inferService(entry.title)
    const prevVersion = captured?.prevVersion ?? SERVICE_DEFAULT_VERSIONS[service]
    ctx.rooms.update(ctx.roomId, { services: { ...ctx.room().services, [service]: { version: prevVersion } } })
    if (ctx.isAwake()) {
      await ctx.backend.removeService(ctx.roomId, service, { volume: true })
      await ctx.backend.createService(ctx.roomId, service, prevVersion)
      const ping = await pingService(ctx, service)
      if (!ping.ok) throw new Error(ping.detail)
      if (captured?.backupFile) await restoreServiceFromFile(ctx, service, captured.backupFile)
    }
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
    // newest backup for this service must exist and be non-empty
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
    if (!ctx.room().services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake()) throw new Error('Wake the room first')
    resolveRoomBackupFile(ctx.userData, ctx.roomId, p.service, p.backupId)
  },
  async capture(ctx, p) {
    const backupFile = await backupServiceToFile(ctx, p.service)
    ctx.log(`safety backup before restore: ${backupFile}`)
    return { backupFile }
  },
  async apply(ctx, p, steps) {
    const file = resolveRoomBackupFile(ctx.userData, ctx.roomId, p.service, p.backupId)
    steps.push(`Restore ${SERVICE_LABEL[p.service]} from ${p.backupId}`)
    await restoreServiceFromFile(ctx, p.service, file)
  },
  verify(ctx, p) {
    return pingService(ctx, p.service)
  },
  async undo(ctx, entry) {
    const captured = entry.captured as { backupFile: string } | null
    if (!captured?.backupFile) throw new Error('No safety backup was captured')
    const service = inferService(entry.title)
    await restoreServiceFromFile(ctx, service, captured.backupFile)
  }
}
