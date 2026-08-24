import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getPlayingArtwork, getPausedArtwork } from '../lib/artwork'

/*
  PLAIN LANGUAGE OVERVIEW
  =======================
  This file talks to the iPhone lock screen.

  What it does:
  1. Shows song info on lock screen (title, artist, cover art)
     - When playing: music note artwork
     - When paused (anchor keeping session alive): pause icon artwork
     -> This is how user knows "is it really paused?" since iOS always shows || while anchor plays

  2. Tells iOS which buttons to show on lock screen:
     - skip10 mode:  registers seekbackward/seekforward  -> round ±10s arrows + seek bar
     - prevnext mode: registers previoustrack/nexttrack  -> << >> chevrons + seek bar
     - NEVER both at once -> iOS bug makes it random depending on version/PWA vs browser
     Your toggle in PlayBar switches lockScreenMode and this file re-registers handlers

  3. Handles button presses from lock screen:
     - play  -> play the real track
     - pause -> SPECIAL: while anchor owns session, iOS still shows || and fires "pause"
              that pause really means "resume the real track" (remotePauseOrResume)
     - seekto / seekbackward / seekforward -> jump in song
     - previoustrack / nexttrack -> switch song (only in prevnext mode)
*/

export function useMediaSession() {
  // Refs so lock screen handlers always call the LATEST functions
  // (iOS keeps the handler even after React re-renders, so we use refs)
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  // When anchor owns session, "pause" from lock screen means "resume track"
  const remotePauseOrResumeRef = useRef<(() => void) | null>(null)
  const seekRef = useRef<((time: number) => void) | null>(null)
  const prevRef = useRef<(() => void) | null>(null)
  const nextRef = useRef<(() => void) | null>(null)

  const { currentTrackIndex, queue, isPlaying, lockScreenMode } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  // Keep lock screen song info + artwork in sync
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) return
    // Swap artwork so user can tell "real playing" vs "paused but anchor keeping alive"
    const artwork = isPlaying ? getPlayingArtwork() : getPausedArtwork()
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.name,
      artist: currentTrack.artist || 'Unknown Artist',
      album: currentTrack.album || 'Unknown Album',
      artwork: [{ src: artwork, sizes: '300x300', type: 'image/svg+xml' }],
    })
  }, [currentTrack, currentTrack?.id, isPlaying])

  // Register lock screen button handlers - re-runs when user toggles mode
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const safeSetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Some browsers don't support all actions, ignore
      }
    }

    // Center play button on lock screen
    safeSetHandler('play', () => {
      playRef.current?.()
    })

    // Center pause button - ROUTES THROUGH remotePauseOrResume
    // Why: when anchor is playing (paused state), lock screen still shows ||
    // so this "pause" actually means "resume the real song"
    safeSetHandler('pause', () => {
      if (remotePauseOrResumeRef.current) remotePauseOrResumeRef.current()
      else pauseRef.current?.()
    })

    // Dragging the seek bar on lock screen
    safeSetHandler('seekto', (details) => {
      if (details.seekTime != null) seekRef.current?.(details.seekTime)
    })

    // --- Toggle logic: ONLY ONE set at a time (iOS bug if both) ---
    if (lockScreenMode === 'skip10') {
      // Show round ±10s arrows - good for scrubbing inside a track
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
      // Turn OFF chevrons so iOS doesn't get confused
      safeSetHandler('previoustrack', null)
      safeSetHandler('nexttrack', null)
    } else {
      // Show << >> chevrons - good for switching tracks
      safeSetHandler('previoustrack', () => {
        prevRef.current?.()
      })
      safeSetHandler('nexttrack', () => {
        nextRef.current?.()
      })
      // Turn OFF skip arrows
      safeSetHandler('seekbackward', null)
      safeSetHandler('seekforward', null)
    }

    // Cleanup when component unmounts or mode changes
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

  // Called from App.tsx to wire up real functions (play, pause, etc.)
  const setHandlers = (handlers: {
    onPlay: () => void
    onPause: () => void
    onRemotePauseOrResume: () => void // the special pause->resume handler
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
