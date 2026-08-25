import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'

/* 
  PLAIN LANGUAGE OVERVIEW
  =======================
  This file is the player brain. One invisible <audio> does all real playback.
  For videos, a paused <video> is moved frame-by-frame to match the audio.

  The iOS 30-second kill problem:
  - If you pause and lock the phone, iOS kills the audio session after ~30s.
  - Fix = "handoff": while playing, ONLY the real track plays.
             while paused, we pause the track and play a silent WAV that is
             exactly as long as the track, frozen at the pause position.
             iOS thinks "something is still playing" so it keeps the session alive.
             On resume we kill the silent file and resume the real track.

  Only ONE element ever plays at a time -> no seek bar fighting.
*/

// Who currently owns the iOS audio session
type SessionOwner = 'idle' | 'track' | 'anchor'

// Tell iOS we want background playback (needed for PWA)
function setAudioSessionType() {
  if ('audioSession' in navigator) {
    try {
      ;(navigator as any).audioSession.type = 'playback'
    } catch {}
  }
}

// Hide an element off-screen but keep it in the DOM (iOS needs it attached)
function hideOffscreen(el: HTMLElement) {
  el.style.position = 'fixed'
  el.style.left = '-2px'
  el.style.top = '-2px'
  el.style.width = '1px'
  el.style.height = '1px'
  el.style.opacity = '0'
  el.style.pointerEvents = 'none'
}

// Silent file settings: cap at 15min to avoid huge files, low sample rate is fine for silence
const MAX_SILENT_SECONDS = 15 * 60
const SILENT_SAMPLE_RATE = 8000

// Build a silent WAV file in memory of a given duration (seconds)
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

// Tell the lock screen what time to show (so it shows song time, not silent file time)
function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!('mediaSession' in navigator)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  const pos = Math.min(Math.max(0, position), duration)
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos })
  } catch {
    // Some iOS versions reject playbackRate 0, retry with 1
    if (playbackRate === 0) {
      try {
        navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: pos })
      } catch {}
    }
  }
}

