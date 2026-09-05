# Media Player PWA - Project Status & Context

## Project Overview
A PWA media player web app that plays audio and video files, built with React + TypeScript + Vite + Tailwind CSS + Zustand. Hosted on GitHub Pages at `https://quirel64.github.io/media-player/`.

**User has iOS devices + Windows laptop only** — no Mac, no Apple Developer account. This is why PWA was chosen over Tauri.

## Architecture — FINAL (Arena same-element)
- **Storage**: OPFS for file blobs, IndexedDB for metadata (tracks, playlists, settings)
- **Audio engine**: ONE permanent `<audio>` (`controls=true`, hidden offscreen, `audioSession.type='playback'`) that swaps `src` track <-> duration-matched silent placeholder on the SAME element (no second element, no cross-element play). Silent WAV generated via `src/lib/silentAudio.ts` (`createSilentWavUrl`, 60min cap, 8kHz/4kHz, ~2MB for 125s). `HOLD_RATE=0.0000001` (4 months per second) so visual bar doesn't drift even though `rAF` stops when PWA hidden.
- **Video display**: For video files, a `<video>` element is created but kept **paused** and seek-framed via `requestAnimationFrame` to show the correct frame when `sourceKind==='track'` and `!paused`.
- **iOS session keeping**: Same-element handoff — `play` → `src=track`, `pause` → `src=silent placeholder` at `frozenPos` with `HOLD_RATE`, `resume` → `src=track` at `frozenPos`. All `play()` calls happen synchronously in the `MediaSession` action callback before any `await`, so PWA keeps activation (fixes `AbortError` cross-element). Queued `transitionRef`/`queuedCommandRef` handles overlapping `seek→100%`/`next` spam. `setPositionState` always with `trackDuration` + `frozenPos`, `publishPosition` not dependent on timers.
- **State**: Zustand store (`playerStore.ts`)
- **Shuffle**: Fisher-Yates with no-repeat cycling
- **Media Session API**: Lock screen controls, metadata (single artwork `src/lib/artwork.ts` now, no play/pause toggle), seek bar
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
**has been completed**


### Known iOS Limitations (NOT fixable by us)
1. **PiP ("beeld in beeld")**: Does NOT work in standalone PWA mode (WebKit bug 303885). Only works in Safari browser mode. This is an Apple bug.
2. **Fullscreen**: iOS native video player handles fullscreen via its own zoom arrows (blue arrows in top-left). Our custom button was conflicting — now removed.
3. **webkitdirectory (folder select)**: Only works on iOS 18.4+. Older iOS shows file picker instead.
4. **PWA audio lock screen controls**: *Fixed* — previous WebKit Bug 261858 (controls dead after ~30s paused) is now fixed via same-element silent placeholder (26m+ gaps proven: `13:31:55` `7.99s` → `13:57:56` resume `7.99s`, `11:12:28` `93s` → `11:40:16`, `13:31` `HOLD_RATE 1e-7`). Must still use single-element, `HOLD_RATE 0.0000001`, and sync `play()` in action callback.
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
- **Dual-element silent anchor** (second `<audio>` at 0.001 with `handoff`, `pinAnchor`, `watchdog`) + **single-element freeze** (`volume 0.001` pin): Removed — PWA `AbortError` cross-element and bar drift to `131` while audio at `22.7`. Replaced by same-element silent placeholder (one permanent `<audio>` swaps `src` track<->WAV, `HOLD_RATE 1e-7`, duration-matched, not OPFS).

## File Structure
- `src/hooks/useAudioEngine.ts` — Core engine: `<audio>` source of truth, `<video>` seek-framed for display, play/pause/seek/next/prev
- `src/hooks/useMediaSession.ts` — Lock screen handlers: `play`/`pause`/`seekto` + `skip10` *or* `prevnext` (single artwork `getPlayingArtwork`, no toggle).
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
5. **Session keeping — SOLVED** 2026-08-30: Same-element silent placeholder (Arena) with `HOLD_RATE 1e-7` — gaps `26m` `7.99→7.99`, `28m` `93→93`, `22m` `13.4→13.4` on PWA, no `AbortError`, `5h` `28125KB` placeholder still swaps in `0.5s`. In-app `ended`/`seek 100%` and lock `nexttrack` both `track resumed @0.03s` with one tap.

