import { z } from 'zod'
import { zChangeId, zPmKind, zQuickChange, zRoomId } from '@devhotel/shared'
import type { ControlClient } from './client'

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: ToolContent[]; isError?: boolean }

async function screenshotContent(
  client: import('./client').ControlClient,
  roomId: string,
  mode: 'auto' | 'screen' = 'auto'
): Promise<ToolContent> {
  const shot = await client.screenshot(roomId, mode)
  return { type: 'image', data: shot.png, mimeType: 'image/png' }
}

/**
 * Bounded-output controls shared by run_in_room and read_run_output. They are
 * the reason an agent no longer has to wrap every command in grep/sed: the
 * Room applies the selection and keeps whatever the response could not carry.
 */
const outputControls = {
  maxBytes: z
    .number()
    .int()
    .min(256)
    .max(4_000_000)
    .optional()
    .describe('inline budget per stream, in bytes (default 64000)'),
  maxLines: z.number().int().min(1).max(1_000_000).optional().describe('inline budget per stream, in lines'),
  mode: z
    .enum(['head', 'tail'])
    .optional()
    .describe("which end to keep when output does not fit — run_in_room defaults to 'tail'; read_run_output defaults to 'head' for paging"),
  include: z.string().max(200).optional().describe('keep only lines containing this literal string'),
  exclude: z.string().max(200).optional().describe('drop lines containing this literal string'),
  ignoreCase: z.boolean().optional().describe('match ASCII letters in include/exclude case-insensitively')
}

type OutputArgs = {
  maxBytes?: number
  maxLines?: number
  mode?: 'head' | 'tail'
  include?: string
  exclude?: string
  ignoreCase?: boolean
}

