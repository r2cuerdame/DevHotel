/**
 * Caches that belong to the Hotel rather than to any one Room.
 *
 * Every Room has had its own `/cache` since the beginning, and that is the
 * right default for anything a Room can dirty. It is the wrong default for
 * content-addressed package stores: ten Rooms on the same project download the
 * same tarballs ten times, store them ten times, and keep them until each Room
 * is deleted. The bytes are identical by construction — that is what a content
 * address means — so the only thing the per-Room copy buys is isolation nobody
 * asked for.
 *
 * A shared cache is therefore its own kind of owned artifact, with its own
 * ownership labels and its own liveness rule, and the rule is the point: a
 * shared cache is reachable while *any* Room exists. Deleting a Room says
 * nothing about the Rooms still using it, and a Room-scoped deletion path that
 * could reach one would be precisely the "removal without proving reachability"
 * this issue exists to rule out. Nothing Room-scoped can name one: the names do
 * not contain a Room ID and the labels do not carry `devhotel.room`, so the
 * Room volume validator rejects one on sight.
 */

/** Marks an artifact as belonging to the Hotel, not to a Room. */
export const HOTEL_SCOPE_LABEL = 'devhotel.scope'
export const HOTEL_SCOPE_VALUE = 'hotel'
export const SHARED_CACHE_ROLE = 'shared-cache'

/** Where shared caches are mounted inside a Room. Never `/cache`, which is the Room's own. */
export const SHARED_CACHE_MOUNT = '/shared-cache'

const PURPOSE_RE = /^[a-z][a-z0-9]{0,15}$/

/**
 * The name of one shared cache.
 *
 * `dh-shared-` cannot collide with `dh-<roomId>-`: a Room ID is exactly eight
 * lowercase alphanumerics and `shared` is six, so no Room can ever produce this
 * prefix and no shared cache can ever be parsed as a Room's disk.
 */
export function sharedCacheVolume(purpose: string): string {
  if (!PURPOSE_RE.test(purpose)) throw new Error(`invalid shared cache purpose: ${purpose}`)
  return `dh-shared-${purpose}`
}

export function isSharedCacheVolumeName(name: string): boolean {
  return /^dh-shared-[a-z][a-z0-9]{0,15}$/.test(name)
}

export function sharedCachePurpose(name: string): string | null {
  const match = /^dh-shared-([a-z][a-z0-9]{0,15})$/.exec(name)
  return match?.[1] ?? null
}

/** The complete label set a shared cache must carry to prove DevHotel owns it. */
export function sharedCacheLabels(purpose: string): Record<string, string> {
  if (!PURPOSE_RE.test(purpose)) throw new Error(`invalid shared cache purpose: ${purpose}`)
  return {
    'devhotel.managed': '1',
    'devhotel.role': SHARED_CACHE_ROLE,
    [HOTEL_SCOPE_LABEL]: HOTEL_SCOPE_VALUE,
    'devhotel.cache': purpose
  }
}

/** Whether observed labels prove Hotel-scoped DevHotel ownership of this cache. */
export function provesSharedCacheOwnership(name: string, labels: Record<string, string>): boolean {
  const purpose = sharedCachePurpose(name)
  if (!purpose) return false
  // A `devhotel.room` label on a Hotel-scoped artifact means something built it
  // with the wrong rules; refusing it is cheaper than guessing which rules won.
  if (labels['devhotel.room'] !== undefined) return false
  const expected = sharedCacheLabels(purpose)
  return Object.entries(expected).every(([key, value]) => labels[key] === value)
}

/**
 * The package store: npm's and pnpm's, in one disk.
 *
 * One volume rather than two because the two stores are the same kind of thing
 * with the same liveness rule, and a Room that uses corepack will touch both.
 * They stay in separate directories inside it, which is what each tool already
 * expects.
 */
export const NODE_PACKAGE_SHARED_CACHE = 'packages'

export interface SharedCacheMount {
  volume: string
  path: string
}

/** The shared caches a Node Room mounts, and where. */
export function nodeSharedCacheMounts(): SharedCacheMount[] {
  return [{ volume: sharedCacheVolume(NODE_PACKAGE_SHARED_CACHE), path: SHARED_CACHE_MOUNT }]
}
