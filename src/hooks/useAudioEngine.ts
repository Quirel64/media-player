import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'

type SessionOwner = 'idle' | 'track' | 'anchor'

function setAudioSessionType() {
  if ('audioSession' in navigator) {
    try {
      ;(navigator as any).audioSession.type = 'playback'
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

// Cap to 15 min to keep memory reasonable; longer tracks loop + pin.
const MAX_SILENT_SECONDS = 15 * 60
const SILENT_SAMPLE_RATE = 8000

function createSilentWavBlob(durationSeconds: number): Blob {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, MAX_SILENT_SECONDS))
  const numSamples = Math.floor(seconds * SILENT_SAMPLE_RATE)
  const blockAlign = 2
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SILENT_SAMPLE_RATE, true)
  view.setUint32(28, SILENT_SAMPLE_RATE * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  return new Blob([buffer], { type: 'audio/wav' })
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
  const rafPinRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)
  const pendingPlayRef = useRef(false)

  // Handoff state
  const ownerRef = useRef<SessionOwner>('idle')
  const frozenPosRef = useRef(0)
  const frozenDurationRef = useRef(0)
  const handoffLockRef = useRef(false)
  const ignoreTrackPauseRef = useRef(false)
  const suppressAnchorPauseRef = useRef(false)
  const lastResumeRef = useRef(0)
  const silentUrlRef = useRef<string | null>(null)
  const silentDurationRef = useRef(0)

  const {
    isPlaying: _isPlaying,
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

  const stopPinRaf = useCallback(() => {
    if (rafPinRef.current) {
      cancelAnimationFrame(rafPinRef.current)
      rafPinRef.current = 0
    }
  }, [])

  const suppressNextAnchorPause = useCallback((_reason: string) => {
    suppressAnchorPauseRef.current = true
    window.setTimeout(() => {
      suppressAnchorPauseRef.current = false
    }, 700)
  }, [])

  const pinAnchor = useCallback(() => {
    const silent = silentRef.current
    if (!silent || ownerRef.current !== 'anchor') return
    const target = frozenPosRef.current
    const maxPos =
      Number.isFinite(silent.duration) && silent.duration > 0
        ? Math.max(0, silent.duration - 0.05)
        : target
    const clamped = Math.max(0, Math.min(target, maxPos))
    if (Math.abs(silent.currentTime - clamped) > 0.03) {
      try {
        silent.currentTime = clamped
      } catch {}
    }
    if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
      try {
        navigator.mediaSession?.setPositionState({
          duration: frozenDurationRef.current,
          playbackRate: 1,
          position: Math.min(target, frozenDurationRef.current),
        })
      } catch {}
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

  const ensureAnchorDuration = useCallback(async (trackDuration: number) => {
    const silent = silentRef.current
    if (!silent) return
    const target = Math.max(1, Number.isFinite(trackDuration) ? trackDuration : 2)
    // Reuse if within 0.5s - avoid rebuilding same duration
    if (
      silentUrlRef.current &&
      Math.abs(silentDurationRef.current - target) < 0.5 &&
      Number.isFinite(silent.duration) &&
      silent.duration > 0
    )
      return

    if (silentUrlRef.current) {
      URL.revokeObjectURL(silentUrlRef.current)
      silentUrlRef.current = null
    }

    const blob = createSilentWavBlob(target)
    const url = URL.createObjectURL(blob)
    silentUrlRef.current = url
    silentDurationRef.current = target

    await new Promise<void>((resolve) => {
      const done = () => {
        silent.removeEventListener('loadedmetadata', done)
        resolve()
      }
      silent.addEventListener('loadedmetadata', done)
      silent.src = url
      silent.load()
      window.setTimeout(() => {
        silent.removeEventListener('loadedmetadata', done)
        resolve()
      }, 500)
    })
    // Actual duration may differ slightly from target
    if (Number.isFinite(silent.duration) && silent.duration > 0) {
      silentDurationRef.current = silent.duration
    }
  }, [])

  // Hard-release anchor: stop pinning, pause, remove src, revoke blob.
  // Prevents iOS PWA from still treating anchor as active lock-screen item.
  const hardReleaseAnchor = useCallback(() => {
    const silent = silentRef.current
    stopPinRaf()
    if (silent) {
      suppressNextAnchorPause('handoff-to-track')
      silent.pause()
      silent.removeAttribute('src')
      silent.load()
      if (silentUrlRef.current) {
        URL.revokeObjectURL(silentUrlRef.current)
        silentUrlRef.current = null
      }
      silentDurationRef.current = 0
    }
    ownerRef.current = 'track'
  }, [stopPinRaf, suppressNextAnchorPause])

  const handoffToAnchor = useCallback(async () => {
    const track = mediaRef.current
    const anchor = silentRef.current
    if (!track || !anchor) return

    const pos = Number.isFinite(track.currentTime) ? track.currentTime : 0
    const dur =
      Number.isFinite(track.duration) && track.duration > 0
        ? track.duration
        : frozenDurationRef.current || 2

    frozenPosRef.current = pos
    frozenDurationRef.current = dur

    await ensureAnchorDuration(dur)

    try {
      const maxPos =
        Number.isFinite(anchor.duration) && anchor.duration > 0 ? anchor.duration - 0.05 : pos
      anchor.currentTime = Math.max(0, Math.min(pos, maxPos))
    } catch {}

    setAudioSessionType()
    try {
      await anchor.play()
    } catch {
      await new Promise((r) => setTimeout(r, 100))
      try {
        setAudioSessionType()
        await anchor.play()
      } catch {
        return
      }
    }

    try {
      anchor.playbackRate = 0.0001
    } catch {
      try {
        anchor.playbackRate = 0.0625
      } catch {}
    }

    stopPinRaf()
    const pin = () => {
      const a = silentRef.current
      if (!a || a.paused || ownerRef.current !== 'anchor') return
      pinAnchor()
      rafPinRef.current = requestAnimationFrame(pin)
    }
    rafPinRef.current = requestAnimationFrame(pin)

    ownerRef.current = 'anchor'
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
  }, [ensureAnchorDuration, pinAnchor, stopPinRaf])

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
      // Keep session alive at end-of-playlist via anchor at final position.
      void handoffToAnchor()
    }
  }, [setCurrentTrackIndex, setPlaying, handoffToAnchor])

  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el || !el.src) return
    if (handoffLockRef.current) return
    handoffLockRef.current = true

    try {
      // If anchor owns session, restore track position first.
      if (ownerRef.current === 'anchor') {
        try {
          el.currentTime = frozenPosRef.current
        } catch {}
      }

      // Exclusive handoff: hard-release anchor BEFORE starting track.
      hardReleaseAnchor()
      setAudioSessionType()

      try {
        if (el.readyState < 2) {
          pendingPlayRef.current = true
          el.load()
          return
        }
        await el.play()
      } catch {
        await new Promise((r) => setTimeout(r, 120))
        try {
          setAudioSessionType()
          await el.play()
        } catch {
          setPlaying(false)
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
          void handoffToAnchor()
          return
        }
      }

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
  }, [setPlaying, startVideoSync, hardReleaseAnchor, handoffToAnchor])

  // Resume from anchor with watchdog retries (PWA may drop first hidden play).
  const requestResumeFromAnchor = useCallback(
    (_source: string) => {
      const now = Date.now()
      if (now - lastResumeRef.current < 650) return
      lastResumeRef.current = now
      void play()
      window.setTimeout(() => {
        const track = mediaRef.current
        if (ownerRef.current === 'track' && track && track.paused && !track.ended) {
          void play()
        }
      }, 450)
      window.setTimeout(() => {
        const track = mediaRef.current
        if (ownerRef.current === 'track' && track && track.paused && !track.ended) {
          void play()
        }
      }, 1200)
    },
    [play],
  )

  const loadTrack = useCallback(
    async (trackIndex: number) => {
      const { queue } = usePlayerStore.getState()
      const track = queue[trackIndex]
      if (!track) return

      stopRaf()
      cleanupVideo()
      stopPinRaf()
      suppressNextAnchorPause('load-track')
      silentRef.current?.pause()
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
    },
    [cleanupVideo, setCurrentTime, setDuration, attachVideo, stopRaf, stopPinRaf, suppressNextAnchorPause],
  )

  const pause = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return
    if (handoffLockRef.current) return
    handoffLockRef.current = true

    try {
      const pos = el.currentTime
      frozenPosRef.current = pos
      if (Number.isFinite(el.duration) && el.duration > 0) {
        frozenDurationRef.current = el.duration
      }

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

      await handoffToAnchor()
      // Publish frozen position after handoff so lock screen shows correct seek bar.
      publishPosition(frozenDurationRef.current || el.duration, frozenPosRef.current, 0)
    } finally {
      handoffLockRef.current = false
    }
  }, [setPlaying, setCurrentTime, stopRaf, handoffToAnchor])

  // Called when iOS fires MediaSession "pause" while anchor owns session.
  // In that state the lock-screen center button still shows || (something is playing)
  // so that "pause" really means "resume the real track".
  const remotePauseOrResume = useCallback(() => {
    const owner = ownerRef.current
    const anchor = silentRef.current
    const track = mediaRef.current
    if (owner === 'anchor' || (track?.paused && anchor && !anchor.paused)) {
      requestResumeFromAnchor('mediaSession-pause')
      return
    }
    pause()
  }, [pause, requestResumeFromAnchor])

  const togglePlay = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (ownerRef.current === 'anchor') {
      requestResumeFromAnchor('in-app-toggle')
      return
    }
    if (el.paused) void play()
    else void pause()
  }, [play, pause, requestResumeFromAnchor])

  const seek = useCallback(
    (time: number) => {
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
      // If anchor owns session, keep it pinned to new position so scrub-while-paused doesn't jump.
      if (ownerRef.current === 'anchor' && silentRef.current) {
        try {
          const a = silentRef.current
          const maxPos = Number.isFinite(a.duration) && a.duration > 0 ? a.duration - 0.05 : clamped
          a.currentTime = Math.max(0, Math.min(clamped, maxPos))
        } catch {}
        if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
          try {
            navigator.mediaSession?.setPositionState({
              duration: frozenDurationRef.current,
              playbackRate: 1,
              position: clamped,
            })
          } catch {}
        }
      } else {
        setCurrentTime(clamped)
        publishPosition(el.duration, clamped, ownerRef.current === 'track' ? 1 : 0)
        return
      }
      setCurrentTime(clamped)
    },
    [setCurrentTime],
  )

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

    const silent = document.createElement('audio')
    silent.preload = 'auto'
    silent.loop = true
    silent.volume = 0.001
    silent.setAttribute('data-silent', 'true')
    silent.setAttribute('playsinline', 'true')
    hideOffscreen(silent)
    document.body.appendChild(silent)
    silentRef.current = silent

    const onAnchorTimeUpdate = () => {
      // rAF is suspended on lock screen, but timeupdate still fires for the active anchor.
      pinAnchor()
    }
    const onAnchorPlay = () => {
      if (ownerRef.current === 'anchor') {
        try {
          silent.playbackRate = 0.0001
        } catch {}
        pinAnchor()
      }
    }
    const onAnchorPause = () => {
      if (ownerRef.current === 'anchor') {
        if (suppressAnchorPauseRef.current) return
        // If MediaSession pause already triggered a resume within 800ms, ignore this duplicate native event.
        if (Date.now() - lastResumeRef.current < 800) return
        // If another app (YouTube) interrupted while we're fully backgrounded, don't fight it — just release.
        if (document.hidden) {
          suppressNextAnchorPause('system-interruption')
          stopPinRaf()
          silent.pause()
          silent.removeAttribute('src')
          silent.load()
          if (silentUrlRef.current) {
            URL.revokeObjectURL(silentUrlRef.current)
            silentUrlRef.current = null
          }
          silentDurationRef.current = 0
          ownerRef.current = 'idle'
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
          return
        }
        // PWA quirk: iOS can pause anchor directly without MediaSession pause handler.
        requestResumeFromAnchor('anchor-pause-event')
      }
    }
    silent.addEventListener('timeupdate', onAnchorTimeUpdate)
    silent.addEventListener('play', onAnchorPlay)
    silent.addEventListener('pause', onAnchorPause)

    const onTimeUpdate = () => {
      if (mediaRef.current !== audio) return
      if (ownerRef.current === 'anchor') return
      setCurrentTime(audio.currentTime)
      publishPosition(audio.duration, audio.currentTime, 1)
      syncVideoToAudio()
    }
    const onLoadedMetadata = () => {
      if (mediaRef.current !== audio) return
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d)
        frozenDurationRef.current = d
        publishPosition(d, audio.currentTime, ownerRef.current === 'track' ? 1 : 0)
        void ensureAnchorDuration(d)
      }
    }
    const onPlay = () => {
      if (mediaRef.current !== audio) return
      if (ignoreTrackPauseRef.current) return
      setPlaying(true)
      ownerRef.current = 'track'
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        publishPosition(audio.duration, audio.currentTime, 1)
      }
      if (videoRef.current && videoRef.current.src) {
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
      // Handoff is handled in pause(). This only fires for unexpected pauses.
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
      silent.removeEventListener('timeupdate', onAnchorTimeUpdate)
      silent.removeEventListener('play', onAnchorPlay)
      silent.removeEventListener('pause', onAnchorPause)
      stopRaf()
      stopPinRaf()
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
          setAudioSessionType()
          // Anchor was paused while backgrounded - restart it to keep session alive.
          // If user actually wants to resume, the next lock-screen tap will do it.
          silent.play().catch(() => {})
        }
        if (ownerRef.current === 'track' && el && videoRef.current && videoRef.current.src && !el.paused) {
          try {
            videoRef.current.currentTime = el.currentTime
            videoRef.current.play().catch(() => {})
          } catch {}
          startVideoSync()
        }
      } else {
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
    remotePauseOrResume,
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
