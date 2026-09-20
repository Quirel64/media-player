import { useRef, useEffect, useCallback, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import type { Track } from '../lib/types'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'
import { createSilentWavUrl, describeSilentWav } from '../lib/silentAudio'
import { getPlayingArtwork } from '../lib/artwork'
import { VideoSyncController } from '../lib/videoSync'

/*
  FINAL — Same-element source swap (Arena idea + your 0.0000001 tweak).

  Why this wins over old anchor handoff / single-element freeze:
  - PWA iOS grants background permission per HTMLMediaElement. Cross-element play() (track <-> anchor)
    is often rejected as AbortError in standalone. Same permanent <audio> swapping src track <-> silent placeholder
    keeps the activation because play() happens synchronously in the MediaSession callback before any await.
  - Silent placeholder is duration-matched (no 2s loop snap) and HOLD_RATE 0.0000001 (your test: 0.25 still drifted, 1e-7 = 4 months per second)
  - Memory: 1 placeholder at a time (~2MB for 125s), revoked when not active, not OPFS — 5h track 28125KB still only 0.5s swap, no storage bloat

  States on one element: idle -> track (playing) -> anchor (paused, silent keeps session) -> track (resume)
  Logs: track resumed @ X / track → placeholder @ X / anchor source active @ X
*/

const HOLD_RATE = 0.0000001
const FALLBACK_HOLD_RATE = 0.0625
// HOLD_RATE 1e-7 keeps bar frozen (~4 months/sec) while anchor holds session; 0 made bar drift to end (see 13:44 logs)
const INVERT_LOCK_ICON_TEST = false

function setRate(el: HTMLMediaElement, rate: number) {
  try { el.defaultPlaybackRate = rate; el.playbackRate = rate } catch {
    try { el.defaultPlaybackRate = FALLBACK_HOLD_RATE; el.playbackRate = FALLBACK_HOLD_RATE } catch { /* ignore */ }
  }
}

function setAudioSessionType() {
  const nav = navigator as unknown as { audioSession?: { type: string } }
  if (nav.audioSession) { try { nav.audioSession.type = 'playback' } catch { /* ignore */ } }
}
function hideOffscreen(el: HTMLElement) {
  Object.assign(el.style, { position: 'fixed', left: '-2px', top: '-2px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' } as CSSStyleDeclaration)
}
function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!('mediaSession' in navigator)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  try { navigator.mediaSession.setPositionState({ duration, playbackRate, position: Math.min(Math.max(0, position), duration) }) } catch { /* ignore iOS during transition */ }
}
function getLockPlaybackState(kind: 'track' | 'anchor'): MediaSessionPlaybackState {
  if (INVERT_LOCK_ICON_TEST) return kind === 'track' ? 'paused' : 'playing'
  return kind === 'track' ? 'playing' : 'paused'
}
function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

type SourceKind = 'track' | 'anchor'

