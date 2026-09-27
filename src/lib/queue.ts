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

/** Index of the queue occurrence with the given key, or -1. */
export function findQueueIndexByKey(queue: Track[], key: string | null): number {
  if (key == null) return -1
  return queue.findIndex((t) => queueKey(t) === key)
}
