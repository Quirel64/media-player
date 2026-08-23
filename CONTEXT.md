# Media Player PWA - Project Status & Context

## Project Overview
A PWA media player web app that plays audio and video files, built with React + TypeScript + Vite + Tailwind CSS + Zustand. Hosted on GitHub Pages at `https://quirel64.github.io/media-player/`.

**User has iOS devices + Windows laptop only** — no Mac, no Apple Developer account. This is why PWA was chosen over Tauri.

## Architecture
- **Storage**: OPFS for file blobs, IndexedDB for metadata (tracks, playlists, settings)
- **Audio engine**: Single `<audio>` element as source of truth for ALL files (audio and video). No Web Audio API. No hidden `<video>` for audio files. Persistent element created once on mount, only `src` changes per track.
- **Video display**: For video files, a `<video>` element is created but kept **paused** and seek-framed via `requestAnimationFrame` to show the correct video frame. Only `<audio>` actually plays → single instance, no dual-player issues.
- **iOS session keeping**: Silent audio anchor (volume=0.001, never paused) loops continuously to keep iOS audio session alive. `setPositionState()` always set to TRACK position (not anchor position) so seek bar shows correct time. Artwork switches between music note (playing) and pause icon (paused).
- **State**: Zustand store (`playerStore.ts`)
- **Shuffle**: Fisher-Yates with no-repeat cycling
- **Media Session API**: Lock screen controls, metadata, seek bar
- **PWA**: vite-plugin-pwa, service worker, GitHub Actions deploy

## iOS-Specific Behavior (CRITICAL - Read this first)

### What works
- **Lock screen interface**: ±10s skip buttons + working seek bar — achieved with `<audio>` element only (no hidden `<video>` needed)
- **Background playback**: `<audio>` element plays in background on iOS lock screen
- **Next track auto-advance**: Works when track finishes (even with screen off in PWA)
- **Shuffle/Repeat**: Work correctly
- **Seek bar drag**: Works on both mobile and desktop
- **Play button sync**: App play button stays in sync with iOS native controls
- **Track selection + delete**: Works on mobile
- **Lock screen persists across restarts**: Force-close → reopen → play → lock screen still shows correct interface

### Key Breakthrough: Single Playing Element
**Previous approach (broken)**: Both `<audio>` and `<video>` played simultaneously → dual-instance, pause conflicts, iOS confusion about session type.

**Current approach (working)**: Only `<audio>` plays. `<video>` stays paused and is seek-framed via `requestAnimationFrame` for visual display. One playing element = no conflicts.

This was validated by a standalone test app (`custom-lock-screen-media-player`) that proved `<audio>` alone gives the correct lock screen interface with working seek bar.

### Lock Screen Button Modes
iOS lock screen buttons are determined by which MediaSession action handlers are registered:

| Mode | Handlers | Lock Screen UI |
|------|----------|----------------|
| `skip10` | `seekbackward`/`seekforward`/`seekto` | ±10s round arrows + working seek bar |
| `prevnext` | `previoustrack`/`nexttrack` | << >> chevrons + seek bar (user confirmed seek bar still works!) |
| `both` | All four handlers | **BUGGY** — inconsistent behavior between iOS versions |

**Our current config**: `skip10` mode (only `seekbackward`/`seekforward`/`seekto`). User confirmed seek bar works with both modes, disproving earlier theory that `prevnext` breaks the seek bar.

**Known issue**: Registering both `seekbackward`/`seekforward` AND `previoustrack`/`nexttrack` simultaneously causes inconsistent behavior. The test app explicitly warns: "This mirrors an easy-to-fall-into bug... Behavior becomes inconsistent between iOS versions / web vs installed-PWA."

**Future enhancement**: Toggle between `skip10` and `prevnext` modes in settings. Test app has this implemented as a simple `setMode()` toggle.

### Known iOS Limitations (NOT fixable by us)
1. **PiP ("beeld in beeld")**: Does NOT work in standalone PWA mode (WebKit bug 303885). Only works in Safari browser mode. This is an Apple bug.
2. **Fullscreen**: iOS native video player handles fullscreen via its own zoom arrows (blue arrows in top-left). Our custom button was conflicting — now removed.
3. **webkitdirectory (folder select)**: Only works on iOS 18.4+. Older iOS shows file picker instead.
4. **PWA audio lock screen controls**: Can become non-functional after pausing for ~30 seconds in PWA mode (WebKit Bug 261858). Must bring app to foreground to "wake up" the audio session.
5. **"Both" mode registration**: Registering both `seekbackward`/`seekforward` AND `previoustrack`/`nexttrack` simultaneously causes inconsistent lock screen UI. Only register one set at a time.