export function useAudioEngine() {
  // --- Elements (created once, never recreated) ---
  const mediaRef = useRef<HTMLMediaElement | null>(null) // real track
  const videoRef = useRef<HTMLVideoElement | null>(null) // paused video for picture
  const silentRef = useRef<HTMLAudioElement | null>(null) // silent keep-alive
  const blobUrlRef = useRef<string | null>(null) // URL for current track file
  const videoContainerRef = useRef<HTMLDivElement | null>(null) // where video gets inserted

  // --- Animation frames ---
  const rafRef = useRef(0) // video sync loop
  const rafPinRef = useRef(0) // silent pin loop (only when app visible)

  // --- Handoff state (the core of the 30s fix) ---
  const ownerRef = useRef<SessionOwner>('idle') // who owns iOS session right now
  const frozenPosRef = useRef(0) // where we paused (so we can resume there)
  const frozenDurationRef = useRef(0) // track duration at pause
  const handoffLockRef = useRef(false) // prevents play+pause at same time
  const ignoreTrackPauseRef = useRef(false) // ignore the pause event we triggered ourselves
  const suppressAnchorPauseRef = useRef(false) // ignore anchor pause we triggered ourselves
  const lastResumeRef = useRef(0) // debounce resume
  const silentUrlRef = useRef<string | null>(null) // URL for silent file
  const silentDurationRef = useRef(0) // how long silent file actually is
  const pendingPlayRef = useRef(false) // track was requested before file loaded

  const {
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

  // --- Small helpers ---

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

  // For 700ms after we pause the anchor ourselves, ignore its "pause" event
  // (otherwise it would think user pressed pause and try to resume)
  const suppressNextAnchorPause = useCallback(() => {
    suppressAnchorPauseRef.current = true
    window.setTimeout(() => {
      suppressAnchorPauseRef.current = false
    }, 700)
  }, [])

  // Keep silent file frozen at paused position + keep lock screen bar showing that position
  // This runs from BOTH rAF (when app visible) and timeupdate (when locked - rAF stops)
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

  // Keep paused video picture in sync with audio (only when track is playing)
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
    video.pause() // always start paused, audio drives playback
  }, [])

  // Make sure silent file has same duration as current track (reuse if already close)
  const ensureAnchorDuration = useCallback(async (trackDuration: number) => {
    const silent = silentRef.current
    if (!silent) return
    const target = Math.max(1, Number.isFinite(trackDuration) ? trackDuration : 2)
    if (
      silentUrlRef.current &&
      Math.abs(silentDurationRef.current - target) < 0.5 &&
      Number.isFinite(silent.duration) &&
      silent.duration > 0
    )
      return // already correct, reuse

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
    if (Number.isFinite(silent.duration) && silent.duration > 0) {
      silentDurationRef.current = silent.duration
    }
  }, [])

  // Release anchor but KEEP the blob URL cached so next handoff is instant.
  // Before: we revoked the URL and cleared duration -> every pause had to rebuild a 2MB WAV (7s on PWA) while holding handoffLock, so a quick resume tap was ignored.
  // Now: just pause, keep URL/duration, so ensureAnchorDuration can reuse it instantly.
  const hardReleaseAnchor = useCallback(() => {
    const silent = silentRef.current
    stopPinRaf()
    if (silent) {
      suppressNextAnchorPause()
      silent.pause()
      // Don't remove src / revoke URL - keep it cached for instant reuse. Just pause.
      // iOS stops treating it as active once paused; we don't need to fully unload.
    }
    ownerRef.current = 'track'
  }, [stopPinRaf, suppressNextAnchorPause])

  // PAUSE HANDOFF: track -> silent
  // Save position, build silent file of same length, jump to same time, play it almost frozen
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

    // Crawl super slowly so even if iOS reads anchor time, it barely moves
    try {
      anchor.playbackRate = 0.0001
    } catch {
      try {
        anchor.playbackRate = 0.0625
      } catch {}
    }

    // Pin loop for when app is visible (when locked, timeupdate does the pinning)
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
    addLog(`handoff -> ANCHOR @ ${pos.toFixed(1)}s / ${dur.toFixed(1)}s`)
  }, [ensureAnchorDuration, pinAnchor, stopPinRaf])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, getNextTrackIndex } = usePlayerStore.getState()
    addLog(`track ended, repeat=${repeatMode}`)
    if (repeatMode === 'one') {
      const el = mediaRef.current
      if (el) {
        el.currentTime = 0
        setAudioSessionType()
        el.play().catch((e) => addLog(`repeat-one play failed: ${String(e)}`))
      }
      return
    }
    const nextIndex = getNextTrackIndex()
    if (nextIndex !== null) {
      addLog(`auto-next to index ${nextIndex}`)
      setCurrentTrackIndex(nextIndex)
    } else {
      setPlaying(false)
      addLog('end of queue -> anchor')
      void handoffToAnchor()
    }
  }, [setCurrentTrackIndex, setPlaying, handoffToAnchor])

  // PLAY: anchor -> track (exclusive handoff)
  // FIX: keep the user tap gesture for PWA. The first el.play() is called
  // synchronously (no await before it) so iOS still sees it as "user tapped lock screen".
  const play = useCallback(() => {
    const el = mediaRef.current
    if (!el || !el.src) return
    if (handoffLockRef.current) return
    handoffLockRef.current = true

    // If we were paused, restore saved position before playing
    if (ownerRef.current === 'anchor') {
      try {
        el.currentTime = frozenPosRef.current
      } catch {}
      addLog(`resume from anchor @ ${frozenPosRef.current.toFixed(1)}s`)
    }

    // Kill anchor BEFORE starting track (never both playing) - synchronous, keeps gesture
    hardReleaseAnchor()
    setAudioSessionType()

    if (el.readyState < 2) {
      pendingPlayRef.current = true
      el.load()
      handoffLockRef.current = false
      addLog('play deferred: readyState <2, waiting for canplay')
      return
    }

    // Call play synchronously to keep the user gesture (don't await before this)
    const playPromise = el.play()
    if (!playPromise) {
      handoffLockRef.current = false
      return
    }

    playPromise
      .then(() => {
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
        addLog(`play succeeded @ ${el.currentTime.toFixed(1)}s`)
        handoffLockRef.current = false
      })
      .catch((err) => {
        const msg = String(err)
        const isNotAllowed = msg.includes('NotAllowedError')
        addLog(`play failed: ${msg} ${isNotAllowed ? '(PWA needs tap - will retry)' : ''}`)
        console.warn('[play] first attempt failed:', err)

        // Retry after a short delay - watchdog will also retry at 450/1200ms
        window.setTimeout(() => {
          setAudioSessionType()
          const retryPromise = el.play()
          if (!retryPromise) {
            handoffLockRef.current = false
            return
          }
          retryPromise
            .then(() => {
              pendingPlayRef.current = false
              ownerRef.current = 'track'
              setPlaying(true)
              if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing'
                publishPosition(el.duration, el.currentTime, 1)
              }
              startVideoSync()
              addLog(`play retry succeeded @ ${el.currentTime.toFixed(1)}s`)
              handoffLockRef.current = false
            })
            .catch((err2) => {
              addLog(`play retry failed: ${String(err2)}`)
              console.warn('[play] retry failed:', err2)
              // Keep as track so watchdog can still try, don't auto-handoff to anchor
              ownerRef.current = 'track'
              setPlaying(false)
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
              if (isNotAllowed) showError(`Play blocked: ${String(err2).slice(0, 80)} - tap again`)
              handoffLockRef.current = false
            })
        }, 120)
      })
  }, [setPlaying, startVideoSync, hardReleaseAnchor])

  // Resume with retries: PWA sometimes drops the first play() when hidden, so retry at 450ms and 1200ms
  const requestResumeFromAnchor = useCallback(
    (source: string) => {
      const now = Date.now()
      if (now - lastResumeRef.current < 650) {
        addLog(`resume ${source} ignored (debounce)`)
        return
      }
      lastResumeRef.current = now
      addLog(`resume requested via ${source}`)
      play()
      window.setTimeout(() => {
        const track = mediaRef.current
        if (ownerRef.current === 'track' && track && track.paused && !track.ended) {
          addLog('watchdog retry #1')
          play()
        }
      }, 450)
      window.setTimeout(() => {
        const track = mediaRef.current
        if (ownerRef.current === 'track' && track && track.paused && !track.ended) {
          addLog('watchdog retry #2')
          play()
        }
      }, 1200)
    },
    [play],
  )

  const loadTrack = useCallback(
    async (trackIndex: number) => {
      const { queue, isPlaying: wasPlaying } = usePlayerStore.getState()
      const track = queue[trackIndex]
      if (!track) return

      // Keep session alive while loading next track if we were playing.
      // Before: always went idle + paused anchor -> lock screen showed app icon + "speelt niets af" during the OPFS load (2-3s on PWA), and next play lost its gesture.
      const keepAlive = wasPlaying && queue.length > 1
      if (keepAlive) {
        addLog(`loadTrack ${track.name} - keeping anchor alive while loading (wasPlaying)`)
        // Don't clear frozenPos - keep last position so anchor stays pinned if needed
        // Ensure anchor is playing at frozen pos to keep lock screen alive during load
        if (ownerRef.current !== 'anchor' && silentRef.current?.paused) {
          // If track was playing, hand off to anchor at current pos so session doesn't die during OPFS fetch
          const el = mediaRef.current
          if (el && Number.isFinite(el.duration) && el.duration > 0) {
            frozenPosRef.current = el.currentTime
            frozenDurationRef.current = el.duration
          }
          void handoffToAnchor()
        }
      } else {
        stopPinRaf()
        suppressNextAnchorPause()
        silentRef.current?.pause()
        ownerRef.current = 'idle'
        frozenPosRef.current = 0
      }

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

      // Only autoplay if we were already playing (track end -> next, or user pressed next while playing)
      // Before: always true -> tried to autoplay on first load without gesture -> NotAllowedError + fade out
      pendingPlayRef.current = wasPlaying
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
    // Don't block pause if a previous handoff is still building - user explicitly paused
    // (the old handoffLock check here caused resume to be ignored while handoff built)
    const pos = el.currentTime
    frozenPosRef.current = pos
    if (Number.isFinite(el.duration) && el.duration > 0) {
      frozenDurationRef.current = el.duration
    }

    // Pause real track, but ignore its "pause" event (we handle handoff ourselves)
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

    addLog(`pause @ ${pos.toFixed(1)}s -> handing to anchor`)
    // handoffToAnchor now reuses cached blob, so this is <200ms not 7s
    await handoffToAnchor()
    publishPosition(frozenDurationRef.current || el.duration, frozenPosRef.current, 0)
  }, [setPlaying, setCurrentTime, stopRaf, handoffToAnchor])

  // When iOS fires "pause" while anchor owns session, that pause really means "resume"
  // (lock screen still shows || because anchor is playing)
  const remotePauseOrResume = useCallback(() => {
    const owner = ownerRef.current
    const anchor = silentRef.current
    const track = mediaRef.current
    addLog(`remote pause/resume: owner=${owner} trackPaused=${track?.paused} anchorPaused=${anchor?.paused}`)
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
      // If paused (anchor owns), move anchor too so scrubbing doesn't jump back
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

  // Create the two audio elements ONCE when app starts
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
    silent.volume = 0.001 // not 0, not muted - iOS requires audible volume to keep session
    silent.setAttribute('data-silent', 'true')
    silent.setAttribute('playsinline', 'true')
    hideOffscreen(silent)
    document.body.appendChild(silent)
    silentRef.current = silent

    // Anchor events: timeupdate is the only one that still fires on lock screen
    const onAnchorTimeUpdate = () => {
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
        if (Date.now() - lastResumeRef.current < 800) return // duplicate with mediaSession pause
        // If another app interrupted while backgrounded, don't fight - just release
        if (document.hidden) {
          suppressNextAnchorPause()
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
        // PWA quirk: iOS paused anchor directly, not via mediaSession handler -> treat as resume
        requestResumeFromAnchor('anchor-pause-event')
      }
    }
    silent.addEventListener('timeupdate', onAnchorTimeUpdate)
    silent.addEventListener('play', onAnchorPlay)
    silent.addEventListener('pause', onAnchorPause)

    // Real track events
    const onTimeUpdate = () => {
      if (mediaRef.current !== audio) return
      if (ownerRef.current === 'anchor') return // ignore when anchor owns session
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
      // Real handoff is handled in pause(), this is just for unexpected pauses
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
        addLog(`canplay -> pendingPlay true, calling play()`)
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

  // When user picks a different track, load it
  useEffect(() => {
    if (currentTrack && queue.length > 0) {
      loadTrack(currentTrackIndex)
    }
  }, [currentTrackIndex, currentTrack?.id])

  // Keep volume in sync
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

  // When app comes back to front, fix up playback
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
