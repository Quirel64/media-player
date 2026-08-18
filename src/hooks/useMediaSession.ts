import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export function useMediaSession() {
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  const seekRef = useRef<((time: number) => void) | null>(null)

  const { currentTrackIndex, queue } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    if (currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: currentTrack.artist || 'Unknown Artist',
        album: currentTrack.album || 'Unknown Album',
      })
    }
  }, [currentTrack, currentTrack?.id])

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
      pauseRef.current?.()
    })

    safeSetHandler('seekto', (details) => {
      if (details.seekTime != null) {
        seekRef.current?.(details.seekTime)
      }
    })

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

    return () => {
      safeSetHandler('play', null)
      safeSetHandler('pause', null)
      safeSetHandler('seekto', null)
      safeSetHandler('seekbackward', null)
      safeSetHandler('seekforward', null)
    }
  }, [])

  const setHandlers = (handlers: {
    onPlay: () => void
    onPause: () => void
    onPrev: () => void
    onNext: () => void
    onSeek: (time: number) => void
  }) => {
    playRef.current = handlers.onPlay
    pauseRef.current = handlers.onPause
    seekRef.current = handlers.onSeek
  }

  return { setHandlers }
}
