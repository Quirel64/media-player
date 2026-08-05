import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export function useMediaSession() {
  const prevTrackRef = useRef<(() => void) | null>(null)
  const nextTrackRef = useRef<(() => void) | null>(null)
  const togglePlayRef = useRef<(() => void) | null>(null)

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

    navigator.mediaSession.setActionHandler('play', () => {
      togglePlayRef.current?.()
    })

    navigator.mediaSession.setActionHandler('pause', () => {
      togglePlayRef.current?.()
    })

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      prevTrackRef.current?.()
    })

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      nextTrackRef.current?.()
    })

    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        const audio = document.querySelector('audio')
        if (audio) audio.currentTime = details.seekTime
      }
    })

    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }
  }, [])

  const setHandlers = (handlers: {
    onPlay: () => void
    onPrev: () => void
    onNext: () => void
  }) => {
    togglePlayRef.current = handlers.onPlay
    prevTrackRef.current = handlers.onPrev
    nextTrackRef.current = handlers.onNext
  }

  return { setHandlers }
}