## iOS Session Keeping — Complete Research Summary — FINAL (Arena + your tweak)

### What we've proven through testing:
1. **A playing element is REQUIRED** — Without any `audio` `playing` (even silent), PWA kills session after ~30s (WebKit 261858). `volume 0.001` not `muted` is required.
2. **Two elements at once = seek bar fighting** — iOS merges timelines. `0.25` still drifted visually; `1e-7` (your test) is effectively frozen (~4 months/sec).
3. **Cross-element handoff is rejected on PWA** — `anchor.play()` → `AbortError` on `PWA` `home-screen standalone` but not Safari tab. Same-element `src` swap keeps the `MediaSession` activation because `play()` is called synchronously before `await`.
4. **Duration-matched silent on same element fixes both** — `125.2s` track → `125.2s` silent at same `currentTime`, `HOLD_RATE 1e-7`, `setPositionState(trackDuration, frozenPos, HOLD_RATE)` stays `22.7` not `131`, one tap `▶️` resumes.
5. **`rAF` stops when PWA hidden** — correctness can't depend on rewind timers; `timeupdate` pin is best-effort but `frozenPos` is authoritative.

### The correct approach — FINAL (Arena same-element, your 1e-7 tweak):
**One permanent `<audio>` swaps `src` (no second element):**
1. **Duration-matched silent WAV** on same element: `createSilentWavUrl(trackDuration)` `src/lib/silentAudio.ts:12` capped `60min` (`8kHz`/`4kHz`), `~2MB` for `125s`, not `OPFS` — `5h` `28125KB` still swaps in `0.5s`.
2. ** `play()` → `src=track` at `frozenPos`**, `pause()` → `src=silent` at `frozenPos` with `HOLD_RATE 0.0000001` (your test: `0.25` still drifted, `1e-7`=4 months/sec). Both `play()` calls happen **synchronously** in the `MediaSession` `pause`/`play` callback before any `await` — keeps PWA activation, no `AbortError`.
3. **Queued transitions** `transitionRef`/`queuedCommandRef` `src/hooks/useAudioEngine.ts:82` handles `seek→100%`/`next` spam that gave `speelt niets af`; `transitionToken` guards stale `loadTrack` gens.
4. **No pin needed** — `frozenPos` is authoritative, `setPositionState(trackDuration, frozenPos, HOLD_RATE)` while anchor, `1` while track. Bar stays `7.99` for `26m` `13:31:55→13:57:56`, not `131`.

### The flow:
```
PLAYING: audio.src = track blob, playbackRate=1, setPositionState(duration, currentTime,1), video rAF copies time
PAUSE (tap ||): frozenPos = currentTime, ensureAnchor(duration) → activateSource('anchor', silentUrl, frozenPos) → media.src=silent, load, play() sync → owner=anchor, playbackState=playing, lock shows ▶️ (paused) but audio technically playing silent
RESUME (tap ▶️ while anchor): activateSource('track', trackUrl, frozenPos) → media.src=track, load, play() sync → owner=track, video resumes
```
Lock `||` while anchor still means `pause → resume` via `remotePauseOrResume` `src/hooks/useMediaSession.ts:35`.

## Planned Features
1. **Skip mode toggle**: Switch between ±10s skip buttons and prev/next track buttons on lock screen. Test app has working implementation — simple `setMode()` toggle between `skip10` and `prevnext`. To integrate into main app settings or as a one-button cycle.
*done*
2. **Playlist feature**: User mentioned as alternative focus.
3. **Implement duration-matched handoff**: Integrate the correct handoff approach from ChatGPT Sol's test app into the main media-player.
4. **something something brother complaints**: addding a value system that influences the fisher yates algorythm based on values given by the user.
5. **something something brother complaints2**: adding a stack feature where the user can add a track to a stack on top or below a queue which would play first over the current playlist.
6. **something something brother complaints3**: adding a value to each track which is that a certain track plays at a certain volume.
7. giving the app a better visual makeover with animations, startup and menu.


