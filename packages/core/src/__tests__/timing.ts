/**
 * Deadline-driven waiting for tests that observe real asynchronous work
 * (child processes, loopback sockets, event emitters). A fixed `setTimeout`
 * sleep is load-bearing: it passes only while the machine is fast enough,
 * and a parallel run makes it flake. A polled deadline returns as soon as
 * the condition holds and fails with the reason only when it never does.
 */

export interface UntilOptions {
  /** Fail after this long. Generous on purpose: it bounds a hang, not speed. */
  timeoutMs?: number
  /** Poll interval. */
  intervalMs?: number
  /** Names the condition in the failure message. */
  what?: string
}

export async function until(
  condition: () => boolean | Promise<boolean>,
  opts: UntilOptions = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const intervalMs = opts.intervalMs ?? 10
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.what ?? 'condition'}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * How much scheduler latency a "settled within its declared deadline"
 * assertion tolerates. The claim such an assertion makes is that the code
 * honoured a short explicit deadline instead of a long default one, so the
 * allowance only has to stay far below that default; it does not have to be
 * tight, and a tight bound is exactly what a loaded parallel run breaks.
 */
export const SCHEDULING_ALLOWANCE_MS = 5_000
