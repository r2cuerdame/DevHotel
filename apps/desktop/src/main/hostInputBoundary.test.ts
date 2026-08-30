import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Session } from 'electron'
import { describe, expect, it } from 'vitest'
import { HOST_INPUT_CAPABILITIES, HOST_INPUT_PERMISSIONS, hostInputCapability } from '@devhotel/shared'
import { EMULATOR_ADB_SERIAL } from '@devhotel/core'
import { androidActionCommand } from './androidInput'
import { hardenRoomSession } from './roomSessionPolicy'

/**
 * The Host-input isolation contract, enforced.
 *
 * A test running inside a Room must not move the Host cursor, change Host
 * keyboard state, or take the Host foreground window. Three layers prove it:
 * the shipped source contains no API that *can* do those things, the Room
 * control paths that do exist are Room-local, and the one capability that
 * genuinely takes the Host desktop is user-only and journaled.
 *
 * `hostInputProbe.globalSetup.ts` adds the live Host observation on top.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const THIS_FILE = resolve(import.meta.filename)

const SCANNED_ROOTS = ['apps', 'packages']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.ps1']
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'release', '.git', 'coverage'])

/**
 * APIs whose entire purpose is to drive the real mouse, the real keyboard, or
 * the foreground window. None of them belong in a product whose promise is
 * "give AI a room, not your computer" — so their absence is asserted rather
 * than assumed.
 */
const BANNED_HOST_INPUT_APIS: { api: string; pattern: RegExp }[] = [
  { api: 'robotjs', pattern: /\brobotjs\b/i },
  { api: 'nut.js', pattern: /@nut-tree|\bnut-js\b/i },
  { api: 'iohook', pattern: /\biohook\b/i },
  { api: 'node-key-sender', pattern: /node-key-sender/i },
  { api: 'user32 SendInput', pattern: /\bSendInput\b/ },
  { api: 'user32 keybd_event', pattern: /\bkeybd_event\b/ },
  { api: 'user32 mouse_event', pattern: /\bmouse_event\b/ },
  { api: 'user32 SetCursorPos', pattern: /\bSetCursorPos\b/ },
  { api: 'user32 SetForegroundWindow', pattern: /\bSetForegroundWindow\b/ },
  { api: 'user32 BlockInput', pattern: /\bBlockInput\b/ },
  { api: 'WScript SendKeys', pattern: /\bSendKeys\b/ },
  { api: 'xdotool', pattern: /\bxdotool\b/ },
  { api: 'ydotool', pattern: /\bydotool\b/ },
  { api: 'wtype', pattern: /\bwtype\b/ },
  { api: 'pyautogui', pattern: /\bpyautogui\b/i },
  { api: 'AutoHotkey', pattern: /\bAutoHotkey\b|\.ahk\b/i },
  {
    api: 'Electron foreground grab',
    pattern: /\.setAlwaysOnTop\(|\.setKiosk\(|\.setFullScreen\(|\.flashFrame\(|\.moveTop\(|\bapp\.focus\(/
  },
  { api: 'Electron window raise', pattern: /\b(win|window|mainWindow)\.(focus|show)\(/ }
]

/** npm packages that exist to synthesize real Host input. */
const BANNED_HOST_INPUT_PACKAGES = [
  'robotjs',
  '@nut-tree/nut-js',
  '@nut-tree-fork/nut-js',
  '@jitsi/robotjs',
  'iohook',
  'node-key-sender',
  'nutjs'
]

interface Exemption {
  file: string
  api: string
  why: string
}

/**
 * The complete set of places DevHotel is allowed to touch the Host foreground.
 * Both are the user asking for their own window back; neither is reachable
 * from a Room, a Job, an Agent, or a test.
 */
const EXEMPTIONS: Exemption[] = [
  {
    file: 'apps/desktop/src/main/index.ts',
    api: 'Electron window raise',
    why: 'Launching DevHotel a second time raises the window that already exists. User-initiated only.'
  },
  {
    file: 'apps/desktop/src/main/tray.ts',
    api: 'Electron window raise',
    why: 'Clicking the tray icon opens the app window. User-initiated only.'
  }
]

interface Finding {
  file: string
  line: number
  api: string
  text: string
}

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full)
      } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(full)
      }
    }
  }
  for (const root of SCANNED_ROOTS) walk(join(REPO_ROOT, root))
  return found
}

function scanForHostInputApis(): Finding[] {
  const findings: Finding[] = []
  for (const file of sourceFiles()) {
    // The policy itself names these APIs in order to ban them.
    if (resolve(file) === THIS_FILE) continue
    const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((text, index) => {
      for (const { api, pattern } of BANNED_HOST_INPUT_APIS) {
        if (pattern.test(text)) findings.push({ file: relativePath, line: index + 1, api, text: text.trim() })
      }
    })
  }
  return findings
}

function packageManifests(): { file: string; dependencies: string[] }[] {
  const manifests: { file: string; dependencies: string[] }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(join(dir, entry.name))
      } else if (entry.name === 'package.json') {
        const parsed = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as Record<string, unknown>
        const names = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) =>
          Object.keys((parsed[field] as Record<string, string> | undefined) ?? {})
        )
        manifests.push({ file: relative(REPO_ROOT, join(dir, entry.name)).split(sep).join('/'), dependencies: names })
      }
    }
  }
  walk(join(REPO_ROOT, 'apps'))
  walk(join(REPO_ROOT, 'packages'))
  manifests.push({
    file: 'package.json',
    dependencies: Object.keys(
      ((JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>)
        .devDependencies as Record<string, string> | undefined) ?? {}
    )
  })
  return manifests
}

