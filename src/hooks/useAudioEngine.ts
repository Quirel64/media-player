import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'

/*
  PLAN 1 — Single-element freeze (no anchor handoff).

  On pause we keep the SAME <audio> playing at volume 0.001 and playbackRate 0.0001,
  pinned at frozenPos via timeupdate+rAF. iOS sees "still playing" (0.001 not muted)
  so it keeps the lock-screen session alive >30s without a second silent file.
  On play we restore volume/rate and let time advance. No handoff = no race.
*/

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
  const pos = Math.min(Math.max(0, position), duration)
  try { navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos }) } catch {
    if (playbackRate === 0) { try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: pos }) } catch { /* ignore */ } }
  }
}

export function useAudioEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)

  const rafVideoRef = useRef(0)
  const rafPinRef = useRef(0)

  const frozenPosRef = useRef(0)
  const frozenDurRef = useRef(0)
  const isFrozenRef = useRef(false)
  const lastVolumeRef = useRef(1)

  const pendingPlayRef = useRef(false)
  const prevTrackIdRef = useRef<string | null>(null)
  const loadGenRef = useRef(0)
  const lastSeekNextRef = useRef(0)

  const { currentTrackIndex, queue, volume, isMuted, setPlaying, setCurrentTime, setDuration, setCurrentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  const stopVideoRaf = useCallback(() => { if (rafVideoRef.current) { cancelAnimationFrame(rafVideoRef.current); rafVideoRef.current = 0 } }, [])
  const stopPinRaf = useCallback(() => { if (rafPinRef.current) { cancelAnimationFrame(rafPinRef.current); rafPinRef.current = 0 } }, [])

  const pinFrozen = useCallback(() => {
    const el = mediaRef.current
    if (!el || !isFrozenRef.current) return
    const target = frozenPosRef.current
    // Always re-assert frozen position — 0.0001 rate still crawls and web may ignore rate, so force every frame
    try { if (Math.abs(el.currentTime - target) > 0.01) el.currentTime = target } catch { /* ignore */ }
    // Also freeze the fake video element (NowPlaying) — matches test app
    const v = videoRef.current
    if (v && v.src) { try { if (Math.abs(v.currentTime - target) > 0.12) v.currentTime = target } catch { /* ignore */ } }
    if (Number.isFinite(frozenDurRef.current) && frozenDurRef.current > 0) {
      try { navigator.mediaSession.setPositionState({ duration: frozenDurRef.current, playbackRate: 1, position: Math.min(target, frozenDurRef.current) }) } catch { /* ignore */ }
    }
  }, [])

  const startVideoSync = useCallback(() => {
    stopVideoRaf()
    const tick = () => {
      const a = mediaRef.current, v = videoRef.current
      if (a && v && !isFrozenRef.current && !a.paused) {
        if (Math.abs(v.currentTime - a.currentTime) > 0.12) { try { v.currentTime = a.currentTime } catch { /* ignore */ } }
      }
      if (mediaRef.current && !isFrozenRef.current && !mediaRef.current.paused) rafVideoRef.current = requestAnimationFrame(tick)
    }
    rafVideoRef.current = requestAnimationFrame(tick)
  }, [stopVideoRaf])

  const cleanupVideo = useCallback(() => { if (videoRef.current) { const v=videoRef.current; v.pause(); v.removeAttribute('src'); v.load(); if(v.parentNode) v.parentNode.removeChild(v); videoRef.current=null; } }, [])
  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current
    let v = videoRef.current
    if (!v) {
      v = document.createElement('video')
      v.muted = true; v.playsInline = true; v.setAttribute('webkit-playsinline','true'); v.setAttribute('playsinline','true')
      v.preload='auto'; v.controls=false
      Object.assign(v.style, { width:'100%', height:'100%', objectFit:'contain', borderRadius:'12px', touchAction:'manipulation', background:'#000' })
      videoRef.current = v
    }
    if (container && v.parentNode !== container) { container.innerHTML=''; container.appendChild(v) }
    if (v.src !== url) { v.src = url; v.load() }
    v.pause()
  }, [])

  // --- transport ---
  const play = useCallback(async () => {
    const el = mediaRef.current
    if (!el || !el.src) { addLog('play aborted: no src'); return }

    const isNewTrack = currentTrack?.id !== prevTrackIdRef.current
    if (isFrozenRef.current) {
      // Resume from frozen pause — same track
      if (!isNewTrack) {
        try { el.currentTime = frozenPosRef.current } catch {}
        setCurrentTime(frozenPosRef.current)
        logFreeze(`unfreeze -> play from ${frozenPosRef.current.toFixed(1)}s`)
      } else {
        // Frozen but track changed (next via seek) — start 0
        try { el.currentTime = 0 } catch {}
        frozenPosRef.current = 0
        setCurrentTime(0)
        addLog(`auto-next frozen new track -> start 0`)
      }
      try { el.volume = lastVolumeRef.current } catch {}
      try { el.playbackRate = 1 } catch {}
      isFrozenRef.current = false
      stopPinRaf()
    } else if (isNewTrack && !pendingPlayRef.current) {
      try { if (el.currentTime !== 0) el.currentTime = 0 } catch {}
      setCurrentTime(0)
    } else if (pendingPlayRef.current && isNewTrack) {
      // Auto-next via pendingPlay — ensure 0
      try { el.currentTime = 0 } catch {}
      frozenPosRef.current = 0
      setCurrentTime(0)
      addLog(`auto-next pendingPlay new track -> start 0`)
    }

    setAudioSessionType()
    if (el.readyState < 2) { pendingPlayRef.current = true; el.load(); addLog('play deferred: readyState <2'); return }

    try { await el.play() } catch (e) {
      addLog(`play failed: ${String(e)}`); await new Promise(r=>setTimeout(r,120))
      try { setAudioSessionType(); await el.play() } catch (e2) { addLog(`retry failed: ${String(e2)}`); setPlaying(false); if (String(e).includes('NotAllowedError')) showError(`Play blocked: ${String(e2).slice(0,80)} — tap again`); return }
    }
    if (videoRef.current?.src) { try{ videoRef.current.currentTime = el.currentTime; videoRef.current.play().catch(()=>{}) }catch{}; startVideoSync() }
    setIsPlayingWrap(true)
    if ('mediaSession' in navigator) { navigator.mediaSession.playbackState='playing'; publishPosition(el.duration, el.currentTime, 1) }
    addLog(`play ok @ ${el.currentTime.toFixed(1)}s vol=${el.volume}`)
  }, [currentTrack, startVideoSync])

  // helper to avoid stale closure on setPlaying
  const setIsPlayingWrap = (v: boolean) => setPlaying(v)
  const logFreeze = (msg: string) => addLog(msg)

  const pause = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    // Save once — frozenPos is the single source of truth for pause position
    frozenPosRef.current = el.currentTime
    frozenDurRef.current = Number.isFinite(el.duration) && el.duration>0 ? el.duration : 2
    lastVolumeRef.current = isMuted ? 0 : volume
    addLog(`freeze @ ${frozenPosRef.current.toFixed(1)}s / ${frozenDurRef.current.toFixed(1)}s — keep playing at 0.001 vol`)

    // Don't pause — keep playing inaudibly and pin time
    try { el.volume = 0.001 } catch {}
    try { el.playbackRate = 0.0001 } catch { try{ el.playbackRate=0.0625 }catch{} }
    isFrozenRef.current = true
    setPlaying(false)
    setCurrentTime(frozenPosRef.current)
    addLog(`freeze setCurrentTime store=${frozenPosRef.current.toFixed(1)} el=${el.currentTime.toFixed(1)}`)
    if ('mediaSession' in navigator) { navigator.mediaSession.playbackState='paused'; publishPosition(frozenDurRef.current, frozenPosRef.current, 0) }

    stopPinRaf()
    const pin = () => {
      const a = mediaRef.current
      if (!a || !isFrozenRef.current || a.paused) return
      pinFrozen()
      rafPinRef.current = requestAnimationFrame(pin)
    }
    rafPinRef.current = requestAnimationFrame(pin)
    videoRef.current?.pause(); stopVideoRaf()
    if (el.paused) { setAudioSessionType(); el.play().catch(e=>addLog(`freeze play failed: ${String(e)}`)) }
  }, [volume, isMuted, setPlaying, setCurrentTime, pinFrozen, stopVideoRaf, stopPinRaf])

  const togglePlay = useCallback(() => {
    const el = mediaRef.current; if(!el) return
    if (isFrozenRef.current) { void play(); return }
    if (el.paused) void play(); else pause()
  }, [play, pause])

  const remotePauseOrResume = useCallback(() => {
    const el = mediaRef.current; if(!el) return
    addLog(`remote pause/resume: frozen=${isFrozenRef.current} paused=${el.paused}`)
    if (isFrozenRef.current) { void play(); return }
    pause()
  }, [play, pause])

  const seek = useCallback((t: number) => {
    const el = mediaRef.current; if(!el) return
    const max = Number.isFinite(el.duration)? el.duration : t
    const clamped = Math.max(0, Math.min(t, max))
    const isNearEnd = Number.isFinite(el.duration) && el.duration>0 && clamped >= el.duration - 0.4
    const { isPlaying: wasPlaying } = usePlayerStore.getState()
    if (isNearEnd && wasPlaying && !isFrozenRef.current) {
      const now = Date.now()
      if (pendingPlayRef.current || now - lastSeekNextRef.current < 500) { addLog(`seek near end ignored (debounce)`); return }
      const { getNextTrackIndex } = usePlayerStore.getState()
      const n = getNextTrackIndex()
      if (n !== null) { lastSeekNextRef.current = now; addLog(`seek near end ${clamped.toFixed(1)}/${el.duration.toFixed(1)} -> auto-next ${n} (gesture)`); el.currentTime = clamped; frozenPosRef.current = clamped; setCurrentTime(clamped); setCurrentTrackIndex(n); return }
    }
    if (isFrozenRef.current) {
      frozenPosRef.current = clamped
      try{ el.currentTime = clamped }catch{}
      if (videoRef.current) try{ videoRef.current.currentTime=clamped }catch{}
      setCurrentTime(clamped)
      if (Number.isFinite(frozenDurRef.current) && frozenDurRef.current>0) { try{ navigator.mediaSession.setPositionState({ duration: frozenDurRef.current, playbackRate:1, position:clamped }) }catch{} }
    } else {
      el.currentTime = clamped; if(videoRef.current) try{ videoRef.current.currentTime=clamped }catch{}; setCurrentTime(clamped); publishPosition(el.duration, clamped, 1)
    }
  }, [setCurrentTime, setCurrentTrackIndex])

  const nextTrack = useCallback(() => { const { getNextTrackIndex } = usePlayerStore.getState(); const n=getNextTrackIndex(); if(n!==null) setCurrentTrackIndex(n) }, [setCurrentTrackIndex])
  const prevTrack = useCallback(() => { const { currentTime, getPrevTrackIndex } = usePlayerStore.getState(); if(currentTime>3){ seek(0); return } const p=getPrevTrackIndex(); if(p!==null) setCurrentTrackIndex(p) }, [setCurrentTrackIndex, seek])
  const goToTrack = useCallback((i:number)=> setCurrentTrackIndex(i), [setCurrentTrackIndex])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, getNextTrackIndex } = usePlayerStore.getState()
    addLog(`ended repeat=${repeatMode}`)
    if (repeatMode==='one') { const el=mediaRef.current; if(el){ el.currentTime=0; setAudioSessionType(); el.play().catch(e=>addLog(`repeat-one failed: ${String(e)}`)) } return }
    const n=getNextTrackIndex()
    if (n!==null){
      addLog(`auto-next ${n}`)
      // Ensure next load sees autoplay=true even though onPause will set isPlaying=false after ended
      setPlaying(true)
      setCurrentTrackIndex(n)
    }
    else {
      // End of queue — freeze at end to keep session (like pause)
      const el=mediaRef.current
      if(el){ frozenPosRef.current=el.currentTime; frozenDurRef.current=el.duration; isFrozenRef.current=true; try{ el.volume=0.001; el.playbackRate=0.0001 }catch{}; setPlaying(false); if('mediaSession' in navigator) navigator.mediaSession.playbackState='paused'; addLog('end -> frozen keep-alive') }
    }
  }, [setCurrentTrackIndex, setPlaying])

  const loadTrack = useCallback(async (idx:number)=>{
    const gen = ++loadGenRef.current
    const { queue: q, isPlaying: wasPlaying } = usePlayerStore.getState()
    const track = q[idx]; if(!track) return
    const prevId = prevTrackIdRef.current
    if (prevId && prevId !== track.id) addLog(`track change ${prevId.slice(0,4)} -> ${track.id.slice(0,4)}: will reset pos to 0`)

    // If we were frozen, unfreeze before loading next track — new track starts fresh
    if (isFrozenRef.current) {
      isFrozenRef.current = false; stopPinRaf()
      const el=mediaRef.current
      if (el) { try{ el.volume = isMuted?0:volume }catch{}; try{ el.playbackRate=1 }catch{} }
    }
    frozenPosRef.current = 0
    stopVideoRaf(); cleanupVideo()
    if (blobUrlRef.current){ URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current=null }

    const url = await getFileURLFromOPFS(track.fileName)
    if (gen !== loadGenRef.current) { addLog(`load [${idx+1}] stale gen ${gen} vs ${loadGenRef.current} abandoned`); if(url) URL.revokeObjectURL(url); return }
    if (!url){ showError(`File not found: ${track.fileName}`); return }
    blobUrlRef.current = url

    const el=mediaRef.current; if(!el) return
    setCurrentTime(0); setDuration(0)
    pendingPlayRef.current = wasPlaying
    prevTrackIdRef.current = track.id
    if (gen !== loadGenRef.current) { addLog(`load stale after OPFS gen ${gen} abandoned`); URL.revokeObjectURL(url); blobUrlRef.current=null; return }
    el.src = url; el.load()
    // Ensure audible volume for new track (unless muted)
    try{ el.volume = isMuted?0:volume }catch{}; try{ el.playbackRate=1 }catch{}

    if (track.mediaType==='video') attachVideo(url)

    // Let useMediaSession handle artwork based on isPlaying — don't clobber with wasPlaying
    // This matches test app single-element and avoids app-icon flash
    if ('mediaSession' in navigator) {
      try{ navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist||'Unknown Artist', album: track.album||'Unknown Album' }) }catch{ /* ignore */ }
    }
    setAudioSessionType()
    addLog(`load [${idx+1}/${q.length}] ${track.name} autoplay=${wasPlaying}`)
  }, [attachVideo, cleanupVideo, setCurrentTime, setDuration, stopVideoRaf, stopPinRaf, isMuted, volume])

  // One-time element creation
  useEffect(()=>{
    const audio=document.createElement('audio')
    audio.preload='auto'; audio.controls=false; audio.setAttribute('playsinline','true'); audio.setAttribute('webkit-playsinline','true'); audio.setAttribute('x-webkit-airplay','allow')
    hideOffscreen(audio); document.body.appendChild(audio); mediaRef.current=audio

    const onTime=()=>{
      if(mediaRef.current!==audio) return
      if(isFrozenRef.current){ pinFrozen(); return }
      setCurrentTime(audio.currentTime); publishPosition(audio.duration, audio.currentTime, 1)
    }
    const onMeta=()=>{
      if(mediaRef.current!==audio) return
      const d=audio.duration
      if(Number.isFinite(d) && d>0){ setDuration(d); frozenDurRef.current=d; publishPosition(d, audio.currentTime, isFrozenRef.current?0:1) }
    }
    const onPlay=()=>{
      if(mediaRef.current!==audio) return
      if(isFrozenRef.current) return
      setPlaying(true); publishPosition(audio.duration, audio.currentTime, 1)
      if('mediaSession' in navigator) navigator.mediaSession.playbackState='playing'
      if(videoRef.current?.src){ try{ videoRef.current.currentTime=audio.currentTime; videoRef.current.play().catch(()=>{}) }catch{}; startVideoSync() }
    }
    const onPause=()=>{
      if(mediaRef.current!==audio) return
      if(isFrozenRef.current) return
      if(document.visibilityState==='visible' || audio.ended){ setPlaying(false); if('mediaSession' in navigator){ navigator.mediaSession.playbackState='paused'; publishPosition(audio.duration, audio.currentTime, 0) } stopVideoRaf() }
    }
    const onEnded=()=>{ if(mediaRef.current===audio && !isFrozenRef.current) handleTrackEnd() }
    const onError=()=>{
      if(mediaRef.current!==audio) return
      const t=usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]
      showError(`Audio error: ${t?.name||'unknown'}`); setPlaying(false)
    }
    const onCanPlay=()=>{ if(mediaRef.current===audio && pendingPlayRef.current){ addLog('canplay -> play'); play() } }
    // timeupdate is background-safe pin for frozen state (rAF stops on lock)
    const onFrozenTime=()=>{ if(isFrozenRef.current) pinFrozen() }

    audio.addEventListener('timeupdate',onTime)
    audio.addEventListener('loadedmetadata',onMeta)
    audio.addEventListener('durationchange',onMeta)
    audio.addEventListener('play',onPlay)
    audio.addEventListener('pause',onPause)
    audio.addEventListener('ended',onEnded)
    audio.addEventListener('error',onError)
    audio.addEventListener('canplay',onCanPlay)
    audio.addEventListener('timeupdate',onFrozenTime)
    audio.addEventListener('seeked',()=>{ if(mediaRef.current===audio && !isFrozenRef.current) publishPosition(audio.duration, audio.currentTime, 1) })

    setAudioSessionType()
    return ()=>{
      audio.removeEventListener('timeupdate',onTime); audio.removeEventListener('loadedmetadata',onMeta); audio.removeEventListener('durationchange',onMeta)
      audio.removeEventListener('play',onPlay); audio.removeEventListener('pause',onPause); audio.removeEventListener('ended',onEnded); audio.removeEventListener('error',onError); audio.removeEventListener('canplay',onCanPlay); audio.removeEventListener('timeupdate',onFrozenTime)
      stopVideoRaf(); stopPinRaf()
      audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove()
      if(blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
      mediaRef.current=null
    }
  }, [handleTrackEnd, pinFrozen, startVideoSync, play, stopVideoRaf, stopPinRaf, setDuration, setPlaying, setCurrentTime])

  useEffect(()=>{ if(currentTrack && queue.length>0) void loadTrack(currentTrackIndex) }, [currentTrackIndex, currentTrack?.id])
  useEffect(()=>{ if(mediaRef.current) mediaRef.current.volume = isFrozenRef.current ? 0.001 : (isMuted?0:volume) }, [volume, isMuted])
  useEffect(()=>{ return()=>{ if(blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) } }, [])
  useEffect(()=>{
    const onVis=()=>{
      if(document.visibilityState==='visible'){
        const el=mediaRef.current
        if(isFrozenRef.current && el && el.paused){ setAudioSessionType(); el.play().catch(()=>{}) }
        else if(!isFrozenRef.current && el && usePlayerStore.getState().isPlaying && el.paused && !el.ended){ setAudioSessionType(); void play() }
        if(!isFrozenRef.current && el && videoRef.current?.src && !el.paused){ try{ videoRef.current.currentTime=el.currentTime; videoRef.current.play().catch(()=>{}) }catch{}; startVideoSync() }
      } else { videoRef.current?.pause(); stopVideoRaf() }
    }
    document.addEventListener('visibilitychange',onVis); return()=>document.removeEventListener('visibilitychange',onVis)
  }, [play, startVideoSync, stopVideoRaf])

  return { play, pause, remotePauseOrResume, togglePlay, seek, nextTrack, prevTrack, goToTrack, videoContainerRef }
}
