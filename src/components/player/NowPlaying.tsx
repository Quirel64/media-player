import { motion } from 'framer-motion'
import { usePlayerStore } from '../../stores/playerStore'
import type { Track } from '../../lib/types'

interface NowPlayingProps {
  currentTrack: Track | null
  videoContainerRef: React.RefObject<HTMLDivElement | null>
  version?: string
}

function formatTime(seconds: number): string {
  if (!seconds || seconds === 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function NowPlaying({ currentTrack, videoContainerRef, version }: NowPlayingProps) {
  const { currentTime, duration } = usePlayerStore()

  if (!currentTrack) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-slate-600">
          <div className="mb-2 text-4xl">🎶</div>
          <p className="text-sm">Select a track to play</p>
          {version && (
            <p className="mt-4 text-[10px] text-slate-700">v{version}</p>
          )}
        </div>
      </div>
    )
  }

  // Both audio and video now use the video container
  // Audio tracks use a canvas-based video with album art
  return (
    <div className="flex flex-col gap-4 p-4">
      <div
        ref={videoContainerRef}
        className="relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-black"
        style={{ aspectRatio: '16/9', maxHeight: '50vh' }}
      >
        {/* Video element (real video or audio-as-video) gets appended here by useAudioEngine */}
      </div>
      <div className="px-2">
        <motion.h2
          key={currentTrack.name}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-1 text-lg font-bold text-white"
        >
          {currentTrack.name}
        </motion.h2>
        <p className="text-sm text-slate-400">
          {currentTrack.artist}
          {currentTrack.album !== 'Unknown Album' && ` • ${currentTrack.album}`}
        </p>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-slate-600">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          {version && (
            <p className="text-[10px] text-slate-700">v{version}</p>
          )}
        </div>
      </div>
    </div>
  )
}
