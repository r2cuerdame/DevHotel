import { z } from 'zod'

/** Zod schemas shared by the loopback control API (main process) and the MCP server. */

export const zSourceType = z.enum(['managed-git', 'linked-folder', 'empty'])
export const zActor = z.enum(['user', 'devhotel', 'agent'])
export const zPmKind = z.enum(['npm', 'pnpm'])
export const zProviderKind = z.enum(['web', 'android'])
export const zServiceKind = z.enum(['postgres', 'redis'])

export const zQuickChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node-version'), version: z.string().regex(/^\d+$/, 'major version like "22"') }),
  z.object({ kind: z.literal('start-command'), command: z.string().min(1) }),
  z.object({ kind: z.literal('domain'), domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.localhost$/) }),
  z.object({ kind: z.literal('https'), enabled: z.boolean() }),
  z.object({ kind: z.literal('internal-port'), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal('deps-install'), clean: z.boolean() }),
  z.object({ kind: z.literal('android-build') }),
  z.object({ kind: z.literal('service-add'), service: zServiceKind, version: z.string().regex(/^\d+$/).optional() }),
  z.object({ kind: z.literal('service-remove'), service: zServiceKind }),
  z.object({ kind: z.literal('service-restart'), service: zServiceKind }),
  z.object({ kind: z.literal('db-backup'), service: zServiceKind }),
  z.object({ kind: z.literal('db-restore'), service: zServiceKind, file: z.string().min(1) })
])

export const zPlanRoomInput = z.object({
  sourceType: zSourceType,
  sourceRef: z.string(),
  nickname: z.string().min(1).max(60),
  project: z.string().min(1).max(100).optional(),
  provider: zProviderKind.optional()
})

export const zCreateRoomInput = z.object({
  sourceType: zSourceType,
  sourceRef: z.string(),
  project: z.string().min(1).max(100),
  nickname: z.string().min(1).max(60),
  actor: zActor,
  provider: zProviderKind.optional(),
  planOverrides: z
    .object({
      runtimeVersion: z.string().regex(/^\d+$/).optional(),
      pmKind: zPmKind.optional(),
      startCommand: z.string().min(1).optional(),
      internalPort: z.number().int().min(1).max(65535).optional(),
      domain: z.string().optional(),
      https: z.boolean().optional()
    })
    .optional()
})

export const zRunInRoomInput = z.object({
  roomId: z.string().min(1),
  cmd: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional()
})

export interface ControlInfo {
  port: number
  token: string
  pid: number
  version: string
}

/**
 * Loopback control API surface (main process serves it; MCP consumes it).
 * All routes are prefixed /v1 and require `Authorization: Bearer <token>`.
 * Mutations through this API are always attributed to actor 'agent'.
 */
export const CONTROL_ROUTES = {
  ping: { method: 'GET', path: '/v1/ping' },
  listRooms: { method: 'GET', path: '/v1/rooms' },
  createRoom: { method: 'POST', path: '/v1/rooms' },
  inspectRoom: { method: 'GET', path: '/v1/rooms/:id' },
  startRoom: { method: 'POST', path: '/v1/rooms/:id/start' },
  sleepRoom: { method: 'POST', path: '/v1/rooms/:id/sleep' },
  execInRoom: { method: 'POST', path: '/v1/rooms/:id/exec' },
  runChecks: { method: 'POST', path: '/v1/rooms/:id/checks' },
  applyChange: { method: 'POST', path: '/v1/rooms/:id/changes' },
  undoChange: { method: 'POST', path: '/v1/rooms/:id/undo' },
  diagnostic: { method: 'GET', path: '/v1/rooms/:id/diagnostic' }
} as const

export const zApplyChangeBody = z.object({ change: zQuickChange })
export const zUndoChangeBody = z.object({ changeId: z.string().min(1) })
export const zExecBody = z.object({
  cmd: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional()
})
