import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getPlayingArtwork, getPausedArtwork } from '../lib/artwork'

export function useMediaSession() {
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  const remotePauseOrResumeRef = useRef<(() => void) | null>(null)
  const seekRef = useRef<((time: number) => void) | null>(null)
  const prevRef = useRef<(() => void) | null>(null)
  const nextRef = useRef<(() => void) | null>(null)

  const { currentTrackIndex, queue, isPlaying, lockScreenMode } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) return
    const artwork = isPlaying ? getPlayingArtwork() : getPausedArtwork()
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.name,
      artist: currentTrack.artist || 'Unknown Artist',
      album: currentTrack.album || 'Unknown Album',
      artwork: [{ src: artwork, sizes: '300x300', type: 'image/svg+xml' }],
    })
  }, [currentTrack, currentTrack?.id, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const safeSetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {}
    }

    safeSetHandler('play', () => {
      playRef.current?.()
    })
    safeSetHandler('pause', () => {
      if (remotePauseOrResumeRef.current) remotePauseOrResumeRef.current()
      else pauseRef.current?.()
    })
    safeSetHandler('seekto', (details) => {
      if (details.seekTime != null) seekRef.current?.(details.seekTime)
    })

    // Toggle logic: only register ONE set at a time to avoid iOS bug
    if (lockScreenMode === 'skip10') {
      // Round ±10s arrows + working seek bar
      safeSetHandler('seekbackward', (details) => {
        const { currentTime } = usePlayerStore.getState()
        const offset = details.seekOffset ?? 10
        seekRef.current?.(Math.max(0, currentTime - offset))
      })
      safeSetHandler('seekforward', (details) => {
        const { currentTime, duration } = usePlayerStore.getState()
        const offset = details.seekOffset ?? 10
        seekRef.current?.(Math.min(duration, currentTime + offset))
      })
      // Make sure prev/next chevrons are OFF
      safeSetHandler('previoustrack', null)
      safeSetHandler('nexttrack', null)
    } else {
      // Chevrons << >> for track switching
      safeSetHandler('previoustrack', () => {
        prevRef.current?.()
      })
      safeSetHandler('nexttrack', () => {
        nextRef.current?.()
      })
      // Make sure skip arrows are OFF
      safeSetHandler('seekbackward', null)
      safeSetHandler('seekforward', null)
    }

    return () => {
      safeSetHandler('play', null)
      safeSetHandler('pause', null)
      safeSetHandler('seekto', null)
      safeSetHandler('seekbackward', null)
      safeSetHandler('seekforward', null)
      safeSetHandler('previoustrack', null)
      safeSetHandler('nexttrack', null)
    }
  }, [lockScreenMode])

  const setHandlers = (handlers: {
    onPlay: () => void
    onPause: () => void
    onRemotePauseOrResume: () => void
    onPrev: () => void
    onNext: () => void
    onSeek: (time: number) => void
  }) => {
    playRef.current = handlers.onPlay
    pauseRef.current = handlers.onPause
    remotePauseOrResumeRef.current = handlers.onRemotePauseOrResume
    prevRef.current = handlers.onPrev
    nextRef.current = handlers.onNext
    seekRef.current = handlers.onSeek
  }

  return { setHandlers }
}
