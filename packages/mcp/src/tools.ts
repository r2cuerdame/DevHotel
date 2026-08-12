import { z } from 'zod'
import { zChangeId, zPmKind, zQuickChange, zRoomId } from '@devhotel/shared'
import type { ControlClient } from './client'

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: ToolContent[]; isError?: boolean }

/** The phone screen as raw pixels via in-room adb — no host SDK, no noVNC letterboxing. */
const SCREENCAP_CMD =
  "adb connect localhost:5555 >/dev/null 2>&1; adb -s localhost:5555 exec-out screencap -p | base64 | tr -d '\\n'"

async function screenshotContent(client: import('./client').ControlClient, roomId: string): Promise<ToolContent> {
  const result = (await client.execInRoom(roomId, ['sh', '-lc', SCREENCAP_CMD], 60_000)) as {
    code: number
    stdout: string
    stderr: string
  }
  const data = result.stdout.trim()
  if (result.code !== 0 || data.length < 100) {
    throw new Error(
      `screen capture failed (exit ${result.code}): ${result.stderr.slice(-200) || 'empty image'} — ` +
        'the room must be an awake Android room with its emulator running; apps using FLAG_SECURE block capture'
    )
  }
  return { type: 'image', data, mimeType: 'image/png' }
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
      description: 'List all DevHotel rooms with project, nickname, status, stack, and domain.',
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
      description: 'Start (wake) a room: its web server and services run again with preserved state.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => {
        await (await getClient()).startRoom(a.roomId)
        return `Room ${a.roomId} started.`
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
      description: 'Inspect a room: status, URL, stack, latest health check, recent changes and undoable change.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).inspectRoom(a.roomId))
    },
    {
      name: 'run_in_room',
      description:
        'Run a command inside the room (never on the host). Use for installs, builds, scripts. Returns exit code, stdout, stderr.',
      schema: {
        roomId: zRoomId,
        cmd: z.array(z.string()).min(1).describe('argv array, e.g. ["pnpm","install"]'),
        timeoutMs: z.number().int().positive().optional()
      },
      handler: wrap(async (a) => (await getClient()).execInRoom(a.roomId, a.cmd, a.timeoutMs))
    },
    {
      name: 'check_room',
      description:
        'Run DevHotel health checks on a room (runtime, deps, process, port, gateway, HTTPS, HTTP) and return the report with suggested fixes.',
      schema: { roomId: zRoomId },
      handler: wrap(async (a) => (await getClient()).runChecks(a.roomId))
    },
    {
      name: 'apply_quick_change',
      description:
        'Apply a quick change to a room as a verified, undoable transaction. Web rooms: node-version, package-manager, start-command, domain, https, internal-port, deps-install, service-install/version/restart/remove (postgres/redis), db-backup/restore, package-install. Android rooms: android-build (provenance APK), android-run (build, install and launch on the emulator screen), emulator-config (device/OS), start-command.',
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
        'One call answering "is DevHotel ready and what is running": app version, isolation backend health, gateway ports/routes, and every room with provider, status, domain, URL, and (for awake Android rooms) emulator state.',
      schema: {},
      handler: wrap(async () => (await getClient()).hotelStatus())
    },
    {
      name: 'android_screenshot',
      description:
        "Capture the Android room's phone screen and return it as an image — clean device pixels via in-room adb, no host SDK and no noVNC letterboxing. The room must be awake with its emulator running.",
      schema: { roomId: zRoomId },
      handler: async (a: { roomId: string }): Promise<ToolResult> => {
        try {
          return { content: [await screenshotContent(await getClient(), a.roomId)] }
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
      name: 'sync_from_host',
      description:
        "Request an inbound sync of the room's linked Host folder into the Room-owned working state. DevHotel shows an approval dialog to the human — this call blocks until they Allow or Deny, and fails if declined, if the room has no Host link, or if it is asleep. The synced path is always the room's own linked folder; agents cannot choose paths.",
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
