export type ShutdownAction = 'quit' | 'install-update' | 'relaunch'

export interface ShutdownPolicyDeps {
  shutdown: () => Promise<void>
  installUpdate: () => void
  relaunch: () => void
  exit: (code: number) => void
  reportFailure: (action: ShutdownAction, error: unknown) => void | Promise<void>
}

/** Performs update/relaunch work only after a successful Room shutdown; failures exit non-zero. */
export async function executeShutdownPolicy(action: ShutdownAction, deps: ShutdownPolicyDeps): Promise<void> {
  try {
    await deps.shutdown()
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
  }
}
