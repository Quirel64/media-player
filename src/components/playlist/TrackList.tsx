import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Track } from '../../lib/types'
import { PlayingIndicator } from '../ui/PlayingIndicator'

interface TrackListProps {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
  hideHeader?: boolean
  externalSelectMode?: boolean
  onExternalSelectModeChange?: (v: boolean) => void
  selectAllTrigger?: number
  selectClearTrigger?: number
  // S3: optional thumbnails keyed by fileName (Library passes its lazy map;
  // rows without one keep the icon fallback). Same look in queue + detail.
  thumbs?: Record<string, string>
  // Controlled selection (S1): when provided, selection state lives in the
  // parent so Queue mode and Group detail share ONE set — no loose states.
  // Falls back to internal state when absent.
  externalSelectedIds?: Set<string>
  onSelectedIdsChange?: (ids: Set<string>) => void
  // When true the highlighted row is the library source of a playlist
  // occurrence playing elsewhere (muted dot, not the pulsing one).
  currentIsSource?: boolean
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TrackList({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, onAddToPlaylist, hideHeader, externalSelectMode, onExternalSelectModeChange, selectAllTrigger, selectClearTrigger, thumbs, externalSelectedIds, onSelectedIdsChange, currentIsSource }: TrackListProps & { onAddToPlaylist?: (tracks: Track[]) => void }) {
  const [internalSelectMode, setInternalSelectMode] = useState(false)
  const selectMode = externalSelectMode !== undefined ? externalSelectMode : internalSelectMode
  const setSelectMode = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? (v as (prev: boolean) => boolean)(selectMode) : v
    if (onExternalSelectModeChange) onExternalSelectModeChange(next)
    else setInternalSelectMode(next)
  }
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set())
  // Shared selection when controlled, private otherwise.
  const selectedIds = externalSelectedIds ?? internalSelectedIds
  const setSelectedIds = (
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const next = typeof updater === 'function'
      ? (updater as (prev: Set<string>) => Set<string>)(selectedIds)
      : updater
    if (onSelectedIdsChange) onSelectedIdsChange(next)
    else setInternalSelectedIds(next)
  }
  useEffect(() => {
    if (selectAllTrigger && selectAllTrigger > 0) {
      setSelectedIds(new Set(tracks.map(t => t.id)))
    }
  }, [selectAllTrigger, tracks])
  useEffect(() => {
    if (selectClearTrigger && selectClearTrigger > 0) {
      setSelectedIds(new Set())
    }
  }, [selectClearTrigger])

  const toggleSelect = (trackId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(tracks.map((t) => t.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  const deleteSelected = () => {
    const selected = tracks.filter((t) => selectedIds.has(t.id))
    if (selected.length > 0 && onRemoveTracks) {
      onRemoveTracks(selected)
    }
    setSelectedIds(new Set())
    setSelectMode(false)
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  if (tracks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center"
        >
          <div className="mb-4 text-6xl">🎵</div>
          <h2 className="mb-2 text-xl font-semibold text-white">No Music Yet</h2>
          <p className="mb-6 text-sm text-slate-400">
            Open a folder or select audio files to get started
          </p>
          <div className="flex gap-3">
            <button
              onClick={onPickFolder}
              className="rounded-lg bg-primary px-4 py-2.5 font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
            >
              Open Folder
            </button>
            <button
              onClick={onPickFiles}
              className="rounded-lg border border-slate-700 px-4 py-2.5 font-medium text-slate-300 transition-colors hover:border-accent hover:text-accent"
            >
              Select Files
            </button>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Library</h2>
            <p className="text-sm text-slate-400">
              {selectMode
                ? `${selectedIds.size} of ${tracks.length} selected`
                : `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          <div className="flex gap-2">
            {selectMode ? (
              <>
                <button
                  onClick={selectedIds.size === tracks.length ? deselectAll : selectAll}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  {selectedIds.size === tracks.length ? 'Deselect All' : 'Select All'}
                </button>
                <button
                  onClick={exitSelectMode}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setSelectMode(true)}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  Select
                </button>
                <button
                  onClick={onPickFolder}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  + Folder
                </button>
                <button
                  onClick={onPickFiles}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  + Files
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <AnimatePresence mode="popLayout">
          {tracks.map((track, index) => {
            const isSelected = selectedIds.has(track.id)
            return (
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, delay: index * 0.02 }}
                onClick={() => {
                  if (selectMode) {
                    toggleSelect(track.id)
                  } else {
                    onSelectTrack(index)
                  }
                }}
                className={`group flex cursor-pointer items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
                  selectMode && isSelected
                    ? 'bg-primary/20'
                    : index === currentTrackIndex
                    ? 'bg-primary/20 text-primary-light'
                    : 'text-slate-300 hover:bg-slate-800/50'
                }`}
              >
                <div className="flex w-8 items-center justify-center">
                  {selectMode ? (
                    <div
                      className={`h-5 w-5 rounded border-2 transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-slate-600'
                      }`}
                    >
                      {isSelected && (
                        <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor">
                          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                        </svg>
                      )}
                    </div>
                  ) : index === currentTrackIndex ? (
                    <PlayingIndicator variant={currentIsSource ? 'source' : 'playing'} />
                  ) : (
                    <span className="text-sm text-slate-500">{index + 1}</span>
                  )}
                </div>

                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-slate-800 text-xs ${index === currentTrackIndex ? 'ring-1 ring-primary' : ''}`}>
                  {thumbs?.[track.fileName]
                    ? <img src={thumbs[track.fileName]} alt="" className="h-full w-full object-cover" loading="lazy" />
                    : (track.mediaType === 'video' ? '🎬' : '🎵')}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium">{track.name}</p>
                    {track.mediaType === 'video' && (
                      <span className="flex-shrink-0 text-xs text-slate-500">🎬</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {track.artist} {track.album !== 'Unknown Album' ? `• ${track.album}` : ''}
                  </p>
                </div>

                <span className="text-xs text-slate-600">{formatSize(track.size)}</span>
                <span className="w-12 text-right text-xs text-slate-500">
                  {formatDuration(track.duration)}
                </span>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Selection action bar */}
      <AnimatePresence>
        {selectMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: 60 }}
            animate={{ y: 0 }}
            exit={{ y: 60 }}
            className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3"
          >
            <div className="flex items-center justify-center gap-3">
              {onAddToPlaylist && (
                <button
                  onClick={() => {
                    const selected = tracks.filter((t) => selectedIds.has(t.id))
                    onAddToPlaylist(selected)
                  }}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
                >
                  Add to playlist ({selectedIds.size})
                </button>
              )}
              <button
                onClick={deleteSelected}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
              >
                Delete ({selectedIds.size})
              </button>
              <button
                onClick={exitSelectMode}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
