import { addLog } from './logger'

/*
  Runtime experiment flags, localStorage-backed, toggled from the EventLog.
  Read AT CALL TIME (not module load) so an EventLog toggle takes effect
  immediately without re-applying handlers or reloading the app.
*/

const VIDEO_PAUSED_KEY = 'video-paused-mode'
const RESILIENT_KEY = 'lock-resilient-toggle'
const DELAYED_START_KEY = 'video-delayed-start'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const v = localStorage.getItem(key)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* ignore */ }
  return fallback
}

function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* ignore */ }
}

// Experiment 1: when ON, the muted <video> never plays for video tracks — it
// stays paused and seek-framed (the pre-dual-play design). Tests whether a
// PLAYING video timeline is what cripples the lock-screen session on iOS 27.2
// (lock seek/±10 dead only on video-first tracks). Default OFF.
export function isVideoPausedMode(): boolean {
  return readFlag(VIDEO_PAUSED_KEY, false)
}

export function setVideoPausedMode(on: boolean): void {
  writeFlag(VIDEO_PAUSED_KEY, on)
  addLog(`flag video-paused-mode → ${on ? 'ON' : 'OFF'} (takes effect on next video track load or seek)`)
}

// Experiment 2: the iOS 26.2 inverted-icon workaround. ON (default): lock-screen
// center presses route through the engine-aware remotePauseOrResume and pause()
// auto-resumes while anchor/pending. OFF: presses are literal (play→play,
// pause→pause, extra pauses ignored) — tests whether resuming against an
// interruption is what causes the pause/resume ping-pong + AbortError. Default ON.
export function isLockResilientToggle(): boolean {
  return readFlag(RESILIENT_KEY, true)
}

export function setLockResilientToggle(on: boolean): void {
  writeFlag(RESILIENT_KEY, on)
  addLog(`flag lock-resilient-toggle → ${on ? 'ON' : 'OFF'} (center presses: ${on ? 'engine-aware toggle' : 'literal play/pause'})`)
}

// Experiment 4: in-app video recovery. The lock wedge is born at session
// ESTABLISHMENT when the muted video is playing alongside (established-paused
// sessions stay healable by the mode-flip revive; established-dual-playing
// ones don't, and the seek bar specifically can't be rebound). When ON, the
// video is framed but stays paused for the first ~12s of a track so the
// session establishes on audio alone, then starts playing in-app. Never
// starts on a lock screen. Default OFF.
export function isVideoDelayedStart(): boolean {
  return readFlag(DELAYED_START_KEY, false)
}

export function setVideoDelayedStart(on: boolean): void {
  writeFlag(DELAYED_START_KEY, on)
  addLog(`flag video-delayed-start → ${on ? 'ON' : 'OFF'} (video starts playing 12s after track start; needs Video paused OFF)`)
}
// Experiment 3 (v2): iOS builds the lock-screen UI from the registered handler
// set AT LOCK TIME. Re-applying the SAME set is proven inert (greyed runs and
// working runs emit identical re-applies), but a CONFIGURATION change rebuilds
// it: so when ON, the handlers flip to the other lock mode then restore
// (useMediaSession.reviveHandlers) the instant visibility goes hidden. Default OFF.
const REVIVE_KEY = 'lock-revive-on-hidden'
export function isLockReviveOnHidden(): boolean {
  return readFlag(REVIVE_KEY, false)
}

export function setLockReviveOnHidden(on: boolean): void {
  writeFlag(REVIVE_KEY, on)
  addLog(`flag lock-revive-on-hidden → ${on ? 'ON' : 'OFF'} (handlers re-applied right before lock builds the UI)`)
}
