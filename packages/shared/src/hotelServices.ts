import { z } from 'zod'

export const zHotelServiceId = z.string().min(1).max(240).regex(/^[A-Za-z0-9._/@:-]+$/)
export const zHotelServiceCategory = z.enum([
  'integration',
  'mcp',
  'skill',
  'device',
  'credential',
  'scheduler',
  'registry'
])
export const zHotelServiceAdapterId = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/)
export const zHotelServiceInterface = z.enum(['cli', 'remote-http', 'agent-native'])
export const zHotelServiceContext = z.enum(['hotel', 'host-project', 'room'])
export const zHotelServiceScopeRef = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
export const zHotelServiceAvailability = z.enum(['available', 'unavailable'])
export const zHotelServiceRegistrationState = z.enum(['registered', 'unregistered'])
export const zHotelServiceProvisionState = z.enum(['not-provisioned', 'provisioning', 'provisioned', 'repair-needed', 'failed'])
export const zHotelServiceConnectionState = z.enum([
  'not-applicable',
  'disconnected',
  'connected',
  'unavailable',
  'invalid',
  'temporarily-unavailable'
])

const zManifestVersion = z.object({
  current: z.string().min(1).max(128),
  pin: z.object({
    mode: z.enum(['exact', 'major', 'none']),
    value: z.string().min(1).max(128).nullable()
  }).strict(),
  update: z.object({
    mode: z.enum(['manual', 'automatic', 'disabled']),
    channel: z.string().min(1).max(80)
  }).strict(),
  rollback: z.object({
    supported: z.boolean(),
    strategy: z.enum(['previous-version', 'reprovision', 'none'])
  }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.pin.mode === 'none' && value.pin.value !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pin', 'value'], message: 'an unpinned service cannot carry a pin value' })
  }
  if (value.pin.mode !== 'none' && value.pin.value === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pin', 'value'], message: 'a pinned service requires a pin value' })
  }
  if (!value.rollback.supported && value.rollback.strategy !== 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rollback', 'strategy'], message: 'unsupported rollback must use the none strategy' })
  }
})

const zManifestPermission = z.object({
  id: zHotelServiceAdapterId,
  title: z.string().min(1).max(160),
  access: z.enum(['read', 'write', 'secret', 'external-resource']),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  approval: z.enum(['none', 'once', 'per-use'])
}).strict()

/**
 * Portable catalog contract. Service-specific implementations live behind
 * adapterId; adding one never requires a new core/MCP operation or schema.
 */
export const zHotelServiceManifest = z.object({
  schemaVersion: z.literal(1),
  id: zHotelServiceId,
  title: z.string().min(1).max(240),
  description: z.string().max(4000),
  category: zHotelServiceCategory,
  adapterId: zHotelServiceAdapterId,
  interface: zHotelServiceInterface,
  version: zManifestVersion,
  lifecycle: z.object({
    install: z.boolean(),
    update: z.boolean(),
    start: z.boolean(),
    stop: z.boolean(),
    restart: z.boolean(),
    remove: z.boolean(),
    rollback: z.boolean()
  }).strict(),
  supportedContexts: z.array(zHotelServiceContext).min(1).max(3),
  permissions: z.array(zManifestPermission).max(64),
  health: z.object({
    capability: z.enum(['none', 'status', 'probe']),
    timeoutMs: z.number().int().min(100).max(120_000).nullable()
  }).strict()
}).strict().superRefine((value, ctx) => {
  if (new Set(value.supportedContexts).size !== value.supportedContexts.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['supportedContexts'], message: 'contexts must be unique' })
  }
  const permissionIds = value.permissions.map((permission) => permission.id)
  if (new Set(permissionIds).size !== permissionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permissions'], message: 'permission ids must be unique' })
  }
  if (value.health.capability === 'none' && value.health.timeoutMs !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['health', 'timeoutMs'], message: 'a service without health capability cannot have a timeout' })
  }
  if (value.health.capability !== 'none' && value.health.timeoutMs === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['health', 'timeoutMs'], message: 'health capability requires a timeout' })
  }
})

export type HotelServiceManifest = z.infer<typeof zHotelServiceManifest>
export type HotelServiceContext = z.infer<typeof zHotelServiceContext>
export type HotelServiceAvailability = z.infer<typeof zHotelServiceAvailability>
export type HotelServiceProvisionState = z.infer<typeof zHotelServiceProvisionState>
export type HotelServiceConnectionState = z.infer<typeof zHotelServiceConnectionState>

