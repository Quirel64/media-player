import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null
let sourceNode: MediaElementAudioSourceNode | null = null

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

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const audioAnchorRef = useRef<HTMLAudioElement | null>(null)
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
      mediaRef.current.pause()
      if (mediaRef.current.parentNode) {
        mediaRef.current.parentNode.removeChild(mediaRef.current)
      }
      mediaRef.current = null
    }
    if (audioAnchorRef.current) {
      audioAnchorRef.current.pause()
      audioAnchorRef.current.src = ''
      audioAnchorRef.current = null
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

    if (track.mediaType === 'video') {
      const v = document.createElement('video')
      v.playsInline = true
      v.setAttribute('webkit-playsinline', 'true')
      v.muted = true
      v.controls = true
      v.style.touchAction = 'manipulation'
      v.style.width = '100%'
      v.style.maxHeight = '100%'
      v.style.objectFit = 'contain'
      v.style.borderRadius = '12px'

      v.addEventListener('ended', () => handleTrackEnd())

      if (videoContainerRef.current) {
        videoContainerRef.current.appendChild(v)
      }
      mediaRef.current = v

      const audio = new Audio()
      audio.preload = 'auto'
      audio.src = url
      audioAnchorRef.current = audio

      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime ?? 0)
      })
      audio.addEventListener('loadedmetadata', () => {
        const d = audio.duration
        setDuration(Number.isFinite(d) && d > 0 ? d : 0)
      })
      audio.addEventListener('durationchange', () => {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) setDuration(d)
      })
      audio.addEventListener('ended', () => {
        v.pause()
        handleTrackEnd()
      })
      audio.addEventListener('error', () => {
        showError(`Audio error: ${track.name}`)
        setPlaying(false)
      })
      audio.addEventListener('play', () => {
        setPlaying(true)
      })
      audio.addEventListener('pause', () => {
        if (!audio.seeking && (document.visibilityState === 'visible' || audio.ended)) {
          setPlaying(false)
        }
      })

      setAudioSessionType()

      try {
        await Promise.all([v.play(), audio.play()])
        setPlaying(true)
      } catch (e) {
        showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
        setPlaying(false)
      }
    } else {
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
      })
      el.addEventListener('loadedmetadata', () => {
        const d = el.duration
        setDuration(Number.isFinite(d) && d > 0 ? d : 0)
      })
      el.addEventListener('durationchange', () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) setDuration(d)
      })
      el.addEventListener('ended', () => {
        handleTrackEnd()
      })
      el.addEventListener('error', () => {
        showError(`Audio error: ${track.name}`)
        setPlaying(false)
      })
      el.addEventListener('play', () => {
        setPlaying(true)
      })
      el.addEventListener('pause', () => {
        if (!el.seeking && (document.visibilityState === 'visible' || el.ended)) {
          setPlaying(false)
        }
      })

      document.body.appendChild(el)
      mediaRef.current = el

      setAudioSessionType()

      el.src = url
      el.load()

      setAudioSessionType()

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

    if (audioContext?.state === 'suspended') {
      await audioContext.resume()
    }

    setAudioSessionType()

    try {
      const promises: Promise<void>[] = [el.play()]
      if (audioAnchorRef.current) {
        promises.push(audioAnchorRef.current.play())
      }
      await Promise.all(promises)
      setPlaying(true)
    } catch (e) {
      showError(`Play failed: ${e instanceof Error ? e.message : 'unknown'}`)
      setPlaying(false)
    }
  }, [setPlaying])

  const pause = useCallback(() => {
    mediaRef.current?.pause()
    audioAnchorRef.current?.pause()
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
    if (audioAnchorRef.current) {
      audioAnchorRef.current.currentTime = time
    }
    if (mediaRef.current) {
      mediaRef.current.currentTime = time
    }
    setCurrentTime(time)
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
    if (audioAnchorRef.current) {
      audioAnchorRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  useEffect(() => {
    if (!currentTrack || !mediaRef.current) return

    const ctx = getAudioContext()

    const targetEl = audioAnchorRef.current || mediaRef.current

    if (!sourceNode && targetEl) {
      sourceNode = ctx.createMediaElementSource(targetEl)
      sourceNode.connect(gainNode!)
    }

    const { trackVolumes } = usePlayerStore.getState()
    const trackGain = trackVolumes[currentTrack.id] ?? 1

    if (gainNode) {
      gainNode.gain.setTargetAtTime(trackGain, ctx.currentTime, 0.01)
    }
  }, [currentTrack, currentTrack?.id])

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
      if (document.visibilityState === 'visible') {
        const { isPlaying: wasPlaying } = usePlayerStore.getState()
        const el = mediaRef.current
        if (el && wasPlaying && el.paused && !el.ended) {
          el.play().catch(() => {})
          if (audioAnchorRef.current && audioAnchorRef.current.paused) {
            audioAnchorRef.current.play().catch(() => {})
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
