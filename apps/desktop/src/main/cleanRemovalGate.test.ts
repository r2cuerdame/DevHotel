import { describe, expect, it, vi } from 'vitest'
import { CleanRemovalGate, deferShutdownForCleanRemoval } from './cleanRemovalGate'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('CleanRemovalGate', () => {
  it('deduplicates removal and holds Quit until native confirmation is cancelled', async () => {
    const pending = deferred<boolean>()
    const operation = vi.fn(() => pending.promise)
    const gate = new CleanRemovalGate()
    const first = gate.run(operation)
    const second = gate.run(operation)
    const shutdown = vi.fn()

    expect(first).toBe(second)
    expect(operation).toHaveBeenCalledTimes(0)
    expect(deferShutdownForCleanRemoval(gate, shutdown)).toBe(true)
    pending.resolve(false)
    await first
    await Promise.resolve()
    expect(operation).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(gate.current()).toBeNull()
  })

  it('does not start a competing shutdown after removal helpers are scheduled', async () => {
    const gate = new CleanRemovalGate()
    const shutdown = vi.fn()
    const removal = gate.run(async () => true)

    expect(deferShutdownForCleanRemoval(gate, shutdown)).toBe(true)
    await removal
    await Promise.resolve()
    expect(shutdown).not.toHaveBeenCalled()
    expect(gate.current()).toBe(removal)
  })
})
