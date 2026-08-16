# Media Player PWA - Project Status & Context

## Project Overview
A PWA media player web app that plays audio and video files, built with React + TypeScript + Vite + Tailwind CSS + Zustand. Hosted on GitHub Pages at `https://quirel64.github.io/media-player/`.

**User has iOS devices + Windows laptop only** — no Mac, no Apple Developer account. This is why PWA was chosen over Tauri.

## Architecture
- **Storage**: OPFS for file blobs, IndexedDB for metadata (tracks, playlists, settings)
- **Audio engine**: Both audio and video files use `<audio>` (hidden, source of truth) + `<video>` (muted, hidden or visible) for iOS lock screen controls
- **State**: Zustand store (`playerStore.ts`)
- **Shuffle**: Fisher-Yates with no-repeat cycling
- **Media Session API**: Lock screen controls, metadata, seek bar
- **PWA**: vite-plugin-pwa, service worker, GitHub Actions deploy

## iOS-Specific Behavior (CRITICAL - Read this first)

### What works
- **Video playback**: Play → lock screen → pauses → press play on iOS inline player → resumes consistently
- **Audio playback**: Same pattern as video after recent fixes
- **Lock screen controls (all files)**: ±10s skip buttons + interactable seek bar — both audio and video files get the video lock screen UI via hidden `<video>` element
- **Next track auto-advance**: Works when track finishes (even with screen off in PWA)
- **Shuffle/Repeat**: Work correctly, SVG icons turn purple when active
- **Seek bar drag**: Works on both mobile and desktop
- **Play button sync**: App play button stays in sync with iOS native controls
- **Track selection + delete**: Works on mobile

### Known iOS Limitations (NOT fixable by us)
1. **PiP ("beeld in beeld")**: Does NOT work in standalone PWA mode (WebKit bug 303885). Only works in Safari browser mode. This is an Apple bug.
2. **Fullscreen**: iOS native video player handles fullscreen via its own zoom arrows (blue arrows in top-left). Our custom button was conflicting — now removed.
3. **Lock screen next/prev buttons**: Hidden if `seekforward`/`seekbackward` handlers are registered. We removed those handlers so next/prev buttons show.
4. **webkitdirectory (folder select)**: Only works on iOS 18.4+. Older iOS shows file picker instead.
5. **PWA audio lock screen controls**: Can become non-functional after pausing for ~30 seconds in PWA mode (WebKit Bug 261858). Must bring app to foreground to "wake up" the audio session.

### File Picker on iOS (CRITICAL)
iOS Safari has a known bug where dynamically created `<input type="file">` elements:
1. **MUST be appended to the DOM** (not just created with `createElement`)
2. **MUST use `addEventListener('change', ...)`** not `.onchange = ...`
3. Should be removed from DOM after use

Current implementation in `useFolderPicker.ts` handles this correctly.

### Background Playback Pattern (CRITICAL - Updated)
iOS decides at the moment you **leave the app** whether to keep the media session alive. It checks: "is this audio or video?"

| Scenario | Background? | Why |
|---|---|---|
| `<audio>` playing → leave app | **Works** | iOS keeps audio sessions alive |
| `<audio>` finishes → `<video>` starts → leave app | **Fails** | Now it's a video session |
| `<video>` playing → leave app | **Fails** | iOS kills video sessions |
| `<video>` starts while already in background | **Works** | No foreground→background transition |
| Reopen app → close again while video plays | **Fails** | Foreground→background kills video |

**The rule:** If an `<audio>` element is the active session owner when you leave → iOS allows background playback. If `<video>` → iOS pauses.

**Solution: Silent audio anchor.** A silent `<audio>` element on loop from app start keeps the audio session alive. When video plays, the silent audio is still there. When you leave, iOS sees audio → allows background playback. The silent audio has gain=0 so the user never hears it.

The `navigator.audioSession.type = 'playback'` is set before every play attempt.

### Lock Screen Seek Bar (iOS)
iOS shows the seek bar on lock screen for `<video>` elements, NOT `<audio>` elements. For ALL files (audio and video), we use the same architecture:
- `<audio>` element (hidden, DOM-appended) — source of truth for playback, drives background play
- `<video>` element (muted, hidden or visible) — gives iOS the video lock screen interface

This means even audio files get a hidden `<video>` element to trigger iOS's video lock screen UI (±10s skip buttons + interactable seek bar). The `<video>` element pauses on `visibilitychange` to background; `<audio>` keeps playing.

Key rules:
- `setPositionState()` must be called on play, seek, and periodically (throttled to 1s) to keep seek bar accurate
- **Critical: `setPositionState()` must be called as early as possible** — in `loadedmetadata`, `durationchange`, `play()`, and after `seekto`. If called too late, iOS may not recognize the seek bar as interactable
- `seekto` action handler enables scrubbing from lock screen
- **Do NOT register `seekforward`/`seekbackward`** — iOS hides next/prev buttons when these are set
- Lock screen controls can stop responding after ~30 seconds in PWA mode (WebKit Bug 261858)
- **Debug logging**: `setPositionState` calls are logged to console with `[setPositionState]` prefix
- **Service worker caching**: Offline mode may serve old cached code. After deploying, user must refresh PWA while online to pick up new service worker

## File Structure
- `src/hooks/useAudioEngine.ts` — Core audio/video engine, play/pause/seek/next/prev
- `src/hooks/useMediaSession.ts` — Lock screen controls, MediaSession API
- `src/hooks/useFolderPicker.ts` — File picking, OPFS storage, IndexedDB persistence
- `src/stores/playerStore.ts` — Zustand state (queue, shuffle, repeat, volume)
- `src/lib/opfs.ts` — OPFS read/write/delete
- `src/lib/idb.ts` — IndexedDB for tracks, playlists, settings
- `src/lib/shuffle.ts` — Fisher-Yates shuffle, track ID generation
- `src/lib/types.ts` — Track, Playlist, RepeatMode types
- `src/lib/format.ts` — Shared utilities (formatTime)
- `src/components/player/PlayBar.tsx` — Bottom controls (seek, play, shuffle, repeat)
- `src/components/player/NowPlaying.tsx` — Video player / audio art display
- `src/components/playlist/TrackList.tsx` — Track list with selection mode
- `src/components/layout/Layout.tsx` — Fixed nowPlaying + scrollable content
- `src/components/layout/BottomNav.tsx` — Mobile tabs (Add/Library/Playlists)
- `src/components/ui/Toast.tsx` — Error/info/success toast notifications
- `src/App.tsx` — Main app, tab management
- `vite.config.ts` — `base: '/media-player/'`, PWA plugin config
- `.github/workflows/deploy.yml` — GitHub Pages deploy

## Testing Notes
User tests on iOS device (Brave browser + Safari) and Windows laptop.
- PWA version: Add to home screen, standalone mode
- Web version: In-browser

## Open Issues
1. Tracks may not persist after closing/reopening app (IndexedDB/OPFS possibly cleared by iOS)
2. Old videos (16+ years) may have missing duration metadata
3. Audio files sometimes don't save when adding via file picker (intermittent)
