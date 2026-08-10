import { z } from 'zod'

/** Zod schemas shared by the loopback control API (main process) and the MCP server. */

export const zSourceType = z.enum(['managed-git', 'linked-folder', 'empty'])
export const zActor = z.enum(['user', 'devhotel', 'agent'])
export const zPmKind = z.enum(['npm', 'pnpm'])
export const zProviderKind = z.enum(['web', 'android'])
export const zServiceKind = z.enum(['postgres', 'redis'])
export const zRoomId = z.string().regex(/^[a-z0-9]{8}$/, 'valid Room ID')
export const zChangeId = z.string().uuid()
export const zTermId = z.string().uuid()
export const zNickname = z.string().trim().min(1).max(60)
export const zLocalDomain = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.localhost$/)
export const zBackupId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^(postgres|redis)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[0-9a-f]{8})?\.(sql|rdb)$/i)
export const zRegistryPackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, 'valid npm registry package name')
export const zRegistryPackageVersion = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'exact semantic version')
export const zPackageSearchQuery = z.string().trim().min(1).max(100)
export const zPackageSearchOffset = z.number().int().min(0).max(1000)
export const zNpmSearchResponse = z.object({
  objects: z
    .array(
      z.object({
        package: z.object({
          name: z.string().min(1).max(214),
          version: z.string().min(1).max(128),
          description: z.string().max(2000).optional(),
          date: z.string().max(64).optional(),
          publisher: z.object({ username: z.string().max(200).optional() }).optional()
        })
      })
    )
    .max(50)
})

export const zQuickChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node-version'), version: z.string().regex(/^\d+$/, 'major version like "22"') }).strict(),
  z.object({ kind: z.literal('start-command'), command: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('domain'), domain: zLocalDomain }).strict(),
  z.object({ kind: z.literal('https'), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('internal-port'), port: z.number().int().min(1).max(65535) }).strict(),
  z.object({ kind: z.literal('deps-install'), clean: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('package-install'),
      name: zRegistryPackageName,
      version: zRegistryPackageVersion,
      dev: z.boolean()
    })
    .strict(),
  z.object({ kind: z.literal('android-build') }).strict(),
  z.object({ kind: z.literal('android-run') }).strict(),
  z.object({
    kind: z.literal('package-manager'),
    pm: z.enum(['npm', 'pnpm']),
    version: z.string().regex(/^\d+(\.\d+){0,2}$/).optional()
  }).strict(),
  z.object({
    kind: z.literal('emulator-config'),
    device: z.string().regex(/^[A-Za-z0-9 ().-]{2,40}$/),
    version: z.enum(['14.0', '13.0', '12.0', '11.0'])
  }).strict(),
  z.object({ kind: z.literal('service-version'), service: zServiceKind, version: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('service-add'), service: zServiceKind, version: z.string().regex(/^\d+$/).optional() }).strict(),
  z.object({ kind: z.literal('service-remove'), service: zServiceKind }).strict(),
  z.object({ kind: z.literal('service-restart'), service: zServiceKind }).strict(),
  z.object({ kind: z.literal('db-backup'), service: zServiceKind }).strict(),
  z.object({ kind: z.literal('db-restore'), service: zServiceKind, backupId: zBackupId }).strict(),
  z.object({
    kind: z.literal('os-settings'),
    os: z.object({
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)),
      cpus: z.number().positive().max(64).optional(),
      memoryMB: z.number().int().min(256).max(131072).optional(),
      timezone: z
        .string()
        .regex(/^[A-Za-z0-9_+\-/]{1,64}$/)
        .optional()
    }).strict()
  }).strict()
])

export const zPlanRoomInput = z.object({
  sourceType: zSourceType,
  sourceRef: z.string().max(4096),
  nickname: zNickname,
  project: z.string().trim().min(1).max(100).optional(),
  provider: zProviderKind.optional()
}).strict()

/** User-approved desktop creation supports Web and build-only Android Rooms. */
export const zRendererPlanRoomInput = zPlanRoomInput
export type RendererPlanRoomInput = z.infer<typeof zRendererPlanRoomInput>

