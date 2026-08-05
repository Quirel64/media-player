import { useState, useEffect, useCallback } from 'react'
import { Layout } from './components/layout/Layout'
import { Sidebar } from './components/layout/Sidebar'
import { TrackList } from './components/playlist/TrackList'
import { NowPlaying } from './components/player/NowPlaying'
import { PlayBar } from './components/player/PlayBar'
import { useAudioEngine } from './hooks/useAudioEngine'
import { useMediaSession } from './hooks/useMediaSession'
import { useFolderPicker } from './hooks/useFolderPicker'
import { usePlayerStore } from './stores/playerStore'
import { requestPersistentStorage } from './lib/idb'

export default function App() {
  const [ready, setReady] = useState(false)
  const { queue, currentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex] || null

  const { pickFolder, loadSavedTracks, clearAll } = useFolderPicker()
  const { togglePlay, nextTrack, prevTrack, seek, goToTrack } = useAudioEngine()
  const { setHandlers } = useMediaSession()

  useEffect(() => {
    const init = async () => {
      await requestPersistentStorage()
      const tracks = await loadSavedTracks()
      setReady(true)
    }
    init()
  }, [])

  useEffect(() => {
    setHandlers({
      onPlay: togglePlay,
      onPrev: prevTrack,
      onNext: nextTrack,
    })
  }, [togglePlay, prevTrack, nextTrack])

  const handleSelectTrack = useCallback(
    (index: number) => {
      goToTrack(index)
    },
    [goToTrack]
  )

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

  return (
    <Layout
      sidebar={
        <Sidebar
          trackCount={queue.length}
          onPickFolder={pickFolder}
          onClearAll={clearAll}
        />
      }
      main={
        <>
          <NowPlaying currentTrack={currentTrack} />
          <TrackList
            tracks={queue}
            currentTrackIndex={currentTrackIndex}
            onSelectTrack={handleSelectTrack}
            onPickFolder={pickFolder}
          />
        </>
      }
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
