import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export function useMediaSession() {
  const prevTrackRef = useRef<(() => void) | null>(null)
  const nextTrackRef = useRef<(() => void) | null>(null)
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  const seekRef = useRef<((time: number) => void) | null>(null)

  const { isPlaying, currentTrackIndex, queue } = usePlayerStore()
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

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying])

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

    safeSetHandler('previoustrack', () => {
      prevTrackRef.current?.()
    })

    safeSetHandler('nexttrack', () => {
      nextTrackRef.current?.()
    })

    safeSetHandler('seekto', (details) => {
      if (details.seekTime != null) {
        seekRef.current?.(details.seekTime)
      }
    })

    safeSetHandler('seekforward', (details) => {
      const el = document.querySelector('audio, video') as HTMLMediaElement | null
      if (el) {
        el.currentTime = Math.min(el.currentTime + (details.seekOffset ?? 10), el.duration || Infinity)
      }
    })

    safeSetHandler('seekbackward', (details) => {
      const el = document.querySelector('audio, video') as HTMLMediaElement | null
      if (el) {
        el.currentTime = Math.max(el.currentTime - (details.seekOffset ?? 10), 0)
      }
    })

    return () => {
      safeSetHandler('play', null)
      safeSetHandler('pause', null)
      safeSetHandler('previoustrack', null)
      safeSetHandler('nexttrack', null)
      safeSetHandler('seekto', null)
      safeSetHandler('seekforward', null)
      safeSetHandler('seekbackward', null)
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
    prevTrackRef.current = handlers.onPrev
    nextTrackRef.current = handlers.onNext
    seekRef.current = handlers.onSeek
  }

  return { setHandlers }
}
