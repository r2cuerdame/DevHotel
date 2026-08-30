import { describe, expect, it, vi } from 'vitest'
import { listRoomsWithRuntimeRetry } from './roomRefresh'

function room(state: 'running' | 'degraded' | 'dead' | 'stopped' | 'unknown', expected: 'running' | 'stopped' | 'transitional') {
  return { runtimeStatus: { state, expected } }
}

describe('listRoomsWithRuntimeRetry', () => {
  it('retries one unknown snapshot for a Room expected to be running', async () => {
    const first = [room('unknown', 'running')]
    const second = [room('running', 'running')]
    const listRooms = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    await expect(listRoomsWithRuntimeRetry(listRooms, async () => undefined)).resolves.toBe(second)
    expect(listRooms).toHaveBeenCalledTimes(2)
  })

  it('does not retry terminal or intentionally transitional states', async () => {
    const terminalList = vi.fn(async () => [room('dead', 'running')])
    const transitionalList = vi.fn(async () => [room('unknown', 'transitional')])

    await listRoomsWithRuntimeRetry(terminalList, async () => undefined)
    await listRoomsWithRuntimeRetry(transitionalList, async () => undefined)

    expect(terminalList).toHaveBeenCalledTimes(1)
    expect(transitionalList).toHaveBeenCalledTimes(1)
  })

  it('keeps the first uncertain snapshot when the bounded retry fails', async () => {
    const first = [room('unknown', 'running')]
    let calls = 0
    const listRooms = vi.fn(async () => {
      calls += 1
      if (calls === 1) return first
      throw new Error('transient refresh failure')
    })

    await expect(listRoomsWithRuntimeRetry(listRooms, async () => undefined)).resolves.toBe(first)
    expect(listRooms).toHaveBeenCalledTimes(2)
  })
})