export function useAudioEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  const anchorUrlRef = useRef('')
  const anchorForDurationRef = useRef(0)
  const urlCacheRef = useRef<Map<string, string>>(new Map())

  const videoSyncRef = useRef<VideoSyncController | null>(null)
  const frozenPosRef = useRef(0)
  const trackDurationRef = useRef(0)
  const transitionRef = useRef(false)
  const transitionTokenRef = useRef(0)
  const queuedCommandRef = useRef<'play' | 'pause' | null>(null)
  const commandRunnerRef = useRef<((c: 'play' | 'pause') => void) | null>(null)
  const loadGenRef = useRef(0)
  const prevTrackIdRef = useRef<string | null>(null)
  const nextGestureRef = useRef(false)

  const sourceKindRef = useRef<SourceKind>('track')
  const ownerRef = useRef<'idle' | 'track' | 'anchor'>('idle')
  const pendingAnchorPosRef = useRef<number | null>(null)

  const { currentTrackIndex, queue, volume, isMuted, setPlaying, setCurrentTime, setDuration, setCurrentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]
  const [loadForce, setLoadForce] = useState(0)

  const getSync = useCallback(() => {
    if (!videoSyncRef.current) {
      videoSyncRef.current = new VideoSyncController({
        getAudio: () => mediaRef.current,
        getVideo: () => videoRef.current,
        isActive: () => sourceKindRef.current === 'track' && ownerRef.current === 'track' && !!mediaRef.current && !mediaRef.current.paused && document.visibilityState === 'visible',
        log: (m) => addLog(m),
        onStats: (s) => { if (s.lastAction !== 'locked' && s.lastAction !== 'idle') addLog(`vsync ${s.lastAction} drift ${s.drift.toFixed(2)} rate ${s.rate.toFixed(3)}`) },
      })
    }
    return videoSyncRef.current
  }, [])
  const stopRaf = useCallback(() => { videoSyncRef.current?.stop() }, [])
  const startVideoFrames = useCallback(() => { getSync().start() }, [getSync])

  const attachVideo = useCallback((url: string) => {
    let v = videoRef.current
    if (!v) {
      v = document.createElement('video')
      v.muted = true; (v as unknown as { defaultMuted: boolean }).defaultMuted = true
      v.playsInline = true; v.setAttribute('webkit-playsinline','true'); v.setAttribute('x-webkit-airplay','deny'); v.preload='auto'; v.controls=false
      try { (v as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true } catch {}
      v.style.width='100%'; v.style.height='100%'; v.style.objectFit='contain'; v.style.background='#000'
      videoRef.current = v
    }
    const c = videoContainerRef.current
    if (c && v.parentNode !== c) { c.innerHTML=''; c.appendChild(v) }
    // Universal reset: always reload even if same src so same-track tap restarts fresh
    v.src = url; v.load()
    try { v.currentTime = 0 } catch {}
    v.pause()
  }, [])
  const detachVideo = useCallback(() => { const v=videoRef.current; if(!v) return; v.pause(); v.removeAttribute('src'); v.load() }, [])
  const cleanupVideo = useCallback(() => { if (videoRef.current) { const v=videoRef.current; v.pause(); v.removeAttribute('src'); v.load(); if(v.parentNode) v.parentNode.removeChild(v); videoRef.current=null } }, [])

  const setOwner = useCallback((o: 'idle' | 'track' | 'anchor') => { ownerRef.current = o }, [])

  const ensureAnchor = useCallback((trackDuration: number) => {
    const target = Math.max(2, Number.isFinite(trackDuration) ? trackDuration : 2)
    if (anchorUrlRef.current && Math.abs(anchorForDurationRef.current - target) < 0.2) return
    addLog(`building same-element placeholder ${describeSilentWav(target)}`)
    const nextUrl = createSilentWavUrl(target)
    const prev = anchorUrlRef.current
    anchorUrlRef.current = nextUrl
    anchorForDurationRef.current = target
    if (prev && sourceKindRef.current !== 'anchor') URL.revokeObjectURL(prev)
  }, [])

  const flushQueued = useCallback(() => {
    const c = queuedCommandRef.current; queuedCommandRef.current = null
    if (c) queueMicrotask(() => commandRunnerRef.current?.(c))
  }, [])

  const activateSource = useCallback(async (kind: SourceKind, url: string, position: number) => {
    const media = mediaRef.current
    if (!media || !url) throw new Error('media or source missing')
    const token = ++transitionTokenRef.current
    sourceKindRef.current = kind
    setOwner('idle')
    setAudioSessionType()
    const rate = kind === 'anchor' ? HOLD_RATE : 1
    const isVideoTrack = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
    const v = videoRef.current
    // Ensure video is in correct paused/playing state immediately (fix: video kept playing after 2nd lock pause)
    if (isVideoTrack && v) {
      if (kind === 'anchor') { try { v.pause() } catch {} }
      else { v.muted = true }
    } else if (v && kind === 'anchor') {
      try { v.pause() } catch {}
    }
    const setPosWhenReady = () => {
      if (token !== transitionTokenRef.current) return
      const srcDur = media.duration
      const safeMax = Number.isFinite(srcDur) ? Math.max(0, srcDur - 0.35) : position
      const safePos = Math.min(Math.max(0, position), safeMax)
      try { media.currentTime = safePos } catch { /* canplay retry */ }
      setRate(media, rate)
      if (v) setRate(v, 1)
    }
    // Audio: keep only single seek before play (play:182) + anchor listeners. No double seek for track.
    if (kind === 'anchor') {
      media.addEventListener('loadedmetadata', setPosWhenReady, { once: true })
      media.addEventListener('canplay', setPosWhenReady, { once: true })
    }
    media.autoplay = true; setRate(media, rate)
    media.src = url; media.load()
    if (kind === 'track' && Math.abs((media.currentTime || 0) - position) > 0.15) try { media.currentTime = position } catch {}
    // Sync lock UI before await to keep PWA gesture — must match final state (fix iOS 26.2 inverted icon)
    // For iOS 26.2, also publish position BEFORE state so bar and icon stay in sync
    const preDuration = trackDurationRef.current || media.duration || position
    if (kind === 'anchor') {
      publishPosition(preDuration, frozenPosRef.current, HOLD_RATE)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
      addLog(`pre-publish anchor ${getLockPlaybackState('anchor')} dur=${preDuration.toFixed(1)} pos=${frozenPosRef.current.toFixed(2)} rate=${HOLD_RATE}`)
    } else {
      publishPosition(preDuration, position, 1)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
      addLog(`pre-publish track ${getLockPlaybackState('track')} dur=${preDuration.toFixed(1)} pos=${position.toFixed(2)} rate=1`)
    }
    const playPromise = media.play()
    // Dual-play: muted video plays alongside audio (native 30fps). Keep muted so iOS keeps audio session.
    let videoPlay: Promise<void> | null = null
    if (isVideoTrack && v && kind === 'track') { v.muted = true; try { videoPlay = v.play() } catch { /* ignore */ } }
    else if (v && kind === 'anchor') { try { v.pause() } catch {} }
    try {
      await playPromise
    } catch (e) {
      // iOS PWA may reject if not in gesture — log and re-throw for retry in caller
      addLog(`${kind} play() rejected: ${e}`)
      throw e
    }
    if (videoPlay) await videoPlay.catch(() => { addLog('video.play failed') })
    if (token !== transitionTokenRef.current) {
      // Stale: still ensure lock shows correct final kind for the newer token
      addLog(`activateSource ${kind} stale token ${token} abandoned`)
      return
    }
    if (kind === 'anchor') setPosWhenReady()
    setOwner(kind)
    if (kind === 'track') {
      // Ensure video is seeked to same position as audio (fix: video gets ahead after lock resume)
      if (isVideoTrack && v) {
        try { if (Math.abs(v.currentTime - media.currentTime) > 0.15) v.currentTime = media.currentTime } catch {}
      }
      setPlaying(true);
      const postDur = media.duration || trackDurationRef.current
      publishPosition(postDur, media.currentTime, 1)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
      addLog(`post-publish track ${getLockPlaybackState('track')} dur=${postDur.toFixed(1)} pos=${media.currentTime.toFixed(2)} rate=1 state=${getLockPlaybackState('track')}`)
      // Ensure video reflects track state even after token race
      if (isVideoTrack && v && v.paused) { try { v.muted = true; await v.play() } catch { /* ignore */ } }
    } else {
      setPlaying(false);
      const postDur = trackDurationRef.current || media.duration
      publishPosition(postDur, frozenPosRef.current, HOLD_RATE)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
      addLog(`post-publish anchor ${getLockPlaybackState('anchor')} dur=${postDur.toFixed(1)} pos=${frozenPosRef.current.toFixed(2)} rate=${HOLD_RATE} state=${getLockPlaybackState('anchor')}`)
      if (v) try { v.pause(); v.currentTime = frozenPosRef.current } catch {}
    }
    // Double-publish 120ms later to fix iOS 26.2 where lock icon lags behind setPositionState — now with correct order (publish then state)
    setTimeout(() => {
      if (token !== transitionTokenRef.current) return
      if (sourceKindRef.current === kind) {
        if (kind === 'track') {
          const d = media.duration || trackDurationRef.current; publishPosition(d, media.currentTime, 1)
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track') } catch {}
          addLog(`re-publish track ${getLockPlaybackState('track')} pos=${media.currentTime.toFixed(2)}`)
        } else {
          const d = trackDurationRef.current || media.duration; publishPosition(d, frozenPosRef.current, HOLD_RATE)
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor') } catch {}
          addLog(`re-publish anchor ${getLockPlaybackState('anchor')} pos=${frozenPosRef.current.toFixed(2)}`)
        }
      }
    }, 120)
    // Extra 500ms correction for iOS 26.2 that sometimes inverts first in-app pause
    setTimeout(() => {
      if (token !== transitionTokenRef.current) return
      if (sourceKindRef.current === kind) {
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState(kind) } catch {}
        addLog(`500ms correct playbackState ${getLockPlaybackState(kind)}`)
      }
    }, 500)
    addLog(`${kind} source active on permanent element @ ${media.currentTime.toFixed(2)}s${isVideoTrack && kind==='track' ? (v && !v.paused ? ' +video playing' : ' +video paused') : ''} owner=${kind}`)
  }, [setOwner, startVideoFrames, setPlaying])

  const play = useCallback(async () => {
    const state = usePlayerStore.getState()
    const track = state.queue[state.currentTrackIndex] ?? currentTrack
    const media = mediaRef.current
    if (!track || !media) { addLog(`play ignored — no track (queue ${state.queue.length} idx ${state.currentTrackIndex})`); return }
    if (pendingAnchorPosRef.current !== null) {
      const pend = pendingAnchorPosRef.current
      pendingAnchorPosRef.current = null
      addLog(`play cancels deferred anchor @ ${pend.toFixed(2)} -> resume track`)
      setPlaying(true)
      publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
      try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing' } catch {}
      // Resume track audio that was paused for deferred
      try { await media.play() } catch (e) { addLog(`cancel deferred play failed ${e}`) }
      const vResume = videoRef.current; if (vResume && vResume.src) { try { vResume.currentTime = frozenPosRef.current } catch {}; vResume.muted = true; vResume.play().catch(() => {}) }
      return
    }
    if (transitionRef.current) { queuedCommandRef.current = 'play'; addLog('play queued behind swap'); return }
    transitionRef.current = true
    try {
      const resumePos = frozenPosRef.current
      // Same track, same src — direct resume keeps gesture (no source swap)
      const currentBlobIsTrack = blobUrlRef.current && media.src === blobUrlRef.current
      const isVideoResume = track.mediaType === 'video'
      const vResume = videoRef.current
      if (sourceKindRef.current === 'track' && currentBlobIsTrack) {
        setAudioSessionType()
        if (Number.isFinite(resumePos) && Math.abs((media.currentTime || 0) - resumePos) > 0.15) try { media.currentTime = resumePos } catch {}
        // Ensure video seeked to resumePos before play (fix ahead after lock resume)
        if (isVideoResume && vResume && vResume.src) {
          try { if (Math.abs(vResume.currentTime - resumePos) > 0.15) vResume.currentTime = resumePos } catch {}
        }
        // Publish before state for iOS sync
        publishPosition(media.duration || trackDurationRef.current, resumePos, 1)
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        addLog(`direct resume pre-publish ${getLockPlaybackState('track')} pos=${resumePos.toFixed(2)}`)
        const directPlay = media.play()
        let vPlay: Promise<void> | null = null
        if (isVideoResume && vResume) { vResume.muted = true; try { vPlay = vResume.play() } catch {} }
        await directPlay
        if (vPlay) await vPlay.catch(() => addLog('video resume failed'))
        // Baseline 1: no video hardSync
        setOwner('track'); setPlaying(true)
        publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        addLog(`track resumed on permanent element @ ${media.currentTime.toFixed(2)}s rate=1 state=${getLockPlaybackState('track')} direct`)
        // Corrective re-publish for iOS 26.2
        setTimeout(() => {
          publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track') } catch {}
        }, 120)
      } else {
        // Need src swap — ensure blob URL for OPFS track
        let url = blobUrlRef.current
        // If blob was revoked or track changed, re-derive
        if (!url || prevTrackIdRef.current !== track.id) {
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
          const fresh = await getFileURLFromOPFS(track.fileName)
          if (!fresh) { showError(`File not found: ${track.fileName}`); throw new Error('no url') }
          blobUrlRef.current = fresh; url = fresh
        }
        try { await activateSource('track', url, resumePos) } catch (e) {
          addLog(`track source swap play() failed: ${e}`); await delay(120); await activateSource('track', url, resumePos)
        }
      }
    } catch (e) { setPlaying(false); setOwner('idle'); addLog(`resume failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, currentTrack, flushQueued, setOwner, setPlaying, startVideoFrames])

  const pause = useCallback(async () => {
    const media = mediaRef.current
    if (!media) return
    if (sourceKindRef.current === 'anchor' || pendingAnchorPosRef.current !== null) { addLog('pause while placeholder/pending → resume'); pendingAnchorPosRef.current = null; void play(); return }
    if (transitionRef.current) { queuedCommandRef.current = 'pause'; addLog('pause queued'); return }
    // Defer visible anchor to hidden: visible anchor shows || inverted, hidden shows > correctly + keeps session with HOLD_RATE
    if (document.visibilityState === 'visible' && sourceKindRef.current === 'track') {
      const pos = media.currentTime
      frozenPosRef.current = pos; setCurrentTime(pos); setPlaying(false); stopRaf()
      const vPause = videoRef.current; if (vPause) try { vPause.pause(); vPause.currentTime = pos } catch {}
      try { media.pause(); addLog(`pause deferred media.pause @ ${pos.toFixed(2)}s`) } catch {}
      pendingAnchorPosRef.current = pos
      ensureAnchor(trackDurationRef.current || media.duration || 2)
      publishPosition(trackDurationRef.current || media.duration, pos, HOLD_RATE)
      try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch {}
      addLog(`pause deferred (visible) @ ${pos.toFixed(2)}s — will swap to anchor on hidden`)
      return
    }
    transitionRef.current = true
    try {
      const pos = media.currentTime
      frozenPosRef.current = pos; setCurrentTime(pos); setPlaying(false); stopRaf()
      const vPause = videoRef.current; if (vPause) try { vPause.pause() } catch {}
      ensureAnchor(trackDurationRef.current || media.duration || 2)
      await activateSource('anchor', anchorUrlRef.current, pos)
      addLog(`track → placeholder swap @ ${pos.toFixed(2)}s`)
    } catch (e) { setOwner('idle'); addLog(`placeholder swap failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, ensureAnchor, flushQueued, play, setOwner, setPlaying, setCurrentTime, stopRaf])

  commandRunnerRef.current = (c) => { if (c === 'play') void play(); else void pause() }
  const togglePlay = useCallback(() => { if (ownerRef.current === 'track') void pause(); else void play() }, [pause, play])
  const remotePauseOrResume = useCallback(() => {
    // While placeholder is playing iOS still shows ||, so pause means resume
    if (sourceKindRef.current === 'anchor' || ownerRef.current === 'anchor') void play(); else void pause()
  }, [play, pause])

  const seek = useCallback((time: number) => {
    const media = mediaRef.current; if (!media) return
    const trackDur = trackDurationRef.current || media.duration || time
    const clamped = Math.max(0, Math.min(time, trackDur))
    frozenPosRef.current = clamped; setCurrentTime(clamped)
    const srcMax = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.35) : clamped
    try { media.currentTime = Math.min(clamped, srcMax) } catch { /* ignore */ }
    const v = videoRef.current; if (v?.src) try { v.currentTime = clamped } catch {}
    publishPosition(trackDur, clamped, sourceKindRef.current === 'track' ? 1 : media.playbackRate || HOLD_RATE)
    addLog(`seek ${clamped.toFixed(2)}s (source=${sourceKindRef.current})`)
  }, [setCurrentTime])
  const seekRelative = useCallback((d: number) => seek(frozenPosRef.current + d), [seek])
  void seekRelative

  const nextTrack = useCallback(() => {
    const { getNextTrackIndex } = usePlayerStore.getState()
    const n = getNextTrackIndex(); if (n !== null) { nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(n) }
  }, [setCurrentTrackIndex, setPlaying])
  const prevTrack = useCallback(() => {
    const { getPrevTrackIndex, currentTime } = usePlayerStore.getState()
    if (currentTime > 3 || frozenPosRef.current > 3) { seek(0); return }
    const p = getPrevTrackIndex(); if (p !== null) { nextGestureRef.current = true; setPlaying(usePlayerStore.getState().isPlaying || ownerRef.current==='track'); setCurrentTrackIndex(p) }
  }, [seek, setCurrentTrackIndex, setPlaying])

  // goToTrack defined after loadTrack to allow same-index fresh reload
  const markNextGesture = useCallback(() => { nextGestureRef.current = true }, [])

  const handleTrackEnd = useCallback(() => {
    const { getNextTrackIndex, repeatMode } = usePlayerStore.getState()
    addLog(`ended repeat=${repeatMode}`)
    if (repeatMode === 'one') { const m=mediaRef.current; if(m){ m.currentTime=0; frozenPosRef.current=0; setCurrentTime(0); setAudioSessionType(); m.play().catch(e=>addLog(`repeat-one failed: ${e}`)) } return }
    const n = getNextTrackIndex()
    if (n !== null) { addLog(`auto-next ${n}`); nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(n) }
    else { setPlaying(false); // freeze at end to keep session
      const m=mediaRef.current; if(m){ frozenPosRef.current=m.currentTime; setPlaying(false); if('mediaSession'in navigator) navigator.mediaSession.playbackState=getLockPlaybackState('anchor'); addLog('end -> frozen keep-alive') } }
  }, [setCurrentTrackIndex, setPlaying, setCurrentTime])

  const loadTrack = useCallback(async (idx: number) => {
    // Every tap is a fresh start — even same fileName/instanceId dupes (simplifies playlist dupes)
    frozenPosRef.current = 0
    setCurrentTime(0)
    const gen = ++loadGenRef.current
    const { queue: q } = usePlayerStore.getState()
    const track = q[idx]; if (!track) return
    const prevId = prevTrackIdRef.current
    if (prevId && prevId !== track.id) addLog(`track change ${prevId.slice(0,4)} -> ${track.id.slice(0,4)}: will reset pos to 0`)

    // If frozen placeholder active, we'll swap to track — no need to keep HOLD_RATE
    transitionRef.current = false; queuedCommandRef.current = null

    stopRaf(); cleanupVideo()
    // Don't revoke cached URL here — cache keeps it for gesture-kept next/prev
    blobUrlRef.current = null

    // Try cache first to keep gesture for next/prev — OPFS is async and loses PWA gesture
    let url = urlCacheRef.current.get(track.fileName) ?? null
    if (!url) {
      url = await getFileURLFromOPFS(track.fileName)
      if (url) urlCacheRef.current.set(track.fileName, url)
    }
    if (gen !== loadGenRef.current) { addLog(`load [${idx+1}] stale gen ${gen} abandoned`); // don't revoke cached url
      return }
    if (!url) { showError(`File not found: ${track.fileName}`); return }
    blobUrlRef.current = url
    const el = mediaRef.current; if (!el) return
    const instanceId = (track as Track & { instanceId?: string }).instanceId ?? track.id
    // Every tap is fresh — always reset time/duration even for same fileName dupes
    setCurrentTime(0); setDuration(0); trackDurationRef.current = 0
    if (prevId && prevId !== instanceId) addLog(`track change ${prevId.slice(0,4)} -> ${instanceId.slice(0,4)}: fresh load`)
    else if (prevId) addLog(`track restart ${instanceId.slice(0,4)}: fresh load`)
    prevTrackIdRef.current = instanceId

    if (track.mediaType === 'video') attachVideo(url)
    if ('mediaSession' in navigator) {
      const art = getPlayingArtwork()
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist||'Unknown Artist', album: track.album||'Unknown Album', artwork: [{ src: art, sizes:'300x300', type:'image/svg+xml' }] }) } catch {
        try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist||'Unknown Artist', album: track.album||'Unknown Album' }) } catch {}
      }
    }
    setAudioSessionType()
    const { isPlaying: wasPlaying } = usePlayerStore.getState()
    const shouldAutoplay = wasPlaying || nextGestureRef.current
    nextGestureRef.current = false
    addLog(`load [${idx+1}/${q.length}] ${track.name} autoplay=${shouldAutoplay} (wasPlaying=${wasPlaying})`)
    if (shouldAutoplay) {
      void play()
    } else {
      el.src = url; el.load()
    }
  }, [attachVideo, cleanupVideo, setCurrentTime, setDuration, stopRaf])

  // goToTrack defined after loadTrack so same-index tap forces fresh reload via useEffect
  const goToTrack = useCallback((i: number) => {
    nextGestureRef.current = true
    setPlaying(true)
    setCurrentTrackIndex(i)
    setLoadForce(v => v + 1)
  }, [setCurrentTrackIndex, setPlaying, setLoadForce])

  // Permanent element once
  useEffect(() => {
    const media = document.createElement('audio')
    media.preload = 'auto'; media.controls = true; media.setAttribute('playsinline','true'); media.setAttribute('webkit-playsinline','true'); media.setAttribute('x-webkit-airplay','allow'); (media as unknown as { dataset: Record<string,string> }).dataset.sessionOwner='permanent'
    hideOffscreen(media); document.body.appendChild(media); mediaRef.current = media
    const nav = navigator as Navigator & { standalone?: boolean }
    const standalone = (nav as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches
    addLog(`environment: ${standalone ? 'home-screen standalone PWA' : 'browser tab'}; permanent element ready`)

    const onLoadedMetadata = () => {
      if (sourceKindRef.current === 'anchor') return
      const d = media.duration; if (!Number.isFinite(d) || d<=0) return
      trackDurationRef.current = d; setDuration(d); publishPosition(d, media.currentTime, 1)
      ensureAnchor(d)
    }
    const onPlaying = () => {
      const k = sourceKindRef.current
      if (k==='track') {
        setOwner(k); setPlaying(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
        // Ensure video reflects playing track (fix: video stuck paused after lock resume)
        const v = videoRef.current
        const isVideoTrack = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
        if (isVideoTrack && v && v.src && v.paused) { v.muted = true; v.play().catch(() => {}) }
      } else {
        setOwner(k); setPlaying(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
        publishPosition(trackDurationRef.current || media.duration, frozenPosRef.current, HOLD_RATE)
        // Anchor must keep video paused (fix: video kept playing after 2nd lock pause)
        const v = videoRef.current; if (v && !v.paused) try { v.pause() } catch {}
      }
      addLog(`native playing (${k}, same element)`)
    }
    const onPause = () => {
      if (transitionRef.current) { addLog(`native pause ignored during transition (${sourceKindRef.current})`); return }
      // Only treat pause as real pause when track was playing; anchor pause is expected to be playing silent
      if (sourceKindRef.current==='track' && ownerRef.current==='track') { setPlaying(false); try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor') } catch {} }
      addLog(`native pause (${sourceKindRef.current})`)
    }
    const onTimeUpdate = () => {
      if (sourceKindRef.current==='track') { if (!transitionRef.current) frozenPosRef.current = media.currentTime; setCurrentTime(media.currentTime); publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1); return }
      // Best effort: frozen track pos is authoritative even if anchor bar drifts — threshold 0.35 avoids PC constant rewind loop
      const frozen = frozenPosRef.current
      if (media.currentTime - frozen >= 0.35) { try { media.currentTime = Math.min(frozen, Math.max(0, media.duration - 0.35)) } catch {} }
      publishPosition(trackDurationRef.current || media.duration, frozen, media.playbackRate || HOLD_RATE)
      // Keep video paused while anchor (guard against iOS resuming video on visibility)
      const v = videoRef.current; if (v && !v.paused) try { v.pause() } catch {}
    }
    const onEnded = () => {
      if (sourceKindRef.current==='anchor') { const safe=Math.max(0, Math.min(frozenPosRef.current, media.duration-0.35)); media.currentTime=safe; media.play().catch(e=>addLog(`placeholder restart failed: ${e}`)); return }
      handleTrackEnd()
    }
    const onError = () => addLog(`permanent media error: code ${media.error?.code} ${media.error?.message||''}`)
    media.addEventListener('loadedmetadata', onLoadedMetadata); media.addEventListener('durationchange', onLoadedMetadata)
    media.addEventListener('playing', onPlaying); media.addEventListener('pause', onPause)
    media.addEventListener('timeupdate', onTimeUpdate); media.addEventListener('ended', onEnded); media.addEventListener('error', onError)
    setAudioSessionType(); addLog('permanent audio element ready (same-element handoff)')
    return () => {
      stopRaf(); transitionTokenRef.current+=1; media.pause(); media.removeAttribute('src'); media.load(); media.remove(); mediaRef.current=null
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current); if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [ensureAnchor, handleTrackEnd, setDuration, setPlaying, setCurrentTime, startVideoFrames, stopRaf])

  useEffect(() => { const t=queue[currentTrackIndex]; if(!t) return; if (t.mediaType==='video') attachVideo(blobUrlRef.current||''); else detachVideo() }, [currentTrackIndex, queue])

  useEffect(() => {
    const onVis = () => {
      addLog(`visibility -> ${document.visibilityState} owner=${ownerRef.current} kind=${sourceKindRef.current} pending=${pendingAnchorPosRef.current} lock=${getLockPlaybackState(sourceKindRef.current as 'track'|'anchor')}`)
      if (document.visibilityState==='hidden') {
        stopRaf();
        // Pending in-app pause: do real anchor swap while hidden (hidden-created anchor shows > correctly)
        if (pendingAnchorPosRef.current !== null) {
          const pos = pendingAnchorPosRef.current
          pendingAnchorPosRef.current = null
          addLog(`hidden deferred anchor swap @ ${pos.toFixed(2)}`)
          const vPend = videoRef.current; if (vPend) try { vPend.pause(); vPend.currentTime = pos } catch {}
          void (async () => {
            transitionRef.current = true
            try {
              ensureAnchor(trackDurationRef.current || mediaRef.current?.duration || 2)
              await activateSource('anchor', anchorUrlRef.current, pos)
              addLog(`deferred track → placeholder swap @ ${pos.toFixed(2)}s (hidden)`)
            } catch (e) { setOwner('idle'); addLog(`deferred swap failed: ${e}`) }
            finally { transitionRef.current = false; flushQueued() }
          })()
          return
        }
        const vHidden = videoRef.current
        if (vHidden) try { vHidden.pause() } catch {}
        const kindHidden = sourceKindRef.current as 'track'|'anchor'
        if (kindHidden === 'anchor') {
          const dur = trackDurationRef.current || 0
          const pos = frozenPosRef.current
          try {
            publishPosition(dur, pos, HOLD_RATE)
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
          } catch {}
          addLog(`hidden anchor refresh paused pos=${pos.toFixed(2)} HOLD_RATE`)
          if (vHidden && vHidden.src) try { vHidden.currentTime = pos } catch {}
          // Keep silent anchor playing at HOLD_RATE to keep session (truly paused kills after 30s)
          const mediaHidden = mediaRef.current
          if (mediaHidden && mediaHidden.paused) {
            try { setRate(mediaHidden, HOLD_RATE); mediaHidden.play().then(() => addLog(`hidden anchor resume HOLD_RATE`)).catch(() => {}) } catch {}
          }
        } else {
          const dur = mediaRef.current?.duration || trackDurationRef.current || 0
          const pos = mediaRef.current?.currentTime || 0
          try {
            publishPosition(dur, pos, 1)
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
          } catch {}
          addLog(`hidden track refresh playing pos=${pos.toFixed(2)}`)
          // Keep video paused while hidden (audio continues), will seek on visible
          if (vHidden && !vHidden.paused) try { vHidden.pause() } catch {}
        }
        return
      }
      setAudioSessionType()
      const m=mediaRef.current; const v=videoRef.current
      const isVideo = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
      if (pendingAnchorPosRef.current !== null) {
        addLog(`visible cancel deferred anchor, stay track @ ${m?.currentTime.toFixed(2)}`)
        pendingAnchorPosRef.current = null
        setPlaying(true)
        publishPosition(m?.duration || trackDurationRef.current || 0, m?.currentTime || 0, 1)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing' } catch {}
        if (isVideo && v && v.src) { try { v.currentTime = m?.currentTime || 0 } catch {}; v.muted = true; v.play().catch(() => {}) }
        return
      }
      // Anchor must stay paused (fix 2nd lock pause video drift)
      if (sourceKindRef.current === 'anchor' || ownerRef.current === 'anchor') {
        if (v && !v.paused) try { v.pause() } catch {}
        if (v && v.src) try { v.currentTime = frozenPosRef.current } catch {}
        publishPosition(trackDurationRef.current || (m?.duration ?? 0), frozenPosRef.current, HOLD_RATE)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor') } catch {}
        return
      }
      if (ownerRef.current==='track' && m && !m.paused) {
        // App switcher: video paused while hidden, audio continued — seek video to audio on return (fix ahead)
        if (isVideo && v && v.src) {
          const drift = Math.abs(v.currentTime - m.currentTime)
          if (drift > 0.15) {
            try { v.currentTime = m.currentTime; addLog(`visible video seek to audio ${m.currentTime.toFixed(2)} drift ${drift.toFixed(2)}`) } catch {}
          }
          if (v.paused) { v.muted = true; v.play().catch(() => addLog('visible video fallback disabled')) }
        } else if (!isVideo) startVideoFrames()
        publishPosition(m.duration || trackDurationRef.current, m.currentTime, 1)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track') } catch {}
        addLog(`visible track playing seek synced`)
      }
    }
    const onPageShow = (e: PageTransitionEvent) => { setAudioSessionType(); addLog(`pageshow${(e as unknown as { persisted?: boolean }).persisted?' (bfcache)':''}`) }
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pageshow', onPageShow as EventListener)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pageshow', onPageShow as EventListener) }
  }, [startVideoFrames, stopRaf])

  useEffect(() => { if (currentTrack && queue.length>0) { void loadTrack(currentTrackIndex); setLoadForce(0) } }, [currentTrackIndex, loadForce])
  useEffect(() => { if (mediaRef.current) mediaRef.current.volume = isMuted ? 0 : volume }, [volume, isMuted])
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  return { play, pause, remotePauseOrResume, togglePlay, seek, seekRelative: (d:number)=>seek(frozenPosRef.current+d), nextTrack, prevTrack, goToTrack, markNextGesture, videoContainerRef }
}
