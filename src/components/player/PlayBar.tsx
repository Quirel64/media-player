import { motion } from 'framer-motion'
import { usePlayerStore } from '../../stores/playerStore'
import type { Track } from '../../lib/types'

interface PlayBarProps {
  currentTrack: Track | null
  onTogglePlay: () => void
  onNext: () => void
  onPrev: () => void
  onSeek: (time: number) => void
}

function formatTime(seconds: number): string {
  if (!seconds || seconds === 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function PlayBar({ currentTrack, onTogglePlay, onNext, onPrev, onSeek }: PlayBarProps) {
  const { isPlaying, currentTime, duration, volume, isMuted, shuffleOn, repeatMode, setVolume, toggleMute, toggleShuffle, cycleRepeat } =
    usePlayerStore()

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percent = x / rect.width
    onSeek(percent * duration)
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3 md:px-6">
      {/* Track info */}
      <div className="hidden min-w-0 flex-1 md:block">
        {currentTrack ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/30 to-accent/30">
              <span className="text-lg">🎵</span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{currentTrack.name}</p>
              <p className="truncate text-xs text-slate-400">{currentTrack.artist}</p>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-500">No track selected</div>
        )}
      </div>

      {/* Center controls */}
      <div className="flex flex-1 flex-col items-center gap-1 md:flex-none md:w-96">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleShuffle}
            className={`hidden p-2 transition-colors md:block ${
              shuffleOn ? 'text-primary' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            🔀
          </button>

          <button
            onClick={onPrev}
            className="p-2 text-slate-400 transition-colors hover:text-white"
          >
            ⏮
          </button>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={onTogglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-950 transition-transform hover:scale-105"
          >
            {isPlaying ? '⏸' : '▶'}
          </motion.button>

          <button
            onClick={onNext}
            className="p-2 text-slate-400 transition-colors hover:text-white"
          >
            ⏭
          </button>

          <button
            onClick={cycleRepeat}
            className={`hidden p-2 transition-colors md:block ${
              repeatMode !== 'off' ? 'text-primary' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {repeatMode === 'one' ? '🔂' : '🔁'}
          </button>
        </div>

        {/* Seek bar */}
        <div className="flex w-full items-center gap-2">
          <span className="w-10 text-right text-xs text-slate-500">{formatTime(currentTime)}</span>
          <div
            onClick={handleSeek}
            className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-slate-700"
          >
            <motion.div
              className="absolute left-0 top-0 h-full rounded-full bg-primary"
              style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-md transition-opacity group-hover:opacity-100"
              style={{ left: duration > 0 ? `calc(${(currentTime / duration) * 100}% - 6px)` : '0' }}
            />
          </div>
          <span className="w-10 text-xs text-slate-500">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="hidden items-center gap-2 md:flex">
        <button onClick={toggleMute} className="p-2 text-slate-400 transition-colors hover:text-white">
          {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={isMuted ? 0 : volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-20 accent-primary"
        />
      </div>
    </div>
  )
}
