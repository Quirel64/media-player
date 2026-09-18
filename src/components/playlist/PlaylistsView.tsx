import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Track, Playlist } from '../../lib/types'
import { getAllTracks } from '../../lib/idb'
import { showError } from '../ui/Toast'

interface Props {
  playlists: Playlist[]
  onCreatePlaylist: (name: string, tracks?: Track[]) => Promise<void>
  onPlayPlaylist: (id: string, startIdx?: number) => void
  onDeletePlaylist: (id: string) => void
  onAddToPlaylist: (tracks: Track[]) => void
}

export function PlaylistsView({ playlists, onCreatePlaylist, onPlayPlaylist, onDeletePlaylist }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTracks, setActiveTracks] = useState<Track[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')

  const active = activeId ? playlists.find(p => p.id === activeId) ?? null : null

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

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) { showError('Name required'); return }
    await onCreatePlaylist(name, [])
    setNewName('')
    setShowCreate(false)
  }

  // Active playlist detail
  if (active) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          <button onClick={() => setActiveId(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">{active.name}</h2>
            <p className="text-xs text-slate-400">{active.items.length} tracks {active.items.length !== activeTracks.length ? `(${activeTracks.length} available)` : ''}</p>
          </div>
          <button onClick={() => onPlayPlaylist(active.id, 0)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white">Play</button>
        </div>
        {active.items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
            <div>
              <div className="mb-2 text-3xl">📋</div>
              <p className="text-sm">No tracks yet</p>
              <p className="text-xs">Add from Library via Select → Add to playlist</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {activeTracks.map((t, idx) => (
              <div key={`${active.items[idx]?.id ?? t.id}-${idx}`} onClick={() => onPlayPlaylist(active.id, idx)} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800/50 text-slate-300">
                <span className="w-6 text-xs text-slate-500">{idx + 1}</span>
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-xs">{t.mediaType === 'video' ? '🎬' : '🎵'}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{t.name}</p>
                  <p className="truncate text-xs text-slate-500">{t.artist !== 'Unknown Artist' ? t.artist : t.folderName}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-slate-800 p-3">
          <button onClick={() => onDeletePlaylist(active.id)} className="w-full rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-300 hover:bg-red-900/50">Delete playlist</button>
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 px-4 py-3">
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
        <div className="grid grid-cols-2 gap-3 p-3 overflow-y-auto">
          {playlists.map(p => (
            <motion.button key={p.id} whileTap={{ scale: 0.97 }} onClick={() => setActiveId(p.id)} className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left">
              <div className="flex h-28 items-center justify-center bg-slate-800 text-2xl">📋</div>
              <div className="px-3 py-2.5">
                <p className="truncate text-sm font-medium text-white">{p.name}</p>
                <p className="text-xs text-slate-400">{p.items.length} tracks</p>
              </div>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )
}
