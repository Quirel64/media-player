import { motion } from 'framer-motion'

/**
 * Unified playing indicator (Phase 3 follow-up).
 *
 * - `playing`: the exact queue occurrence that is sounding now (pulsing dot).
 * - `source`: the library original of a playlist occurrence sounding elsewhere
 *   (static muted dot). Makes the playlist→library double-glow intentional and
 *   visually distinct instead of looking like a bug.
 */
export function PlayingIndicator({ variant = 'playing' }: { variant?: 'playing' | 'source' }) {
  if (variant === 'source') {
    return (
      <span
        className="h-2 w-2 flex-shrink-0 rounded-full bg-slate-500"
        title="Source of what's playing"
      />
    )
  }
  return (
    <motion.span
      animate={{ scale: [1, 1.25, 1], opacity: [1, 0.75, 1] }}
      transition={{ repeat: Infinity, duration: 1.5 }}
      className="h-2 w-2 flex-shrink-0 rounded-full bg-primary"
      title="Now playing"
    />
  )
}
