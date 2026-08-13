import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null
let sourceNode: MediaElementAudioSourceNode | null = null
let lastPositionUpdate = 0

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
    gainNode = audioContext.createGain()
    gainNode.connect(audioContext.destination)
  }
  return audioContext
}

function setAudioSessionType() {
  if ('audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'playback'
    } catch {}
  }
}

function setPositionStateImmediate() {
  if (!('mediaSession' in navigator)) return
  const { currentTime, duration } = usePlayerStore.getState()
  if (!Number.isFinite(duration) || duration <= 0) {
    console.log('[setPositionState] skipped: duration=', duration)
    return
  }
  const position = Math.min(currentTime, duration)
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position,
    })
    console.log('[setPositionState] OK:', { duration, position })
    lastPositionUpdate = Date.now()
  } catch (e) {
    console.log('[setPositionState] error:', e)
  }
}

function updatePositionState() {
  if (!('mediaSession' in navigator)) return
  const now = Date.now()
  if (now - lastPositionUpdate < 1000) return
  setPositionStateImmediate()
}

export { setPositionStateImmediate }

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

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
      // Remove src properly to avoid triggering error event
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
    if (sourceNode) {
      try { sourceNode.disconnect() } catch {}
      sourceNode = null
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

    setAudioSessionType()

    const ctx = getAudioContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    if (track.mediaType === 'video') {
      // Audio element: source of truth for playback
      const audio = new Audio()
      audio.preload = 'auto'
      audio.src = url

      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime ?? 0)
        updatePositionState()
      })
      audio.addEventListener('loadedmetadata', () => {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          setPositionStateImmediate()
        }
      })
      audio.addEventListener('durationchange', () => {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          setPositionStateImmediate()
        }
      })
      audio.addEventListener('ended', () => {
        if (videoRef.current && !videoRef.current.paused) {
          videoRef.current.pause()
        }
        handleTrackEnd()
      })
      audio.addEventListener('error', () => {
        // Ignore errors from old elements that were cleaned up
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

      mediaRef.current = audio

      // Append to DOM (hidden) so iOS can track position for lock screen seek bar
      audio.controls = false
      audio.style.position = 'fixed'
      audio.style.left = '-1px'
      audio.style.top = '-1px'
      audio.style.width = '1px'
      audio.style.height = '1px'
      audio.style.opacity = '0'
      audio.style.pointerEvents = 'none'
      document.body.appendChild(audio)

      // Connect to Web Audio API for per-track volume
      if (!sourceNode) {
        sourceNode = ctx.createMediaElementSource(audio)
        sourceNode.connect(gainNode!)
      }
      const { trackVolumes } = usePlayerStore.getState()
      const trackGain = trackVolumes[track.id] ?? 1
      gainNode!.gain.setTargetAtTime(trackGain, ctx.currentTime, 0.01)

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

      // When video can play, seek to audio position
      v.addEventListener('canplay', () => {
        if (Math.abs(v.currentTime - audio.currentTime) > 1) {
          v.currentTime = audio.currentTime
        }
      })

      setAudioSessionType()

      try {
        await audio.play()
        updatePositionState()
        v.currentTime = audio.currentTime
        v.play().catch(() => {})
        setPlaying(true)
      } catch (e) {
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    } else {
      // Audio file: simple audio element
      const el = document.createElement('audio')
      el.preload = 'auto'
      el.controls = false
      el.style.position = 'fixed'
      el.style.left = '-1px'
      el.style.top = '-1px'
      el.style.width = '1px'
      el.style.height = '1px'
      el.style.opacity = '0'
      el.style.pointerEvents = 'none'

      el.addEventListener('timeupdate', () => {
        setCurrentTime(el.currentTime ?? 0)
        updatePositionState()
      })
      el.addEventListener('loadedmetadata', () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          setPositionStateImmediate()
        }
      })
      el.addEventListener('durationchange', () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) {
          setDuration(d)
          setPositionStateImmediate()
        }
      })
      el.addEventListener('ended', () => {
        handleTrackEnd()
      })
      el.addEventListener('error', () => {
        // Ignore errors from old elements that were cleaned up
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

      document.body.appendChild(el)
      mediaRef.current = el

      // Connect to Web Audio API for per-track volume
      if (!sourceNode) {
        sourceNode = ctx.createMediaElementSource(el)
        sourceNode.connect(gainNode!)
      }
      const { trackVolumes } = usePlayerStore.getState()
      const trackGain = trackVolumes[track.id] ?? 1
      gainNode!.gain.setTargetAtTime(trackGain, ctx.currentTime, 0.01)

      setAudioSessionType()

      el.src = url
      el.load()

      setAudioSessionType()

      try {
        await el.play()
        updatePositionState()
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

    if (audioContext?.state === 'suspended') {
      await audioContext.resume()
    }

    setAudioSessionType()

    try {
      await el.play()
      setPositionStateImmediate()
      // Also resume video when playing
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
    updatePositionState()
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

  // Pause video when going to background, resume and sync when returning
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Going to background: pause video, keep audio playing
        videoRef.current?.pause()
      } else {
        // Coming back: sync video to audio position and resume
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
