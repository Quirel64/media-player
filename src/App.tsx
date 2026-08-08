import { useState, useEffect, useCallback } from 'react'
import { Layout } from './components/layout/Layout'
import { Sidebar } from './components/layout/Sidebar'
import { AddView } from './components/layout/AddView'
import { TrackList } from './components/playlist/TrackList'
import { NowPlaying } from './components/player/NowPlaying'
import { PlayBar } from './components/player/PlayBar'
import { useAudioEngine } from './hooks/useAudioEngine'
import { useMediaSession } from './hooks/useMediaSession'
import { useFolderPicker } from './hooks/useFolderPicker'
import { usePlayerStore } from './stores/playerStore'
import { requestPersistentStorage } from './lib/idb'
import type { TabId } from './components/layout/BottomNav'
import type { Track } from './lib/types'

export default function App() {
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('library')
  const { queue, currentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex] || null

  const { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTracks } = useFolderPicker()
  const { togglePlay, nextTrack, prevTrack, seek, goToTrack, videoContainerRef } = useAudioEngine()
  const { setHandlers } = useMediaSession()

  useEffect(() => {
    const init = async () => {
      await requestPersistentStorage()
      const tracks = await loadSavedTracks()
      if (tracks.length > 0) {
        setActiveTab('library')
      } else {
        setActiveTab('add')
      }
      setReady(true)
    }
    init()
  }, [])

  useEffect(() => {
    setHandlers({
      onPlay: togglePlay,
      onPrev: prevTrack,
      onNext: nextTrack,
      onSeek: seek,
    })
  }, [togglePlay, prevTrack, nextTrack, seek])

  const handleSelectTrack = useCallback(
    (index: number) => {
      goToTrack(index)
    },
    [goToTrack]
  )

  const handlePickFolder = useCallback(async () => {
    const tracks = await pickFolder()
    if (tracks) setActiveTab('library')
  }, [pickFolder])

  const handlePickFiles = useCallback(async () => {
    const tracks = await pickFiles()
    if (tracks) setActiveTab('library')
  }, [pickFiles])

  const handleRemoveTracks = useCallback(async (tracks: Track[]) => {
    await removeTracks(tracks)
  }, [removeTracks])

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
    return <NowPlaying currentTrack={currentTrack} videoContainerRef={videoContainerRef} />
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'add':
        return <AddView onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} />
      case 'library':
        return (
          <TrackList
            tracks={queue}
            currentTrackIndex={currentTrackIndex}
            onSelectTrack={handleSelectTrack}
            onPickFolder={handlePickFolder}
            onPickFiles={handlePickFiles}
            onRemoveTracks={handleRemoveTracks}
          />
        )
      case 'playlists':
        return (
          <div className="flex h-full items-center justify-center p-8">
            <div className="text-center text-slate-500">
              <div className="mb-2 text-4xl">📋</div>
              <p className="text-sm">Playlists coming soon</p>
            </div>
          </div>
        )
    }
  }

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      trackCount={queue.length}
      sidebar={
        <Sidebar
          trackCount={queue.length}
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
  )
}
