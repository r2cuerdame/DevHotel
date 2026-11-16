import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, registerSensitiveSecrets } from '@devhotel/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDataOwnership } from './cleanRemoval'
import {
  STARTUP_FAILURE_REPORT_DEADLINE_MS,
  canFocusMainWindow,
  createStartupFailureReporter,
  executeStartupPolicy,
  type StartupFailureDialogOptions,
  type StartupWindowHandle
} from './startupPolicy'

const tempRoots: string[] = []

function makeTempUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'devhotel-startup-policy-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('startup failure policy', () => {
  it('does not report failure or exit when bootstrap succeeds', async () => {
    const reportFailure = vi.fn()
    const exit = vi.fn()

    await executeStartupPolicy({
      bootstrap: async () => undefined,
      reportFailure,
      exit
    })

    expect(reportFailure).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports failure once and exits non-zero after bootstrap rejects or throws synchronously', async () => {
    const order: string[] = []
    const failure = new Error('selectRoomRuntime failed')
    const reportFailure = vi.fn(async (error: unknown) => {
      expect(error).toBe(failure)
      order.push('report')
    })
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`)
    })

    await executeStartupPolicy({
      bootstrap: async () => {
        throw failure
      },
      reportFailure,
      exit
    })

    expect(reportFailure).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['report', 'exit:1'])

    const syncReport = vi.fn()
    const syncExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: () => {
        throw new Error('sync preparation failure')
      },
      reportFailure: syncReport,
      exit: syncExit
    })
    expect(syncReport).toHaveBeenCalledTimes(1)
    expect(syncExit).toHaveBeenCalledWith(1)
  })

  it('still exits with code 1 when reportFailure throws synchronously or rejects', async () => {
    const syncThrowExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: async () => {
        throw new Error('openDb failed')
      },
      reportFailure: () => {
        throw new Error('dialog subsystem unavailable')
      },
      exit: syncThrowExit
    })
    expect(syncThrowExit).toHaveBeenCalledTimes(1)
    expect(syncThrowExit).toHaveBeenCalledWith(1)

    const asyncRejectExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: async () => {
        throw new Error('openDb failed')
      },
      reportFailure: async () => {
        throw new Error('async dialog rejected')
      },
      exit: asyncRejectExit
    })
    expect(asyncRejectExit).toHaveBeenCalledTimes(1)
    expect(asyncRejectExit).toHaveBeenCalledWith(1)
  })

  it('bounds hung failure reporting with a deadline and clears the timer when reporting finishes in time', async () => {
    vi.useFakeTimers()
    try {
      const hungExit = vi.fn()
      const lateReport = new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late report rejection')), STARTUP_FAILURE_REPORT_DEADLINE_MS + 5_000)
      })
      const hungPolicy = executeStartupPolicy({
        bootstrap: async () => {
          throw new Error('tray init failed')
        },
        reportFailure: () => lateReport,
        exit: hungExit,
        reportDeadlineMs: STARTUP_FAILURE_REPORT_DEADLINE_MS
      })

      await vi.advanceTimersByTimeAsync(STARTUP_FAILURE_REPORT_DEADLINE_MS - 1)
      expect(hungExit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await hungPolicy
      expect(hungExit).toHaveBeenCalledTimes(1)
      expect(hungExit).toHaveBeenCalledWith(1)

      // Advancing past the hung report promise must not exit twice or leak unhandled rejections.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(hungExit).toHaveBeenCalledTimes(1)

      const fastExit = vi.fn()
      await executeStartupPolicy({
        bootstrap: async () => {
          throw new Error('fast failure')
        },
        reportFailure: async () => undefined,
        exit: fastExit,
        reportDeadlineMs: 1_000
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fastExit).toHaveBeenCalledTimes(1)
      expect(fastExit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reproduces preparation failures without deleting corrupt data and allows a clean relaunch after repair', async () => {
    const userData = makeTempUserData()
    const roomManifest = join(userData, 'rooms', 'room1', 'manifest.yaml')
    mkdirSync(join(userData, 'rooms', 'room1'), { recursive: true })
    writeFileSync(roomManifest, 'project: demo\n', 'utf8')

    const ownerFile = join(userData, '.devhotel-owner.json')
    writeFileSync(ownerFile, '{invalid-json', 'utf8')
    const dbFile = join(userData, 'devhotel.db')
    writeFileSync(dbFile, 'not-a-sqlite-database', 'utf8')

    // Pre-fix baseline: calling bootstrap directly without startupPolicy leaves exit uncalled.
    const rawExit = vi.fn()
    await expect(
      Promise.resolve().then(() => {
        ensureDataOwnership(userData)
        rawExit(0)
      })
    ).rejects.toThrow(/ownership manifest is unreadable/)
    expect(rawExit).not.toHaveBeenCalled()

    // Fixed path: ensureDataOwnership failure reports once, exits 1, and preserves files.
    const ownerReports: unknown[] = []
    const ownerExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: async () => {
        ensureDataOwnership(userData)
      },
      reportFailure: (error) => {
        ownerReports.push(error)
      },
      exit: ownerExit
    })
    expect(ownerReports).toHaveLength(1)
    expect(ownerExit).toHaveBeenCalledWith(1)
    expect(readFileSync(ownerFile, 'utf8')).toBe('{invalid-json')
    expect(readFileSync(dbFile, 'utf8')).toBe('not-a-sqlite-database')
    expect(readFileSync(roomManifest, 'utf8')).toBe('project: demo\n')

    // Repair owner file and exercise corrupt devhotel.db preparation failure.
    rmSync(ownerFile)
    const dbReports: unknown[] = []
    const dbExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: async () => {
        ensureDataOwnership(userData)
        openDb(userData)
      },
      reportFailure: (error) => {
        dbReports.push(error)
      },
      exit: dbExit
    })
    expect(dbReports).toHaveLength(1)
    expect(dbExit).toHaveBeenCalledWith(1)
    expect(readFileSync(dbFile, 'utf8')).toBe('not-a-sqlite-database')
    expect(readFileSync(roomManifest, 'utf8')).toBe('project: demo\n')

    // After repairing the corrupt DB file, relaunching succeeds cleanly.
    rmSync(dbFile)
    const relaunchReport = vi.fn()
    const relaunchExit = vi.fn()
    await executeStartupPolicy({
      bootstrap: async () => {
        ensureDataOwnership(userData)
        const db = openDb(userData)
        db.close()
      },
      reportFailure: relaunchReport,
      exit: relaunchExit
    })
    expect(relaunchReport).not.toHaveBeenCalled()
    expect(relaunchExit).not.toHaveBeenCalled()
    expect(readFileSync(roomManifest, 'utf8')).toBe('project: demo\n')
  })
})

describe('startup failure reporter', () => {
  it('logs redacted failure details and shows a parentless error dialog once on normal launch', async () => {
    const releaseSecret = registerSensitiveSecrets(['ephemeral-pairing-secret-998877'])
    try {
      const logs: string[] = []
      const dialogs: StartupFailureDialogOptions[] = []
      const reporter = createStartupFailureReporter({
        argv: ['DevHotel.exe'],
        logError: (message) => logs.push(message),
        showDialog: async (options) => {
          dialogs.push(options)
        }
      })

      const innerCause = new Error(
        'https://me:github_pat_1234567890ABCDEFGHIJ@github.com/acme/private.git Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345'
      )
      const rootError = new AggregateError(
        [
          new Error('DATABASE_PASSWORD=hunter2-secret', { cause: innerCause }),
          new Error('ephemeral-pairing-secret-998877 failed')
        ],
        'API_TOKEN=sk_live_secret_987654321'
      )

      const exit = vi.fn()
      await executeStartupPolicy({
        bootstrap: async () => {
          throw rootError
        },
        reportFailure: reporter,
        exit
      })

      expect(logs).toHaveLength(1)
      expect(dialogs).toHaveLength(1)
      expect(exit).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(1)

      const combinedOutput = `${logs[0]}\n${dialogs[0]!.title}\n${dialogs[0]!.message}\n${dialogs[0]!.detail}`
      expect(combinedOutput).toContain('DevHotel startup failed:')
      expect(combinedOutput).toContain('DevHotel could not start')
      expect(combinedOutput).toContain('•••')
      for (const secret of [
        'github_pat_1234567890ABCDEFGHIJ',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345',
        'hunter2-secret',
        'sk_live_secret_987654321',
        'ephemeral-pairing-secret-998877'
      ]) {
        expect(combinedOutput).not.toContain(secret)
      }
    } finally {
      releaseSecret()
    }
  })

  it('logs redacted failure details without opening an error dialog on --hidden launch', async () => {
    const logs: string[] = []
    const showDialog = vi.fn()
    const exit = vi.fn()
    const reporter = createStartupFailureReporter({
      argv: ['DevHotel.exe', '--hidden'],
      logError: (message) => logs.push(message),
      showDialog
    })

    await executeStartupPolicy({
      bootstrap: async () => {
        throw new Error('DB_SECRET=top-secret-db-pass failed to open')
      },
      reportFailure: reporter,
      exit
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('DB_SECRET=')
    expect(logs[0]).not.toContain('top-secret-db-pass')
    expect(showDialog).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('second-instance readiness handling', () => {
  it('ignores second-instance focus while mainWindow is null or destroyed and restores/focuses once ready', () => {
    let activeHandle: StartupWindowHandle | null = null
    const onSecondInstance = (): boolean => {
      if (!canFocusMainWindow(activeHandle)) return false
      if (activeHandle.isMinimized()) activeHandle.restore()
      activeHandle.show()
      activeHandle.focus()
      return true
    }

    expect(canFocusMainWindow(null)).toBe(false)
    expect(onSecondInstance()).toBe(false)

    const destroyedHandle: StartupWindowHandle = {
      isDestroyed: () => true,
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    activeHandle = destroyedHandle
    expect(canFocusMainWindow(destroyedHandle)).toBe(false)
    expect(onSecondInstance()).toBe(false)
    expect(destroyedHandle.show).not.toHaveBeenCalled()
    expect(destroyedHandle.focus).not.toHaveBeenCalled()

    const normalOrder: string[] = []
    const normalHandle: StartupWindowHandle = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => normalOrder.push('restore'),
      show: () => normalOrder.push('show'),
      focus: () => normalOrder.push('focus')
    }
    activeHandle = normalHandle
    expect(canFocusMainWindow(normalHandle)).toBe(true)
    expect(onSecondInstance()).toBe(true)
    expect(normalOrder).toEqual(['show', 'focus'])

    const minimizedOrder: string[] = []
    const minimizedHandle: StartupWindowHandle = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => minimizedOrder.push('restore'),
      show: () => minimizedOrder.push('show'),
      focus: () => minimizedOrder.push('focus')
    }
    activeHandle = minimizedHandle
    expect(canFocusMainWindow(minimizedHandle)).toBe(true)
    expect(onSecondInstance()).toBe(true)
    expect(minimizedOrder).toEqual(['restore', 'show', 'focus'])
  })
})
