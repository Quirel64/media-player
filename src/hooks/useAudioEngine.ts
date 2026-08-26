import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'
import { createSilentWavBlob } from '../lib/silentAudio'

/*
  Clean rebuild — iOS 30s pause persistence via silent-anchor handoff.

  Idea: iOS kills the MediaSession ~30s after the last playing element is paused (WebKit 261858).
  Fix: when user pauses, we pause the real track and instantly play a silent WAV that is the
  same duration as the track, frozen at the pause position. iOS thinks "something still playing"
  so the lock screen stays alive forever. On resume we kill the silent file and play the real
  track again. Only ONE element ever plays at a time -> no seek bar fighting.

  States: idle -> track (playing) -> anchor (paused, silent keeps session) -> track (resume)
*/

type SessionOwner = 'idle' | 'track' | 'anchor'

function setAudioSessionType() {
  const nav = navigator as unknown as { audioSession?: { type: string } }
  if (nav.audioSession) {
    try { nav.audioSession.type = 'playback' } catch { /* ignore */ }
  }
}

function hideOffscreen(el: HTMLElement) {
  Object.assign(el.style, {
    position: 'fixed', left: '-2px', top: '-2px',
    width: '1px', height: '1px', opacity: '0', pointerEvents: 'none',
  } as CSSStyleDeclaration)
}

