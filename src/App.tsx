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
import { getSetting, saveSetting, saveTracks, getAllTracks, getPlaylist, savePlaylist } from './lib/idb'
import { queueKey, toQueueItem, isLibraryQueue, findQueueIndexByKey } from './lib/queue'
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
    // Only force-reload on success — a failed resolve (empty/missing playlist)
    // must NOT fall through to playing whatever the queue happens to hold.
    if (!(await playPlaylist(playlistId, startItemIndex))) return
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
      // Phase 1b reconcile inside loadSavedTracks purges duds/orphans and repairs
      // the library copy — no App-side dud filters needed anymore.
      const tracks = await loadSavedTracks()
      setLibraryTracks(tracks)
      if (tracks.length > 0) {
        setActiveTab('library')
      } else {
        setActiveTab('add')
      }
      setReady(true)
    }
    init()
  }, [])

  // Keep libraryTracks in sync when queue is library (not playlist)
  useEffect(() => {
    const sync = async () => {
      setLibraryTracks(await getAllTracks())
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

  // Flush libraryTracks to IDB on hide/pagehide — best-effort durability for iOS force-close.
  // libraryTracks is canonical by construction (reconcile + queue helpers), so save as-is.
  useEffect(() => {
    const flush = () => {
      if (libraryTracks.length === 0) return
      void saveTracks(libraryTracks)
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
      // If queue is not libraryTracks (e.g., playlist), switch queue to library
      if (!isLibraryQueue(queue, libraryTracks) && libraryTracks.length > 0) {
        const { setQueue, setOriginalOrder, setCurrentTrackIndex: setIdx, setPlaying } = usePlayerStore.getState()
        const withInstance = libraryTracks.map((t) => toQueueItem(t))
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
    // Capture the sounding occurrence first: same stale-index class of bug as
    // playlist removal — deleting the playing file must migrate, not ghost.
    const before = usePlayerStore.getState()
    const beforeKey = before.queue[before.currentTrackIndex] ? queueKey(before.queue[before.currentTrackIndex]) : null
    const beforeIdx = before.currentTrackIndex
    // Phase 1a: removeTracks() now prunes library copy + playlist refs itself
    // (transactional delete) — here we just refresh library + playlist views.
    await removeTracks(tracks)
    const all = await getAllTracks()
    setLibraryTracks(all)
    await refreshPlaylists()
    const after = usePlayerStore.getState()
    if (after.queue.length === 0) {
      if (beforeKey != null) { try { await pause() } catch { /* best-effort */ } }
      return
    }
    if (beforeKey != null && !after.queue.some((t) => queueKey(t) === beforeKey)) {
      // Sounding file deleted → next in line, previous if it was the last one.
      goToTrack(Math.min(beforeIdx, after.queue.length - 1))
    }
  }, [removeTracks, refreshPlaylists, goToTrack, pause])

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

  // Library highlight: match by track id (library rows are tracks, twins have distinct ids).
  // Playlist occurrence highlight uses currentQueueKey below (instanceId-aware).
  const libraryCurrentIdx = (() => {
    const cur = queue[currentTrackIndex]
    if (!cur) return -1
    return libraryTracks.findIndex((t) => t.id === cur.id)
  })()
  const currentQueueKey = currentTrack ? queueKey(currentTrack) : null

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
            queueIsLibrary={isLibraryQueue(queue, libraryTracks)}
            currentTrackId={currentTrack?.id ?? null}
          />
        )
      case 'playlists':
        return (
          <PlaylistsView
            playlists={playlists}
            onCreatePlaylist={async (name, tracks) => { await createPlaylist(name, tracks ?? []) }}
            onForcePlayPlaylist={forcePlayPlaylist}
            onDeletePlaylist={async (id) => {
              // If currently playing this playlist, clear queue (compare by queueKey occurrences)
              const pl = playlists.find(p => p.id === id)
              const itemKeys = pl ? new Set(pl.items.map((it) => it.id)) : new Set<string>()
              const wasPlaying = pl ? queue.length > 0 && queue.length === pl.items.length && queue.every((t) => itemKeys.has(queueKey(t))) : false
              await deletePlaylist(id)
              if (wasPlaying) {
                // Stop audio too — otherwise the orphaned src keeps sounding with no queue.
                try { await pause() } catch { /* best-effort */ }
                const { setQueue, setOriginalOrder, setCurrentTrackIndex } = usePlayerStore.getState()
                setQueue([])
                setOriginalOrder([])
                setCurrentTrackIndex(0)
              }
            }}
            onRemoveFromPlaylist={async (pid, itemIds) => {
              const pl = await getPlaylist(pid)
              if (!pl) return
              const beforeKeys = new Set(pl.items.map((it) => it.id))
              const wasPlayingThisPlaylist = queue.length > 0 && queue.every((t) => beforeKeys.has(queueKey(t))) && queue.length === pl.items.length
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
                  if (t) resolved.push(toQueueItem(t, it.id))
                }
                const { setQueue, setOriginalOrder, setCurrentTrackIndex } = usePlayerStore.getState()
                if (resolved.length === 0) {
                  // Last item removed while playing → stop, don't leave orphan audio.
                  try { await pause() } catch { /* best-effort */ }
                  setQueue([])
                  setOriginalOrder([])
                  setCurrentTrackIndex(0)
                } else {
                  // Policy: if the sounding occurrence survives, keep it playing
                  // seamlessly at its NEW index; if it was removed, migrate to
                  // the next in line (same index holds the successor), or the
                  // previous track when it was the last one.
                  const curKey = currentTrack ? queueKey(currentTrack) : null
                  const newPos = curKey ? findQueueIndexByKey(resolved, curKey) : -1
                  if (newPos !== -1) {
                    setQueue(resolved)
                    setOriginalOrder(resolved)
                    setCurrentTrackIndex(newPos)
                  } else {
                    const migrateIdx = Math.min(currentTrackIndex, resolved.length - 1)
                    const { setQueue: sq, setOriginalOrder: soo } = usePlayerStore.getState()
                    sq(resolved)
                    soo(resolved)
                    goToTrack(migrateIdx >= 0 ? migrateIdx : 0)
                  }
                }
              }
            }}
            currentTrackId={currentTrack?.id ?? null}
            currentQueueKey={currentQueueKey}
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
