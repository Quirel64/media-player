import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const lastPositionUpdateRef = useRef(0)

  const {
    isPlaying,
    currentTrackIndex,
    volume,
    isMuted,
    queue,
    setPlaying,
    setCurrentTime,
    setDuration,
    setCurrentTrackIndex,
  } = usePlayerStore()

  const currentTrack = queue[currentTrackIndex]

  const cleanupMedia = useCallback(() => {
    if (mediaRef.current) {
      const el = mediaRef.current
      el.pause()
      el.removeAttribute('src')
      el.load()
      mediaRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      if (videoRef.current.parentNode) {
        videoRef.current.parentNode.removeChild(videoRef.current)
      }
      videoRef.current = null
    }
  }, [])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, getNextTrackIndex } = usePlayerStore.getState()
    if (repeatMode === 'one') {
      const el = mediaRef.current
      if (el) {
        el.currentTime = 0
        el.play().catch(() => {})
      }
      return
    }
    const nextIndex = getNextTrackIndex()
    if (nextIndex !== null) {
      setCurrentTrackIndex(nextIndex)
    } else {
      setPlaying(false)
    }
  }, [setCurrentTrackIndex, setPlaying])

  const loadTrack = useCallback(async (trackIndex: number) => {
    const { queue } = usePlayerStore.getState()
    const track = queue[trackIndex]
    if (!track) return

    cleanupMedia()

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    const url = await getFileURLFromOPFS(track.fileName)
    if (!url) {
      showError(`File not found in OPFS: ${track.fileName}`)
      return
    }
    blobUrlRef.current = url

    if (track.mediaType === 'video') {
      // Video file: <audio> source of truth (background) + visible <video> (display)
      const audio = new Audio()
      audio.preload = 'auto'
      audio.src = url

      const updatePosition = () => {
        if (!('mediaSession' in navigator)) return
        const now = Date.now()
        if (now - lastPositionUpdateRef.current < 1000) return
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: 1,
            position: Math.min(audio.currentTime, audio.duration),
          })
          lastPositionUpdateRef.current = now
        } catch {}
      }

      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime ?? 0)
        updatePosition()
      })
      audio.addEventListener('loadedmetadata', () => {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          if ('mediaSession' in navigator) {
            try {
              navigator.mediaSession.setPositionState({
                duration: d,
                playbackRate: 1,
                position: Math.min(audio.currentTime, d),
              })
            } catch {}
          }
        }
      })
      audio.addEventListener('durationchange', () => {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          if ('mediaSession' in navigator) {
            try {
              navigator.mediaSession.setPositionState({
                duration: d,
                playbackRate: 1,
                position: Math.min(audio.currentTime, d),
              })
            } catch {}
          }
        }
      })
      audio.addEventListener('ended', () => {
        if (videoRef.current && !videoRef.current.paused) {
          videoRef.current.pause()
        }
        handleTrackEnd()
      })
      audio.addEventListener('error', () => {
        if (mediaRef.current !== audio) return
        showError(`Audio error: ${track.name}`)
        setPlaying(false)
      })
      audio.addEventListener('play', () => {
        if (mediaRef.current !== audio) return
        setPlaying(true)
      })
      audio.addEventListener('pause', () => {
        if (mediaRef.current !== audio) return
        if (!audio.seeking && (document.visibilityState === 'visible' || audio.ended)) {
          setPlaying(false)
        }
      })

      audio.controls = false
      audio.style.position = 'fixed'
      audio.style.left = '-1px'
      audio.style.top = '-1px'
      audio.style.width = '1px'
      audio.style.height = '1px'
      audio.style.opacity = '0'
      audio.style.pointerEvents = 'none'
      document.body.appendChild(audio)

      // Video element: visual display only, muted, follows audio time
      const v = document.createElement('video')
      v.playsInline = true
      v.setAttribute('webkit-playsinline', 'true')
      v.muted = true
      v.controls = false
      v.preload = 'auto'
      v.src = url
      v.style.position = 'absolute'
      v.style.inset = '0'
      v.style.width = '100%'
      v.style.height = '100%'
      v.style.objectFit = 'contain'
      v.style.borderRadius = '12px'
      v.style.touchAction = 'manipulation'

      videoRef.current = v

      if (videoContainerRef.current) {
        videoContainerRef.current.appendChild(v)
      }

      // Sync video to audio on timeupdate
      audio.addEventListener('timeupdate', () => {
        if (v.paused && !v.seeking && document.visibilityState === 'visible') {
          v.currentTime = audio.currentTime
        }
      })

      v.addEventListener('canplay', () => {
        if (Math.abs(v.currentTime - audio.currentTime) > 1) {
          v.currentTime = audio.currentTime
        }
      })

      try {
        await audio.play()
        v.currentTime = audio.currentTime
        await v.play().catch(() => {})
        mediaRef.current = audio
        setPlaying(true)
      } catch (e) {
        mediaRef.current = audio
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    } else {
      // Audio file: plain <audio> element, no hidden <video>, no Web Audio API
      const el = document.createElement('audio')
      el.preload = 'auto'
      el.controls = false
      el.src = url

      const updatePosition = () => {
        if (!('mediaSession' in navigator)) return
        const now = Date.now()
        if (now - lastPositionUpdateRef.current < 1000) return
        if (!Number.isFinite(el.duration) || el.duration <= 0) return
        try {
          navigator.mediaSession.setPositionState({
            duration: el.duration,
            playbackRate: 1,
            position: Math.min(el.currentTime, el.duration),
          })
          lastPositionUpdateRef.current = now
        } catch {}
      }

      el.addEventListener('timeupdate', () => {
        setCurrentTime(el.currentTime ?? 0)
        updatePosition()
      })
      el.addEventListener('loadedmetadata', () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          if ('mediaSession' in navigator) {
            try {
              navigator.mediaSession.setPositionState({
                duration: d,
                playbackRate: 1,
                position: Math.min(el.currentTime, d),
              })
            } catch {}
          }
        }
      })
      el.addEventListener('durationchange', () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          if ('mediaSession' in navigator) {
            try {
              navigator.mediaSession.setPositionState({
                duration: d,
                playbackRate: 1,
                position: Math.min(el.currentTime, d),
              })
            } catch {}
          }
        }
      })
      el.addEventListener('ended', () => {
        handleTrackEnd()
      })
      el.addEventListener('error', () => {
        if (mediaRef.current !== el) return
        showError(`Audio error: ${track.name}`)
        setPlaying(false)
      })
      el.addEventListener('play', () => {
        if (mediaRef.current !== el) return
        setPlaying(true)
      })
      el.addEventListener('pause', () => {
        if (mediaRef.current !== el) return
        if (!el.seeking && (document.visibilityState === 'visible' || el.ended)) {
          setPlaying(false)
        }
      })

      mediaRef.current = el

      try {
        await el.play()
        setPlaying(true)
      } catch (e) {
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    }
  }, [cleanupMedia, setCurrentTime, setDuration, setPlaying, handleTrackEnd])

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return

    try {
      await el.play()
      if ('mediaSession' in navigator && Number.isFinite(el.duration) && el.duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: el.duration,
            playbackRate: 1,
            position: Math.min(el.currentTime, el.duration),
          })
        } catch {}
      }
      if (videoRef.current && videoRef.current.paused) {
        videoRef.current.currentTime = el.currentTime
        videoRef.current.play().catch(() => {})
      }
      setPlaying(true)
    } catch (e) {
      showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
      setPlaying(false)
    }
  }, [setPlaying])

  const pause = useCallback(() => {
    mediaRef.current?.pause()
    videoRef.current?.pause()
    setPlaying(false)
  }, [setPlaying])

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause()
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const seek = useCallback((time: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = time
      setCurrentTime(time)
    }
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
    if ('mediaSession' in navigator && mediaRef.current) {
      const el = mediaRef.current
      if (Number.isFinite(el.duration) && el.duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: el.duration,
            playbackRate: 1,
            position: Math.min(time, el.duration),
          })
        } catch {}
      }
    }
  }, [setCurrentTime])

  const nextTrack = useCallback(() => {
    const { getNextTrackIndex } = usePlayerStore.getState()
    const nextIndex = getNextTrackIndex()
    if (nextIndex !== null) {
      setCurrentTrackIndex(nextIndex)
    }
  }, [setCurrentTrackIndex])

  const prevTrack = useCallback(() => {
    const { currentTime, getPrevTrackIndex } = usePlayerStore.getState()
    if (currentTime > 3) {
      seek(0)
    } else {
      const prevIndex = getPrevTrackIndex()
      if (prevIndex !== null) {
        setCurrentTrackIndex(prevIndex)
      }
    }
  }, [setCurrentTrackIndex, seek])

  const goToTrack = useCallback((index: number) => {
    setCurrentTrackIndex(index)
  }, [setCurrentTrackIndex])

  useEffect(() => {
    if (currentTrack && queue.length > 0) {
      loadTrack(currentTrackIndex)
    }
  }, [currentTrackIndex, currentTrack?.id])

  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
      cleanupMedia()
    }
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        videoRef.current?.pause()
      } else {
        const audio = mediaRef.current
        const video = videoRef.current
        if (audio && video && !audio.ended) {
          video.currentTime = audio.currentTime
          if (usePlayerStore.getState().isPlaying) {
            video.play().catch(() => {})
          }
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return {
    play,
    pause,
    togglePlay,
    seek,
    nextTrack,
    prevTrack,
    goToTrack,
    loadTrack,
    mediaRef,
    videoContainerRef,
  }
}
