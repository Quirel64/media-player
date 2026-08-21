import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

type SessionOwner = 'idle' | 'track' | 'anchor'

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

function createSilentWavUrl(durationSeconds = 2): string {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, 60 * 60))
  const sampleRate = seconds > 15 * 60 ? 4000 : 8000
  const numSamples = Math.ceil(seconds * sampleRate)
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

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!('mediaSession' in navigator)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  const pos = Math.min(Math.max(0, position), duration)
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos })
  } catch {
    if (playbackRate === 0) {
      try {
        navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: pos })
      } catch {}
    }
  }
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

  // Handoff state
  const ownerRef = useRef<SessionOwner>('idle')
  const frozenPosRef = useRef(0)
  const handoffLockRef = useRef(false)
  const ignoreTrackPauseRef = useRef(false)
  const ignoreSilentPauseRef = useRef(false)
  const silentUrlRef = useRef<string>('')
  const silentDurationRef = useRef(0)

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
      if (audio && video && ownerRef.current === 'track' && !audio.paused) {
        const diff = Math.abs(video.currentTime - audio.currentTime)
        if (diff > 0.12) {
          try {
            video.currentTime = audio.currentTime
          } catch {}
        }
      }
      if (mediaRef.current && ownerRef.current === 'track' && !mediaRef.current.paused) {
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
    if (ownerRef.current !== 'track') return
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
    video.pause()
  }, [])

  const snapSilent = useCallback((position: number) => {
    const silent = silentRef.current
    if (!silent || !Number.isFinite(silent.duration) || silent.duration <= 0) return 0
    const max = Math.max(0, silent.duration - 1.2)
    const pos = Math.min(Math.max(0, position), max)
    try {
      silent.currentTime = pos
    } catch {}
    return pos
  }, [])

  const ensureAnchorDuration = useCallback(async (trackDuration: number) => {
    const silent = silentRef.current
    if (!silent) return
    const target = Math.max(2, Number.isFinite(trackDuration) ? trackDuration : 2)
    if (silent.src && Math.abs(silentDurationRef.current - target) < 0.2) return

    const url = createSilentWavUrl(target)
    if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current)
    silentUrlRef.current = url
    silent.loop = false
    silent.src = url
    silent.load()

    await new Promise<void>((resolve) => {
      const done = () => {
        silent.removeEventListener('loadedmetadata', done)
        resolve()
      }
      silent.addEventListener('loadedmetadata', done)
      window.setTimeout(done, 800)
    })

    silentDurationRef.current = silent.duration || target
  }, [])

  const stopSilent = useCallback(() => {
    const silent = silentRef.current
    if (!silent) return
    ignoreSilentPauseRef.current = true
    silent.pause()
    window.setTimeout(() => {
      ignoreSilentPauseRef.current = false
    }, 50)
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
    if (handoffLockRef.current) return
    handoffLockRef.current = true

    try {
      setAudioSessionType()

      // HANDOFF: stop the silent placeholder before the track starts,
      // otherwise iOS reports both durations on the lock-screen seek bar
      stopSilent()
      if (ownerRef.current === 'anchor') {
        try {
          el.currentTime = frozenPosRef.current
        } catch {}
      }

      try {
        if (el.readyState < 2) {
          pendingPlayRef.current = true
          el.load()
          return
        }
        await el.play()
      } catch {
        await new Promise(r => setTimeout(r, 150))
        try {
          setAudioSessionType()
          await el.play()
        } catch {
          setPlaying(false)
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
          return
        }
      }

      // Video is display-only (paused, seek-framed). Do NOT play it.
      const video = videoRef.current
      if (video && video.src) {
        try {
          video.pause()
          video.currentTime = el.currentTime
        } catch {}
      }

      pendingPlayRef.current = false
      ownerRef.current = 'track'
      setPlaying(true)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        publishPosition(el.duration, el.currentTime, 1)
      }
      startVideoSync()
    } finally {
      handoffLockRef.current = false
    }
  }, [setPlaying, startVideoSync, stopSilent])

  const loadTrack = useCallback(async (trackIndex: number) => {
    const { queue } = usePlayerStore.getState()
    const track = queue[trackIndex]
    if (!track) return

    stopRaf()
    cleanupVideo()
    stopSilent()
    ownerRef.current = 'idle'
    frozenPosRef.current = 0

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
    } else {
      if (videoRef.current) {
        const v = videoRef.current
        v.pause()
        v.removeAttribute('src')
        v.load()
        if (v.parentNode) v.parentNode.removeChild(v)
        videoRef.current = null
      }
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist || 'Unknown Artist',
        album: track.album || 'Unknown Album',
      })
    }

    setAudioSessionType()
  }, [cleanupVideo, setCurrentTime, setDuration, attachVideo, stopRaf, stopSilent])

  const pause = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return
    if (handoffLockRef.current) return
    handoffLockRef.current = true

    try {
      const pos = el.currentTime
      frozenPosRef.current = pos

      // Pause track with ignore flag so the event handler doesn't re-enter
      ignoreTrackPauseRef.current = true
      el.pause()
      videoRef.current?.pause()
      stopRaf()
      window.setTimeout(() => {
        ignoreTrackPauseRef.current = false
      }, 50)

      setPlaying(false)
      setCurrentTime(pos)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
        publishPosition(el.duration, pos, 0)
      }

      // HANDOFF: generate duration-matched silent WAV, seek to same position, play it
      await ensureAnchorDuration(el.duration || 2)
      const silent = silentRef.current
      if (!silent) {
        ownerRef.current = 'idle'
        return
      }
      const snapped = snapSilent(pos)
      frozenPosRef.current = snapped
      setAudioSessionType()
      try {
        await silent.play()
        ownerRef.current = 'anchor'
      } catch {
        ownerRef.current = 'idle'
      }
      publishPosition(el.duration || silent.duration, snapped, 0)
    } finally {
      handoffLockRef.current = false
    }
  }, [setPlaying, setCurrentTime, stopRaf, ensureAnchorDuration, snapSilent])

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
    frozenPosRef.current = clamped
    if (videoRef.current && videoRef.current.src) {
      try {
        videoRef.current.currentTime = clamped
      } catch {}
    }
    if (ownerRef.current === 'anchor') {
      snapSilent(clamped)
    }
    setCurrentTime(clamped)
    publishPosition(
      el.duration,
      clamped,
      ownerRef.current === 'track' ? 1 : 0
    )
  }, [setCurrentTime, snapSilent])

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

    // Silent anchor: duration-matched, NOT looped, only plays when track is paused
    const silent = document.createElement('audio')
    silent.preload = 'auto'
    silent.volume = 0.001
    silent.setAttribute('data-silent', 'true')
    silent.setAttribute('playsinline', 'true')
    hideOffscreen(silent)
    document.body.appendChild(silent)
    silentRef.current = silent

    const onTimeUpdate = () => {
      if (mediaRef.current !== audio) return
      if (ownerRef.current !== 'track') return
      setCurrentTime(audio.currentTime)
      publishPosition(audio.duration, audio.currentTime, 1)
      syncVideoToAudio()
    }
    const onLoadedMetadata = () => {
      if (mediaRef.current !== audio) return
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d)
        publishPosition(d, audio.currentTime, ownerRef.current === 'track' ? 1 : 0)
        // Pre-build matching placeholder so pause handoff is instant
        void ensureAnchorDuration(d)
      }
    }
    const onPlay = () => {
      if (mediaRef.current !== audio) return
      if (ignoreTrackPauseRef.current) return
      setPlaying(true)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        publishPosition(audio.duration, audio.currentTime, 1)
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
      if (ignoreTrackPauseRef.current) return
      // Handoff to silent is handled in pause(). This only fires for
      // unexpected pauses (iOS backgrounding, etc.)
    }
    const onEnded = () => {
      if (mediaRef.current !== audio) return
      if (ownerRef.current !== 'track') return
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

    // Silent: rewind every ~1s so the seek bar stays frozen at the paused position
    const onSilentTime = () => {
      if (ownerRef.current !== 'anchor') return
      const frozen = frozenPosRef.current
      if (silent.currentTime - frozen >= 1) {
        snapSilent(frozen)
      }
      publishPosition(audio.duration || silent.duration, frozen, 0)
    }
    const onSilentEnded = () => {
      if (ownerRef.current !== 'anchor') return
      snapSilent(frozenPosRef.current)
      silent.play().catch(() => {})
    }
    const onSilentPause = () => {
      if (ignoreSilentPauseRef.current) return
      if (ownerRef.current === 'anchor') {
        // iOS paused our placeholder — restart it to keep the session alive
        setAudioSessionType()
        silent.play().catch(() => {})
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
      if (mediaRef.current === audio && ownerRef.current === 'track') {
        publishPosition(audio.duration, audio.currentTime, 1)
      }
    })

    silent.addEventListener('timeupdate', onSilentTime)
    silent.addEventListener('ended', onSilentEnded)
    silent.addEventListener('pause', onSilentPause)

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
      if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current)
      mediaRef.current = null
      silentRef.current = null
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
        const silent = silentRef.current
        if (ownerRef.current === 'track' && el && wasPlaying && el.paused && !el.ended) {
          setAudioSessionType()
          play()
        } else if (ownerRef.current === 'anchor' && silent && silent.paused) {
          // Placeholder was paused while app was in background — restart it
          setAudioSessionType()
          silent.play().catch(() => {})
        }
        // Re-sync video to audio
        if (ownerRef.current === 'track' && el && videoRef.current && videoRef.current.src && !el.paused) {
          try {
            videoRef.current.currentTime = el.currentTime
            videoRef.current.play().catch(() => {})
          } catch {}
          startVideoSync()
        }
      } else {
        // Backgrounding: pause video but keep whoever owns the session going
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