interface FakeRoomSession {
  session: Session
  request(permission: string): boolean
  check(): boolean
  device(): boolean
  downloadPrevented(): boolean
}

function fakeRoomSession(): FakeRoomSession {
  let requestHandler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null
  let checkHandler: (() => boolean) | null = null
  let deviceHandler: (() => boolean) | null = null
  let downloadListener: ((event: { preventDefault(): void }) => void) | null = null

  const session = {
    setPermissionRequestHandler: (handler: typeof requestHandler) => {
      requestHandler = handler
    },
    setPermissionCheckHandler: (handler: typeof checkHandler) => {
      checkHandler = handler
    },
    setDevicePermissionHandler: (handler: typeof deviceHandler) => {
      deviceHandler = handler
    },
    on: (event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === 'will-download') downloadListener = listener
    }
  } as unknown as Session

  return {
    session,
    request(permission: string): boolean {
      if (!requestHandler) throw new Error('no permission request handler was installed')
      let granted: boolean | null = null
      requestHandler({}, permission, (value) => {
        granted = value
      })
      if (granted === null) throw new Error(`permission request handler never answered for ${permission}`)
      return granted
    },
    check(): boolean {
      if (!checkHandler) throw new Error('no permission check handler was installed')
      return checkHandler()
    },
    device(): boolean {
      if (!deviceHandler) throw new Error('no device permission handler was installed')
      return deviceHandler()
    },
    downloadPrevented(): boolean {
      if (!downloadListener) throw new Error('no will-download listener was installed')
      let prevented = false
      downloadListener({
        preventDefault: () => {
          prevented = true
        }
      })
      return prevented
    }
  }
}

describe('Host input boundary', () => {
  it('ships no API that can move the Host cursor, keyboard or foreground window', () => {
    const findings = scanForHostInputApis()
    const unexpected = findings.filter(
      (finding) => !EXEMPTIONS.some((allowed) => allowed.file === finding.file && allowed.api === finding.api)
    )

    expect(
      unexpected.map((finding) => `${finding.file}:${finding.line} [${finding.api}] ${finding.text}`)
    ).toEqual([])
  })

  it('keeps the Host foreground exemption list exact', () => {
    const findings = scanForHostInputApis()
    // A stale exemption is as bad as a missing one: it silently pre-approves
    // the next Host-focus call somebody adds to that file.
    for (const exemption of EXEMPTIONS) {
      expect(
        findings.some((finding) => finding.file === exemption.file && finding.api === exemption.api),
        `exemption for ${exemption.file} [${exemption.api}] no longer matches anything and should be deleted`
      ).toBe(true)
    }
  })

  it('depends on no Host input-synthesis package', () => {
    const offenders = packageManifests().flatMap(({ file, dependencies }) =>
      dependencies.filter((name) => BANNED_HOST_INPUT_PACKAGES.includes(name)).map((name) => `${file}: ${name}`)
    )
    expect(offenders).toEqual([])
  })
})

describe('Room preview session policy', () => {
  it('denies every permission that would hand Room content the Host cursor, keyboard or screen', () => {
    const fake = fakeRoomSession()
    hardenRoomSession(fake.session)

    for (const permission of HOST_INPUT_PERMISSIONS) {
      expect(fake.request(permission), `${permission} must be denied`).toBe(false)
    }
    // Blanket denial, not an allow-list with holes.
    expect(fake.request('notifications')).toBe(false)
    expect(fake.request('media')).toBe(false)
    expect(fake.check()).toBe(false)
    expect(fake.device()).toBe(false)
    expect(fake.downloadPrevented()).toBe(true)
  })
})

describe('Room-local input paths', () => {
  it('drives the Android phone strip through in-Room adb, not Host clicks on the preview', () => {
    for (const action of ['back', 'home', 'recents', 'rotate'] as const) {
      const command = androidActionCommand(action)
      expect(command[0]).toBe('sh')
      expect(command[1]).toBe('-lc')
      expect(command[2]).toContain(`adb -s ${EMULATOR_ADB_SERIAL}`)
      // No Host screen coordinates anywhere in the Room-local input path.
      expect(command[2]).not.toMatch(/screen|cursor|mouse/i)
    }
    expect(androidActionCommand('back')[2]).toContain('input keyevent 4')
    expect(androidActionCommand('home')[2]).toContain('input keyevent 3')
    expect(androidActionCommand('recents')[2]).toContain('input keyevent 187')
    expect(androidActionCommand('rotate')[2]).toContain('user_rotation')
  })
})

describe('Host input capability registry', () => {
  it('models the VMware console as the only Host-input capability, and as user-only', () => {
    expect(HOST_INPUT_CAPABILITIES.map((capability) => capability.id)).toEqual(['host-input:vmware-console'])
    const console = hostInputCapability('host-input:vmware-console')
    expect(console).not.toBeNull()
    expect(console!.requiresActor).toBe('user')
    expect(console!.surrenders).toEqual(['cursor', 'keyboard', 'foreground'])
    // Observability is part of the contract, so the audit line must be real text.
    expect(console!.auditLine.length).toBeGreaterThan(20)
  })

  it('has no capability an Agent may invoke', () => {
    for (const capability of HOST_INPUT_CAPABILITIES) {
      expect(capability.requiresActor).toBe('user')
    }
  })
})
