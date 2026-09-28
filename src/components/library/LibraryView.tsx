import { useState, useMemo, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Track } from '../../lib/types'
import { groupTracks } from '../../lib/group'
import { TrackList } from '../playlist/TrackList'
import { PlayingIndicator } from '../ui/PlayingIndicator'
import { getTrackFile } from '../../lib/idb'
import { getTrackThumbnail } from '../../lib/thumbnail'

interface Props {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
  onAddToPlaylist?: (tracks: Track[]) => void
  // False while a playlist is playing: highlights become "source" dots and
  // group taps still resolve through the same queue helpers.
  queueIsLibrary?: boolean
  currentTrackId?: string | null
}

export function LibraryView({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, onAddToPlaylist, queueIsLibrary = true, currentTrackId = null }: Props) {
  const [mode, setMode] = useState<'groups' | 'queue'>('groups')
  const [search, setSearch] = useState('')
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  // S1: ONE select mode + ONE selection set for the whole Library (queue mode,
  // group detail, and later the grid) — Back preserves selection, no loose states.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())
  const [queueSelectAllTrigger, setQueueSelectAllTrigger] = useState(0)
  const [queueSelectClearTrigger, setQueueSelectClearTrigger] = useState(0)
  const [selectAllOn, setSelectAllOn] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const grouped = useMemo(() => groupTracks(tracks, { minGroupSize: 2 }), [tracks])

  // Lazy thumbnails: first 4 per group + visible loose (limit 24 total) to avoid IndexedDB churn on iOS.
  // S3: when a group is open, load ALL its members (cap 40) so detail rows show thumbs too.
  useEffect(() => {
    let cancelled = false
    const toLoad: Track[] = []
    const open = activeGroupId ? grouped.groups.find((g) => g.id === activeGroupId) : null
    if (open) {
      for (let i = 0; i < Math.min(40, open.tracks.length); i++) toLoad.push(open.tracks[i])
    } else {
      for (const g of grouped.groups) for (let i = 0; i < Math.min(4, g.tracks.length); i++) toLoad.push(g.tracks[i])
      for (let i = 0; i < Math.min(100, grouped.loose.length); i++) toLoad.push(grouped.loose[i])
    }
    const uniq = [...new Map(toLoad.map((t) => [t.fileName, t] as const)).values()]
    const missing = uniq.filter((t) => !thumbs[t.fileName])
    if (missing.length === 0) return
    ;(async () => {
      for (const t of missing) {
        if (cancelled) break
        try {
          const file = await getTrackFile(t.fileName)
          if (!file || cancelled) continue
          const url = await getTrackThumbnail(file, t.mediaType)
          if (url && !cancelled) setThumbs((prev) => (prev[t.fileName] ? prev : { ...prev, [t.fileName]: url }))
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [grouped.groups, grouped.loose, activeGroupId])
  const query = search.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    if (!query) return grouped.groups
    return grouped.groups.filter((g) => g.name.toLowerCase().includes(query) || g.tracks.some((t) => t.name.toLowerCase().includes(query)))
  }, [grouped.groups, query])

  const filteredLoose = useMemo(() => {
    if (!query) return grouped.loose
    return grouped.loose.filter((t) => t.name.toLowerCase().includes(query))
  }, [grouped.loose, query])

  const activeGroup = activeGroupId ? grouped.groups.find((g) => g.id === activeGroupId) ?? null : null

  // S2: shared select-mode helpers for the grid (queue mode keeps its triggers).
  const toggleSelectMode = () => { setSelectMode(v => !v); setSelectAllOn(false) }
  const toggleTrackSelected = (id: string) => {
    setSelectedTrackIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleQueueSelectAll = () => {
    if (selectAllOn) {
      setQueueSelectClearTrigger(v => v + 1)
      setSelectAllOn(false)
    } else {
      setQueueSelectAllTrigger(v => v + 1)
      setSelectAllOn(true)
    }
  }
  const toggleGridSelectAll = () => {
    if (selectAllOn) {
      setSelectedTrackIds(new Set())
      setSelectAllOn(false)
    } else {
      const visible = new Set<string>()
      for (const g of filteredGroups) for (const t of g.tracks) visible.add(t.id)
      for (const t of filteredLoose) visible.add(t.id)
      setSelectedTrackIds(prev => new Set([...prev, ...visible]))
      setSelectAllOn(true)
    }
  }
  const playingVariant = queueIsLibrary ? 'playing' as const : 'source' as const

  const handleSelectInGroup = (track: Track) => {
    const idx = tracks.findIndex((t) => t.id === track.id)
    if (idx !== -1) onSelectTrack(idx)
  }

  if (tracks.length === 0) {
    return <TrackList tracks={tracks} currentTrackIndex={currentTrackIndex} onSelectTrack={onSelectTrack} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} onAddToPlaylist={onAddToPlaylist} />
  }

  // Group detail view — thumbnail grid like the loose cards (per S3 decision):
  // tap plays, Select-mode tap selects, playing card gets ring + badge dot.
  if (activeGroup) {
    const membersSelected = activeGroup.tracks.filter((t) => selectedTrackIds.has(t.id))
    const detailAllSelected = activeGroup.tracks.length > 0 && membersSelected.length === activeGroup.tracks.length
    const toggleDetailSelectAll = () => {
      if (detailAllSelected) {
        const ids = new Set(activeGroup.tracks.map((t) => t.id))
        setSelectedTrackIds(prev => new Set([...prev].filter((id) => !ids.has(id))))
      } else {
        const ids = activeGroup.tracks.map((t) => t.id)
        setSelectedTrackIds(prev => new Set([...prev, ...ids]))
      }
    }
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          <button onClick={() => setActiveGroupId(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">{activeGroup.name}</h2>
            <p className="text-xs text-slate-400">{selectMode ? `${membersSelected.length} selected • ` : ''}{activeGroup.tracks.length} tracks • {activeGroup.reason.split(' score')[0]}</p>
          </div>
          {selectMode && (
            <button onClick={toggleDetailSelectAll} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">{detailAllSelected ? 'Clear' : 'Select All'}</button>
          )}
          <button onClick={toggleSelectMode} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{selectMode ? 'Done' : 'Select'}</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3">
            {activeGroup.tracks.map((t) => {
              const thumb = thumbs[t.fileName]
              const selected = selectedTrackIds.has(t.id)
              const playing = currentTrackId != null && t.id === currentTrackId
              return (
                <motion.button
                  key={t.id}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => { if (selectMode) toggleTrackSelected(t.id); else handleSelectInGroup(t) }}
                  className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${playing || (selectMode && selected) ? 'ring-2 ring-primary' : ''}`}
                >
                  {playing && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                  {selectMode && !playing && (
                    <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                  )}
                  {selectMode && playing && (
                    <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                  )}
                  <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                    {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="truncate pr-1 text-sm font-medium text-white">{t.name}</p>
                    <p className="truncate pr-1 text-xs text-slate-400">{t.artist !== 'Unknown Artist' ? t.artist : t.folderName} • {t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, '0')}` : '--:--'}</p>
                  </div>
                </motion.button>
              )
            })}
          </div>
        </div>
        {selectMode && membersSelected.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
            <div className="flex items-center justify-center gap-3">
              {onAddToPlaylist && (
                <button
                  onClick={() => onAddToPlaylist(membersSelected)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
                >
                  Add to playlist ({membersSelected.length})
                </button>
              )}
              {onRemoveTracks && (
                <button
                  onClick={() => {
                    onRemoveTracks(membersSelected)
                    const ids = new Set(membersSelected.map((t) => t.id))
                    setSelectedTrackIds(prev => new Set([...prev].filter((id) => !ids.has(id))))
                  }}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
                >
                  Delete ({membersSelected.length})
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: title + toggle */}
      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Library</h2>
            <p className="text-xs text-slate-400">{tracks.length} tracks • {grouped.groups.length} groups • {grouped.loose.length} loose</p>
          </div>
          <div className="flex items-center gap-2">
            {selectMode && (
              <button
                onClick={() => { if (mode === 'queue') toggleQueueSelectAll(); else toggleGridSelectAll() }}
                className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300"
              >
                {selectAllOn ? 'Clear' : 'Select All'}
              </button>
            )}
            <button onClick={toggleSelectMode} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{selectMode ? 'Done' : 'Select'}</button>
            <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
              <button onClick={() => setMode('groups')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'groups' ? 'bg-primary text-white' : 'text-slate-400'}`}>Groups</button>
              <button onClick={() => setMode('queue')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'queue' ? 'bg-primary text-white' : 'text-slate-400'}`}>Queue</button>
            </div>
          </div>
        </div>
        {mode === 'groups' && (
          <div className="mt-3 flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search groups or tracks..." className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={onPickFolder} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Folder</button>
            <button onClick={onPickFiles} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Files</button>
          </div>
        )}
        {mode === 'queue' && (
          <div className="mt-3 flex gap-2">
            <button onClick={onPickFolder} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Folder</button>
            <button onClick={onPickFiles} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Files</button>
          </div>
        )}
      </div>

      {mode === 'queue' ? (
        <div className="flex-1 overflow-hidden">
          <TrackList tracks={tracks} currentTrackIndex={currentTrackIndex} onSelectTrack={onSelectTrack} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} onAddToPlaylist={onAddToPlaylist} hideHeader externalSelectMode={selectMode} onExternalSelectModeChange={(v) => { setSelectMode(v); if (!v) setSelectAllOn(false) }} selectAllTrigger={queueSelectAllTrigger} selectClearTrigger={queueSelectClearTrigger} externalSelectedIds={selectedTrackIds} onSelectedIdsChange={setSelectedTrackIds} currentIsSource={!queueIsLibrary} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {filteredGroups.length === 0 && filteredLoose.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No matches for "{query}" — try search term appears in track name (e.g. omori, mario)</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredGroups.map((g) => {
                const allSelected = g.tracks.length > 0 && g.tracks.every((t) => selectedTrackIds.has(t.id))
                const someSelected = !allSelected && g.tracks.some((t) => selectedTrackIds.has(t.id))
                const hasPlaying = currentTrackId != null && g.tracks.some((t) => t.id === currentTrackId)
                return (
                <motion.button
                    key={g.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setActiveGroupId(g.id)}
                    className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${hasPlaying ? 'ring-2 ring-primary' : selectMode && allSelected ? 'ring-2 ring-primary' : selectMode && someSelected ? 'ring-1 ring-slate-500' : ''}`}
                  >
                  {hasPlaying && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                  {selectMode && allSelected && <span className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-white">✓</span>}
                  <div className="grid h-28 grid-cols-2 gap-0.5 bg-slate-800 p-0.5">
{[0, 1, 2, 3].map((i) => {
                      const t = g.tracks[i]
                      if (!t) return <div key={i} className="bg-slate-700" />
                      if (i === 3 && g.tracks.length > 4) return <div key={i} className="flex items-center justify-center bg-slate-700 text-sm font-semibold text-slate-300">+{g.tracks.length - 3}</div>
                      const thumb = thumbs[t.fileName]
                      return (
                        <div key={i} className="flex items-center justify-center overflow-hidden bg-slate-700 text-[10px] text-slate-300">
                          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : t.mediaType === 'video' ? '🎬' : '🎵'}
                        </div>
                      )
                    })}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="truncate pr-1 text-sm font-medium text-white">{g.name}</p>
                    <p className="pr-1 text-xs text-slate-400">{selectMode ? `${g.tracks.filter((t) => selectedTrackIds.has(t.id)).length}/${g.tracks.length} selected` : `${g.tracks.length} tracks`}</p>
                  </div>
                </motion.button>
                )
              })}
              {filteredLoose.map((t) => {
                const thumb = thumbs[t.fileName]
                const selected = selectedTrackIds.has(t.id)
                const playing = currentTrackId != null && t.id === currentTrackId
                return (
                  <motion.button
                    key={t.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { if (selectMode) toggleTrackSelected(t.id); else handleSelectInGroup(t) }}
                    className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${playing ? 'ring-2 ring-primary' : selectMode && selected ? 'ring-2 ring-primary' : ''}`}
                  >
                    {playing && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                    {selectMode && (
                      <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                    )}
                    <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="truncate pr-1 text-sm font-medium text-white">{t.name}</p>
                      <p className="truncate pr-1 text-xs text-slate-400">{t.duration ? `${Math.floor(t.duration/60)}:${String(Math.floor(t.duration%60)).padStart(2,'0')}` : '--:--'} • loose</p>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          )}
          <p className="mt-3 text-center text-[10px] text-slate-500">Dynamic groups from filename (high-score 2+ tokens). Singles searchable. Tap group to open, track to play in queue.{selectMode ? ' In Select mode, tap loose tracks to select.' : ''}</p>
        </div>
      )}
      {mode === 'groups' && selectMode && selectedTrackIds.size > 0 && (
        <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
          <div className="flex items-center justify-center gap-3">
            {onAddToPlaylist && (
              <button
                onClick={() => onAddToPlaylist(tracks.filter((t) => selectedTrackIds.has(t.id)))}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
              >
                Add to playlist ({selectedTrackIds.size})
              </button>
            )}
            {onRemoveTracks && (
              <button
                onClick={() => {
                  onRemoveTracks(tracks.filter((t) => selectedTrackIds.has(t.id)))
                  setSelectedTrackIds(new Set())
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
              >
                Delete ({selectedTrackIds.size})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
