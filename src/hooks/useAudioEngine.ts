import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { createAudioVideo, destroyAudioVideo } from '../lib/audioToVideo'

let gainNode: GainNode | null = null

function setAudioSessionType() {
  if ('audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'playback'
    } catch {}
  }
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const isAudioVideoRef = useRef(false)

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
      mediaRef.current.pause()

      if (isAudioVideoRef.current && mediaRef.current instanceof HTMLVideoElement) {
        destroyAudioVideo(mediaRef.current)
      }

      if (mediaRef.current.parentNode) {
        mediaRef.current.parentNode.removeChild(mediaRef.current)
      }
      mediaRef.current = null
      isAudioVideoRef.current = false
    }
  }, [])

  const createVideoElement = useCallback(() => {
    const v = document.createElement('video')
    v.playsInline = true
    v.setAttribute('webkit-playsinline', 'true')
    v.controls = true
    v.style.touchAction = 'manipulation'
    v.style.width = '100%'
    v.style.maxHeight = '100%'
    v.style.objectFit = 'contain'
    v.style.borderRadius = '12px'

    v.addEventListener('timeupdate', () => {
      setCurrentTime(v.currentTime ?? 0)
    })
    v.addEventListener('loadedmetadata', () => {
      const d = v.duration
      setDuration(Number.isFinite(d) && d > 0 ? d : 0)
    })
    v.addEventListener('durationchange', () => {
      const d = v.duration
      if (Number.isFinite(d) && d > 0) setDuration(d)
    })
    v.addEventListener('ended', () => {
      handleTrackEnd()
    })
    v.addEventListener('error', () => {
      const msg = `Media error: ${v.src ? v.src.split('/').pop() : 'unknown'}`
      showError(msg)
      setPlaying(false)
    })
    v.addEventListener('play', () => {
      setPlaying(true)
    })
    v.addEventListener('pause', () => {
      if (!v.seeking && (document.visibilityState === 'visible' || v.ended)) {
        setPlaying(false)
      }
    })

    if (videoContainerRef.current) {
      videoContainerRef.current.appendChild(v)
    }

    mediaRef.current = v
    return v
  }, [setCurrentTime, setDuration, setPlaying])

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

    if (track.mediaType === 'video') {
      const v = createVideoElement()
      v.src = url
      v.load()

      setAudioSessionType()

      try {
        await v.play()
        setPlaying(true)
      } catch (e) {
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    } else {
      // Audio track: use video element with canvas art for iOS background playback
      const v = createVideoElement()
      isAudioVideoRef.current = true

      try {
        const audioVideo = createAudioVideo(url)
        // Copy event listeners and replace
        const listeners: [string, EventListener][] = []
        const events = ['timeupdate', 'loadedmetadata', 'durationchange', 'ended', 'error', 'play', 'pause']
        for (const evt of events) {
          const handler = v.getAttribute(`data-listener-${evt}`)
          if (handler) continue
        }

        // Remove the plain video we created, use the audio-video one instead
        if (v.parentNode) {
          v.parentNode.removeChild(v)
        }

        // Re-attach event listeners to the audio-video element
        audioVideo.addEventListener('timeupdate', () => {
          setCurrentTime(audioVideo.currentTime ?? 0)
        })
        audioVideo.addEventListener('loadedmetadata', () => {
          const d = audioVideo.duration
          setDuration(Number.isFinite(d) && d > 0 ? d : 0)
        })
        audioVideo.addEventListener('durationchange', () => {
          const d = audioVideo.duration
          if (Number.isFinite(d) && d > 0) setDuration(d)
        })
        audioVideo.addEventListener('ended', () => {
          handleTrackEnd()
        })
        audioVideo.addEventListener('error', () => {
          const msg = `Audio error: ${track.name}`
          showError(msg)
          setPlaying(false)
        })
        audioVideo.addEventListener('play', () => {
          setPlaying(true)
        })
        audioVideo.addEventListener('pause', () => {
          if (!audioVideo.seeking && (document.visibilityState === 'visible' || audioVideo.ended)) {
            setPlaying(false)
          }
        })

        if (videoContainerRef.current) {
          videoContainerRef.current.appendChild(audioVideo)
        }
        mediaRef.current = audioVideo

        setAudioSessionType()

        try {
          await audioVideo.play()
          setPlaying(true)
        } catch (e) {
          showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
          setPlaying(false)
        }
      } catch (e) {
        showError(`Audio-video creation failed: ${e instanceof Error ? e.message : 'unknown'}`)
        // Fallback: try with plain video element
        v.src = url
        v.load()
        setAudioSessionType()
        try {
          await v.play()
          setPlaying(true)
        } catch {
          setPlaying(false)
        }
      }
    }
  }, [cleanupMedia, createVideoElement, setCurrentTime, setDuration, setPlaying, handleTrackEnd])

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return

    setAudioSessionType()

    try {
      await el.play()
      setPlaying(true)
    } catch (e) {
      showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
      setPlaying(false)
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

  // Load track when index changes
  useEffect(() => {
    if (currentTrack && queue.length > 0) {
      loadTrack(currentTrackIndex)
    }
  }, [currentTrackIndex, currentTrack?.id])

  // Update volume
  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  // Cleanup
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
      cleanupMedia()
    }
  }, [])

  // iOS PWA: resume playback when app returns to foreground
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const { isPlaying: wasPlaying } = usePlayerStore.getState()
        const el = mediaRef.current
        if (el && wasPlaying && el.paused && !el.ended) {
          el.play().catch(() => {})
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
