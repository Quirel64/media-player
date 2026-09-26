import { useState, useEffect, useCallback } from 'react'
import { Layout } from './components/layout/Layout'
import { Sidebar } from './components/layout/Sidebar'
import { AddView } from './components/layout/AddView'
import { LibraryView } from './components/library/LibraryView'
import { NowPlaying } from './components/player/NowPlaying'
import { PlayBar } from './components/player/PlayBar'
import { useAudioEngine } from './hooks/useAudioEngine'
import { useMediaSession } from './hooks/useMediaSession'
import { useFolderPicker } from './hooks/useFolderPicker'
import { usePlayerStore } from './stores/playerStore'
import { getSetting, saveSetting, saveTracks, getAllTracks, getAllPlaylists, savePlaylist, deleteTrack, getPlaylist } from './lib/idb'
import { ToastContainer } from './components/ui/Toast'
import { EventLog } from './components/ui/EventLog'
import { PlaylistsView } from './components/playlist/PlaylistsView'
import { AddToPlaylistSheet } from './components/playlist/AddToPlaylistSheet'
import { usePlaylists } from './hooks/usePlaylists'
import type { TabId } from './components/layout/BottomNav'
import type { Track } from './lib/types'
import type { LockScreenMode } from './lib/types'

export default function App() {
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('library')
  const [nowCollapsed, setNowCollapsed] = useState(false)
  const [pendingAddTracks, setPendingAddTracks] = useState<Track[] | null>(null)
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const { queue, currentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex] || null

  const { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTracks } = useFolderPicker()
  const { playlists, createPlaylist, addTracksToPlaylist, deletePlaylist, playPlaylist, refresh: refreshPlaylists } = usePlaylists()
  const { play, pause, remotePauseOrResume, togglePlay, nextTrack, prevTrack, seek, goToTrack, markNextGesture, videoContainerRef } = useAudioEngine()
  const forcePlayPlaylist = useCallback(async (playlistId: string, startItemIndex = 0) => {
    await playPlaylist(playlistId, startItemIndex)
    // goToTrack forces loadTrack even for same index (fresh reload for dups)
    goToTrack(startItemIndex)
  }, [playPlaylist, goToTrack])
  const { setHandlers } = useMediaSession()

  useEffect(() => {
    const init = async () => {
      const savedMode = await getSetting('lockScreenMode') as LockScreenMode | undefined
      if (savedMode === 'skip10' || savedMode === 'prevnext') {
        usePlayerStore.getState().setLockScreenMode(savedMode)
      }
      // Cleanup dud tracks from previous instanceId bug (same fileName dupes where instanceId !== id)
      try {
        const all = await getAllTracks()
        const seenFileName = new Map<string, Track>()
        const toDelete: string[] = []
        for (const t of all) {
          const existing = seenFileName.get(t.fileName)
          if (!existing) {
            seenFileName.set(t.fileName, t)
          } else {
            // Duplicate fileName — keep the one without instanceId or with instanceId === id (original), delete dud
            const isDud = t.instanceId && t.instanceId !== t.id
            const existingIsDud = existing.instanceId && existing.instanceId !== existing.id
            if (isDud && !existingIsDud) {
              toDelete.push(t.id)
            } else if (!isDud && existingIsDud) {
              toDelete.push(existing.id)
              seenFileName.set(t.fileName, t)
            } else if (isDud && existingIsDud) {
              toDelete.push(t.id)
            }
          }
        }
        if (toDelete.length > 0) {
          for (const id of toDelete) await deleteTrack(id)
          // Also cleanup playlists referencing deleted trackIds
          const allPls = await getAllPlaylists()
          for (const pl of allPls) {
            const before = pl.items.length
            pl.items = pl.items.filter(it => !toDelete.includes(it.trackId))
            if (pl.items.length !== before) {
              pl.items.forEach((it, idx) => { it.order = idx })
              await savePlaylist(pl)
            }
          }
        }
      } catch {}
      const tracks = await loadSavedTracks()
      // Ensure libraryTracks are clean (no instanceId dupes)
      const clean = tracks.filter(t => !t.instanceId || t.instanceId === t.id)
      setLibraryTracks(clean)
      if (clean.length > 0) {
        setActiveTab('library')
      } else {
        setActiveTab('add')
      }
      setReady(true)
    }
    init()
  }, [])

  // Keep libraryTracks in sync when queue is library (not playlist) — filter duds
  useEffect(() => {
    const sync = async () => {
      const all = await getAllTracks()
      const clean = all.filter(t => !t.instanceId || t.instanceId === t.id)
      setLibraryTracks(clean)
    }
    void sync()
  }, [queue.length])

  // Persist lock screen mode
  const lockScreenMode = usePlayerStore((s) => s.lockScreenMode)
  useEffect(() => {
    saveSetting('lockScreenMode', lockScreenMode)
  }, [lockScreenMode])

  useEffect(() => {
    setHandlers({
      onPlay: play,
      onPause: pause,
      onRemotePauseOrResume: remotePauseOrResume,
      onPrev: prevTrack,
      onNext: nextTrack,
      onSeek: seek,
    })
  }, [play, pause, remotePauseOrResume, prevTrack, nextTrack, seek])

  // Flush libraryTracks to IDB on hide/pagehide — best-effort durability for iOS force-close
  // Do NOT flush queue when it contains playlist instanceId dupes (would create dud tracks with same fileName)
  useEffect(() => {
    const flush = () => {
      if (libraryTracks.length === 0) return
      // Only save tracks without instanceId or where instanceId === id (library tracks)
      const toSave = libraryTracks.filter(t => !t.instanceId || t.instanceId === t.id)
      if (toSave.length === 0) return
      void saveTracks(toSave)
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [libraryTracks])

  const handleSelectTrack = useCallback(
    (index: number) => {
      // Universal reset: every tap restarts fresh, even same fileName/instance
      markNextGesture()
      // If queue is not libraryTracks (e.g., playlist), switch queue to library with instanceIds
      const isLibraryQueue = queue.length === libraryTracks.length && queue.every((t, i) => (t.instanceId ?? t.id) === (libraryTracks[i]?.instanceId ?? libraryTracks[i]?.id))
      if (!isLibraryQueue && libraryTracks.length > 0) {
        const { setQueue, setOriginalOrder, setCurrentTrackIndex: setIdx, setPlaying } = usePlayerStore.getState()
        const withInstance = libraryTracks.map(t => ({ ...t, instanceId: t.instanceId ?? t.id }))
        setQueue(withInstance)
        setOriginalOrder(withInstance)
        setIdx(index)
        setPlaying(true)
      } else {
        goToTrack(index)
      }
    },
    [goToTrack, markNextGesture, queue, libraryTracks]
  )

  const handlePickFolder = useCallback(async () => {
    const tracks = await pickFolder()
    if (tracks) {
      const all = await getAllTracks()
      setLibraryTracks(all)
      setActiveTab('library')
    }
  }, [pickFolder])

  const handlePickFiles = useCallback(async () => {
    const tracks = await pickFiles()
    if (tracks) {
      const all = await getAllTracks()
      setLibraryTracks(all)
      setActiveTab('library')
    }
  }, [pickFiles])

  const handleRemoveTracks = useCallback(async (tracks: Track[]) => {
    await removeTracks(tracks)
    const all = await getAllTracks()
    setLibraryTracks(all)
    // Cleanup playlists: remove items referencing deleted trackIds
    const allPlaylists = await getAllPlaylists()
    let changed = false
    for (const pl of allPlaylists) {
      if (pl.id === 'library') continue
      const before = pl.items.length
      const deletedIds = new Set(tracks.map(t => t.id))
      pl.items = pl.items.filter(it => !deletedIds.has(it.trackId))
      if (pl.items.length !== before) {
        pl.items.forEach((it, idx) => { it.order = idx })
        pl.updatedAt = Date.now()
        await savePlaylist(pl)
        changed = true
      }
    }
    if (changed) await refreshPlaylists()
  }, [removeTracks, refreshPlaylists])

  const handleAddToPlaylist = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    setPendingAddTracks(tracks)
  }, [])

  const handleCloseSheet = useCallback(() => setPendingAddTracks(null), [])
  const handleAfterAdd = useCallback(() => {
    setPendingAddTracks(null)
    setActiveTab('playlists')
  }, [])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="mb-4 text-4xl animate-pulse">🎵</div>
          <p className="text-sm text-slate-400">Loading...</p>
        </div>
      </div>
    )
  }

  const renderNowPlaying = () => {
    return <NowPlaying currentTrack={currentTrack} videoContainerRef={videoContainerRef} collapsed={nowCollapsed} onToggleCollapsed={() => setNowCollapsed((v) => !v)} />
  }

  const libraryCurrentIdx = (() => {
    const cur = queue[currentTrackIndex]
    if (!cur) return -1
    return libraryTracks.findIndex(t => t.id === cur.id)
  })()

  const renderContent = () => {
    switch (activeTab) {
      case 'add':
        return <AddView onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} />
      case 'library':
        return (
          <LibraryView
            tracks={libraryTracks}
            currentTrackIndex={libraryCurrentIdx}
            onSelectTrack={handleSelectTrack}
            onPickFolder={handlePickFolder}
            onPickFiles={handlePickFiles}
            onRemoveTracks={handleRemoveTracks}
            onAddToPlaylist={handleAddToPlaylist}
          />
        )
      case 'playlists':
        return (
          <PlaylistsView
            playlists={playlists}
            onCreatePlaylist={async (name, tracks) => { await createPlaylist(name, tracks ?? []) }}
            onForcePlayPlaylist={forcePlayPlaylist}
            onDeletePlaylist={async (id) => {
              // If currently playing this playlist, clear queue
              const pl = playlists.find(p => p.id === id)
              const wasPlaying = pl ? queue.length > 0 && queue.length === pl.items.length && queue.every(t => pl.items.some(it => it.trackId === t.id)) : false
              await deletePlaylist(id)
              if (wasPlaying) {
                const { setQueue, setOriginalOrder, setCurrentTrackIndex } = usePlayerStore.getState()
                setQueue([])
                setOriginalOrder([])
                setCurrentTrackIndex(0)
              }
            }}
            onRemoveFromPlaylist={async (pid, itemIds) => {
              const pl = await getPlaylist(pid)
              if (!pl) return
              const beforeIds = new Set(pl.items.map(it => it.trackId))
              const wasPlayingThisPlaylist = queue.length > 0 && queue.every(t => beforeIds.has(t.id)) && queue.length === pl.items.length
              const s = new Set(itemIds)
              pl.items = pl.items.filter(it => !s.has(it.id))
              pl.items.forEach((it, idx) => { it.order = idx })
              pl.updatedAt = Date.now()
              await savePlaylist(pl)
              await refreshPlaylists()
              // If currently playing this playlist, update queue to new order (instanceId per item)
              if (wasPlayingThisPlaylist) {
                const allTracks = await getAllTracks()
                const map = new Map(allTracks.map(t => [t.id, t] as const))
                const resolved: Track[] = []
                for (const it of pl.items) {
                  const t = map.get(it.trackId)
                  if (t) resolved.push({ ...t, instanceId: it.id })
                }
                const { setQueue, setOriginalOrder, setCurrentTrackIndex, currentTrackIndex: curIdx } = usePlayerStore.getState()
                if (resolved.length === 0) {
                  setQueue([])
                  setOriginalOrder([])
                  setCurrentTrackIndex(0)
                } else {
                  const newIdx = Math.min(curIdx, resolved.length - 1)
                  setQueue(resolved)
                  setOriginalOrder(resolved)
                  setCurrentTrackIndex(newIdx >= 0 ? newIdx : 0)
                }
              }
            }}
            currentTrackId={currentTrack?.id ?? null}
          />
        )
      case 'logs':
        return (
          <div className="flex h-full flex-col p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-white">Debug Log</h2>
              <p className="text-xs text-slate-500">Shows play/pause/handoff and any NotAllowedError — check here after testing on lock screen.</p>
            </div>
            <div className="flex-1 overflow-hidden">
              <EventLog />
            </div>
          </div>
        )
    }
  }

  return (
    <>
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      trackCount={libraryTracks.length}
      sidebar={
        <Sidebar
          trackCount={libraryTracks.length}
          onPickFolder={handlePickFolder}
          onPickFiles={handlePickFiles}
          onClearAll={clearAll}
        />
      }
      nowPlaying={renderNowPlaying()}
      content={renderContent()}
      player={
        <PlayBar
          currentTrack={currentTrack}
          onTogglePlay={togglePlay}
          onNext={nextTrack}
          onPrev={prevTrack}
          onSeek={seek}
        />
      }
    />
    <ToastContainer />
    {pendingAddTracks && (
      <AddToPlaylistSheet
        open={!!pendingAddTracks}
        tracks={pendingAddTracks}
        playlists={playlists}
        onClose={handleCloseSheet}
        onAdd={addTracksToPlaylist}
        onCreate={async (name, tracks) => { await createPlaylist(name, tracks) }}
        onAfterAdd={handleAfterAdd}
      />
    )}
    </>
  )
}
