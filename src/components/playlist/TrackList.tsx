import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import type { Track } from '../../lib/types'
import { PlayingIndicator } from '../ui/PlayingIndicator'
import { HoldRing } from '../ui/HoldRing'
import { useHoldToDrag, unblockTouchScroll } from '../ui/useHoldToDrag'
import { orderByIds } from '../../lib/queue'


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
  // Reorder mode (#10): hold-and-drag (grip or row hold) with tap-to-play and
  // select intact. Parent owns persistence + live queue mapping via ONE
  // full-order commit at drop — never a from/to splice (those collapse
  // multi-step drags).
  reorderMode?: boolean
  onReorderCommit?: (newIds: string[]) => void
  // Row-level hold entry: flips visual Order mode, then the same gesture
  // starts dragging on the already-live controls (no remount, no transfer).
  // Undefined = holds do nothing here.
  onHoldToOrder?: () => void
  // Fires on every drop (changed or not) so hold-entered sessions can auto-exit.
  onDropEnd?: () => void
  // Hold-entered sessions (grips hidden) also exit when the finger lifts WITHOUT
  // any drop — otherwise a failed start strands an empty Order mode. The
  // check is deferred a tick so a real drop's commit (window-level pointerup
  // listener) lands first; unmounting before commit would eat the reorder.
  onReleaseWithoutDrop?: () => void
  // Grips are exclusive to button-entered Order mode (accessibility without
  // cluttering hold-entered drags, which need no handle).
  showGrips?: boolean
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

// Hold-and-drag row, ALWAYS mounted: grip-only dragging (dragListener={false})
// so vertical scroll still works everywhere else; select-none stops iOS text
// selection mid-drag. One tree before/during/after every gesture — no remount
// can ever strand a drag (the lesson of the transfer era).
function DragTrackRow({ track, index, isCurrent, currentIsSource, constraints, selectMode, isSelected, onToggleSelect, showGrip, holdToOrder, onPlay, onCommitMove }: {
  track: Track
  index: number
  isCurrent: boolean
  currentIsSource?: boolean
  constraints: React.RefObject<HTMLDivElement | null>
  selectMode: boolean
  isSelected: boolean
  onToggleSelect: () => void
  showGrip: boolean
  // Row-level hold: starts the drag on these already-live controls and flips
  // visual Order mode first when needed. Undefined = holds do nothing here.
  holdToOrder?: () => void
  onPlay: () => void
  onCommitMove: () => void
}) {
  const controls = useDragControls()
  // Long-press anywhere on the row also grabs it (same controls as the grip).
  // touch-action flips to none only while held: the flip lands while the finger
  // is still stationary, so the first move belongs to the drag, not the scroller.
  const hold = useHoldToDrag(controls, {
    shouldStart: () => !selectMode && !!holdToOrder,
    onStarting: () => holdToOrder?.(),
  })
  return (
    <Reorder.Item
      value={track.id}
      dragListener={false}
      dragControls={controls}
      dragConstraints={constraints}
      whileDrag={{ scale: 1.04, boxShadow: '0 10px 28px rgba(0,0,0,0.5)' }}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.02, 0.4) }}
      onDragEnd={() => onCommitMove()}
      onClick={() => {
        if (selectMode) onToggleSelect()
        else onPlay()
      }}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      className={`group flex cursor-pointer select-none items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
        hold.dragging ? 'touch-none' : 'touch-pan-y'
      } ${
        isCurrent ? 'bg-primary/20 text-primary-light' : 'text-slate-300 hover:bg-slate-800/50'
      }`}
    >
      <div className="flex w-8 items-center justify-center">
        {hold.holding ? (
          <HoldRing />
        ) : selectMode ? (
          <div
            className={`h-5 w-5 rounded border-2 transition-colors ${
              isSelected ? 'border-primary bg-primary' : 'border-slate-600'
            }`}
          >
            {isSelected && (
              <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
              </svg>
            )}
          </div>
        ) : showGrip ? (
        <span
          onPointerDown={(e) => controls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab touch-none rounded px-1.5 py-2 text-sm leading-none text-slate-500 hover:bg-slate-700 hover:text-white active:cursor-grabbing"
          title="Hold and drag to reorder"
        >
          ⋮⋮
        </span>
        ) : isCurrent ? (
          <PlayingIndicator variant={currentIsSource ? 'source' : 'playing'} />
        ) : (
          <span className="text-sm text-slate-500">{index + 1}</span>
        )}
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
    </Reorder.Item>
  )
}

