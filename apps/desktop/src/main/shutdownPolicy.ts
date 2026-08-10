export type ShutdownAction = 'quit' | 'install-update'

export interface ShutdownPolicyDeps {
  shutdown: () => Promise<void>
  installUpdate: () => void
  exit: (code: number) => void
  reportFailure: (action: ShutdownAction, error: unknown) => void | Promise<void>
}

/** Installs only after a fully successful Room shutdown; failures always exit non-zero. */
export async function executeShutdownPolicy(action: ShutdownAction, deps: ShutdownPolicyDeps): Promise<void> {
  try {
    await deps.shutdown()
    if (action === 'install-update') deps.installUpdate()
    else deps.exit(0)
  } catch (error) {
    try {
      await deps.reportFailure(action, error)
    } finally {
      deps.exit(1)
    }
  }
}
