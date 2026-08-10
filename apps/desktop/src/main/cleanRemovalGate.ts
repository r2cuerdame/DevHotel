export type CleanRemovalOperation = () => Promise<boolean>

/** Serializes the destructive removal flow and exposes it to app shutdown coordination. */
export class CleanRemovalGate {
  private active: Promise<boolean> | null = null

  run(operation: CleanRemovalOperation): Promise<boolean> {
    if (this.active) return this.active
    const task = Promise.resolve().then(operation)
    this.active = task
    void task.then(
      (scheduledRemoval) => {
        // Once the coordinator is scheduled, keep the gate closed until app.quit;
        // otherwise a tray Update/Quit can race the external removal sequence.
        if (!scheduledRemoval) this.clear(task)
      },
      () => this.clear(task)
    )
    return task
  }

  current(): Promise<boolean> | null {
    return this.active
  }

  private clear(task: Promise<boolean>): void {
    if (this.active === task) this.active = null
  }
}

/**
 * A successful removal schedules its own quit after the coordinator is launched.
 * Cancellation/failure releases the originally requested Quit/Update action.
 */
export function deferShutdownForCleanRemoval(gate: CleanRemovalGate, shutdown: () => void): boolean {
  const active = gate.current()
  if (!active) return false
  void active.then(
    (scheduledRemoval) => {
      if (!scheduledRemoval) shutdown()
    },
    () => shutdown()
  )
  return true
}
