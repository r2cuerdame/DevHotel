import type { RoomRuntimeStatus } from '@devhotel/shared'

type RuntimeExpectation = {
  runtimeStatus: Pick<RoomRuntimeStatus, 'state' | 'expected'>
}

const ROOM_REFRESH_RETRY_DELAY_MS = 100

export function hasTransientUnknownRuntime(rooms: readonly RuntimeExpectation[]): boolean {
  return rooms.some((room) => room.runtimeStatus.expected === 'running' && room.runtimeStatus.state === 'unknown')
}

/** Revalidate one uncertain awake-Room snapshot while preserving the first result if the retry itself fails. */
export async function listRoomsWithRuntimeRetry<T extends RuntimeExpectation>(
  listRooms: () => Promise<T[]>,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, ROOM_REFRESH_RETRY_DELAY_MS))
): Promise<T[]> {
  const first = await listRooms()
  if (!hasTransientUnknownRuntime(first)) return first
  await wait()
  try {
    return await listRooms()
  } catch {
    return first
  }
}
