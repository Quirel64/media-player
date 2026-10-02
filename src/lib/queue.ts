import type { Track } from './types'

/**
 * Queue identity (Phase 3).
 *
 * Three layers: Library (canonical tracks, one per file, UUID `id`) → Queue
 * (what's playing now: library order OR one playlist resolved to tracks) →
 * Engine (plays `queue[currentTrackIndex]`).
 *
 * A playlist can hold the same track twice without duplicating the blob, so a
 * queue occurrence needs its own key: `instanceId` (playlist item id) when it
 * comes from a playlist, otherwise the track id itself. EVERY identity check
 * against queue items must use `queueKey`, never bare `id` — matching by `id`
 * lights up all twins at once (the old double-highlight bug).
 */
export function queueKey(t: Pick<Track, 'id' | 'instanceId'>): string {
  return t.instanceId ?? t.id
}

/** Stamp a library track as a queue occurrence (library rows carry instanceId = id). */
export function toQueueItem(track: Track, itemId?: string): Track {
  return { ...track, instanceId: itemId ?? track.instanceId ?? track.id }
}

/** True when the playing queue IS the given library list, occurrence by occurrence. */
export function isLibraryQueue(queue: Track[], libraryTracks: Track[]): boolean {
  if (queue.length !== libraryTracks.length) return false
  return queue.every((t, i) => queueKey(t) === queueKey(libraryTracks[i]))
}

/**
 * Membership check: same tracks in ANY order (id multiset). A session-reordered
 * library queue fails `isLibraryQueue` (order differs) but passes here — that's
 * the distinction between "same sequence" (tap/index math) and "same library
 * content" (Order-mode gating, playing-vs-source dots).
 */
export function hasSameTracks(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<string, number>()
  for (const t of a) counts.set(t.id, (counts.get(t.id) ?? 0) + 1)
  for (const t of b) {
    const n = counts.get(t.id) ?? 0
    if (n === 0) return false
    counts.set(t.id, n - 1)
  }
  return true
}

/** Index of the queue occurrence with the given key, or -1. */
export function findQueueIndexByKey(queue: Track[], key: string | null): number {
  if (key == null) return -1
  return queue.findIndex((t) => queueKey(t) === key)
}

/**
 * Diff a drag result (single relocation) into one from/to move for the
 * chevron-tested onMove path. Returns null when nothing moved.
 */
export function diffIdMove(oldIds: string[], newIds: string[]): { from: number; to: number } | null {
  if (oldIds.length !== newIds.length) return null
  let firstDiff = -1
  for (let i = 0; i < oldIds.length; i++) {
    if (oldIds[i] !== newIds[i]) { firstDiff = i; break }
  }
  if (firstDiff === -1) return null
  const movedId = newIds[firstDiff]
  const from = oldIds.indexOf(movedId)
  if (from === -1) return null
  return { from, to: firstDiff }
}
