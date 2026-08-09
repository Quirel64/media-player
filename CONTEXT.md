# Media Player PWA - Project Status & Context

## Project Overview
A PWA media player web app that plays audio and video files, built with React + TypeScript + Vite + Tailwind CSS + Zustand. Hosted on GitHub Pages at `https://quirel64.github.io/media-player/`.

**User has iOS devices + Windows laptop only** — no Mac, no Apple Developer account. This is why PWA was chosen over Tauri.

## Architecture
- **Storage**: OPFS for file blobs, IndexedDB for metadata (tracks, playlists, settings)
- **Audio engine**: Dynamically created `<audio>`/`<video>` elements + Web Audio API `GainNode` for per-track volume
- **State**: Zustand store (`playerStore.ts`)
- **Shuffle**: Fisher-Yates with no-repeat cycling
- **Media Session API**: Lock screen controls, metadata
- **PWA**: vite-plugin-pwa, service worker, GitHub Actions deploy

## iOS-Specific Behavior (CRITICAL - Read this first)

### What works
- **Video playback**: Play → lock screen → pauses → press play on iOS inline player → resumes consistently
- **Audio playback**: Same pattern as video after recent fixes
- **Next track auto-advance**: Works when track finishes (even with screen off in PWA)
- **Shuffle/Repeat**: Work correctly, SVG icons turn purple when active
- **Seek bar drag**: Works on both mobile and desktop
- **Play button sync**: App play button stays in sync with iOS native controls
- **Track selection + delete**: Works on mobile

### Known iOS Limitations (NOT fixable by us)
1. **PiP ("beeld in beeld")**: Does NOT work in standalone PWA mode (WebKit bug 303885). Only works in Safari browser mode. This is an Apple bug.
2. **Fullscreen**: iOS native video player handles fullscreen via its own zoom arrows (blue arrows in top-left). Our custom button was conflicting — now removed.
3. **Lock screen next/prev buttons**: iOS doesn't always show these for web audio. The 10-second skip buttons work on video.
4. **webkitdirectory (folder select)**: Only works on iOS 18.4+. Older iOS shows file picker instead.

### File Picker on iOS (CRITICAL)
iOS Safari has a known bug where dynamically created `<input type="file">` elements:
1. **MUST be appended to the DOM** (not just created with `createElement`)
2. **MUST use `addEventListener('change', ...)`** not `.onchange = ...`
3. Should be removed from DOM after use

Current implementation in `useFolderPicker.ts` handles this correctly.

### Background Playback Pattern
The consistent pattern on iOS:
1. User presses play → media plays
2. User locks screen or leaves app → playback pauses
3. User sees iOS lock screen player / inline player
4. User presses play on iOS player → playback resumes
5. Track finishes → next track auto-plays (shuffle/repeat respected)
6. This works reliably once step 4 is done once

The `navigator.audioSession.type = 'playback'` is set before every play attempt.

## File Structure
- `src/hooks/useAudioEngine.ts` — Core audio/video engine, play/pause/seek/next/prev
- `src/hooks/useMediaSession.ts` — Lock screen controls, MediaSession API
- `src/hooks/useFolderPicker.ts` — File picking, OPFS storage, IndexedDB persistence
- `src/stores/playerStore.ts` — Zustand state (queue, shuffle, repeat, volume)
- `src/lib/opfs.ts` — OPFS read/write/delete
- `src/lib/idb.ts` — IndexedDB for tracks, playlists, settings
- `src/lib/shuffle.ts` — Fisher-Yates shuffle, track ID generation
- `src/lib/types.ts` — Track, Playlist, RepeatMode types
- `src/components/player/PlayBar.tsx` — Bottom controls (seek, play, shuffle, repeat)
- `src/components/player/NowPlaying.tsx` — Video player / audio art display
- `src/components/playlist/TrackList.tsx` — Track list with selection mode
- `src/components/layout/Layout.tsx` — Fixed nowPlaying + scrollable content
- `src/components/layout/BottomNav.tsx` — Mobile tabs (Add/Library/Playlists)
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
