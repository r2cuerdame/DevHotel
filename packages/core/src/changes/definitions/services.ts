import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceKind } from '@devhotel/shared'
import { SERVICE_DB_NAME, SERVICE_DB_USER, SERVICE_DEFAULT_VERSIONS } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { sleep } from '../types'

const SERVICE_LABEL: Record<ServiceKind, string> = { postgres: 'PostgreSQL', redis: 'Redis' }

function backupsDir(ctx: ChangeCtx): string {
  const dir = join(ctx.userData, 'rooms', ctx.roomId, 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function pingService(ctx: ChangeCtx, svc: ServiceKind, timeoutMs = 60_000): Promise<{ ok: boolean; detail: string }> {
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

export async function backupServiceToFile(ctx: ChangeCtx, svc: ServiceKind): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
  if (svc === 'postgres') {
    const file = join(backupsDir(ctx), `postgres-${stamp}.sql`)
    const res = await ctx.backend.execInService(ctx.roomId, 'postgres', ['pg_dump', '-U', SERVICE_DB_USER, '-d', SERVICE_DB_NAME], {
      timeoutMs: 600_000
    })
    if (res.code !== 0) throw new Error(`pg_dump failed: ${res.stderr.slice(-300)}`)
    writeFileSync(file, res.stdout, 'utf8')
    return file
  }
  const file = join(backupsDir(ctx), `redis-${stamp}.rdb`)
  const save = await ctx.backend.execInService(ctx.roomId, 'redis', ['redis-cli', 'save'], { timeoutMs: 300_000 })
  if (save.code !== 0) throw new Error(`redis SAVE failed: ${save.stderr.slice(-300)}`)
  await ctx.backend.copyFromService(ctx.roomId, 'redis', '/data/dump.rdb', file)
  return file
}

async function restoreServiceFromFile(ctx: ChangeCtx, svc: ServiceKind, file: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`Backup file not found: ${file}`)
  if (svc === 'postgres') {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync(file, 'utf8')
    const reset = await ctx.backend.execInService(
      ctx.roomId,
      'postgres',
      ['psql', '-U', SERVICE_DB_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${SERVICE_DB_NAME}; CREATE DATABASE ${SERVICE_DB_NAME};`],
      { timeoutMs: 120_000 }
    )
    if (reset.code !== 0) throw new Error(`database reset failed: ${reset.stderr.slice(-300)}`)
    const res = await ctx.backend.execInService(ctx.roomId, 'postgres', ['psql', '-U', SERVICE_DB_USER, '-d', SERVICE_DB_NAME], {
      timeoutMs: 600_000,
      input: sql
    })
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

export const dbRestoreChange: ChangeDefinition<{ service: ServiceKind; file: string }> = {
  kind: 'db-restore',
  plan(ctx, p) {
    return {
      title: `${SERVICE_LABEL[p.service]} data restored`,
      component: SERVICE_LABEL[p.service],
      before: null,
      after: { file: p.file },
      undoable: true,
      undoStrategy: 'safety-backup-restore',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!ctx.room().services[p.service]) throw new Error(`${SERVICE_LABEL[p.service]} is not in this room`)
    if (!ctx.isAwake()) throw new Error('Wake the room first')
    if (!existsSync(p.file)) throw new Error(`Backup file not found: ${p.file}`)
  },
  async capture(ctx, p) {
    const backupFile = await backupServiceToFile(ctx, p.service)
    ctx.log(`safety backup before restore: ${backupFile}`)
    return { backupFile }
  },
  async apply(ctx, p, steps) {
    steps.push(`Restore ${SERVICE_LABEL[p.service]} from ${p.file}`)
    await restoreServiceFromFile(ctx, p.service, p.file)
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
