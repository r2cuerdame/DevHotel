export type ShutdownAction = 'quit' | 'install-update' | 'relaunch'

/**
 * The outer bound on quitting. The orchestrator budgets its own Room work
 * below this; what remains covers runtime disposal. Whatever is still hung
 * when it fires is reported as a terminal failure and the process exits
 * non-zero, so a stuck engine can never leave DevHotel neither running nor
 * quit.
 */
export const SHUTDOWN_POLICY_DEADLINE_MS = 45_000

export class ShutdownDeadlineError extends Error {
  readonly code = 'SHUTDOWN_DEADLINE_EXCEEDED'
  constructor(deadlineMs: number) {
    super(`DevHotel shutdown did not finish within ${Math.round(deadlineMs / 1000)} seconds`)
    this.name = 'ShutdownDeadlineError'
  }
}

export interface ShutdownPolicyDeps {
  shutdown: () => Promise<void>
  installUpdate: () => void
  relaunch: () => void
  exit: (code: number) => void
  reportFailure: (action: ShutdownAction, error: unknown) => void | Promise<void>
  /** Overall deadline for `shutdown`; defaults to SHUTDOWN_POLICY_DEADLINE_MS. */
  deadlineMs?: number
}

/** Performs update/relaunch work only after a successful Room shutdown; failures exit non-zero. */
export async function executeShutdownPolicy(action: ShutdownAction, deps: ShutdownPolicyDeps): Promise<void> {
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_POLICY_DEADLINE_MS
  let timer: NodeJS.Timeout | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShutdownDeadlineError(deadlineMs)), deadlineMs)
  })
  try {
    await Promise.race([deps.shutdown(), deadline])
    if (action === 'install-update') deps.installUpdate()
    else {
      if (action === 'relaunch') deps.relaunch()
      deps.exit(0)
    }
  } catch (error) {
    try {
      await deps.reportFailure(action, error)
    } finally {
      deps.exit(1)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
