import type { CreateRoomInput, RoomRecord } from '@devhotel/shared'

/** Credentials, transport spelling and nickname are not repository identity. */
export function canonicalSource(sourceType: string, sourceRef: string): string {
  if (sourceType === 'empty') return ''
  let ref = sourceRef.trim()
  if (sourceType === 'managed-git') {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(ref)
    if (scp && !ref.includes('://')) ref = `ssh://${scp[1]}/${scp[2]}`
    try {
      const url = new URL(ref)
      let path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
      if (url.hostname === 'github.com') path = path.toLowerCase()
      // Preserve non-default ports and query/ref selectors: they can name a different source.
      const port = url.protocol === 'ssh:' && url.port === '22' ? '' : url.port
      return `${url.hostname.toLowerCase()}${port ? ':' + port : ''}${path}${url.search}${url.hash}`
    } catch { return ref }
  }
  ref = ref.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(ref) || ref.startsWith('//') ? ref.toLowerCase() : ref
}

export function roomIdentityKey(input: Pick<CreateRoomInput, 'sourceType' | 'sourceRef' | 'project' | 'provider'>): string {
  return JSON.stringify([input.sourceType, canonicalSource(input.sourceType, input.sourceRef), input.project.trim().toLowerCase(), input.provider ?? 'web'])
}

export function isCompatibleRoom(room: RoomRecord, input: CreateRoomInput): boolean {
  if (room.status === 'deleting' || roomIdentityKey(room) !== roomIdentityKey(input)) return false
  // An omitted identity is not an exception: default callers must also reuse task-bound Rooms.
  if ((input.taskId?.trim() || input.issueRef?.trim()) &&
      ((room.taskId ?? '') !== (input.taskId?.trim() ?? '') ||
       (room.issueRef ?? '') !== (input.issueRef?.trim() ?? ''))) return false
  const p = input.planOverrides
  return (!p || (
    (p.runtimeVersion === undefined || p.runtimeVersion === room.runtime.version) &&
    (p.pmKind === undefined || p.pmKind === room.packageManager.kind) &&
    (p.startCommand === undefined || p.startCommand === room.startCommand) &&
    (p.internalPort === undefined || p.internalPort === room.internalPort) &&
    (p.domain === undefined || p.domain === room.domain) &&
    (p.https === undefined || p.https === room.https)
  ))
}
