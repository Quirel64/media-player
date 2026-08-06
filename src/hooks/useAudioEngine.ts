import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'

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
      el.setAttribute('playsinline', 'true')
      el.setAttribute('webkit-playsinline', 'true')
    }

    if (isVideo) {
      const v = el as HTMLVideoElement
      v.playsInline = true
      v.setAttribute('webkit-playsinline', 'true')
      v.controls = true
    }

    el.addEventListener('timeupdate', () => {
      setCurrentTime(el.currentTime ?? 0)
    })
    el.addEventListener('loadedmetadata', () => {
      setDuration(el.duration ?? 0)
    })
    el.addEventListener('ended', () => {
      handleTrackEnd()
    })
    el.addEventListener('error', () => {
      console.error('Media playback error')
      setPlaying(false)
    })

    // For video, append to the container
    if (isVideo && videoContainerRef.current) {
      el.style.width = '100%'
      el.style.maxHeight = '100%'
      el.style.objectFit = 'contain'
      el.style.borderRadius = '12px'
      videoContainerRef.current.appendChild(el)
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
        el.play()
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

    // iOS: set audio session type for background playback
    if ('audioSession' in navigator) {
      try {
        (navigator as any).audioSession.type = 'playback'
      } catch {}
    }

    el.src = url
    el.load()

    try {
      // iOS: ensure audio session type is set before play
      if ('audioSession' in navigator) {
        try {
          (navigator as any).audioSession.type = 'playback'
        } catch {}
      }
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
    if ('audioSession' in navigator) {
      try {
        (navigator as any).audioSession.type = 'playback'
      } catch {}
    }

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