### File Picker on iOS (CRITICAL)
iOS Safari has a known bug where dynamically created `<input type="file">` elements:
1. **MUST be appended to the DOM** (not just created with `createElement`)
2. **MUST use `addEventListener('change', ...)`** not `.onchange = ...`
3. Should be removed from DOM after use

Current implementation in `useFolderPicker.ts` handles this correctly.

### What We Removed (and Why)
- **Web Audio API** (`AudioContext`, `GainNode`, `MediaElementAudiosourceNode`): Interfered with iOS media session tracking. Audio now plays directly from `<audio>` element to speakers.
- **Hidden `<video>` for audio files**: Confused iOS about session type. Audio files now use only `<audio>`.
- **`navigator.audioSession.type = 'playback'`**: Initially removed, then **restored** — needed for the PWA/OPFS setup to keep sessions alive.
- **`previoustrack`/`nexttrack` handlers**: These hide the ±10s skip buttons on iOS lock screen.
- **Per-track volume** (was via Web Audio gain node): Removed with Web Audio. Global volume still works via `el.volume`.
- **Silent anchor was temporarily removed**, then **restored** with corrected behavior: never paused, volume=0.001 (not muted), `setPositionState()` always overrides to show track position.

## File Structure
- `src/hooks/useAudioEngine.ts` — Core engine: `<audio>` source of truth, `<video>` seek-framed for display, play/pause/seek/next/prev
- `src/hooks/useMediaSession.ts` — Lock screen handlers: play, pause, seekto, seekbackward, seekforward (NO previoustrack/nexttrack). Switches artwork based on play/pause state.
- `src/hooks/useFolderPicker.ts` — File picking, OPFS storage, IndexedDB persistence
- `src/stores/playerStore.ts` — Zustand state (queue, shuffle, repeat, volume)
- `src/lib/opfs.ts` — OPFS read/write/delete
- `src/lib/idb.ts` — IndexedDB for tracks, playlists, settings
- `src/lib/shuffle.ts` — Fisher-Yates shuffle, track ID generation
- `src/lib/types.ts` — Track, Playlist, RepeatMode types
- `src/lib/format.ts` — Shared utilities (formatTime)
- `src/lib/artwork.ts` — SVG artwork generation for MediaSession lock screen (music note for playing, pause icon for paused)
- `src/components/player/PlayBar.tsx` — Bottom controls (seek, play, shuffle, repeat)
- `src/components/player/NowPlaying.tsx` — Video player / audio art display
- `src/components/playlist/TrackList.tsx` — Track list with selection mode
- `src/components/layout/Layout.tsx` — Fixed nowPlaying + scrollable content
- `src/components/layout/BottomNav.tsx` — Mobile tabs (Add/Library/Playlists)
- `src/components/ui/Toast.tsx` — Error/info/success toast notifications
- `src/App.tsx` — Main app, tab management
- `vite.config.ts` — `base: '/media-player/'`, PWA plugin config
- `.github/workflows/deploy.yml` — GitHub Pages deploy

### Test Projects (reference, not deployed with main app)
- `custom-lock-screen-media-player/` — DeepSeek's test app with mode toggle, event log, lock screen preview
- `custom-lock-screen-media-player-the-new-one/` — ChatGPT Sol patched test app (**PWA handoff fixes**: timeupdate pinning, 0.0001 playbackRate, anchor pause→resume, hard-release anchor, watchdog retries) → deployed at `https://quirel64.github.io/custom-lock-screen-media-player/`

## Testing Notes
User tests on iOS device (Brave browser + Safari) and Windows laptop.
- PWA version: Add to home screen, standalone mode
- Web version: In-browser

## Open Issues
1. Tracks may not persist after closing/reopening app (IndexedDB/OPFS possibly cleared by iOS)
2. Old videos (16+ years) may have missing duration metadata
3. Audio files sometimes don't save when adding via file picker (intermittent)
4. **File persistence bug**: Adding files from a second folder works in-app, but force-closing the app loses the second batch. First batch persists. Likely a race condition in `saveTracks` — the `tx.done` promise may not resolve before force-close. Need to call `requestPersistentStorage()` before each save.
5. **Silent anchor session keeping**: Current approach uses a looping silent anchor that NEVER pauses + `setPositionState()` always set to TRACK position. If iOS ignores `setPositionState()` and shows anchor position instead, fall back to backup approaches below.

## iOS Session Keeping — Complete Research Summary

