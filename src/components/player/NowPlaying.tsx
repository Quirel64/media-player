import { useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { usePlayerStore } from '../../stores/playerStore'
import type { Track } from '../../lib/types'

interface NowPlayingProps {
  currentTrack: Track | null
  videoContainerRef: React.RefObject<HTMLDivElement | null>
}

function formatTime(seconds: number): string {
  if (!seconds || seconds === 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function NowPlaying({ currentTrack, videoContainerRef }: NowPlayingProps) {
  const { currentTime, duration } = usePlayerStore()
  const isFullscreen = useRef(false)

  const toggleFullscreen = useCallback(() => {
    const container = videoContainerRef.current
    if (!container) return

    if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
      const el = container as any
      if (el.requestFullscreen) {
        el.requestFullscreen()
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen()
      }
      isFullscreen.current = true
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen()
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen()
      }
      isFullscreen.current = false
    }
  }, [videoContainerRef])

  if (!currentTrack) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-slate-600">
          <div className="mb-2 text-4xl">🎶</div>
          <p className="text-sm">Select a track to play</p>
        </div>
      </div>
    )
  }

  if (currentTrack.mediaType === 'video') {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div
          ref={videoContainerRef}
          className="group relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-black"
          style={{ aspectRatio: '16/9', maxHeight: '50vh' }}
        >
          {/* Video element gets appended here by useAudioEngine */}
          <button
            onClick={toggleFullscreen}
            className="absolute right-2 top-2 z-10 rounded-lg bg-black/60 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          </button>
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
        </div>
      </div>
    )
  }

  return (
    <motion.div
      key={currentTrack.id}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-center gap-6 p-8"
    >
      <motion.div
        className="flex h-48 w-48 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/30 to-accent/30 shadow-2xl"
        animate={{ rotate: currentTime > 0 ? [0, 0, 0] : 0 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
      >
        <span className="text-6xl">🎵</span>
      </motion.div>

      <div className="text-center">
        <motion.h2
          key={currentTrack.name}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-1 text-xl font-bold text-white"
        >
          {currentTrack.name}
        </motion.h2>
        <p className="text-sm text-slate-400">
          {currentTrack.artist}
          {currentTrack.album !== 'Unknown Album' && ` • ${currentTrack.album}`}
        </p>
      </div>

      <div className="w-full max-w-md">
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-700">
          <motion.div
            className="absolute left-0 top-0 h-full bg-primary"
            style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }}
            transition={{ duration: 0.1 }}
          />
        </div>
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </motion.div>
  )
}
