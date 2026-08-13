/** Monotonic high-water mark for Room-owned workspace volume generations. */
/** Settings key holding the one previous workspace generation kept for recovery. */
export function retainedWorkspaceGenKey(roomId: string): string {
  return `retainedWorkspaceGen:${roomId}`
}

export function workspaceGenMaxKey(roomId: string): string {
  return `workspaceGenMax:${roomId}`
}

export function nextWorkspaceVolumeRevision(current: number, recordedMax: string | null): number {
  const parsed = recordedMax === null ? current : Number.parseInt(recordedMax, 10)
  const max = Number.isSafeInteger(parsed) && parsed >= 0 ? Math.max(current, parsed) : current
  return Math.max(1, max + 1)
}