function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!('mediaSession' in navigator)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  const pos = Math.min(Math.max(0, position), duration)
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos })
  } catch {
    if (playbackRate === 0) {
      try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: pos }) } catch { /* ignore */ }
    }
  }
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const anchorRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  const anchorUrlRef = useRef<string | null>(null)
  const anchorBuiltDurationRef = useRef(0)

  const rafVideoRef = useRef(0)
  const rafPinRef = useRef(0)

  const ownerRef = useRef<SessionOwner>('idle')
  const frozenPosRef = useRef(0)
  const frozenDurationRef = useRef(0)
  const pendingPlayRef = useRef(false)
  const suppressAnchorPauseRef = useRef(false)
  const lastResumeRef = useRef(0)

  const { currentTrackIndex, queue, volume, isMuted, setPlaying, setCurrentTime, setDuration, setCurrentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  // --- helpers ---

  const stopVideoRaf = useCallback(() => {
    if (rafVideoRef.current) { cancelAnimationFrame(rafVideoRef.current); rafVideoRef.current = 0 }
  }, [])

  const stopPinRaf = useCallback(() => {
    if (rafPinRef.current) { cancelAnimationFrame(rafPinRef.current); rafPinRef.current = 0 }
  }, [])

  const suppressNextAnchorPause = useCallback(() => {
    suppressAnchorPauseRef.current = true
    window.setTimeout(() => { suppressAnchorPauseRef.current = false }, 700)
  }, [])

  // Keep silent frozen + lock screen bar frozen. Called from rAF (foreground) and timeupdate (background/locked)
  const pinAnchor = useCallback(() => {
    const a = anchorRef.current
    if (!a || ownerRef.current !== 'anchor') return
    const target = frozenPosRef.current
    const maxPos = Number.isFinite(a.duration) && a.duration > 0 ? Math.max(0, a.duration - 0.05) : target
    const clamped = Math.max(0, Math.min(target, maxPos))
    if (Math.abs(a.currentTime - clamped) > 0.03) {
      try { a.currentTime = clamped } catch { /* ignore */ }
    }
    if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: frozenDurationRef.current,
          playbackRate: 1,
          position: Math.min(target, frozenDurationRef.current),
        })
      } catch { /* ignore */ }
    }
  }, [])

  const startVideoSync = useCallback(() => {
    stopVideoRaf()
    const tick = () => {
      const audio = mediaRef.current
      const video = videoRef.current
      if (audio && video && ownerRef.current === 'track' && !audio.paused) {
        if (Math.abs(video.currentTime - audio.currentTime) > 0.12) {
          try { video.currentTime = audio.currentTime } catch { /* ignore */ }
        }
      }
      if (mediaRef.current && ownerRef.current === 'track' && !mediaRef.current.paused) {
        rafVideoRef.current = requestAnimationFrame(tick)
      }
    }
    rafVideoRef.current = requestAnimationFrame(tick)
  }, [stopVideoRaf])

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
      Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain', borderRadius: '12px', touchAction: 'manipulation', background: '#000' })
      videoRef.current = video
    }
    if (container && video.parentNode !== container) {
      container.innerHTML = ''
      container.appendChild(video)
    }
    if (video.src !== url) { video.src = url; video.load() }
    video.pause()
  }, [])

  // Build/reuse silent WAV matching track duration
  const ensureAnchorDuration = useCallback(async (trackDuration: number) => {
    const a = anchorRef.current
    if (!a) return
    const target = Math.max(1, Number.isFinite(trackDuration) ? trackDuration : 2)

    // Reuse cached blob if duration close — instant, no rebuild delay
    if (anchorUrlRef.current && Math.abs(anchorBuiltDurationRef.current - target) < 0.5) {
      if (!a.src || a.src === '' || a.src === window.location.href) {
        a.src = anchorUrlRef.current
        a.load()
        addLog(`anchor reused from cache: ${target.toFixed(1)}s`)
        return
      }
      if (Number.isFinite(a.duration) && a.duration > 0) return
    }

    if (anchorUrlRef.current) { URL.revokeObjectURL(anchorUrlRef.current); anchorUrlRef.current = null }
    const blob = createSilentWavBlob(target)
    const url = URL.createObjectURL(blob)
    anchorUrlRef.current = url
    anchorBuiltDurationRef.current = target

    await new Promise<void>((resolve) => {
      const done = () => { a.removeEventListener('loadedmetadata', done); resolve() }
      a.addEventListener('loadedmetadata', done)
      a.src = url
      a.load()
      window.setTimeout(() => { a.removeEventListener('loadedmetadata', done); resolve() }, 500)
    })
    if (Number.isFinite(a.duration) && a.duration > 0) anchorBuiltDurationRef.current = a.duration
    addLog(`anchor built: target=${target.toFixed(1)}s actual=${Number.isFinite(a.duration) ? a.duration.toFixed(1) : '?'}s`)
  }, [])

  // Anchor -> track: stop pin, pause anchor (keep src for fast reuse)
  const releaseAnchor = useCallback(() => {
    const a = anchorRef.current
    stopPinRaf()
    if (a) { suppressNextAnchorPause(); a.pause() }
    ownerRef.current = 'track'
  }, [stopPinRaf, suppressNextAnchorPause])

  // Track -> anchor: hand session to silent
  const handoffToAnchor = useCallback(async () => {
    const track = mediaRef.current
    const anchor = anchorRef.current
    if (!track || !anchor) return

    const pos = Number.isFinite(track.currentTime) ? track.currentTime : 0
    const dur = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : frozenDurationRef.current || 2
    frozenPosRef.current = pos
    frozenDurationRef.current = dur

    await ensureAnchorDuration(dur)
    try {
      const maxPos = Number.isFinite(anchor.duration) && anchor.duration > 0 ? anchor.duration - 0.05 : pos
      anchor.currentTime = Math.max(0, Math.min(pos, maxPos))
    } catch { /* ignore */ }

    setAudioSessionType()
    try { await anchor.play() } catch {
      await new Promise((r) => setTimeout(r, 100))
      try { setAudioSessionType(); await anchor.play() } catch { return }
    }

    try { anchor.playbackRate = 0.0001 } catch {
      try { anchor.playbackRate = 0.0625 } catch { /* ignore */ }
    }

    stopPinRaf()
    const pin = () => {
      const a2 = anchorRef.current
      if (!a2 || a2.paused || ownerRef.current !== 'anchor') return
      pinAnchor()
      rafPinRef.current = requestAnimationFrame(pin)
    }
    rafPinRef.current = requestAnimationFrame(pin)

    ownerRef.current = 'anchor'
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    addLog(`handoff -> ANCHOR @ ${pos.toFixed(1)}s / ${dur.toFixed(1)}s`)
  }, [ensureAnchorDuration, pinAnchor, stopPinRaf])

  // --- transport ---

  const play = useCallback(() => {
    const el = mediaRef.current
    if (!el || !el.src) { addLog('play aborted: no src'); return }

    if (ownerRef.current === 'anchor') {
      try { el.currentTime = frozenPosRef.current } catch { /* ignore */ }
      addLog(`resume from anchor @ ${frozenPosRef.current.toFixed(1)}s`)
    }

    releaseAnchor()
    setAudioSessionType()

    if (el.readyState < 2) {
      pendingPlayRef.current = true
      el.load()
      addLog('play deferred: readyState <2')
      return
    }

    const p = el.play()
    if (!p) return
    p.then(() => {
      const v = videoRef.current
      if (v && v.src) { try { v.pause(); v.currentTime = el.currentTime } catch { /* ignore */ } }
      pendingPlayRef.current = false
      ownerRef.current = 'track'
      setPlaying(true)
      if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = 'playing'; publishPosition(el.duration, el.currentTime, 1) }
      startVideoSync()
      addLog(`play ok @ ${el.currentTime.toFixed(1)}s`)
    }).catch((err) => {
      const msg = String(err)
      const notAllowed = msg.includes('NotAllowedError')
      addLog(`play failed: ${msg}${notAllowed ? ' (tap again)' : ''}`)
      window.setTimeout(() => {
        setAudioSessionType()
        el.play()?.then(() => {
          pendingPlayRef.current = false
          ownerRef.current = 'track'
          setPlaying(true)
          if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = 'playing'; publishPosition(el.duration, el.currentTime, 1) }
          startVideoSync()
          addLog(`play retry ok @ ${el.currentTime.toFixed(1)}s`)
        }).catch((e2) => {
          addLog(`play retry failed: ${String(e2)}`)
          ownerRef.current = 'track'
          setPlaying(false)
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
          if (notAllowed) showError(`Play blocked: ${String(e2).slice(0, 80)} — tap again`)
        })
      }, 120)
    })
  }, [releaseAnchor, setPlaying, startVideoSync])

  const requestResumeFromAnchor = useCallback((source: string) => {
    const now = Date.now()
    if (now - lastResumeRef.current < 650) { addLog(`resume ${source} ignored (debounce)`); return }
    lastResumeRef.current = now
    addLog(`resume via ${source}`)
    play()
    window.setTimeout(() => {
      const t = mediaRef.current
      if (ownerRef.current === 'track' && t && t.paused && !t.ended) { addLog('watchdog #1'); play() }
    }, 450)
    window.setTimeout(() => {
      const t = mediaRef.current
      if (ownerRef.current === 'track' && t && t.paused && !t.ended) { addLog('watchdog #2'); play() }
    }, 1200)
  }, [play])

  const pause = useCallback(async () => {
    const el = mediaRef.current
    if (!el) return
    frozenPosRef.current = el.currentTime
    if (Number.isFinite(el.duration) && el.duration > 0) frozenDurationRef.current = el.duration

    el.pause()
    videoRef.current?.pause()
    stopVideoRaf()

    setPlaying(false)
    setCurrentTime(frozenPosRef.current)
    if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = 'paused'; publishPosition(el.duration, frozenPosRef.current, 0) }

    addLog(`pause @ ${frozenPosRef.current.toFixed(1)}s -> anchor`)
    await handoffToAnchor()
    publishPosition(frozenDurationRef.current || el.duration, frozenPosRef.current, 0)
  }, [setPlaying, setCurrentTime, stopVideoRaf, handoffToAnchor])

  const remotePauseOrResume = useCallback(() => {
    const a = anchorRef.current
    const t = mediaRef.current
    addLog(`remote pause/resume: owner=${ownerRef.current} trackPaused=${t?.paused} anchorPaused=${a?.paused}`)
    if (ownerRef.current === 'anchor' || (t?.paused && a && !a.paused)) {
      requestResumeFromAnchor('mediaSession-pause')
      return
    }
    void pause()
  }, [pause, requestResumeFromAnchor])

  const togglePlay = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (ownerRef.current === 'anchor') { requestResumeFromAnchor('in-app-toggle'); return }
    if (el.paused) play(); else void pause()
  }, [play, pause, requestResumeFromAnchor])

  const seek = useCallback((time: number) => {
    const el = mediaRef.current
    if (!el) return
    const max = Number.isFinite(el.duration) ? el.duration : time
    const clamped = Math.max(0, Math.min(time, max))
    el.currentTime = clamped
    frozenPosRef.current = clamped
    if (videoRef.current?.src) { try { videoRef.current.currentTime = clamped } catch { /* ignore */ } }

    if (ownerRef.current === 'anchor' && anchorRef.current) {
      try {
        const a = anchorRef.current
        const maxPos = Number.isFinite(a.duration) && a.duration > 0 ? a.duration - 0.05 : clamped
        a.currentTime = Math.max(0, Math.min(clamped, maxPos))
      } catch { /* ignore */ }
      if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
        try { navigator.mediaSession.setPositionState({ duration: frozenDurationRef.current, playbackRate: 1, position: clamped }) } catch { /* ignore */ }
      }
    } else {
      publishPosition(el.duration, clamped, ownerRef.current === 'track' ? 1 : 0)
    }
    setCurrentTime(clamped)
  }, [setCurrentTime])

  const nextTrack = useCallback(() => {
    const { getNextTrackIndex } = usePlayerStore.getState()
    const n = getNextTrackIndex()
    if (n !== null) setCurrentTrackIndex(n)
  }, [setCurrentTrackIndex])

  const prevTrack = useCallback(() => {
    const { currentTime, getPrevTrackIndex } = usePlayerStore.getState()
    if (currentTime > 3) { seek(0); return }
    const p = getPrevTrackIndex()
    if (p !== null) setCurrentTrackIndex(p)
  }, [setCurrentTrackIndex, seek])

  const goToTrack = useCallback((index: number) => { setCurrentTrackIndex(index) }, [setCurrentTrackIndex])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, getNextTrackIndex } = usePlayerStore.getState()
    addLog(`ended repeat=${repeatMode}`)
    if (repeatMode === 'one') {
      const el = mediaRef.current
      if (el) { el.currentTime = 0; setAudioSessionType(); el.play().catch((e) => addLog(`repeat-one failed: ${String(e)}`)) }
      return
    }
    const n = getNextTrackIndex()
    if (n !== null) { addLog(`auto-next ${n}`); setCurrentTrackIndex(n) }
    else { setPlaying(false); void handoffToAnchor() }
  }, [setCurrentTrackIndex, setPlaying, handoffToAnchor])

  const loadTrack = useCallback(async (trackIndex: number) => {
    const { queue: q, isPlaying: wasPlaying } = usePlayerStore.getState()
    const track = q[trackIndex]
    if (!track) return

    // Keep anchor alive while OPFS loads next file if we were playing -> no "speelt niets af" gap on lock screen
    const keepAlive = wasPlaying && q.length > 1
    if (keepAlive) {
      if (ownerRef.current !== 'anchor' && anchorRef.current?.paused) {
        const el = mediaRef.current
        if (el && Number.isFinite(el.duration) && el.duration > 0) {
          frozenPosRef.current = el.currentTime
          frozenDurationRef.current = el.duration
        }
        void handoffToAnchor().then(() => { frozenPosRef.current = 0 })
      } else if (ownerRef.current === 'anchor') {
        frozenPosRef.current = 0
      }
    } else {
      stopPinRaf()
      suppressNextAnchorPause()
      anchorRef.current?.pause()
      ownerRef.current = 'idle'
      frozenPosRef.current = 0
    }

    stopVideoRaf()
    cleanupVideo()
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null }

    const url = await getFileURLFromOPFS(track.fileName)
    if (!url) { showError(`File not found: ${track.fileName}`); return }
    blobUrlRef.current = url

    const el = mediaRef.current
    if (!el) return
    setCurrentTime(0)
    setDuration(0)
    pendingPlayRef.current = wasPlaying
    el.src = url
    el.load()

    if (track.mediaType === 'video') attachVideo(url)

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name, artist: track.artist || 'Unknown Artist', album: track.album || 'Unknown Album',
      })
    }
    setAudioSessionType()
    addLog(`load [${trackIndex + 1}/${q.length}] ${track.name} autoplay=${wasPlaying}`)
  }, [attachVideo, cleanupVideo, setCurrentTime, setDuration, stopVideoRaf, stopPinRaf, suppressNextAnchorPause, handoffToAnchor])

  // One-time element creation
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

    const anchor = document.createElement('audio')
    anchor.preload = 'auto'
    anchor.loop = true
    anchor.volume = 0.001
    anchor.setAttribute('playsinline', 'true')
    anchor.setAttribute('data-silent', 'true')
    hideOffscreen(anchor)
    document.body.appendChild(anchor)
    anchorRef.current = anchor

    const onAnchorTimeUpdate = () => pinAnchor()
    const onAnchorPlay = () => { if (ownerRef.current === 'anchor') { try { anchor.playbackRate = 0.0001 } catch { /* ignore */ }; pinAnchor() } }
    const onAnchorPause = () => {
      if (ownerRef.current !== 'anchor') return
      if (suppressAnchorPauseRef.current) return
      if (Date.now() - lastResumeRef.current < 800) return
      if (document.hidden) {
        suppressNextAnchorPause(); stopPinRaf(); anchor.pause()
        ownerRef.current = 'idle'
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
        return
      }
      requestResumeFromAnchor('anchor-pause-event')
    }
    anchor.addEventListener('timeupdate', onAnchorTimeUpdate)
    anchor.addEventListener('play', onAnchorPlay)
    anchor.addEventListener('pause', onAnchorPause)

    const onTimeUpdate = () => {
      if (mediaRef.current !== audio || ownerRef.current === 'anchor') return
      setCurrentTime(audio.currentTime)
      publishPosition(audio.duration, audio.currentTime, 1)
      // video sync handled by rAF; this just keeps store/time in sync
    }
    const onLoadedMetadata = () => {
      if (mediaRef.current !== audio) return
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) {
        setDuration(d); frozenDurationRef.current = d
        publishPosition(d, audio.currentTime, ownerRef.current === 'track' ? 1 : 0)
        void ensureAnchorDuration(d)
      }
    }
    const onPlay = () => {
      if (mediaRef.current !== audio) return
      setPlaying(true); ownerRef.current = 'track'
      if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = 'playing'; publishPosition(audio.duration, audio.currentTime, 1) }
      if (videoRef.current?.src) { try { videoRef.current.currentTime = audio.currentTime; videoRef.current.play().catch(() => {}) } catch { /* ignore */ }; startVideoSync() }
    }
    const onEnded = () => { if (mediaRef.current === audio && ownerRef.current === 'track') handleTrackEnd() }
    const onError = () => {
      if (mediaRef.current !== audio) return
      const t = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]
      showError(`Audio error: ${t?.name || 'unknown'}`); setPlaying(false)
    }
    const onCanPlay = () => { if (mediaRef.current === audio && pendingPlayRef.current) { addLog('canplay -> play'); pendingPlayRef.current = false; play() } }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('seeked', () => { if (mediaRef.current === audio && ownerRef.current === 'track') publishPosition(audio.duration, audio.currentTime, 1) })

    setAudioSessionType()

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('canplay', onCanPlay)
      anchor.removeEventListener('timeupdate', onAnchorTimeUpdate)
      anchor.removeEventListener('play', onAnchorPlay)
      anchor.removeEventListener('pause', onAnchorPause)
      stopVideoRaf(); stopPinRaf()
      audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove()
      anchor.pause(); anchor.removeAttribute('src'); anchor.load(); anchor.remove()
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current)
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
      mediaRef.current = null; anchorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (currentTrack && queue.length > 0) void loadTrack(currentTrackIndex)
  }, [currentTrackIndex, currentTrack?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (mediaRef.current) mediaRef.current.volume = isMuted ? 0 : volume }, [volume, isMuted])

  useEffect(() => {
    return () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }
  }, [])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const { isPlaying: wasPlaying } = usePlayerStore.getState()
        const el = mediaRef.current
        const a = anchorRef.current
        if (ownerRef.current === 'track' && el && wasPlaying && el.paused && !el.ended) { setAudioSessionType(); play() }
        else if (ownerRef.current === 'anchor' && a && a.paused) { setAudioSessionType(); a.play().catch(() => {}) }
        if (ownerRef.current === 'track' && el && videoRef.current?.src && !el.paused) {
          try { videoRef.current.currentTime = el.currentTime; videoRef.current.play().catch(() => {}) } catch { /* ignore */ }
          startVideoSync()
        }
      } else { videoRef.current?.pause(); stopVideoRaf() }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [play, startVideoSync, stopVideoRaf])

  return { play, pause, remotePauseOrResume, togglePlay, seek, nextTrack, prevTrack, goToTrack, videoContainerRef }
}
