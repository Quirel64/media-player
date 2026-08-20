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

function hideOffscreen(el: HTMLElement) {
  el.style.position = 'fixed'
  el.style.left = '-2px'
  el.style.top = '-2px'
  el.style.width = '1px'
  el.style.height = '1px'
  el.style.opacity = '0'
  el.style.pointerEvents = 'none'
}

function createSilentWavBlob(): Blob {
  const sampleRate = 8000
  const durationSeconds = 2
  const numSamples = durationSeconds * sampleRate
  const blockAlign = 2
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  return new Blob([buffer], { type: 'audio/wav' })
}

function updatePositionState(el: HTMLMediaElement | null) {
  if (!el || !('mediaSession' in navigator)) return
  if (!Number.isFinite(el.duration) || el.duration <= 0) return
  try {
    navigator.mediaSession.setPositionState({
      duration: el.duration,
      playbackRate: el.playbackRate || 1,
      position: Math.min(Math.max(0, el.currentTime), el.duration),
    })
  } catch {}
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const silentRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)
  const pendingPlayRef = useRef(false)

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

  const currentTrackRef = useRef(currentTrack)
  currentTrackRef.current = currentTrack

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  const startVideoSync = useCallback(() => {
    stopRaf()
    const tick = () => {
      const audio = mediaRef.current
      const video = videoRef.current
      if (audio && video && !audio.paused) {
        const diff = Math.abs(video.currentTime - audio.currentTime)
        if (diff > 0.12) {
          try {
            video.currentTime = audio.currentTime
          } catch {}
        }
      }
      if (mediaRef.current && !mediaRef.current.paused) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopRaf])

  const cleanupVideo = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
    if (videoRef.current) {
      const v = videoRef.current
      v.pause()
      v.removeAttribute('src')
      v.load()
      if (v.parentNode) v.parentNode.removeChild(v)
      videoRef.current = null
    }
  }, [])

  const syncVideoToAudio = useCallback(() => {
    const audio = mediaRef.current
    const video = videoRef.current
    if (!audio || !video || !video.src) return
    if (Math.abs(video.currentTime - audio.currentTime) > 0.25) {
      try {
        video.currentTime = audio.currentTime
      } catch {}
    }
  }, [])

  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current
    let video = videoRef.current
    if (!video) {
      video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.setAttribute('webkit-playsinline', 'true')
      video.setAttribute('playsinline', 'true')
      video.preload = 'auto'
      video.controls = false
      video.style.width = '100%'
      video.style.height = '100%'
      video.style.objectFit = 'contain'
      video.style.borderRadius = '12px'
      video.style.touchAction = 'manipulation'
      video.style.background = '#000'
      videoRef.current = video
    }
    if (container && video.parentNode !== container) {
      container.innerHTML = ''
      container.appendChild(video)
    }
    if (video.src !== url) {
      video.src = url
      video.load()
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

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el || !el.src) return

    setAudioSessionType()

    // Ensure silent anchor is playing — keeps iOS audio session alive
    if (silentRef.current) {
      try {
        await silentRef.current.play()
      } catch {}
    }

    try {
      await el.play()
    } catch (err) {
      // Retry once after short delay — iOS often rejects first play() after session goes stale
      await new Promise(r => setTimeout(r, 120))
      try {
        setAudioSessionType()
        await el.play()
      } catch {
        setPlaying(false)
        return
      }
    }

    // Kick the muted video so iOS keeps the video-style lock screen UI
    if (videoRef.current && videoRef.current.src) {
      try {
        videoRef.current.currentTime = el.currentTime
        videoRef.current.play().catch(() => {})
      } catch {}
      startVideoSync()
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing'
      updatePositionState(el)
    }
    setPlaying(true)
  }, [setPlaying, startVideoSync])

  const loadTrack = useCallback(async (trackIndex: number) => {
    const { queue } = usePlayerStore.getState()
    const track = queue[trackIndex]
    if (!track) return

    stopRaf()
    cleanupVideo()

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

    const el = mediaRef.current
    if (!el) return

    setCurrentTime(0)
    setDuration(0)

    pendingPlayRef.current = true
    el.src = url
    el.load()

    if (track.mediaType === 'video') {
      attachVideo(url)
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist || 'Unknown Artist',
        album: track.album || 'Unknown Album',
      })
    }

    setAudioSessionType()
  }, [cleanupVideo, setCurrentTime, setDuration, attachVideo, stopRaf])

  const pause = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    el.pause()
    videoRef.current?.pause()
    stopRaf()
    // Anchor stays playing — keeps iOS session alive
    setPlaying(false)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused'
      updatePositionState(el)
    }
  }, [setPlaying, stopRaf])

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause()
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const seek = useCallback((time: number) => {
    const el = mediaRef.current
    if (!el) return
    const max = Number.isFinite(el.duration) ? el.duration : time
    const clamped = Math.max(0, Math.min(time, max))
    el.currentTime = clamped
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = clamped
      } catch {}
    }
    setCurrentTime(clamped)
    updatePositionState(el)
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

  // Create persistent audio + silent anchor elements ONCE on mount
  useEffect(() => {
    const audio = document.createElement('audio')
    audio.preload = 'auto'
    audio.controls = false
    audio.setAttribute('playsinline', 'true')
    audio.setAttribute('webkit-playsinline', 'true')
    audio.setAttribute('x-webkit-airplay', 'allow')
    hideOffscreen(audio)
    document.body.appendChild(audio)
    mediaRef.current = audio

    // Silent anchor: never paused, loops forever, keeps iOS session alive
    const silentBlob = createSilentWavBlob()
    const silentUrl = URL.createObjectURL(silentBlob)
    const silent = document.createElement('audio')
    silent.src = silentUrl
    silent.loop = true
    silent.preload = 'auto'
    silent.volume = 0.001
    silent.setAttribute('data-silent', 'true')
    silent.setAttribute('playsinline', 'true')
    hideOffscreen(silent)
    document.body.appendChild(silent)
    silentRef.current = silent

    const onTimeUpdate = () => {
      if (mediaRef.current !== audio) return
      setCurrentTime(audio.currentTime)
      // Call setPositionState on EVERY timeupdate — no throttle.
      // This tells iOS the TRACK position, overriding the anchor's position.
      updatePositionState(audio)
      syncVideoToAudio()
    }
    const onLoadedMetadata = () => {
      if (mediaRef.current !== audio) return
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d)
        updatePositionState(audio)
      }
    }
    const onPlay = () => {
      if (mediaRef.current !== audio) return
      setPlaying(true)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        updatePositionState(audio)
      }
      if (videoRef.current && !videoRef.current.paused) {
        startVideoSync()
      } else if (videoRef.current && videoRef.current.src) {
        try {
          videoRef.current.currentTime = audio.currentTime
          videoRef.current.play().catch(() => {})
        } catch {}
        startVideoSync()
      }
    }
    const onPause = () => {
      if (mediaRef.current !== audio) return
      if (document.visibilityState === 'visible' || audio.ended) {
        setPlaying(false)
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused'
          // Set position to TRACK's paused position (not anchor's position)
          updatePositionState(audio)
        }
        stopRaf()
      }
    }
    const onEnded = () => {
      if (mediaRef.current !== audio) return
      handleTrackEnd()
    }
    const onError = () => {
      if (mediaRef.current !== audio) return
      const track = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]
      showError(`Audio error: ${track?.name || 'unknown'}`)
      setPlaying(false)
    }
    const onCanPlay = () => {
      if (mediaRef.current !== audio) return
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false
        play()
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('seeked', () => {
      if (mediaRef.current === audio) updatePositionState(audio)
    })

    setAudioSessionType()

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('canplay', onCanPlay)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.remove()
      silent.pause()
      silent.removeAttribute('src')
      silent.load()
      silent.remove()
      URL.revokeObjectURL(silentUrl)
      mediaRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load track when currentTrackIndex or queue changes
  useEffect(() => {
    if (currentTrack && queue.length > 0) {
      loadTrack(currentTrackIndex)
    }
  }, [currentTrackIndex, currentTrack?.id])

  // Volume
  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
    }
  }, [])

  // Auto-resume when app returns to foreground
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const { isPlaying: wasPlaying } = usePlayerStore.getState()
        const el = mediaRef.current
        if (el && wasPlaying && el.paused && !el.ended) {
          setAudioSessionType()
          play()
        }
        // Re-sync video to audio
        if (el && videoRef.current && videoRef.current.src && !el.paused) {
          try {
            videoRef.current.currentTime = el.currentTime
            videoRef.current.play().catch(() => {})
          } catch {}
          startVideoSync()
        }
      } else {
        // Backgrounding: pause video but keep audio going
        videoRef.current?.pause()
        stopRaf()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [play, startVideoSync, stopRaf])

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