### What we've proven through testing:
1. **Anchor is REQUIRED** — Without any audio element playing in background, iOS kills the session after ~30 seconds
2. **Two elements playing simultaneously causes seek bar jumping** — iOS reads position from BOTH elements, `setPositionState()` is not strong enough to override
3. **Handoff (switching which element plays) is too fragile** — iOS's toggle play/pause button gets confused about state, causing reversed buttons and double-tap requirements
4. **Artwork switching works reliably** — Music note when playing, pause icon when paused, via `MediaMetadata` updates
5. **`setPositionState()` on every timeupdate doesn't help** — iOS still reads anchor's natural position between calls
6. **Brave browser's playlist keeps sessions for ~30 minutes** — But their session keeping is in native Rust code, not accessible via JavaScript

### The correct approach (from ChatGPT Sol's patched test app):
**Duration-matched handoff with PWA-specific fixes:**

1. **Duration-matched silent WAV**: Generate a silent WAV of the **exact same duration** as the track (capped at 15 min to limit memory)
2. **Position-matching**: When pausing, seek the silent element to the **same position** as the track before playing it
3. **Exclusive ownership mutex**: `handoffLockRef` prevents both elements from playing simultaneously
4. **Near-zero playbackRate (0.0001)**: Anchor crawls so lock-screen clock barely moves even when JS is suspended
5. **Timeupdate-based pinning**: `requestAnimationFrame` stops on lock screen, but `timeupdate` events still fire — pin anchor from `timeupdate`
6. **Lock-screen pause while anchor = resume**: While anchor plays, iOS still shows || and fires `pause` — that "pause" really means "resume the real track" (`remotePauseOrResume`)
7. **Anchor pause event → resume**: In PWA, iOS can pause anchor directly without MediaSession `pause` handler — anchor's native `pause` event also triggers resume
8. **Hard-release anchor on resume**: `pause()` + `removeAttribute('src')` + `load()` + `revokeObjectURL` so iOS stops treating anchor as active lock-screen item
9. **Watchdog retries**: PWA may drop first hidden `play()` — retry at 450ms and 1200ms
10. **Suppress flag**: `suppressAnchorPauseRef` prevents programmatic anchor pauses from triggering resume loop
11. **Seek while anchor**: Move both track and anchor `currentTime` + `setPositionState` with `frozenDuration`

### The handoff flow:
```
PLAYING (owner=track):
  Track plays at playbackRate 1, anchor fully released (no src)
  setPositionState(track.duration, track.currentTime, playbackRate: 1)

PAUSE:
  1. Save frozenPos = track.currentTime, frozenDuration = track.duration
  2. Pause track (with ignore flag)
  3. Generate silent WAV of same duration as track
  4. Seek silent to frozenPos
  5. Play silent at playbackRate 0.0001 → it owns the session
  6. Pin loop: rAF when foregrounded + anchor timeupdate when locked → seek bar frozen
  7. setPositionState(frozenDuration, frozenPos, playbackRate: 1)

RESUME (lock-screen pause while anchor owns session → interpreted as resume):
  1. Hard-release anchor (pause, remove src, revoke URL)
  2. Restore track.currentTime = frozenPos
  3. Play track → it owns the session (with watchdog retries)
  4. setPositionState(track.duration, track.currentTime, playbackRate: 1)
```

### Why previous version failed on PWA (but worked on web):
- `requestAnimationFrame` stops when PWA is locked/backgrounded → pin loop never ran → anchor drifted to end
- Lock-screen center button still showed || (anchor is playing) → pressing it fired `pause` → old code re-handoffed to anchor instead of resuming track
- In PWA, iOS can pause anchor directly without MediaSession handler → need anchor `pause` event listener
- Leaving anchor `src` attached made iOS keep treating anchor as active lock-screen item after resume

### Latest test results (2026-08-23):
- Handoff pause works on both web and PWA (anchor appears, track pauses)
- PWA required all 4 fixes above to make resume work; web only needed basic handoff
- Still need to verify: does track audio actually play after PWA resume, or is anchor still taking over?

## Planned Features
1. **Skip mode toggle**: Switch between ±10s skip buttons and prev/next track buttons on lock screen. Test app has working implementation — simple `setMode()` toggle between `skip10` and `prevnext`. To integrate into main app settings or as a one-button cycle.
2. **Playlist feature**: User mentioned as alternative focus.
3. **Implement duration-matched handoff**: Integrate the correct handoff approach from ChatGPT Sol's test app into the main media-player.
4. **something something brotger complaints**: addding a value system that influences the yates algorythm based on values given by the user.
5. **something something brotger complaints2**: adding a stack feature where the user can add stack on top or below a queue which would play first over the current playlist.
6. **something something brotger complaints3**: addding a value system that influences the yates algorythm based on values given by the user.


