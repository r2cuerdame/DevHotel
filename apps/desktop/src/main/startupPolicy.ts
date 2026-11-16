import { redactSecrets } from '@devhotel/core'

/**
 * Maximum time startup failure reporting may keep the process alive before
 * forcing a non-zero exit. Prevents a stuck error dialog or logger from
 * leaving the single-instance lock stranded after startup already failed.
 */
export const STARTUP_FAILURE_REPORT_DEADLINE_MS = 45_000

const MAX_DIALOG_DETAIL_CHARS = 2_000

export interface StartupPolicyDeps {
  bootstrap: () => void | Promise<void>
  reportFailure: (error: unknown) => void | Promise<void>
  exit: (code: number) => void
  /** Overall deadline for `reportFailure`; defaults to STARTUP_FAILURE_REPORT_DEADLINE_MS. */
  reportDeadlineMs?: number
}

export interface StartupFailureDialogOptions {
  title: string
  message: string
  detail: string
}

export interface StartupFailureReporterDeps {
  argv: readonly string[]
  logError: (message: string) => void
  showDialog: (options: StartupFailureDialogOptions) => void | Promise<void>
}

export interface StartupWindowHandle {
  isDestroyed?: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
}

export function isHiddenStartup(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--hidden')
}

function describeErrorChain(error: unknown, seen = new Set<unknown>()): string {
  if (error !== null && typeof error === 'object') {
    if (seen.has(error)) return '[circular error]'
    seen.add(error)
  }
  if (error instanceof AggregateError) {
    const parts = [error.message, ...error.errors.map((entry) => describeErrorChain(entry, seen))].filter(Boolean)
    return parts.join('\n') || 'Unknown startup error'
  }
  if (error instanceof Error) {
    const base = error.message || error.name || 'Unknown startup error'
    return error.cause !== undefined ? `${base} (cause: ${describeErrorChain(error.cause, seen)})` : base
  }
  if (typeof error === 'string') return error || 'Unknown startup error'
  try {
    return String(error)
  } catch {
    return 'Unknown startup error'
  }
}

function describeErrorLog(error: unknown): string {
  const summary = describeErrorChain(error)
  if (error instanceof Error && error.stack) {
    return error.stack.includes(summary) ? error.stack : `${summary}\n${error.stack}`
  }
  return summary
}

/** Formats a startup failure for user display, scrubbing secrets before any truncation. */
export function formatStartupFailureDetail(error: unknown): string {
  const redacted = redactSecrets(describeErrorChain(error))
  if (redacted.length <= MAX_DIALOG_DETAIL_CHARS) return redacted
  return `${redacted.slice(0, MAX_DIALOG_DETAIL_CHARS - 1)}…`
}

/** Formats a startup failure for application logs with stack context and redacted secrets. */
export function formatStartupFailureLog(error: unknown): string {
  return redactSecrets(describeErrorLog(error))
}

/**
 * Builds the startup failure reporter. Always writes a redacted cause to logs,
 * and shows a parentless error dialog once unless launched with `--hidden`.
 */
export function createStartupFailureReporter(
  deps: StartupFailureReporterDeps
): (error: unknown) => Promise<void> {
  return async (error: unknown) => {
    const detail = formatStartupFailureDetail(error)
    const logDetail = formatStartupFailureLog(error)
    deps.logError(`DevHotel startup failed:\n${logDetail}`)
    if (isHiddenStartup(deps.argv)) return
    await deps.showDialog({
      title: 'DevHotel could not start',
      message: 'DevHotel could not finish starting.',
      detail: `DevHotel will exit with your Room data preserved.\n\n${detail}`
    })
  }
}

/** Reports whether the main window is ready to be raised on `second-instance`. */
export function canFocusMainWindow(handle: StartupWindowHandle | null): handle is StartupWindowHandle {
  return handle !== null && !handle.isDestroyed?.()
}

/**
 * Runs startup initialization and ensures any preparation failure is reported
 * within a bounded deadline and followed by a non-zero exit so the
 * single-instance lock is never left stranded without a window or tray.
 */
export async function executeStartupPolicy(deps: StartupPolicyDeps): Promise<void> {
  try {
    await deps.bootstrap()
  } catch (error) {
    const deadlineMs = deps.reportDeadlineMs ?? STARTUP_FAILURE_REPORT_DEADLINE_MS
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Startup failure report deadline exceeded')), deadlineMs)
    })
    const report = Promise.resolve().then(() => deps.reportFailure(error))
    // Avoid an unhandledRejection if reportFailure rejects after the deadline already fired.
    report.catch(() => undefined)
    try {
      await Promise.race([report, deadline])
    } catch {
      // Reporting failures or timeouts must still exit non-zero to release the lock.
    } finally {
      if (timer) clearTimeout(timer)
      deps.exit(1)
    }
  }
}
