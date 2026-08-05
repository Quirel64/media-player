import { motion, AnimatePresence } from 'framer-motion'
import type { Track } from '../../lib/types'

interface TrackListProps {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TrackList({ tracks, currentTrackIndex, onSelectTrack, onPickFolder }: TrackListProps) {
  if (tracks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center"
        >
          <div className="mb-4 text-6xl">🎵</div>
          <h2 className="mb-2 text-xl font-semibold text-white">No Music Yet</h2>
          <p className="mb-6 text-sm text-slate-400">
            Open a folder with audio files to get started
          </p>
          <button
            onClick={onPickFolder}
            className="rounded-lg bg-primary px-6 py-3 font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
          >
            Open Folder
          </button>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Library</h2>
          <p className="text-sm text-slate-400">
            {tracks.length} track{tracks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={onPickFolder}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
        >
          + Add More
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <AnimatePresence mode="popLayout">
          {tracks.map((track, index) => (
            <motion.div
              key={track.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, delay: index * 0.02 }}
              onClick={() => onSelectTrack(index)}
              className={`group flex cursor-pointer items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
                index === currentTrackIndex
                  ? 'bg-primary/20 text-primary-light'
                  : 'text-slate-300 hover:bg-slate-800/50'
              }`}
            >
              <div className="flex w-8 items-center justify-center">
                {index === currentTrackIndex ? (
                  <motion.div
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="h-4 w-4 rounded-full bg-primary"
                  />
                ) : (
                  <span className="text-sm text-slate-500">{index + 1}</span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{track.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {track.artist} {track.album !== 'Unknown Album' ? `• ${track.album}` : ''}
                </p>
              </div>

              <span className="text-xs text-slate-600">{formatSize(track.size)}</span>
              <span className="w-12 text-right text-xs text-slate-500">
                {formatDuration(track.duration)}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
