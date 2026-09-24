import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Track, Playlist } from '../../lib/types'
import { getAllTracks } from '../../lib/idb'
import { getFileFromOPFS } from '../../lib/opfs'
import { getTrackThumbnail } from '../../lib/thumbnail'
import { showError } from '../ui/Toast'

interface Props {
  playlists: Playlist[]
  onCreatePlaylist: (name: string, tracks?: Track[]) => Promise<void>
  onForcePlayPlaylist: (id: string, startIdx?: number) => void
  onDeletePlaylist: (id: string) => void
  onRemoveFromPlaylist?: (playlistId: string, itemIds: string[]) => Promise<void>
  currentTrackId?: string | null
}

export function PlaylistsView({ playlists, onCreatePlaylist, onForcePlayPlaylist, onDeletePlaylist, onRemoveFromPlaylist, currentTrackId }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTracks, setActiveTracks] = useState<Track[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [viewMode, setViewMode] = useState<'tracks' | 'queue'>('tracks')
  const [editMode, setEditMode] = useState(false)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const active = activeId ? playlists.find(p => p.id === activeId) ?? null : null

  // Resolve tracks for active playlist
  useEffect(() => {
    if (!active) { setActiveTracks([]); return }
    let cancelled = false
    ;(async () => {
      const all = await getAllTracks()
      const map = new Map(all.map(t => [t.id, t] as const))
      const resolved: Track[] = []
      for (const item of active.items) {
        const t = map.get(item.trackId)
        if (t) resolved.push(t)
      }
      if (!cancelled) setActiveTracks(resolved)
    })()
    return () => { cancelled = true }
  }, [active])

  // Thumbnails for active detail and grid
  useEffect(() => {
    let cancelled = false
    const toLoad: { fileName: string, track: Track }[] = []
    // Load thumbs for active playlist detail (all tracks in Tracks view, first 4 for Queue)
    if (active && activeTracks.length > 0) {
      const items = viewMode === 'tracks' ? activeTracks : activeTracks.slice(0, 4)
      items.forEach(t => { if (!thumbs[t.fileName]) toLoad.push({ fileName: t.fileName, track: t }) })
      if (toLoad.length === 0) return
      ;(async () => {
        for (const { track } of toLoad) {
          if (cancelled) break
          try {
            const file = await getFileFromOPFS(track.fileName)
            if (!file || cancelled) continue
            const url = await getTrackThumbnail(file, track.mediaType)
            if (url && !cancelled) setThumbs(prev => prev[track.fileName] ? prev : { ...prev, [track.fileName]: url })
          } catch {}
        }
      })()
    }
    return () => { cancelled = true }
  }, [active, activeTracks, viewMode, thumbs])

  // Grid thumbnails for playlist overview (first 4 per playlist)
  useEffect(() => {
    if (active) return
    let cancelled = false
    ;(async () => {
      const all = await getAllTracks()
      const map = new Map(all.map(t => [t.id, t] as const))
      const toLoad: Track[] = []
      for (const pl of playlists) {
        for (let i = 0; i < Math.min(4, pl.items.length); i++) {
          const t = map.get(pl.items[i].trackId)
          if (t && !thumbs[t.fileName] && !toLoad.find(x => x.fileName === t.fileName)) toLoad.push(t)
        }
      }
      for (const t of toLoad) {
        if (cancelled) break
        try {
          const file = await getFileFromOPFS(t.fileName)
          if (!file || cancelled) continue
          const url = await getTrackThumbnail(file, t.mediaType)
          if (url && !cancelled) setThumbs(prev => prev[t.fileName] ? prev : { ...prev, [t.fileName]: url })
        } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [playlists, active, thumbs])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) { showError('Name required'); return }
    await onCreatePlaylist(name, [])
    setNewName('')
    setShowCreate(false)
  }

  const toggleSelect = (itemId: string) => {
    setSelectedItemIds(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId)
      return next
    })
  }

  const handleRemoveSelected = async () => {
    if (!active || selectedItemIds.size === 0 || !onRemoveFromPlaylist) return
    await onRemoveFromPlaylist(active.id, Array.from(selectedItemIds))
    setSelectedItemIds(new Set())
    setEditMode(false)
  }

  // Active playlist detail
  if (active) {
    const isQueue = viewMode === 'queue'
    return (
      <div className="flex h-full flex-col">
        <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => { setActiveId(null); setEditMode(false); setSelectedItemIds(new Set()); setViewMode('tracks') }} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-white">{active.name?.trim() ? active.name : 'Untitled'}</h2>
              <p className="text-xs text-slate-400">{active.items.length} tracks {active.items.length !== activeTracks.length ? `(${activeTracks.length} available)` : ''}</p>
            </div>
            <button onClick={() => setEditMode(v => !v)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${editMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{editMode ? 'Done' : 'Edit'}</button>
            <button onClick={() => onForcePlayPlaylist(active.id, 0)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white">Play</button>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
              <button onClick={() => setViewMode('tracks')} className={`rounded-full px-3 py-1 text-xs font-medium ${viewMode === 'tracks' ? 'bg-primary text-white' : 'text-slate-400'}`}>Tracks</button>
              <button onClick={() => setViewMode('queue')} className={`rounded-full px-3 py-1 text-xs font-medium ${viewMode === 'queue' ? 'bg-primary text-white' : 'text-slate-400'}`}>Queue</button>
            </div>
            <div className="flex items-center gap-2">
              {editMode && viewMode === 'queue' && (
                <button onClick={() => setSelectedItemIds(s => s.size === active!.items.length ? new Set() : new Set(active!.items.map(it => it.id)))} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">{selectedItemIds.size === active?.items.length ? 'Deselect All' : 'Select All'}</button>
              )}
              {editMode && <span className="text-xs text-slate-400">{selectedItemIds.size} selected</span>}
            </div>
          </div>
        </div>

        {active.items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
            <div>
              <div className="mb-2 text-3xl">📋</div>
              <p className="text-sm">No tracks yet</p>
              <p className="text-xs">Add from Library via Select → Add to playlist</p>
            </div>
          </div>
        ) : isQueue ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-2">
              {activeTracks.map((t, idx) => {
                const itemId = active.items[idx]?.id ?? t.id
                const isSelected = selectedItemIds.has(itemId)
                const isPlaying = !editMode && currentTrackId === t.id
                return (
                  <div key={`${itemId}-${idx}`} onClick={() => editMode ? toggleSelect(itemId) : onForcePlayPlaylist(active.id, idx)} className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${editMode && isSelected ? 'bg-primary/20' : isPlaying ? 'bg-primary/20 text-primary-light' : 'hover:bg-slate-800/50 text-slate-300'}`}>
                    <div className="flex w-8 items-center justify-center">
                      {editMode ? (
                        <div className={`h-5 w-5 rounded border-2 ${isSelected ? 'border-primary bg-primary' : 'border-slate-600'}`}>{isSelected && <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}</div>
                      ) : (
                        <span className="text-xs text-slate-500">{idx + 1}</span>
                      )}
                    </div>
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-xs">{t.mediaType === 'video' ? '🎬' : '🎵'}</div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{t.name}</p>
                      <p className="truncate text-xs text-slate-500">{t.artist !== 'Unknown Artist' ? t.artist : t.folderName}</p>
                    </div>
                    {isPlaying && <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />}
                  </div>
                )
              })}
            </div>
            {editMode && (
              <div className="border-t border-slate-800 bg-slate-900 px-4 py-3">
                <div className="flex gap-2">
                  <button onClick={handleRemoveSelected} disabled={selectedItemIds.size === 0} className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Remove from playlist ({selectedItemIds.size})</button>
                  <button onClick={() => onDeletePlaylist(active.id)} className="rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-300">Delete playlist</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-3">
{activeTracks.map((t, idx) => {
                const thumb = thumbs[t.fileName]
                return (
                  <button key={`${active.items[idx]?.id ?? t.id}-${idx}`} onClick={() => onForcePlayPlaylist(active.id, idx)} className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left">
                    <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="truncate text-sm font-medium text-white">{t.name}</p>
                      <p className="truncate text-xs text-slate-400">{idx + 1} • {t.artist !== 'Unknown Artist' ? t.artist : t.folderName}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {!editMode && active.items.length > 0 && isQueue && (
          <div className="border-t border-slate-800 p-3 text-center text-[11px] text-slate-500">Queue shows playlist order. Use Edit to remove tracks (playlist only, library untouched).</div>
        )}
      </div>
    )
  }

  // List view
  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Playlists</h2>
            <p className="text-xs text-slate-400">{playlists.length} playlists</p>
          </div>
          <button onClick={() => setShowCreate(v => !v)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white">+ Create</button>
        </div>
        {showCreate && (
          <div className="mt-3 flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Playlist name" className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" onKeyDown={e => { if (e.key === 'Enter') void handleCreate() }} />
            <button onClick={handleCreate} className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-white">Save</button>
          </div>
        )}
      </div>
      {playlists.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="text-slate-500">
            <div className="mb-2 text-4xl">📋</div>
            <p className="text-sm">No playlists yet</p>
            <p className="mt-1 text-xs">Select tracks in Library → Add to playlist, or create one above</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3">
            {playlists.map(p => (
              <motion.button key={p.id} whileTap={{ scale: 0.97 }} onClick={() => setActiveId(p.id)} className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left">
                <div className="grid h-28 grid-cols-2 gap-0.5 bg-slate-800 p-0.5">
                  {/* Show 2x2 thumbs or placeholder */}
                  {(() => {
                    return [0,1,2,3].map(i => {
                      if (p.items.length === 0) return <div key={i} className="bg-slate-700 flex items-center justify-center text-slate-500 text-xs">—</div>
                      if (i === 3 && p.items.length > 4) return <div key={i} className="flex items-center justify-center bg-slate-700 text-sm font-semibold text-slate-300">+{p.items.length - 3}</div>
                      return <div key={i} className="bg-slate-700 flex items-center justify-center text-slate-500">📋</div>
                    })
                  })()}
                </div>
                <div className="px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-white">{p.name?.trim() ? p.name : 'Untitled'}</p>
                  <p className="text-xs text-slate-400">{p.items.length} tracks</p>
                </div>
              </motion.button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
