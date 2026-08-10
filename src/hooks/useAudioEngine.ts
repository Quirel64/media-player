import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'

let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null
let sourceNode: MediaElementAudioSourceNode | null = null
let silentAnchor: HTMLAudioElement | null = null

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

function startSilentAnchor() {
  if (silentAnchor) return

  const ctx = getAudioContext()

  // Create a short silent buffer (1 second)
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  // Buffer is already silent (all zeros)

  // Create a buffer source and loop it
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true

  // Connect to a gain node at volume 0 (silent)
  const silentGain = ctx.createGain()
  silentGain.gain.value = 0
  source.connect(silentGain)
  silentGain.connect(ctx.destination)

  // Also create an <audio> element for iOS session purposes
  // iOS needs an actual <audio> element playing to keep the session alive
  const audio = new Audio()
  audio.loop = true
  audio.volume = 0
  audio.muted = true

  // Create a tiny silent WAV file as a data URL
  const sampleRate = 44100
  const numSamples = sampleRate * 2 // 2 seconds
  const buffer2 = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer2)

  // WAV header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, numSamples * 2, true)
  // Samples are all zeros (silent)

  const blob = new Blob([buffer2], { type: 'audio/wav' })
  audio.src = URL.createObjectURL(blob)

  // Start both
  source.start()
  audio.play().catch(() => {})

  silentAnchor = audio
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
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

  const createMediaElement = useCallback((isVideo: boolean) => {
    // Remove old element
    if (mediaRef.current) {
      mediaRef.current.pause()
      if (mediaRef.current.parentNode) {
        mediaRef.current.parentNode.removeChild(mediaRef.current)
      }
      // Disconnect audio nodes
      if (sourceNode) {
        try { sourceNode.disconnect() } catch {}
        sourceNode = null
      }
    }

    const el = isVideo ? document.createElement('video') : document.createElement('audio')
    el.preload = 'auto'
    if (isVideo) {
      const v = el as HTMLVideoElement
      v.playsInline = true
      v.setAttribute('webkit-playsinline', 'true')
      v.controls = true
      v.style.touchAction = 'manipulation'
    } else {
      el.controls = false
      el.style.position = 'fixed'
      el.style.left = '-1px'
      el.style.top = '-1px'
      el.style.width = '1px'
      el.style.height = '1px'
      el.style.opacity = '0'
      el.style.pointerEvents = 'none'
    }

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
      console.error('Media playback error')
      setPlaying(false)
    })
    // Sync play/pause state from native controls (iOS inline player)
    el.addEventListener('play', () => {
      setPlaying(true)
    })
    el.addEventListener('pause', () => {
      // iOS may briefly pause media while moving between app/lock-screen states.
      if (!el.seeking && (document.visibilityState === 'visible' || el.ended)) {
        setPlaying(false)
      }
    })

    // For video, append to the container
    if (isVideo && videoContainerRef.current) {
      el.style.width = '100%'
      el.style.maxHeight = '100%'
      el.style.objectFit = 'contain'
      el.style.borderRadius = '12px'
      videoContainerRef.current.appendChild(el)
    } else if (!isVideo) {
      document.body.appendChild(el)
    }

    mediaRef.current = el
    return el
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

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    const url = await getFileURLFromOPFS(track.fileName)
    if (!url) {
      console.error('File not found in OPFS:', track.fileName)
      return
    }
    blobUrlRef.current = url

    const isVideo = track.mediaType === 'video'
    const el = createMediaElement(isVideo)

    // iOS: set audio session type BEFORE setting src
    setAudioSessionType()

    el.src = url
    el.load()

    // iOS: ensure audio session type is set before play
    setAudioSessionType()

    try {
      await el.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }, [createMediaElement, setPlaying])

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return

    if (audioContext?.state === 'suspended') {
      await audioContext.resume()
    }

    // iOS: set audio session type to allow background playback
    setAudioSessionType()

    try {
      await el.play()
      setPlaying(true)
    } catch {
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

  // Apply per-track volume via Web Audio API GainNode
  useEffect(() => {
    if (!currentTrack || !mediaRef.current) return

    const ctx = getAudioContext()

    if (!sourceNode && mediaRef.current) {
      sourceNode = ctx.createMediaElementSource(mediaRef.current)
      sourceNode.connect(gainNode!)
    }

    const { trackVolumes } = usePlayerStore.getState()
    const trackGain = trackVolumes[currentTrack.id] ?? 1

    if (gainNode) {
      gainNode.gain.setTargetAtTime(trackGain, ctx.currentTime, 0.01)
    }
  }, [currentTrack, currentTrack?.id])

  // Start silent audio anchor on mount (keeps iOS audio session alive)
  useEffect(() => {
    const startAnchor = () => {
      startSilentAnchor()
      document.removeEventListener('click', startAnchor)
      document.removeEventListener('touchstart', startAnchor)
    }
    // Start on first user interaction (required by autoplay policy)
    document.addEventListener('click', startAnchor, { once: true })
    document.addEventListener('touchstart', startAnchor, { once: true })

    // Also try starting immediately (may work in PWA standalone mode)
    startSilentAnchor()

    return () => {
      document.removeEventListener('click', startAnchor)
      document.removeEventListener('touchstart', startAnchor)
    }
  }, [])

  // Cleanup
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
      mediaRef.current?.pause()
      mediaRef.current = null
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
