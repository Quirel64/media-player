import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

function setAudioSessionType() {
  if ('audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'playback'
    } catch {}
  }
}

// Silent audio anchor: keeps iOS audio session alive when main audio is paused
let silentAnchorEl: HTMLAudioElement | null = null
let silentAnchorUrl: string | null = null

function createSilentWavBlob(): Blob {
  const sampleRate = 44100
  const numSamples = sampleRate * 2
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, numSamples * 2, true)
  // Samples are all zeros (silent)

  return new Blob([buffer], { type: 'audio/wav' })
}

function startSilentAnchor() {
  if (silentAnchorEl) return

  const blob = createSilentWavBlob()
  silentAnchorUrl = URL.createObjectURL(blob)

  const audio = new Audio()
  audio.src = silentAnchorUrl
  audio.loop = true
  audio.volume = 0
  audio.muted = true
  audio.preload = 'auto'
  audio.play().catch(() => {})

  silentAnchorEl = audio
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)

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
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
    if (mediaRef.current) {
      const el = mediaRef.current
      el.pause()
      el.removeAttribute('src')
      el.load()
      mediaRef.current = null
    }
    if (videoRef.current) {
      if (videoRef.current.parentNode) {
        videoRef.current.parentNode.removeChild(videoRef.current)
      }
      videoRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, getNextTrackIndex } = usePlayerStore.getState()
    if (repeatMode === 'one') {
      const el = mediaRef.current
      if (el) {
        el.currentTime = 0
        setAudioSessionType()
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

    // Create <audio> element (source of truth for ALL files)
    const audio = new Audio()
    audio.preload = 'auto'
    audio.controls = false
    audio.src = url
    audio.load()

    const updatePosition = () => {
      if (!('mediaSession' in navigator)) return
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: 1,
          position: Math.min(audio.currentTime, audio.duration),
        })
      } catch {}
    }

    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime ?? 0)
      const now = Date.now()
      if (now - (audio as any)._lastPosUpdate > 1000) {
        ;(audio as any)._lastPosUpdate = now
        updatePosition()
      }
    })
    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d)
        updatePosition()
      }
    })
    audio.addEventListener('durationchange', () => {
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d)
        updatePosition()
      }
    })
    audio.addEventListener('ended', () => {
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
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
      }
      // Start RAF for video sync if video track
      if (videoRef.current && rafRef.current === 0) {
        const syncVideoFrame = () => {
          if (videoRef.current && mediaRef.current && !mediaRef.current.paused) {
            const diff = Math.abs(videoRef.current.currentTime - mediaRef.current.currentTime)
            if (diff > 0.1) {
              videoRef.current.currentTime = mediaRef.current.currentTime
            }
          }
          if (mediaRef.current && !mediaRef.current.paused) {
            rafRef.current = requestAnimationFrame(syncVideoFrame)
          }
        }
        rafRef.current = requestAnimationFrame(syncVideoFrame)
      }
    })
    audio.addEventListener('pause', () => {
      if (mediaRef.current !== audio) return
      setPlaying(false)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    })

    // Hidden in DOM so iOS can track position
    audio.style.position = 'fixed'
    audio.style.left = '-1px'
    audio.style.top = '-1px'
    audio.style.width = '1px'
    audio.style.height = '1px'
    audio.style.opacity = '0'
    audio.style.pointerEvents = 'none'
    document.body.appendChild(audio)

    mediaRef.current = audio

    if (track.mediaType === 'video') {
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

      const onVisible = () => {
        if (document.visibilityState === 'visible' && audio && !audio.paused && videoRef.current) {
          videoRef.current.currentTime = audio.currentTime
        }
      }
      document.addEventListener('visibilitychange', onVisible)

      cleanupRef.current = () => {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }

    // Announce track to MediaSession
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist || 'Unknown Artist',
        album: track.album || 'Unknown Album',
      })
    }

    setAudioSessionType()

    // Wait for audio buffer to be ready (prevents play() failures on iOS)
    await new Promise<void>((resolve) => {
      const onCanPlay = () => {
        audio.removeEventListener('canplaythrough', onCanPlay)
        audio.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        audio.removeEventListener('canplaythrough', onCanPlay)
        audio.removeEventListener('error', onError)
        resolve()
      }
      audio.addEventListener('canplaythrough', onCanPlay)
      audio.addEventListener('error', onError)
      setTimeout(resolve, 3000)
    })

    setAudioSessionType()

    try {
      await audio.play()
      updatePosition()
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        updatePosition()
      }
      setPlaying(true)
    } catch (e) {
      showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
      setPlaying(false)
    }
  }, [cleanupMedia, setCurrentTime, setDuration, setPlaying, handleTrackEnd])

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return

    setAudioSessionType()

    try {
      await el.play()
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        if (Number.isFinite(el.duration) && el.duration > 0) {
          try {
            navigator.mediaSession.setPositionState({
              duration: el.duration,
              playbackRate: 1,
              position: Math.min(el.currentTime, el.duration),
            })
          } catch {}
        }
      }
      setPlaying(true)
    } catch (e) {
      setAudioSessionType()
      try {
        await el.play()
        setPlaying(true)
      } catch {
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    }
  }, [setPlaying])

  const pause = useCallback(() => {
    mediaRef.current?.pause()
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

  // CRITICAL: Auto-resume when app returns to foreground (from old working version)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const { isPlaying: wasPlaying } = usePlayerStore.getState()
        const el = mediaRef.current
        if (el && wasPlaying && el.paused && !el.ended) {
          setAudioSessionType()
          el.play().catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  // Silent audio anchor: keeps iOS audio session alive when main audio is paused
  useEffect(() => {
    const startAnchor = () => {
      startSilentAnchor()
      document.removeEventListener('click', startAnchor)
      document.removeEventListener('touchstart', startAnchor)
    }
    document.addEventListener('click', startAnchor, { once: true })
    document.addEventListener('touchstart', startAnchor, { once: true })
    // Also try immediately (may work in PWA standalone mode)
    startSilentAnchor()

    return () => {
      document.removeEventListener('click', startAnchor)
      document.removeEventListener('touchstart', startAnchor)
    }
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
