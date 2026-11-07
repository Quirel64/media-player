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

// Experiment 1 → now DEFAULT: when ON, the muted <video> never plays — it
// stays paused and seek-framed. PROVEN on iOS 27.2: v.play() of the mask is
// THE poisoned-lock event (locks before a delayed start were healthy 10/10;
// after the video played, every lock wedged, flip-proof). Recovery from
// unlock↔lock needs the mode-flip revive (Experiment 3). In-app cost: video
// is a still frame with one drift-snap on return. Turn OFF (or use
// video-delayed-start) to trade lock safety for in-app motion.
export function isVideoPausedMode(): boolean {
  return readFlag(VIDEO_PAUSED_KEY, true)
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
// Experiment 3 (v2) → now DEFAULT: iOS builds the lock-screen UI from the
// registered handler set AT LOCK TIME. Same-set re-applies are proven inert
// (greyed and working runs emit identical re-applies) and no-flip sessions
// heal only randomly — a CONFIGURATION change rebuilds it deterministically:
// the handlers flip to the other lock mode then restore
// (useMediaSession.reviveHandlers) the instant visibility goes hidden.
const REVIVE_KEY = 'lock-revive-on-hidden'
export function isLockReviveOnHidden(): boolean {
  return readFlag(REVIVE_KEY, true)
}

export function setLockReviveOnHidden(on: boolean): void {
  writeFlag(REVIVE_KEY, on)
  addLog(`flag lock-revive-on-hidden → ${on ? 'ON' : 'OFF'} (handlers re-applied right before lock builds the UI)`)
}

// Tunable gap between the flip and the restore inside reviveHandlers. iOS
// needs both sets to land; if greyed controls ever slip through, try longer.
const REVIVE_DELAY_KEY = 'lock-revive-delay'
export function getLockReviveDelay(): number {
  try {
    const v = localStorage.getItem(REVIVE_DELAY_KEY)
    const n = v ? parseInt(v, 10) : NaN
    if (Number.isFinite(n) && n >= 0) return n
  } catch { /* ignore */ }
  return 300
}

export function setLockReviveDelay(ms: number): void {
  try { localStorage.setItem(REVIVE_DELAY_KEY, String(ms)) } catch { /* ignore */ }
  addLog(`flag lock-revive-delay → ${ms}ms (takes effect on next hidden)`)
}

// Experiment 5: handler-application hygiene. Current registrations happen at
// boot, every track change, the play-start edge, mode toggles, and the hidden
// flip. The snapshot model (lock UI read at lock time) makes the per-track
// re-apply a candidate: when ON, identical mode re-applies and their null-set
// cleanups are skipped; boot/mode-toggle/play-start/flip still apply. Default OFF.
const MINIMAL_KEY = 'minimal-handlers'
export function isMinimalHandlers(): boolean {
  return readFlag(MINIMAL_KEY, false)
}

export function setMinimalHandlers(on: boolean): void {
  writeFlag(MINIMAL_KEY, on)
  addLog(`flag minimal-handlers → ${on ? 'ON' : 'OFF'} (skip same-set re-applies at track change; boot/mode-toggle/play-start/flip still apply)`)
}
