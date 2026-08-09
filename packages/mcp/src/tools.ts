import { z } from 'zod'
import { zPmKind, zProviderKind, zQuickChange, zSourceType } from '@devhotel/shared'
import type { ControlClient } from './client'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodRawShape
  handler: (args: any) => Promise<ToolResult>
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

function wrap(fn: (args: any) => Promise<unknown>): (args: any) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args))
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  }
}

/**
 * DevHotel MCP tools (goal.md §20). Every mutation is attributed to actor
 * 'agent' by the control API — users see and can undo agent changes in the UI.
 */
export function makeTools(getClient: () => Promise<ControlClient>): ToolDef[] {
  return [
    {
      name: 'list_rooms',
      description: 'List all DevHotel rooms with project, nickname, status, stack, and domain.',
      schema: {},
      handler: wrap(async () => (await getClient()).listRooms())
    },
    {
      name: 'create_room',
      description:
        'Create a new isolated room for a project (git URL, local folder, or empty). DevHotel auto-detects runtime, package manager, start command and port; pass overrides only when needed. Returns the created room.',
      schema: {
        sourceType: zSourceType,
        sourceRef: z.string().describe('git URL for managed-git, absolute folder path for linked-folder, empty string for empty'),
        project: z.string().describe('project name, e.g. the repo name'),
        nickname: z.string().describe('room nickname, e.g. "dev", "stage", "claude"'),
        provider: zProviderKind.optional().describe("'web' (default) or 'android' for a Gradle build room"),
        runtimeVersion: z.string().regex(/^\d+$/).optional().describe('Node major version override, e.g. "22"'),
        pmKind: zPmKind.optional(),
        startCommand: z.string().optional(),
        internalPort: z.number().int().optional(),
        https: z.boolean().optional()
      },
      handler: wrap(async (a) =>
        (await getClient()).createRoom({
          sourceType: a.sourceType,
          sourceRef: a.sourceRef,
          project: a.project,
          nickname: a.nickname,
          provider: a.provider,
          planOverrides: {
            runtimeVersion: a.runtimeVersion,
            pmKind: a.pmKind,
            startCommand: a.startCommand,
            internalPort: a.internalPort,
            https: a.https
          }
        })
      )
    },
    {
      name: 'start_room',
      description: 'Start (wake) a room: its web server and services run again with preserved state.',
      schema: { roomId: z.string() },
      handler: wrap(async (a) => {
        await (await getClient()).startRoom(a.roomId)
        return `Room ${a.roomId} started.`
      })
    },
    {
      name: 'sleep_room',
      description: 'Sleep a room: stops its whole process tree and frees CPU/RAM while keeping all data.',
      schema: { roomId: z.string() },
      handler: wrap(async (a) => {
        await (await getClient()).sleepRoom(a.roomId)
        return `Room ${a.roomId} is sleeping.`
      })
    },
    {
      name: 'inspect_room',
      description: 'Inspect a room: status, URL, stack, latest health check, recent changes and undoable change.',
      schema: { roomId: z.string() },
      handler: wrap(async (a) => (await getClient()).inspectRoom(a.roomId))
    },
    {
      name: 'run_in_room',
      description:
        'Run a command inside the room (never on the host). Use for installs, builds, scripts. Returns exit code, stdout, stderr.',
      schema: {
        roomId: z.string(),
        cmd: z.array(z.string()).min(1).describe('argv array, e.g. ["pnpm","install"]'),
        timeoutMs: z.number().int().positive().optional()
      },
      handler: wrap(async (a) => (await getClient()).execInRoom(a.roomId, a.cmd, a.timeoutMs))
    },
    {
      name: 'check_room',
      description:
        'Run DevHotel health checks on a room (runtime, deps, process, port, gateway, HTTPS, HTTP) and return the report with suggested fixes.',
      schema: { roomId: z.string() },
      handler: wrap(async (a) => (await getClient()).runChecks(a.roomId))
    },
    {
      name: 'apply_quick_change',
      description:
        'Apply a quick change to a room as a verified, undoable transaction: node-version, start-command, domain, https, internal-port, or deps-install.',
      schema: { roomId: z.string(), change: zQuickChange },
      handler: wrap(async (a) => (await getClient()).applyChange(a.roomId, a.change))
    },
    {
      name: 'undo_change',
      description: 'Undo a previously applied change by id (see inspect_room / apply_quick_change results).',
      schema: { roomId: z.string(), changeId: z.string() },
      handler: wrap(async (a) => (await getClient()).undoChange(a.roomId, a.changeId))
    },
    {
      name: 'copy_diagnostic',
      description:
        'Get the secret-redacted diagnostic bundle for a room — paste it into an LLM or issue to debug startup failures.',
      schema: { roomId: z.string() },
      handler: wrap(async (a) => (await (await getClient()).diagnostic(a.roomId)).text)
    }
  ]
}