function outputSelection(a: OutputArgs): OutputArgs {
  const out: OutputArgs = {}
  if (a.maxBytes !== undefined) out.maxBytes = a.maxBytes
  if (a.maxLines !== undefined) out.maxLines = a.maxLines
  if (a.mode !== undefined) out.mode = a.mode
  if (a.include !== undefined) out.include = a.include
  if (a.exclude !== undefined) out.exclude = a.exclude
  if (a.ignoreCase !== undefined) out.ignoreCase = a.ignoreCase
  return out
}

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
      description:
        'List all DevHotel rooms with project, nickname, live runtime status, stack, and domain. The read-only liveness check never starts or repairs a Room.',
      schema: {},
      handler: wrap(async () => (await getClient()).listRooms())
    },
    {
      name: 'create_room',
      description:
        'Create a new isolated room from a git URL or as an empty Room. Local folders require an explicit human grant in the DevHotel app and are unavailable to agents. Returns the created room.',
      schema: {
        sourceType: z.enum(['managed-git', 'empty']),
        sourceRef: z.string().describe('git URL for managed-git, empty string for empty'),
        project: z.string().describe('project name, e.g. the repo name'),
        nickname: z.string().describe('room nickname, e.g. "dev", "stage", "claude"'),
        provider: z
          .enum(['web', 'android'])
          .optional()
          .describe("'web' (default) serves the site; 'android' builds APKs and previews the room-owned emulator screen"),
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
      description:
        'Start (wake) a room: its web server and services run again with preserved state. Waking can outlast a tool ' +
        'timeout, so this returns the wake as an operation: `status` is "running", "succeeded" or "failed", `stage` ' +
        'says how far it got, and `error` carries the terminal failure. If it comes back "running", the Room is still ' +
        'starting — poll check_operation with the returned id. Calling this again while a wake is running joins that ' +
        'same wake, it never starts a second one.',
      schema: {
        roomId: zRoomId,
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe('how long DevHotel may hold this call waiting for the wake (default 10000; 0 returns at once)')
      },
      handler: wrap(async (a) => (await (await getClient()).startRoom(a.roomId, a.waitMs)).operation)
    },
    {
      name: 'check_operation',
      description:
        'Check a long DevHotel operation (today: waking a Room) by id, or list a Room’s recent operations. Checking ' +
        'never starts or repeats work. A "running" status means the operation is still in progress — your own earlier ' +
        'timeout did not fail it.',
      schema: {
        operationId: z.string().uuid().optional().describe('operation id returned by start_room'),
        roomId: zRoomId.optional().describe('list this Room’s recent operations instead'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe('with operationId: how long to wait for it to finish before answering (default 0)')
      },
      handler: wrap(async (a) => {
        const client = await getClient()
        if (a.operationId) return (await client.getOperation(a.operationId, a.waitMs)).operation
        if (a.roomId) return (await client.listRoomOperations(a.roomId)).operations
        throw new Error('Pass operationId to check one operation, or roomId to list a Room’s recent operations.')
      })
    },
    {
      name: 'sleep_room',
      description: 'Sleep a room: stops its whole process tree and frees CPU/RAM while keeping all data.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => {
        await (await getClient()).sleepRoom(a.roomId)
        return `Room ${a.roomId} is sleeping.`
      })
    },
    {
      name: 'inspect_room',
      description:
        'Inspect a room with read-only runtime revalidation: recorded status, live/degraded/dead components, recovery hint, URL, stack, latest health check, recent changes and undoable change.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).inspectRoom(a.roomId))
    },
    {
      name: 'run_in_room',
      description:
        'Run a command inside the room (never on the host). Dead runtimes are rejected with a stable DevHotel error code and recovery hint before Docker exec. Returns the exit code plus a BOUNDED view of stdout/stderr: by default the last 64000 bytes of each. Filter server-side with literal include/exclude substrings and choose head/tail with mode. Nothing is dropped silently — `output` reports raw versus returned bytes/lines, and complete raw output is retained under `output.runId` whenever the response omits content. UI input belongs here too: drive an Android room with `adb -s emulator-5554 shell input ...`, never with host mouse/keyboard automation aimed at DevHotel.',
      schema: {
        roomId: zRoomId,
        cmd: z.array(z.string()).min(1).describe('argv array, e.g. ["pnpm","install"]'),
        timeoutMs: z.number().int().positive().optional(),
        ...outputControls
      },
      handler: wrap(async (a) => (await getClient()).execInRoom(a.roomId, a.cmd, a.timeoutMs, outputSelection(a)))
    },
    {
      name: 'read_run_output',
      description:
        "Read output for a run whose output.retained flag is true (or a still-running run). Reads default to head paging: pass each nextOffset back as offsetBytes until eof. Filter server-side with literal include/exclude, or set encoding=base64 to recover arbitrary raw bytes exactly. Works while the command is still running.",
      schema: {
        roomId: zRoomId,
        runId: z
          .string()
          .uuid()
          .describe('run id from list_room_runs, or output.runId when run_in_room returned output.retained=true'),
        stream: z.enum(['stdout', 'stderr']).optional().describe("defaults to 'stdout'"),
        offsetBytes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('start at this byte offset: pass the previous read nextOffset to continue'),
        encoding: z
          .enum(['utf8', 'base64'])
          .optional()
          .describe("'utf8' (default) returns text; 'base64' returns exact bytes in contentBase64"),
        ...outputControls
      },
      handler: wrap(async (a) =>
        (await getClient()).readRunOutput(a.roomId, a.runId, {
          ...outputSelection(a),
          ...(a.stream !== undefined ? { stream: a.stream } : {}),
          ...(a.offsetBytes !== undefined ? { offsetBytes: a.offsetBytes } : {}),
          ...(a.encoding !== undefined ? { encoding: a.encoding } : {})
        })
      )
    },
    {
      name: 'list_room_runs',
      description:
        'List the commands running in the room right now and the finished runs whose complete output the room still holds. Running entries show bytes/lines produced so far, which answers "is it hung or just busy" and lets a reconnecting agent pick a run back up after a dropped call.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).listRuns(a.roomId))
    },
    {
      name: 'check_room',
      description:
        'Run DevHotel health checks on a room (runtime, deps, line endings, process, port, gateway, HTTPS, HTTP) and return the report with suggested fixes.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).runChecks(a.roomId))
    },
    {
      name: 'apply_quick_change',
      description:
        'Apply a quick change to a room as a verified, undoable transaction. Web rooms: node-version, package-manager, start-command, domain, https, internal-port, deps-install, service-install/version/restart/remove (postgres/redis), db-backup/restore, package-install. Android rooms: android-build (provenance APK), android-run (build, install and launch on the emulator screen), emulator-config (device/OS), start-command. Both: normalize-line-endings, which rewrites CRLF to LF in the Room copies of gradlew, mvnw, *.sh and other shebang scripts after a Windows Host import — never applied on its own, and undoable.',
      schema: { roomId: zRoomId, change: zQuickChange },
      handler: wrap(async (a) => (await getClient()).applyChange(a.roomId, a.change))
    },
    {
      name: 'undo_change',
      description: 'Undo a previously applied change by id (see inspect_room / list_changes results).',
      schema: { roomId: zRoomId, changeId: zChangeId },
      handler: wrap(async (a) => (await getClient()).undoChange(a.roomId, a.changeId))
    },
    {
      name: 'restart_web',
      description: "Restart the room's main process (web server, or the Android build container).",
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).restartWeb(a.roomId))
    },
    {
      name: 'clone_room',
      description:
        'Clone a Web room into a new nickname: copies environment and services, optionally dependencies and service data. The clone is an independent isolated room.',
      schema: {
        roomId: zRoomId,
        nickname: z.string().describe('nickname for the clone, e.g. "stage", "node24-test"'),
        copyDependencies: z.boolean().describe('copy the installed dependency volume instead of reinstalling'),
        services: z.enum(['copy', 'empty', 'exclude']).describe('copy service data, start services empty, or leave services out')
      },
      handler: wrap(async (a) =>
        (await getClient()).cloneRoom(a.roomId, {
          nickname: a.nickname,
          copyDependencies: a.copyDependencies,
          services: a.services
        })
      )
    },
    {
      name: 'rename_room',
      description: "Change a room's nickname.",
      schema: { roomId: zRoomId, nickname: z.string() },
      handler: wrap(async (a) => {
        await (await getClient()).renameRoom(a.roomId, a.nickname)
        return `Room ${a.roomId} renamed to ${a.nickname}.`
      })
    },
    {
      name: 'delete_room',
      description:
        'DESTRUCTIVE and irreversible: delete a room and all of its managed storage (dependencies, databases, browser profile). Returns reclaimed bytes.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).deleteRoom(a.roomId))
    },
    {
      name: 'list_changes',
      description: 'List the full change journal of a room: every change with status, before/after, and undoability.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).listChanges(a.roomId))
    },
    {
      name: 'room_components',
      description: 'List the installed programs of a room with live in-room versions (Node/JDK, package manager, services, emulator).',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).components(a.roomId))
    },
    {
      name: 'room_logs',
      description: "Tail a room's logs: 'web' is the main process stdout/stderr, 'orchestrator' is DevHotel's lifecycle log for the room.",
      schema: { roomId: zRoomId, kind: z.enum(['web', 'orchestrator']).optional().describe("defaults to 'web'") },
      handler: wrap(async (a) => (await getClient()).logs(a.roomId, a.kind ?? 'web'))
    },
    {
      name: 'copy_diagnostic',
      description:
        'Get the secret-redacted diagnostic bundle for a room — paste it into an LLM or issue to debug startup failures.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await (await getClient()).diagnostic(a.roomId)).text)
    },
    {
      name: 'hotel_status',
      description:
        'One read-only call answering "is DevHotel ready and what is actually running": app version, isolation backend health, gateway ports/routes, and every room with recorded status plus live running/degraded/dead component state. It never starts or repairs a Room.',
      schema: {},
      handler: wrap(async () => (await getClient()).hotelStatus())
    },
    {
      name: 'android_screenshot',
      description:
        "Capture the Android room's phone screen and return it as an image. Default 'auto' uses sharp guest-side screencap; pass mode 'screen' to grab the emulator display instead — that also captures apps that set FLAG_SECURE. The room must be awake. Read the returned image; never point host screen-capture or host input automation at the DevHotel preview window.",
      schema: {
        roomId: zRoomId,
        mode: z.enum(['auto', 'screen']).optional().describe("'screen' captures the display output, including FLAG_SECURE apps")
      },
      handler: async (a: { roomId: string; mode?: 'auto' | 'screen' }): Promise<ToolResult> => {
        try {
          return { content: [await screenshotContent(await getClient(), a.roomId, a.mode ?? 'auto')] }
        } catch (err) {
          return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      }
    },
    {
      name: 'android_run',
      description:
        'One-shot Android dev loop: build the room workspace, install EVERY built module APK, launch the chosen applicationId (default: first module) on the emulator, then return the change result plus a screenshot of the running app. Long call — the Gradle build alone can take minutes.',
      schema: {
        roomId: zRoomId,
        applicationId: z.string().optional().describe('which built module to launch, e.g. "com.example.app"; defaults to the first')
      },
      handler: async (a: { roomId: string; applicationId?: string }): Promise<ToolResult> => {
        try {
          const client = await getClient()
          const entry = await client.applyChange(a.roomId, {
            kind: 'android-run',
            ...(a.applicationId ? { applicationId: a.applicationId } : {})
          })
          const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(entry, null, 2) }]
          try {
            content.push(await screenshotContent(client, a.roomId))
          } catch (err) {
            content.push({ type: 'text', text: `screenshot skipped: ${err instanceof Error ? err.message : String(err)}` })
          }
          return { content }
        } catch (err) {
          return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      }
    },
    {
      name: 'room_pull_file',
      description:
        "Download a file from the room's workspace (an APK, test report, screenshot…) as base64. Absolute in-room path under /workspace; 16MB cap.",
      schema: {
        roomId: zRoomId,
        path: z.string().describe('absolute in-room path under /workspace')
      },
      handler: wrap(async (a) => (await getClient()).pullFile(a.roomId, a.path))
    },
    {
      name: 'room_push_file',
      description:
        "Upload a file into the room's workspace from base64 content. Absolute in-room path under /workspace; parent directories are created; 16MB cap. Marks the working state as modified.",
      schema: {
        roomId: zRoomId,
        path: z.string().describe('absolute in-room destination under /workspace'),
        contentBase64: z.string().describe('file content, base64-encoded')
      },
      handler: wrap(async (a) => (await getClient()).pushFile(a.roomId, a.path, a.contentBase64))
    },
    {
      name: 'reset_room',
      description:
        "Reset a room in place: it keeps its number, nickname, domain, plan, source code and change history, and gives back what it can rebuild — dependencies (reinstalled into a fresh layer), download/SDK caches, Room App data, and the browser profile. A safety backup of every Room App is taken before data is cleared. Not undoable; source code is never touched (use sync_from_host for that).",
      schema: {
        roomId: zRoomId,
        reinstallDependencies: z.boolean().optional().describe('default false'),
        clearCaches: z.boolean().optional().describe('default false'),
        services: z.enum(['keep', 'empty', 'remove']).optional().describe("default 'keep'; empty/remove need an awake room"),
        clearBrowserData: z.boolean().optional().describe('default false')
      },
      handler: wrap(async (a) =>
        (await getClient()).applyChange(a.roomId, {
          kind: 'room-reset',
          reinstallDependencies: a.reinstallDependencies ?? false,
          clearCaches: a.clearCaches ?? false,
          services: a.services ?? 'keep',
          clearBrowserData: a.clearBrowserData ?? false
        })
      )
    },
    {
      name: 'reset_sync_baseline',
      description:
        "Accept the room's current meaningful source files as the Host-sync baseline. Use after reviewing real source drift reported by sync_from_host; ordinary build outputs are ignored automatically. Reads and copies nothing: it only records the comparison point, is journaled, and the sync itself still needs its own human approval.",
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).resetSyncBaseline(a.roomId))
    },
    {
      name: 'sync_from_host',
      description:
        "Re-read the room's linked Host folder into the Room-owned working state. Runs under the room's inbound-sync grant (the human linked that folder when creating the room and can revoke agent sync per room), is journaled as the agent, and reads no other path — agents cannot choose paths. Build outputs are ignored; real Room source drift fails with conflictReason and exact changedPaths (see reset_sync_baseline). The generation it replaces is retained for recovery.",
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).syncFromHost(a.roomId))
    },
    {
      name: 'hotel_github_status',
      description:
        'Status of the Hotel-owned GitHub Service: pinned gh provisioning state and credential connection state. Connecting a token stays a human action in the DevHotel app.',
      schema: {},
      handler: wrap(async () => (await getClient()).hotelGithubStatus())
    },
    {
      name: 'hotel_github_install',
      description: 'Provision (download, verify, pin) the Hotel-owned gh build. Does not touch credentials.',
      schema: {},
      handler: wrap(async () => (await getClient()).hotelGithubInstall())
    }
  ]
}