export interface HotelServiceRecord {
  manifest: HotelServiceManifest
  availability: HotelServiceAvailability
  registrationState: z.infer<typeof zHotelServiceRegistrationState>
  provisionState: HotelServiceProvisionState
  connectionState: HotelServiceConnectionState
  enabled: boolean
  statusDetail: string | null
  createdAt: string
  updatedAt: string
}

export const zHotelServiceRegistrationInput = z.object({
  manifest: zHotelServiceManifest,
  availability: zHotelServiceAvailability,
  enabled: z.boolean(),
  initialConnectionState: z.enum(['not-applicable', 'disconnected'])
}).strict()

export const zHotelServiceStatePatch = z.object({
  availability: zHotelServiceAvailability.optional(),
  registrationState: zHotelServiceRegistrationState.optional(),
  provisionState: zHotelServiceProvisionState.optional(),
  connectionState: zHotelServiceConnectionState.optional(),
  enabled: z.boolean().optional(),
  statusDetail: z.string().max(1000).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'state patch cannot be empty')

export const zHotelServiceAssignmentInput = z.object({
  serviceId: zHotelServiceId,
  scopeKind: zHotelServiceContext,
  scopeRef: zHotelServiceScopeRef.nullable(),
  agentAdapterId: zHotelServiceAdapterId,
  enabled: z.boolean(),
  approved: z.literal(true)
}).strict().superRefine((value, ctx) => {
  if (value.scopeKind === 'hotel' && value.scopeRef !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeRef'], message: 'Hotel scope cannot carry a scope reference' })
  }
  if (value.scopeKind !== 'hotel' && value.scopeRef === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeRef'], message: `${value.scopeKind} scope requires a reference` })
  }
  if (value.scopeKind === 'host-project' && value.scopeRef !== null && !/^project:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.scopeRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeRef'], message: 'Host-project scope requires an opaque project grant ID' })
  }
  if (value.scopeKind === 'room' && value.scopeRef !== null && !/^[a-z0-9]{8}$/.test(value.scopeRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeRef'], message: 'Room scope requires a valid Room ID' })
  }
})

export type HotelServiceRegistrationInput = z.infer<typeof zHotelServiceRegistrationInput>
export type HotelServiceStatePatch = z.infer<typeof zHotelServiceStatePatch>
export type HotelServiceAssignmentInput = z.infer<typeof zHotelServiceAssignmentInput>

export interface HotelServiceAssignment {
  id: string
  serviceId: string
  scopeKind: HotelServiceContext
  scopeRef: string | null
  agentAdapterId: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HotelServiceInjection {
  id: string
  assignmentId: string
  relativePath: string
  managedKey: string
  contentHash: string
  createdAt: string
  updatedAt: string
}

export interface McpRegistryItem {
  id: string
  name: string
  title: string
  description: string
  version: string
  status: string
  installMode: 'remote-http' | 'managed-runtime-required'
  remoteUrl: string | null
  packageKinds: string[]
}

export interface McpRegistryPage {
  items: McpRegistryItem[]
  nextCursor: string | null
  fromCache: boolean
}

export const zMcpRegistrySearch = z.string().trim().max(100)
export const zMcpRegistryCursor = z.string().min(1).max(500)
export const zMcpRegistryLimit = z.number().int().min(1).max(50)
export const zGitHubToken = z.string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_]+$/, 'valid GitHub token characters')

export const zMcpRegistryResponse = z.object({
  servers: z.array(z.object({
    server: z.object({
      name: z.string().min(1).max(240), title: z.string().max(240).optional(),
      description: z.string().max(4000).optional(), version: z.string().min(1).max(128),
      remotes: z.array(z.object({ type: z.string().max(80), url: z.string().url().max(2048) }).passthrough()).max(20).optional(),
      packages: z.array(z.object({ registryType: z.string().max(80) }).passthrough()).max(20).optional()
    }).passthrough(),
    _meta: z.record(z.unknown()).optional()
  }).passthrough()).max(50),
  metadata: z.object({ count: z.number().int().nonnegative(), nextCursor: z.string().max(500).optional() }).passthrough()
}).passthrough()

export interface GitHubServiceStatus {
  installed: boolean
  installing: boolean
  version: string | null
  pinnedVersion: string
  provisionState: 'not-provisioned' | 'provisioning' | 'provisioned' | 'repair-needed' | 'failed'
  authenticated: boolean
  account: string | null
  credentialState: 'disconnected' | 'connected' | 'unavailable' | 'invalid' | 'temporarily-unavailable'
  credentialVaultAvailable: boolean
  detail: string
}