export const zCreateRoomInput = z.object({
  sourceType: zSourceType,
  sourceRef: z.string().max(4096),
  project: z.string().trim().min(1).max(100),
  nickname: zNickname,
  actor: zActor,
  provider: zProviderKind.optional(),
  planOverrides: z
    .object({
      runtimeVersion: z.string().regex(/^\d+$/).optional(),
      pmKind: zPmKind.optional(),
      startCommand: z.string().min(1).optional(),
      internalPort: z.number().int().min(1).max(65535).optional(),
      domain: zLocalDomain.optional(),
      https: z.boolean().optional()
    }).strict()
    .optional()
}).strict()

const zPublicWebCreateRoomInput = zCreateRoomInput
  .omit({ actor: true })
  .extend({ provider: z.literal('web').optional() })
  .strict()

/** Agent calls cannot create a host bind mount until a future explicit grant API exists. */
export const zAgentCreateRoomInput = zPublicWebCreateRoomInput
  .refine((input) => input.sourceType !== 'linked-folder', {
    message: 'Agents cannot create linked-folder Rooms without a user-approved host-folder grant',
    path: ['sourceType']
  })
export type AgentCreateRoomInput = z.infer<typeof zAgentCreateRoomInput>

export const zRendererCreateRoomInput = zCreateRoomInput.omit({ actor: true }).strict()
export type RendererCreateRoomInput = z.infer<typeof zRendererCreateRoomInput>

export const zCloneRoomInput = z.object({
  sourceRoomId: zRoomId,
  nickname: zNickname,
  copyDependencies: z.boolean(),
  services: z.enum(['copy', 'empty', 'exclude']),
  actor: zActor
}).strict()

export const zRendererCloneRoomInput = zCloneRoomInput.omit({ actor: true })

export const zRunInRoomInput = z.object({
  roomId: zRoomId,
  cmd: z.array(z.string().max(16_384)).min(1).max(256),
  timeoutMs: z.number().int().positive().max(600_000).optional()
}).strict()

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

export const zApplyChangeBody = z.object({ change: zQuickChange }).strict()
export const zUndoChangeBody = z.object({ changeId: zChangeId }).strict()
export const zExecBody = z.object({
  cmd: z.array(z.string().max(16_384)).min(1).max(256),
  timeoutMs: z.number().int().positive().max(600_000).optional()
}).strict()

export const zRenameRoomInput = z.object({ roomId: zRoomId, nickname: zNickname }).strict()
export const zLogKind = z.enum(['web', 'orchestrator'])
export const zRoomLogInput = z.object({ roomId: zRoomId, kind: zLogKind }).strict()
export const zRoomChangeInput = z.object({ roomId: zRoomId, changeId: zChangeId }).strict()
export const zRendererSettingKey = z.literal('lang')
export const zRendererSettingValue = z.enum(['en', 'ko', 'ja', 'zh-CN', 'es', 'fr', 'de', 'pt-BR', 'ru'])
export const zRendererSettingInput = z
  .object({ key: zRendererSettingKey, value: zRendererSettingValue })
  .strict()
export const zHostPath = z.string().min(1).max(32_768)
export const zExternalHttpUrl = z
  .string()
  .url()
  .max(8192)
  .refine((value) => /^https?:\/\//i.test(value), 'only http(s) URLs are allowed')
export const zAutostartEnabled = z.boolean()
export const zTermInput = z.object({ termId: zTermId, data: z.string().max(65_536) }).strict()
export const zTermResize = z
  .object({ termId: zTermId, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) })
  .strict()
export const zPreviewNavAction = z.enum(['back', 'forward', 'reload', 'home'])
export const zPreviewTarget = z.enum(['left', 'right', 'both'])
export const zPreviewVisible = z.boolean()
export const zPreviewBounds = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000)
  })
  .strict()
export const zPreviewViewport = z
  .object({ width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) })
  .strict()
export const zOptionalPreviewViewport = zPreviewViewport.nullable()
export const zPreviewLayout = z
  .object({
    mode: z.enum(['single', 'split']),
    leftViewport: zOptionalPreviewViewport,
    rightViewport: zPreviewViewport
  })
  .strict()