export function TrackList({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, onAddToPlaylist, hideHeader, externalSelectMode, onExternalSelectModeChange, selectAllTrigger, selectClearTrigger, reorderMode, onReorderCommit, onHoldToOrder, showGrips, onDropEnd, onReleaseWithoutDrop, externalSelectedIds, onSelectedIdsChange, currentIsSource }: TrackListProps & { onAddToPlaylist?: (tracks: Track[]) => void }) {
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

  // Single Reorder tree, always mounted: hold-and-drag (grip or row hold) with
  // tap-to-play and select intact. Drop commits the FULL order (orderByIds) —
  // single splices collapse multi-step drags to one step.
  const rowIds = useMemo(() => tracks.map((t) => t.id), [tracks])
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  // Cleared on mode/list/track change: a mounted Reorder tree with stale drag
  // measurements stacks items at the container edge (pile-up bug) — never let
  // it survive a track change.
  useEffect(() => { setDragIds(null) }, [reorderMode, tracks, currentTrackIndex])
  const dragIdsRef = useRef<string[] | null>(null)
  useEffect(() => { dragIdsRef.current = dragIds }, [dragIds])
  // Bounds the gesture so rows can't be flung off-screen mid-drag.
  const listRef = useRef<HTMLDivElement | null>(null)
  const displayTracks = useMemo(() => {
    const ordered = orderByIds(tracks, (t) => t.id, dragIds ?? rowIds)
    return ordered ?? tracks
  }, [tracks, dragIds, rowIds])
  // Highlight follows the track id, so it stays put while rows slide under it.
  const displayCurrentIdx = (() => {
    const curId = tracks[currentTrackIndex]?.id
    if (curId == null) return currentTrackIndex
    const i = displayTracks.findIndex((t) => t.id === curId)
    return i === -1 ? currentTrackIndex : i
  })()
  // Memoized: a fresh array identity every render would invalidate the
  // Group's measurements on any unrelated re-render.
  const groupValues = useMemo(() => displayTracks.map((t) => t.id), [displayTracks])
  // Sounding track id: remounts the Reorder tree on track change (fresh
  // measurements, correct positions) instead of reusing a stale snapshot.
  const soundingId = tracks[currentTrackIndex]?.id ?? 'boot'
  const commitDragMove = () => {
    // The hold path blocks scrolling for the whole gesture: always release it
    // at drop, changed or not.
    unblockTouchScroll()
    dropCommittedRef.current = true
    onDropEnd?.()
    const ids = dragIdsRef.current
    if (!ids) return
    const ordered = orderByIds(tracks, (t) => t.id, ids)
    // No-op drops (released where it started) commit nothing.
    if (ordered && ordered.some((t, i) => t.id !== tracks[i]?.id)) onReorderCommit?.(ids)
  }

  // Release-without-drop in a hold-entered session exits it (see prop note).
  // dropCommittedRef distinguishes a real drop (commit ran) from a bare lift.
  const dropCommittedRef = useRef(false)
  useEffect(() => {
    dropCommittedRef.current = false
  }, [reorderMode])
  const handleReleaseUp = () => {
    unblockTouchScroll()
    window.setTimeout(() => {
      if (!dropCommittedRef.current) onReleaseWithoutDrop?.()
      dropCommittedRef.current = false
    }, 0)
  }

  // Row-level hold entry (no delegation needed — every row owns its controls).
  const holdToOrder = !selectMode && onHoldToOrder ? () => onHoldToOrder() : undefined

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

      <div
        className="flex-1 overflow-y-auto px-2 py-2"
        ref={listRef}
        onPointerUp={() => {
          handleReleaseUp()
        }}
        onPointerCancel={() => {
          unblockTouchScroll()
        }}
      >
        <Reorder.Group
          key={soundingId}
          axis="y"
          values={groupValues}
          onReorder={(ids) => setDragIds(ids)}
        >
          <AnimatePresence initial={false}>
            {displayTracks.map((track, index) => (
              <DragTrackRow
                key={track.id}
                track={track}
                index={index}
                isCurrent={index === displayCurrentIdx}
                currentIsSource={currentIsSource}
                constraints={listRef}
                selectMode={selectMode}
                isSelected={selectedIds.has(track.id)}
                onToggleSelect={() => toggleSelect(track.id)}
                showGrip={!!reorderMode && showGrips !== false}
                holdToOrder={holdToOrder}
                onPlay={() => onSelectTrack(index)}
                onCommitMove={commitDragMove}
              />
            ))}
          </AnimatePresence>
        </Reorder.Group>
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
