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

## Library Ordering & Display (2026-09-06)
**Previous behavior (bug):** `processFiles` appended new batch via `[...existingQueue, ...tracks]` (`useFolderPicker.ts:87`) so in-session you saw them at the end, but `loadSavedTracks` used `getAllTracks()` (`idb.ts:80`) which returns IDB key order (sorted by `id`). With UUID `id` (`shuffle.ts:63`) that order is random lexicographic -> reload scattered tracks (e.g. `[Vocaloid] Humans Are Cats...` at 30 and 34 in screenshot) and duplicates not bundled.

**Current fix (v1.1.0+):** Each `Track` now has `createdAt: number` (`types.ts:11`, `useFolderPicker.ts:66` `baseTime+idx`). `TRACKS_STORE` has `by-createdAt` index (`idb.ts:4-15`, `DB_VERSION 3`, upgrade `idb.ts:35`). `getAllTracks()` sorts by `createdAt` (`idb.ts:122`), and `loadSavedTracks` prefers `getPlaylist('library').tracks` (`useFolderPicker.ts:236`) which is the exact insertion-order array (`useFolderPicker.ts:138`). Old tracks without `createdAt` are backfilled on first load. Result: refresh preserves upload order (second batch stays at end, duplicates at insertion point, not scattered).

**Library vs Playlist:** Current `Library` tab (`TrackList.tsx:26`) is a flat queue view (like a playlist) — not a grouped library. Queue order = playback order (`playerStore.ts` `currentTrackIndex`, `getNextTrackIndex`). This is correct for now/next/shuffle but confusing for browsing 64 tracks. Makeover plan: keep queue as "Now Playing Queue" and introduce Library views (group by `folderName`/`album`/`artist`, collapsible sections, filter/search, sort toggles: date added (`createdAt`), A-Z, size, duration). Duplicates will show separately (UUID ensures separate) but grouping will make them findable; optional "bundle duplicates" toggle later.

## Testing Notes
User tests on iOS device (iOS 26.2, Brave + Safari) and Windows laptop.
- PWA version: Add to home screen, standalone mode
- Web version: In-browser
- Last verified 2026-09-15: Video app-switcher seek sync works, `HOLD_RATE 1e-7` bar frozen, lock `visible` anchor inverted `||` but 1-press toggle via `remotePauseOrResume`, `hidden` anchor correct `>`, control center/Windows always `||` (parked). Session survives 30s+ only with `HOLD_RATE` silent anchor.
- Repo: https://github.com/Quirel64/media-player

## Current Baseline — 2026-09-15 (lock screen parked, video fixed)
**Goal**: Keep PWA functional on iOS 26.2 — video in sync, audio no stutter, lock usable with 1 press even if icon inverted.

- **Video**: Fixed app-switcher drift. `onVis hidden` pauses video, `visible` seeks `v.currentTime = audio.currentTime` if drift >0.15 then `v.play()` (`src/hooks/useAudioEngine.ts:582`). `activateSource` now seeks video to `frozenPos`/`media.currentTime` on track resume. Baseline `videoSync` nudge still disabled — dual-play muted video is enough, no stutter. Tested: swipe to app switcher while track playing → audio ahead, return → `visible video seek to audio` re-syncs.
- **Audio stutter**: Fixed — `activateSource`/`play` no longer `hardSync`/`nudge` video while track; video stays paused/seek-farmed or muted playing without rate nudging. No seek storm.
- **Lock screen — known inversion (parked)**: `pause in-app (visible) → anchor` publishes `paused + HOLD_RATE` correctly (`src/hooks/useAudioEngine.ts:129` `pre/post-publish anchor paused`) but iOS 26.2 PWA **visible-created anchor shows `||` (playing) instead of `>`**. `hidden`-created anchor (pause via lock while `hidden`) shows `>` correctly. Logs prove: `11:42:36 hidden anchor refresh paused` is `>` for 1s then flips to `||` via iOS itself; `HOLD_RATE=0` makes bar run to end and kills session after 30s (`speelt niets af`), `1e-7` keeps bar frozen but still `||`. Control Center + Windows PWA **always show `||`** regardless of `paused`/`playing` — separate MediaSession view, not fixable with one `playbackState`. Resilient toggle `src/hooks/useMediaSession.ts:42` + `remotePauseOrResume` (`src/hooks/useAudioEngine.ts:276` `anchor→play else pause`) makes **1 press always toggles** even when icon inverted, so functional. `HOLD_RATE=1e-7` required to keep session alive past 30s — `truly paused (rate 0)` kills session (`14:57:14` `owner=idle` after 30s, `speelt niets af`).
- **Pending**: Re-enable smooth fullscreen + `videoSync` nudge once lock icon is revisited; lock `>` perfect would need `visible`→`hidden` deferred anchor swap (tested `806f395` but keeps audio playing audibly after in-app pause until lock, so reverted).

## Open Issues
1. Tracks may not persist after closing/reopening app (IndexedDB/OPFS possibly cleared by iOS) *fixed*
2. Old videos (16+ years) may have missing duration metadata
3. Audio files sometimes don't save when adding via file picker (intermittent) — same root as 1/4, fixed via same persist hardening
4. **File persistence bug — FIXED 2026-09-05**: Second folder force-close loss. Root: `tx.done` not flushed before iOS suspend + duration probing delaying first durable write. Fix: early `saveTracks(combinedEarly)` with `duration 0` before probing, gesture-kept `requestPersistentStorage()` (`useFolderPicker.ts:52,178`), verify `getAllTracks()` count + retry, `App.tsx` `visibilitychange`/`pagehide` flush, `idb.ts:58` per-track fallback.
5. **Session keeping — SOLVED** 2026-08-30: Same-element silent placeholder (Arena) with `HOLD_RATE 1e-7` — gaps `26m` `7.99→7.99`, `28m` `93→93`, `22m` `13.4→13.4` on PWA, no `AbortError`, `5h` `28125KB` placeholder still swaps in `0.5s`. In-app `ended`/`seek 100%` and lock `nexttrack` both `track resumed @0.03s` with one tap.
6. **Same-name resume — FIXED 2026-09-05**: `generateTrackId` was `${name}-${size}-${lastModified}` (`shuffle.ts:63`) -> colliding IDs for same-name files overwrote `TRACKS_STORE` and `prevTrackIdRef` treated `song.mp3` -> `song (1).mp3` as same track, kept `frozenPos`. Fix: UUID `crypto.randomUUID()` per upload, `fileName` still deduped via `getUniqueFileName`.
7. **Library reorder on reload — FIXED 2026-09-06**: 64-track screenshot showed duplicates at 30/34 after restart. Root: `getAllTracks()` key-order (UUID random) scattered insertion order. Fix: `Track.createdAt` + `by-createdAt` index + playlist-first load (`useFolderPicker.ts:236`, `idb.ts:122`). Library vs Playlist confusion noted — see `## Library Ordering & Display`.
8. **Storage not freed on deletion — FIXED 2026-09-15**: `navigator.storage.estimate().usage` stayed at ~1088MB after deleting all tracks via the app. Root: `clearAllTracks()` only did `db.clear(TRACKS_STORE)` (doesn't release IndexedDB pages), `clearOPFS()` silently failed if `removeEntry` threw, and service worker caches weren't cleared. Fix: `clearAll()` now calls `resetDB()` (deletes and recreates the entire IndexedDB database) + `clearOPFS()` with iterative fallback + `caches.keys()`/`caches.delete()` for service worker caches + logging. `getStorageEstimate()` exposed on `window` and `debugOPFS()` on `window` for console debugging. "Check Storage" button added to EventLog.


## Storage Diagnostic — 2026-09-15
**Key finding**: `navigator.storage.estimate().usage` (our website's storage) ≠ Safari "Documents and Data" (total Safari storage including other websites + cache).
- Fresh install: `estimate().usage` = 0.42MB, `quota` = 39322MB
- After uploading tracks: `estimate().usage` = 1088.79MB (matches track size)
- After deleting tracks via app: `estimate().usage` = 1088.82MB (NOT freed!)
- After clearing webdata via Settings: `estimate().usage` = 0.42MB (freed)
- Windows: 29.16MB usage with 318 files from an earlier build still in OPFS/IndexedDB

**Root cause**: `clearAll()` used `db.clear(TRACKS_STORE)` and `db.clear(FILES_STORE)` which don't release IndexedDB pages. `clearOPFS()` silently failed if `removeEntry` threw. Service worker caches weren't cleared.

**Fix applied** (all in `clearAll()`):
1. `resetDB()` — deletes and recreates the entire IndexedDB database (`deleteDatabase` + `openDB`) to release pages
2. `clearOPFS()` — iterative fallback if `removeEntry` fails, with logging
3. `caches.keys()` + `caches.delete()` — clears all service worker caches
4. `getStorageEstimate()` — exposed on `window` for console use
5. `debugOPFS()` — exposed on `window` for console use
6. "Check Storage" button in EventLog — calls both and logs results

**Diagnostic commands** (console): `await getStorageEstimate()` and `await debugOPFS()`

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
PLAYING: audio.src = track blob, playbackRate=1, setPositionState(duration, currentTime,1), video muted playing alongside if video
PAUSE (tap || in-app or || on lock while playing): frozenPos = currentTime, ensureAnchor(duration) → activateSource('anchor', silentUrl, frozenPos) → media.src=silent, load, play() sync → owner=anchor, playbackState=paused, lock shows ▶️ (paused) but audio technically playing silent at HOLD_RATE
RESUME (tap ▶️ while anchor OR either lock button while inverted): activateSource('track', trackUrl, frozenPos) → media.src=track, load, play() sync → owner=track, playbackState=playing, video resumes, bar rate=1
```
Lock `play` and `pause` both route via `remotePauseOrResume` `src/hooks/useMediaSession.ts:35` / `src/hooks/useAudioEngine.ts:276` (resilient to iOS 26.2 inverted icon where `||` shows while anchor).

## Fix 2026-09-14/15 — iOS 26.2 lock icon + frozen bar + video-keep-playing + app-switcher drift
**Root 1 — bar/video**: `activateSource` set `playbackState` after `await` and `onPlaying` raced; `video` not seeked on resume, so app-switcher `hidden` pause left `audio` ahead of `video`.
**Root 2 — lock `visible` inversion**: `visible`-created `anchor` (in-app pause) publishes `paused + HOLD_RATE` correctly but iOS 26.2 PWA shows `||` instead of `>` until ~1s later flips; `hidden`-created `anchor` (pause via lock while hidden) shows `>` correctly. `HOLD_RATE 0` makes bar run to end and kills session after 30s (`14:56:20` `truly paused` → `speelt niets af`), `1e-7` keeps it but still `||` when visible.
**Fix**: `activateSource` + `play` now `publishPosition` before `playbackState` + `post` + `re` + `500ms` publishes; `onPlaying`/`onTimeUpdate`/`visibility` enforce `paused/HOLD_RATE` vs `playing/1` + `v.pause()`/`v.currentTime=frozenPos` while anchor, `v.currentTime=audio.currentTime` + `v.play()` while track; app-switcher `visible` does `drift>0.15` seek; `useMediaSession.ts:42` both center buttons → `remotePauseOrResume` so 1 press toggles even when inverted. `806f395` deferred `pendingAnchor` tested but kept audio playing audibly after in-app pause, so reverted to immediate swap. Parked control center/Windows `||` always. Builds `390-392kB`.


8. **Duration carryover bug — FIXED 2026-09-15**: double-tapping a track or next-track caused the bar duration to carry over from the old track. Root: `onTimeUpdate` overwrote `frozenPosRef.current` back to the stale position between `loadTrack` resetting it and `play()` reading it. Fix: `loadTrack` seeks `mediaRef.current.currentTime = 0` so `onTimeUpdate` updates `frozenPosRef` to 0. Also reads `media.duration` directly if `media.src` is unchanged so `onLoadedMetadata` is not needed.
9. **Playlist dupe video black screen — FIXED 2026-09-15**: playlist duplicate tracks (same `fileName`, different `instanceId`) caused `play()` to revoke the cached blob URL and re-derive it. The video element `src` pointed to the revoked URL → black screen. Fix: `activateSource` now does `v.src = url; v.load()` for video tracks. Also changed URL revocation check from `prevTrackIdRef.current !== track.id` to `prevFileNameRef.current !== track.fileName` so same-file dupes do not trigger unnecessary revocation.
10. **Seek bar freeze — FIXED 2026-09-15**: double-tapping the same track left `trackDurationRef.current = 0` because `onLoadedMetadata` did not re-fire for the same `media.src`. Fix: `loadTrack` reads `mediaRef.current.duration` directly and sets `trackDurationRef.current`/`setDuration` if valid.

## Playlist feature — COMPLETE 2026-09-15
All core functionality verified on iOS 26.2 PWA + Windows:
- `PlaylistItem {id, trackId, order, addedAt}` dupes allowed, `Playlist {items}` ordered refs
- `usePlaylists.ts`: `createPlaylist`, `addTracksToPlaylist`, `deletePlaylist`, `playPlaylist`, `removeTracksFromPlaylist`
- `PlaylistsView.tsx`: Tracks/Queue/Edit modes, 2×2 thumbnails, playing indicator, Select All in header
- `AddToPlaylistSheet.tsx`: select tracks → choose/create playlist
- Library Select → Add to Playlist (clears selection + jumps to Playlists tab)
- Every track tap forces fresh load (`frozenPos=0`, `v.load()`, `instanceId`-based `loadTrack` re-trigger)
- Lock screen: `skip10` mode, `remotePauseOrResume` resilient toggle, `HOLD_RATE=1e-7` session keeping
- Build ~414kB. Known benign: `video resume failed` in logs (benign `onPlaying` `v.play()` rejection, caught silently)

## Fix 2026-09-16 — OPFS storage leak: permanently switched to IndexedDB
**Root cause**: OPFS (Origin Private File System) has a WebKit bug where `removeEntry()` deletes files but does not release disk space until Safari is force-closed and reopened. `navigator.storage.estimate()` stays high (~1GB) after deletion while Safari "webdata" drops to 3.2MB. This is WebKit bug 289754 and related OPFS storage management issues.

**Proof**: With OPFS enabled: documents and data = 1.22GB after uploading tracks, stayed at 1.22GB after deletion. With IndexedDB-only: documents and data dropped to 68.5MB after deletion. OPFS was the sole culprit.

**Fix applied — `src/lib/opfs.ts` deleted, all file operations now in `src/lib/idb.ts` with renamed functions**:
- `saveFileToOPFS` → `saveTrackFile`
- `getFileFromOPFS` → `getTrackFile`
- `getFileURLFromOPFS` → `getTrackFileURL`
- `deleteFileFromOPFS` → `deleteTrackFile`
- `clearOPFS` → `clearTrackFiles`
- `listFilesInOPFS` → `listTrackFiles`
- `debugOPFS` → `debugTrackFiles`
- All route through IndexedDB `FILES_STORE` via `saveFileBlob`, `getFileBlob`, `deleteFileBlob`, `clearFileBlobs`, `getAllFileBlobNames`
- `clearAll()` no longer shows Safari restart notification
- `useAudioEngine.ts`, `useFolderPicker.ts` updated to use new names
- `LibraryView.tsx`, `PlaylistsView.tsx` cleaned of stale imports and dead thumbnail code

**resetDB() fix**: Uses indexedDB.deleteDatabase(DB_NAME) directly instead of idb deleteDatabase
**Root cause details**: WebKit bug 289754 ("Files remaining in WebsiteData folder after removing all website data") was fixed in r292422@main (March 2025), but the underlying OPFS space-not-freed issue persists in Safari 26.2. OPFS uses Safari's internal file system storage which doesn't immediately release space on `removeEntry()`. IndexedDB does not have this issue.

**Diagnostic tools added**:
- "Check Storage" button in EventLog calls `getStorageEstimate()` + `debugTrackFiles()`
- `window.getStorageEstimate()` and `window.debugTrackFiles()` exposed for console testing
- `EventLog.tsx` footer documents console commands

**Thumbnails**: Restored in `LibraryView.tsx` and `PlaylistsView.tsx` — confirmed NOT the cause of storage issues.

**Remaining minor issue**: Safari documents and data grows ~1MB per app refresh (service worker cache / Safari cache). This is unrelated to our app's storage and is normal Safari behavior.

**Remaining minor issue**: Safari documents and data grows ~1MB per app refresh (service worker cache / Safari cache). This is unrelated to our app's storage and is normal Safari behavior.

## Planned Features
1. **Skip mode toggle**: Switch between ±10s skip buttons and prev/next track buttons on lock screen. Test app has working implementation — simple `setMode()` toggle between `skip10` and `prevnext`. To integrate into main app settings or as a one-button cycle.
*done*
2. **Playlist feature** — *DONE 2026-09-15, extended 2026-10-01/02* ✓ (see `## Playlist Follow-ups`)
   *base done 2026-09-15*: `PlaylistItem {id, trackId, order, addedAt}` dupes allowed, `Playlist {items}` is ordered refs, `TRACKS_STORE` single source, `OPFS` once, `DB_VERSION 4` migrates legacy `tracks[]` → `items[]` (`src/lib/types.ts:15`, `src/lib/idb.ts:4`). `usePlaylists.ts` create/add/play, `PlaylistsView` `src/components/playlist/PlaylistsView.tsx` + `AddToPlaylistSheet`, `Library` Select → Add to playlist (clears + jumps to Playlists) and Playlists `+ Create` / `Play` per `items` order. Library stays `createdAt` for now.
   *extended 2026-10-02*: reverse picker `AddTracksSheet` (+ Tracks button inside playlist → library search + forced select → append); `handleAddTracksToPlaylist` live-appends the sounding queue (position/shuffle kept) for BOTH add directions; video re-attach guarded to real track changes (`queueVideoKeyRef`, fixes black video after live-append).
3. **low prio brother complaints**: addding a value system that influences the fisher yates algorythm based on values given by the user so that a certain track has a higher or lower chance of appearing when using the shuffle.
4. **low prio complaints2**: adding a stack feature where the user can add a track to a stack on top or below a queue which would play first over the current playlist preferably inside of a playlist so you can isolate each stack.
5. adding a manual grouping feature where users can sort their ow tracks in cases where auto grouping misses some tracks.
6. **low prio brother complaints3**: being able to set a sound value to each track which is that a certain track plays at a certain volume.
7. giving the app a better visual makeover with animations, startup screen and menu's including clarity for ease of use.
8. adding fullscreen mode to the video which would work for when you tilt the phone horizonatally for example or just a button that gives fullscreen.
9. making the group play in the groups order instead of the queue. (once playlists are implemented.)
10. allowing users to modify the order of the queue in a playlist or in the library queue mode.
11. adding a delete playlist button while there are no tracks in the playlist. (currently delete playlist only appears when there is at least one track in the playlist.)
12. remove delete from +tracks inside of a playlist as it is for adding tracks not deleting them.

## Cleanup Phases — DONE 2026-09-27 (C, 1a/1b/1c, 3; Phase 4 struck off)
Verified on iPhone 12 (Safari-web + standalone PWA, separate IDB stores) + Windows laptop:
- **C**: `App.tsx` static idb imports (kills `INEFFECTIVE_DYNAMIC_IMPORT`); deleted dead `VideoSyncController` (`videoSync.ts`, ~5.6kB saved). Video stays in sync via leave-app-only recalibration (`drift>0.15` seek on visible). Two follow-up video fixes: anchor swap no longer loads silent WAV into `<video>` (black-screen on pause-outside); anchor→track resume skips `v.load()` when src already correct + pre-seeks (flash/black/resync on unpause).
- **1a transactional delete**: `prunePlaylistsForDeletedTrackIds()` removes deleted ids from EVERY playlist copy incl. `library` + resequences `order`; `App.handleRemoveTracks` simplified. Kills dud resurrection.
- **1b boot reconcile + truthful readout**: `loadSavedTracks` purges queue-leak metadata, missing-blob ghosts, orphan blobs; repairs `library` snapshot with STABLE item IDs; `getTruthfulStorageReport()` (Track.size sum, no blob reads) + Check Storage logs real MB. Finding: `estimate()` lies on iOS (0.57MB for a real 1.1GB library — WebKit doesn't count File blobs); Safari Settings webdata is ground truth. Stable: 0.0→1088.3→0.0MB, docs-and-data residue ~25–65MB Safari overhead.
- **1c canonical uploads**: `processFiles` builds on `getAllTracks()` (instanceIds stripped, createdAt-sorted), never the transient queue; library items keep stable UUIDs across early/final saves. Playlist of 4 refs adds 0 bytes; re-upload doubles 57→114 tracks / 1088→2176MB exactly.
- **3 queue/library split**: `src/lib/queue.ts` (`queueKey`, `toQueueItem`, `isLibraryQueue`, `findQueueIndexByKey`); App dud-filters deleted (~40 lines); occurrence-aware playlist indicator (twins no longer co-light); shared `PlayingIndicator` (playing pulse vs source muted dot); group detail reuses `TrackList` (Select/Add/Delete parity); Select All↔Clear toggle.
- **Phase 4 (storage health) STRUCK OFF**: needs nothing — deletes free device storage (1.1GB reclaimed), no stacking across 4 upload/delete rounds, per-version stores confirmed separate. `requestPersistentStorage`/probing batches left as-is.

## Playlist Follow-ups — DONE 2026-10-01 (S1–S4 + session bugs)
- **S1–S3 Library/Playlist UI**: shared `PlayingIndicator` (playing pulse vs source dot), shared selection set across Library queue/group-detail/grid, group detail as thumbnail grid, loud card playing badges, Select All/Clear everywhere.
- **S4 playlist parity**: Tracks grid selects like Library (keys stay `item.id` = refs-only removal).
- **Removal migration**: deleting the sounding occurrence moves to next/previous, empty stops; deleting the playing playlist pauses.
- **Ghost-audio fix**: `loadTrack` clears deferred visible→hidden anchor (pause-then-switch-context played stale src).
- **Lock mode on reload**: handler registration re-pushes metadata; boot warm-up preloads track 1 paused (it previously never loaded until first tap).

## Lock-screen seek fighting — FIXED (thumbnail probe videos)
Two lock-screen positions fought (one frozen ~4s) then merged ~10s in, video tracks only.
Root cause: `getVideoThumbnail` parks a REAL `<video>` at a ~3.5s seek for every
video file (up to ~100, sequentially, 4s timeout each). Small libraries finish
probing before you can lock; 48+ tracks means probes are still alive 30s+ after
opening the library — the exact quantity threshold found by testing (16 clean,
48 fights; single 5h file clean, slow 5h parse stretches the window to 5–6s).
Heat stretches decodes and widens it further. Verified fixed: 49 tracks incl.
the 5h file, immediate play + lock skip, single bar.
Fix (`thumbnail.ts`, all three loaders): probes are muted + defaultMuted +
volume 0 + disableRemotePlayback + inline + airplay-deny before src, and
Library / playlist-detail / playlist-grid loaders abort while audio plays,
resuming on pause. Thumbnails fill in when paused; playback never shares the
decoder with a probe again.
Follow-up (2026-10-17): probes still pause during playback, but results are now
memoized in a module-level cache (`thumbnail.ts`, data URLs, keyed by fileName,
cap 500) and each view seeds its `thumbs` state from it. Previously every view
had private state, so starting playback in the library then opening a playlist's
Tracks tab showed no thumbnails at all even for already-probed files. Cached
thumbs now appear in every view immediately; only never-probed tracks wait for
pause. Failed video probes are NOT cached (retry later); audio nulls are cached.
Follow-up (2026-10-17): the playlist OVERVIEW grid never rendered thumbnails at
all — it hardcoded a 📋 placeholder per cell while the loader right above it
fetched grid thumbs into state nobody read. Now renders real covers (trackId →
fileName map) with a `+N` badge on the 4th cell when the playlist has more than
4 items (was `+N` replacing the cell, and `length-3`; now `length-4` since the
4th cover shows too).

## Thumbnail probes — persisted + smarter frames (2026-10-22)
The old probe (`getVideoThumbnail`) always seeked to ~3.5s for every video on
every app launch. The seek (not `play()`) is what registers the competing
lock-screen position; a manual seek while a probe is parked is what actually
produced the "two bars fighting" symptom (no manual seek → no fight). So the
fix is fewer/lighter probes, not removing seeks (there is no browser-only
alternative: embedded art is unavailable, WebCodecs+demuxer is out of scope).

- **Persisted to IndexedDB** (`idb.ts` `DB_VERSION 5`, `thumbs` store keyed by
  `fileName`, data URL strings). `thumbnail.ts` hydrates the memory cache once
  (`ensureHydrated`/`loadPersistedThumbnails`), views merge it into state on
  mount. Each file is probed once per device, not once per launch. Deletion
  paths clean up: `removeTrack`/`removeTracks` delete by fileName, boot
  reconcile prunes thumbs for vanished files, `clearAll` wipes the cache
  (`resetDB` drops the store). "Check Storage" now logs thumb count + ~KB.
- **Adaptive seeks** instead of a fixed 3.5s: base
  `clamp(duration*0.1, 3s, 30s)` (short clips use `duration*0.5`), then step
  `~8%` of duration (capped 15s), max 3 attempts. Fixes "still black at 3.5s".
- **Frame validation** before accepting: mean luma must be in `[8, 245]` and
  stddev ≥ 5 (32×18 luma sample). Dark, flat/white title, or letterbox-only
  frames are rejected → next target; if all fail, store nothing and show the
  icon (a black rectangle looks broken, the icon looks intentional).
- **Seekless frame-0 path**: draw after `loadeddata` without writing
  `currentTime`; accepted only if it passes the same validation. Idle probing
  seeks first and uses frame 0 only as a fallback (frame 0 is often a title
  card/logo, which must not become the permanent thumb). During playback, frame
  0 is the only allowed result and is kept **memory-only** (provisional) so a
  later idle pass can seek and persist a representative frame.
- **Probing during playback is opt-in**: EventLog button `Probe play` (default
  OFF, localStorage `thumb-probe-during-playback`). When ON, only the seekless
  path runs (one attempt per file per playing epoch); seeks never run while
  audio plays. Default OFF keeps the hard-won "playback never shares the
  decoder with a probe" guarantee.
- **Serialized + deduped**: one probe media element at a time (`enqueueProbe`
  chain), in-flight map keyed by fileName.
- **Abort on interaction**: `useAudioEngine.seek()` dispatches `media-seek`;
  thumbnail aborts the active probe on that and on `visibilitychange → hidden`
  (`abortThumbnailProbes`), then holds a 2s cooldown so the loop does not
  immediately reopen the park window. Views gate with `canProbeNow()`.
- Probes log one line each: `thumb <name>: seekless-ok`, `seek-ok …`,
  `seekless-fallback`, `unusable …`, `aborted:seek|hidden`, `load-timeout`.
- `abortThumbnailProbes` schedules a `thumb-probes-resume` window event after
  the cooldown (and fires it immediately on visible) so loaders re-run without
  needing an unrelated render.

## Lock-screen wedge saga — model proven, posture promoted (2026-11-05..07)

Symptom (iOS 27.2, appeared after the 26.2→27.2 WebKit gap, no code change):
on video-first tracks the lock-screen seek bar is dead (snaps back) and ±10
log nothing; later it degrades into **greyed, touchless** controls (session UI
shown, touches not routed, audio plays on). Reproduces in the independent
`custom-lock-screen-media-player` repo too → WebKit-level, not engine-local.

**Proven model (device-logged):**
- `v.play()` of the muted mask video is **THE poison event**. Locks performed
  before the video ever played: healthy 10/10 (refresh + force-close) with the
  mode-flip revive. After the video once played: every lock wedged, and the
  flip no longer saves it (buttons may whiten, seek bar stays greyed/cmd „).
- The lock UI is built from a **snapshot read at lock time**. Same-set handler
  re-applies are inert (working and greyed runs emit identical apply logs);
  sessions without the flip heal only randomly (snapshot race, invisible in
  our logs — nothing differs); a **configuration change** (mode flip
  skip10⇄prevnext, ~300ms apart, applied on `visibilitychange→hidden`)
  rebuilds it deterministically (10/10).
- Drift-fix acquitted: the visible-return `drift>0.15` seek runs *after* the
  first lock (return-only; VideoSyncController was already deleted), and the
  engine already pauses+frames the video at every `hidden` — dual-play locks
  wedged anyway. The wedge is born at **establishment** (first play/swap with
  the mask playing), not at any later seek event.
- Historical lock-seek-fighting theories (probes, parked seeks, handler
  null-handoff) were acquitted one by one with device logs; aborts and probe
  markers remain as hygiene.

**Defaults since the promotion build:** `video-paused-mode=1` (frozen video
posture — the only fully lock-safe one), `lock-revive-on-hidden=1` (mode
flip), `lock-resilient-toggle=1` (inverted-icon workaround), tunable
`lock-revive-delay` (EventLog cycles 150/300/600ms, default 300),
`video-delayed-start=0`, `minimal-handlers=0`, `thumb-probe-during-playback=0`.
The boot log always begins with a `flags:` line listing the live combination
(the flags persist in localStorage across force-closes).

**Interrupt notes (iOS 27.2):** iOS interruptions surface as
`MediaSession pause (center ||)` events. Resilient ON = one-press toggle but
re-asserts play against interruptions (YouTube gets paused → our track
re-asserts → other source needs manual resume: the ping-pong). Resilient OFF
= literal presses: interruption is a single clean pause (other source takes
over after 1–2 taps) but the lock-unpause on an inverted icon can take 3
presses (`||`→`||`, `||`→`>`, `>`→plays). Unresolved: distinguishing a user
press from an interruption echo (they are byte-identical to the page).

**Interruption echo-combat (echo-aware v1/v2):** v1 (external native pause
element-event within 4s) proved BLIND at lock time — device logs show iOS
pauses our element MID-SWAP (`native pause ignored during transition` runs
exactly there and even aborts the anchor play() with AbortError), so the
transition guard swallows the very evidence needed. v2 adds the primary
rapid-pair rule: interruption echo pairs land INSIDE the same second as our
own pause (`:05`→`:05`), while a human resume re-press lands ≥1s later — so
a `pause` press while anchored within ~600ms of our own pause action is
ignored as the echo (`Rapid-pair` under `echo-aware-toggle`, default OFF;
play presses never gated; user-center fast-double unaffected — it arrives
coalesced as a play press). Windows flyout: take-over presses hit the
pair-rule too (its repeated `pause` presses are >600ms apart, unmoved).
v3: transition pause events are RECORDED as external (normal swaps emit NO
element pause at all — device logs: pre-publish → native playing (anchor),
nothing between; a transition pause = the interruption itself, and it even
aborts our play() with AbortError). Repairs the 1–2s press blindness in
conceded pauses (v1/v2 blind spot: the mid-swap external was discarded).
**Win/loss criterion (decoded):** after our concessional pause, any pause
press that resumes us before the other source establishes = our track wins
(takeover failed). Pair rule handles same-second presses; the external gate
(v3) handles 1–2s presses; presses after ~4s are treated as human. A second
YouTube tab succeeds right after a failed takeover because the stale episode
ends once one takeover cleanly completes (per-episode race, not damage).

**Lock warm-up unification (autoplay discovery, Experiment 7):** an autoplay
(track end → auto-next during a lock) makes the lock come up FULLY WARM —
correct icons, live touch routing, working seek bar, single presses, with no
manual pause/unpause first. The native pause→fresh play pair it delivers is
the missing warm-up whose absence causes ALL cold-lock symptoms (icon flip,
dead handlers/seek until first pause/unpause, triple press). Experiment 7
`lock-warm-cycle` (default OFF) reproduces it on every visible→hidden: pause
the playing track natively, resume after ~700ms on the same src
(warmCycleRef keeps store state + echo detector untouched during the pair).
Complementary to the mode-flip revive (handlers snapshot) — the warm cycle
services the touch-routing/icon layer. DEVICE RESULT: warm cycle ON → cold
locks come up correct (pause/skip/seek/handlers working, ~700ms audible gap
at the lock moment). Known fixed edge: returning to the app inside the gap
used to freeze the track (resume timer required hidden) — resume now always
restores playback. Warm gap is tunable via EventLog cycler (200/450/700ms,
default 700; shorter gaps risk iOS not registering the pair).

**Experiment 8 (armed resume):** the first press of a session takeover from
our ALREADY-PAUSED state is unattributable at arrival (we're conceded
already — no native pause of ours to contrast, so pair/external gates see
nothing). Fix under echo-aware: hold the resume ~350ms; if iOS pauses our
anchor natively inside the window (other source claiming focus), cancel and
stay conceded — the takeover wins. No event = human press → resume. Play
presses remain instant.

**Lock-screen icon flip (resilient-era observation):** under resilient
mapping the lock cycle is press=paused/icon `||`→`||`, press=playing/
icon `||`→`>` — the icon renders one event behind iOS's own element state
(same-element anchor is "playing silence" while functionally paused, so iOS
paints `||`; the load-clear at resume makes it paint the stale paused state).
A User Center pause re-syncs it. Functionally harmless under resilience
(the third catch-up press the literal mapping needed is gone); cosmetic.

**Deferred video start** (`video-delayed-start`) keeps the first ~12s
lock-safe (session establishes on audio alone) then plays the mask in-app —
opt-in motion mode; once it plays, lock safety reverts to the poisoned case.

**Isolation assets:** `public/test-session.html` (engine-free MediaSession
page, deployed at `/test-session.html`) and the separate
`custom-lock-screen-media-player-the-new-one` repo.

**Still open:** interruption/echo press disambiguation; in-app video motion
(the poison trade); `track play() timed out after 500ms` (intermittent,
dormant, first-load-after-hidden contexts); `minimal-handlers` experiment
replacement; upstream WebKit stale snapshot.

## Engine hardening — DONE (spam survival, iPhone 12 + Windows verified)
- **Swap serialization**: mutex + last-wins skip; blind retry replaced by guarded
  retry (500ms after NotSupportedError, 120ms otherwise).
- **Coalescing + 750ms floor**: index always moves, at most ~1.3Hz sustained
  swaps, one paced catch-up for the final index. Pauses/direct-resumes instant.
- **10s→500ms play bound** (`PLAY_TIMEOUT_MS`, device-tested 7/7 clean):
  wedges become ordinary failures. Watch name-vs-duration: mismatch = catching up.
- **Element rebuild** after 3 consecutive swap failures (30s cooldown) +
  hard-reset on NotSupportedError — in-app recovery, no force-close needed.
- **Deferred anchor prebuild** (800ms past the coalesce window, gen-guarded).
- **Video**: `maybePlayVideo` (canplay-gated, 1.5s cap, framed-paused fallback),
  `muted + volume 0` re-asserted ~4Hz, PlayBar prev/play/next
  `touch-action: manipulation` (no double-tap zoom).
- **Boot**: probe-only warm-up (uniform first-track load path), lockScreenMode
  localStorage fast path, re-apply handlers on play-start edge.

## Reorder saga — scroll-drift FIXED, parked-finger slot lag FIXED (2026-10-17)
**Open items closed this session:**
- **Library hold-drag flyaway — FIXED.** Root: library `DragTrackRow` set BOTH
  `whileDrag={{ scale: 1.04 }}` (framer transform) AND `scale-[1.04]` (Tailwind
  CSS `scale` property) plus `transition-colors`. The two scales compose (~8%
  larger than the size framer measured at dragstart), so the row drifted ahead
  of the finger; near an edge, framer autoscroll compounded it every frame until
  the row flew off. Grip drags never set `hold.dragging`, playlist rows never had
  the class — that's why only library hold-drags broke. Fix: dropped the Tailwind
  scale/shadow and `transition-colors` from the dragged row; `whileDrag` owns all
  scaling. Verified on iPhone: `pointerY − rowTop` constant to the pixel across a
  1554px scrolled drag (`dragtele lib` logs).
- **dragtele showed "no element" — FIXED.** Framer's `onDrag` fires with a native
  pointer event, so `e.currentTarget` was always null. Rows now measure via a real
  `rowRef` (both `TrackList` and `PlaylistsView`).
- **Parked-finger slot lag — FIXED via `src/components/ui/useScrollSlotSync.ts`.**
  Root (framer source, `check-reorder.mjs:38`): `if (!velocity[axis]) return order`
  — framer only re-evaluates slots inside pointer events AND only when vertical
  velocity is non-zero. A finger parked in the autoscroll edge keeps scrolling
  (framer's `autoScrollIfNeeded` runs on any `onDrag`, even zero-velocity ones),
  but the slot check returns early, so rows flow under the finger while order and
  the number badges freeze. The "wiggle" workaround = velocity ≠ 0 = gate opens.
  Fix: scroll-driven geometry sync — on container scroll during a drag, count row
  centers above the finger (last pointer clientY; fallback = dragged row center)
  and move the dragged id to that slot, applied through the same
  `setIds`/`onReorder` path framer uses. Fires ONLY on scroll; framer keeps the
  pointer-move path. A DOM-order == mirror guard skips frames where framer's own
  reorder hasn't rendered, so the two never fight. `syncNow()` also runs at drop
  for the last-frame scroll. New `data-drag-id` on rows, `onDragBegin(id)` wired.
  `addLog('scrollslot lib|pl: from→to')` ships for device verification.

## Reorder saga — history (pre-fix notes)
- Framer Reorder restored (13→14.2: constraint-scroll + React 19 fixes).
- Live mirror, full-order `orderByIds` commits, remount keys (track/select/
  size/resize — never order flag), grip + 600ms hold, touch blocker, haptics,
  edge autoscroll, click suppression, container touch-none while dragging.
- Custom engine (`useRowDrag.ts`) tried and DELETED: fought framer over
  `transform`, broke drop precision.
- RESOLVED 2026-10-17: library rows no longer drift/fly on scrolled drags (double
  `scale` — `whileDrag` transform + Tailwind `scale` property — removed; see the
  new section at the top of this file). Parked-finger slot lag fixed by
  `useScrollSlotSync`. `dragtele` (`lib`/`pl`: pointerY vs rowTop vs scrollTop
  @2Hz, now via `rowRef`) kept for future device verification.
- HoldRing (user-built, SMIL) + 100ms grace; EventLog copyable; global
  no-select except inputs.
- Lessons (do not repeat): `transition` with delay on Reorder items poisons
  layout/drag physics; `layoutScroll` + popLayout breaks mounting; remounting
  mid-gesture strands drags; `setLoadForce(0)` retriggered loads (double-start);
  a CSS `scale`/`transform` utility class on a `Reorder.Item` stacks with
  framer's `whileDrag` transform and desyncs measurement; framer's `onDrag`
  event is native (no `currentTarget`); framer's slot check is gated on pointer
  velocity (`check-reorder.mjs:38`), so scroll-driven reordering needs our own
  geometry pass.

## WebKit 26.2→27.2 research — wedge root-cause candidates (2026-11-09)

Research done before implementing fixes in the test env (`custom-lock-screen-media-player-the-new-one`, Freeze Exact tab).

### Timeline of the gap
Safari 26.2 = Dec 12, 2025 (`20623.1.14`, the good baseline), 26.3 = Feb 11, 26.4 = Mar 24, 26.5 = May 11, 26.6 = Jul 27, 27.0 = Sep 14, 27.2 = current. The wedge appeared in this window with no code change.

### Changes found (in likelihood order)
1. **bug 305592** (Jer Noble, committed Jan 21 2026, `305995@main`, ships ~26.3/26.4): interruptions — system **or WebKit policy, which includes entering background** — now dispatch the MediaSession `pause` action handler instead of just pausing the element. Proves our "interruption echo" observations are **designed behavior**, which is why press-vs-echo disambiguation kept failing. Companion commit bug 314264 (Tubular quirk, May 2026) documents the flip side: `play()` **during** an interruption "steals" the audio session from the other playing app — the resilient-toggle re-assert is exactly that pattern.
2. **New quirk `ShouldSuppressMediaSessionPauseActionOnInterruption`** (`MediaSession.cpp::suspendPlayback` bails out before calling the pause handler when the quirk is on): Apple ships a site-specific opt-OUT of the interruption pause action — confirms the behavior is known-problematic, but it is **not exposed to JS** (Quirks only).
3. **MediaSession now owns its own PlatformMediaSession** (same window as #1): `setPlaybackState("playing"/"paused")` now natively calls `clientWillBeginPlayback()`/`clientWillPausePlayback()`. Our frozen state declares `playbackState = "paused"` while the element is still **producing** silently (rate ~0) — in 26.2 that mismatch was inert; on 27.x it now drives WebKit's session manager. Prime suspect for inverted icon + greyed touchless controls.
4. **bug 308083** (Andy Estes, Feb 2026, `307778@main`): the audio session category model now tracks `hasPlayedAudiblySinceLastInterruption`; pausing an element **that started playing while muted** could drop the shared session from `MediaPlayback` back to `Ambient`. Our always-muted mask video and rate-0 frozen audio live exactly here — the "session alive, audio plays, controls greyed" symptom is ownership/category churn, not a hard session kill.
5. **`RequirePageVisibilityForVideoToBeNowPlaying`** preference (bug 310167, Mar 2026): Now Playing ownership for `<video>` was reworked in this window; a playing muted video at lock establishment can churn ownership against the audio element.
6. Safari 27.0 fixes relevant to us: next-track in background playlist advance (172676372), `setActionHandler` no longer throwing (178167294).

### What was implemented (test env — flags in Freeze Exact + Arena tabs, shared "27.x WebKit flags" panel)
`src/lib/flags.ts` (+ wired into `useFreezeEngine.exact.ts`, `usePlaybackEngine.arena.ts`, `audioSession.arena.ts`, `MediaTestPlayerFreezeExact.tsx`, `MediaTestPlayerArena.tsx`), persisted in localStorage key `lock-flags-27x`, boot logs a `flags:` line. Per-engine rendered meanings live in `src/components/FlagsPanel.tsx` (`kind: "freeze" | "arena"`):
- `playbackStateMode`: `standard` (26.2-style, frozen declares `paused` + rate 0) | `no-paused` (frozen declares `playing`, rate-0 position is what pauses the bar) | `untouched` (never write playbackState; spec "guessed state" rules). Tests hypothesis #3.
- `echoGate`: a `pause` action while hidden+frozen is ignored as interruption echo ("echo-gate: pause press while hidden+frozen IGNORED") instead of unfreezing = `play()` during interruption. Tests hypothesis #1.
- `videoTeardown`: on `hidden` the muted mask `<video>` src is stripped (single-media-session lock establishment, no "started playing while muted" element), re-armed + reframed on `visible`. No-decode alternative to `video-delayed-start`. Tests #4/#5.
- `audioSessionType`: `playback` | `transient` | `unset`. `transient` is a community-reported 27.x fix for another source taking over the lock screen; `unset` is apply-on-next-load only (type cannot be cleared at runtime).

### On-device verdict #1 (2026-11-09): Freeze Exact is OUTDATED on 27.2
User tested the Freeze Exact flags build on the iPhone 12 (iOS 27.2):
- The Freeze Exact anchor itself does **not** work on 27.2 — locking with a video track then waiting 30s+ **never produces lock-screen handlers** (they stay greyed), and pause → wait 30s → resume loses the audio entirely (`AbortError`-style dead element; returning to the app in-app does revive audio, but not handlers).
- **Force-close + relaunch fixes it**: correct handlers appear and the seek bar works. This means the *handlers/hooks* still function under Build 1 but the in-flight freeze/anchor posture gets Wedge-class rejected on 27.2 — consistent with the rate-0 anchor (`useFreezeEngine.exact.ts`, same shape as `useSingleElementEngine.ts`) being retired by the same WebKit changes we are hunting.
- **Testing now happens exclusively on the Arena tab** (`usePlaybackEngine.arena.ts`) — the same-element handoff engine that matches the main media player (`HOLD_RATE 1e-9` here vs `1e-7` in the main app). The four flags are wired there with per-engine semantics in the shared `FlagsPanel.tsx` (shared with the Freeze tab's panel).

### Test protocol (one flag at a time, iPhone 12 PWA + Safari tab, ARENA TAB now)
`playbackStateMode` defaults to `no-paused` (= exact shipped Arena build-1 posture) so the baseline is honest. play → lock → wait 30s+ → try the seek bar / ±10s / play-pause. Record whether controls wedge (dead bar → greyed touchless) and whether the `flags:` boot line shows the intended combination after force-close. Priority combinations: `no-paused` baseline → `standard` (media-player-like "paused while anchor") → `untouched`; then `echoGate` with each; then `videoTeardown` variants; then `audioSessionType: transient`/`unset` variants. Baseline to compare against is all flags in defaults.

Protocol notes added after user testing:
- **Default tab persistence**: the app now lands in the LAST active tab after force-close (localStorage `lock-last-tab`), removing the handler double-registration confound (previously every cold launch opened Freeze Exact and switching to Arena re-registered handlers).
- **"Arena 26.2 (archive)" tab**: verbatim pre-flag copy of the Arena engine + component (from commit `5ba1968~1`, `usePlaybackEngine.archive.ts` / `MediaTestPlayerArchive.tsx`) — pristine build-1 baseline immune to any flag state.
- **Known pre-existing gap, not flag-related**: on unpause the lock seek bar can snap to 0 (build-1 behavior). Duration-matched anchor IS present (`ensureAnchor`); remaining divergences vs the main player: `HOLD_RATE 1e-9` vs `1e-7`, the mask `<video>` never playing alongside (main player: "video muted playing alongside if video"), and shipped-loop writes `playbackState "playing"` while anchored (`standard` flag mode = the main player's actual flow). Check the `track resumed on permanent element @ X` log line: X > 0 means repositioning worked.
- A true carbon-copy port of the main player engine (`media player backup/src/hooks/useAudioEngine.ts` + `useMediaSession.ts`) is feasible but needs playerStore/OPFS adaptation — deferred until first flag results.

### Round 2 results (2026-11-09, Arena tab, iPhone 12, iOS 27.2)
All single flags behaved IDENTICALLY on-device with an audio-only session: `playbackStateMode` × 3, `echoGate` ON, `videoTeardown` ON, `audioSessionType` × 3 (playback/transient/unset). Lock handlers appeared and worked (seek bar + ±10s before AND after 30s+), `||`/`>` swap cleanly, anchor keeps session alive, no flip/triple/ping-pong. One inconsistency: all three playbackState modes showed greyed (non-applied) handlers for a couple of refreshes at some point, then recovered — same shape as `untouched` greyed-out run.
**Interpretation: in a single-media-session, audio-only environment NONE of the five hypotheses reproduces the 27.x wedge — the Arena tab is too "clean" to wedge.** Critical environment difference found on inspection: the Arena tab's mask `<video>` is ALWAYS hard-paused (`attachVideo` ends in `video.pause()`; `startVideoFrames` only nudges `currentTime`, never calls `play()`). The main player genuinely plays the muted <video> alongside the audio (TWO playing media elements at lock establishment) — that difference is now the prime reproduction condition.

New instruments added (defaults preserve build-1 behavior everywhere):
- **Video display → "Video PLAYING muted (main-player style)"** (`dual-play`): mask `<video>` genuinely plays muted alongside (kicked + drift-synced >0.35s in rAF, paused when the anchor takes over) — replicates the main player's dual-playing-session environment. Next test target.
- **holdRate flag** (`1e-9` test app default | `1e-7` main player): removes the last engine-constant divergence from the main player.
- **Unpause snap fix (v1)**: on resume the engine published the freshly-swapped element's `media.currentTime`, which iOS reads back as 0 until metadata lands → lock bar flashed to 0 for a split second on every unpause. Now publishes the requested (`frozenPos`) position instead. Pure publish-path change; no session mechanics touched. (Same `track resumed @ X > 0` logs VP.)
- **Snap v2**: the v1 publish still churned the lock bar during hidden remote-resume (element timeline reset vs our setPositionState). Hidden resume publishes are now SKIPPED (anchor state already carries exactly duration/frozenPos) and re-published on visible. In-flight fix, verify on device.
- YouTube-takeover two-press: iOS can kill the session WITHOUT dispatching our pause handler (element paused, engine still believes track playing → UI stuck "playing"), so the first in-app press "paused again" into the anchor and only the second resumed. Added **reconcile**: `togglePlay`/`remotePause` check the element's real `paused` state — track-owner + already-paused ⇒ direct resume / ignore, no anchor freeze.

### Round 3 results (2026-11-10) — dual-play ALSO no wedge; the carbon copy is the remaining path
- **`dual-play` video bug found + fixed**: with dual-play active, `loadTrack` only attached the mask video for `styleRef.current === "dual"` (dual-play fell through to `detachVideo()`) and the style effect never re-ran on track change — the video never mounted on load/auto-advance. All of the user's观察 workarounds (toggle to dual → pause/unpause → toggle back; or load first, then switch) re-ran the effect. Fixed: attach for `dual-play` in `loadTrack`, and the style effect now deps on `currentIndex` so auto-advance re-attaches.
- **Catch-up parity**: main player resyncs the video to the audio on return-to-app; test env kept a stale frame. Added: on visible, dual-play video is seek-synced to the audio + re-published position. 
- **Device result with a working dual-play (workaround-applied): STILL NO WEDGE** under the full flag matrix — playbackState × 3, echoGate on/off/nothing, videoTeardown, audioSessionType × 3, holdRate 1e-7 vs 1e-9 (waited 30 min+ on 1e-7; session persisted — the "30s kill" flag is inverted-quiet mode territory, irrelevant here). `untouched` → handlers greyed (guessed state doesn't qualify the lock UI on 27.x — falsified for this engine; keep standard/no-paused).
- **Conclusion: the test env cannot reproduce the 27.2 wedge even in the main player's two-playing-elements environment.** Remaining candidate differences for the wedge in the MAIN player: thumbnail probe videos (extra <video> elements from the library view), OPFS+IndexedDB sources vs blob URLs, long-lived store/session, VideoSyncController seek behavior while hidden, artwork size, app-standby/lifetime. Next step agreed: build the carbon copy tab of the main player (`media player backup` engine) verbatim-adapted, and bisect from there.

### Round 4 (2026-11-10) — carbon copy delivered + two new data points
- **dual-play attach fix verified on device**: works on first toggle, no ritual.
- **Snap persists despite v1+v2 publish fixes** → the flash is iOS-internal on the element-timeline reset of a src swap, not our setPositionState churn. Carbon copy comparison ordered (main player claims to be snapless with the SAME swap mechanics — sanity-check that on the copy on 27.2).
- **videoTeardown KILLED the media session irrecoverably** when strip ran on a PLAYING mask video (dual-play): no reviving by pause/unpause, refresh, or disabling flags; user recovered only by moving off `transient` audioSession.type + switching handler mode (session TYPE is runtime-clearable per our lib design — leaves the page in a mixable state where YouTube audio plays ALONGSIDE our track). INTERPRETATION: stripping a LIVE playing element at lock establishment is destructive; this is also the first time ANY manipulation changed session survival — the video element's state at lock establishment is load-bearing. Guard added: teardown now only strips a PARKED (paused) video; a playing one is paused and left intact ("teardown skipped strip: mask video was playing"). 
- **Windows repeat loop in Arena pause** ("the same second repeating audibly, no real pause" + `native playing event (anchor)` + `handlers refreshed` looping ~every second): suspect Chromium pipeline stall at `HOLD_RATE 1e-9` (below Chromium's internal epsilon → waiting/playing refire loop) — precisely why the main player settled on **1e-7** and a `FALLBACK_HOLD_RATE 0.0625` try/catch. The holdRate flag already exposes 1e-7 — instruct: on Windows set holdRate=1e-7; full logs requested to confirm the mechanism.
- **CARBON COPY TAB added** ("Main player (carbon copy)"): whole-tree copy of `media player backup/src` → `src/main-copy/` (@ `b5e2c76`), unmodified, mounted by `MediaTestPlayerMainCopy.tsx`. Own zustand store + own IndexedDB (no name collisions), its own MediaSession lifecycle (only one tab mounted at a time). Deps added: zustand, idb, framer-motion. tsconfig: added `DOM.AsyncIterable` lib for OPFS directory iterators. Bundle 661 KB single-file (fine).

### Round 5: carbon copy results — snap root-caused, interruption echo captured, backup vintage identified
- **Copy is SNAPLESS while Arena snaps** with identical swap mechanics → root cause isolated to publish/position ordering. The copy's `activateSource` pins `media.currentTime = position` AND declares `playbackState` **BEFORE** `await playPromise` (its headline commit `b5e2c76`), so iOS never draws the element's freshly-reset element-zero timeline. Arena did everything after the await → the flash. PARITY FIX implemented in Arena `activateSource`: pre-await currentTime pin + declared state (archive tab keeps the old ordering as the A/B baseline). Verify: Arena unpause should now be snapless like the copy/player.
- **Interruption echo captured double-dispatch evidence** in the copy's logs: every lock `||` press logs `MediaSession pause (center ||)` TWICE (bug 305592's interruption dispatch, byte-identical echo) → engine routes first press while placeholder → `remotePause → pause → resume` (`pause while placeholder → resume`), the queued play races the swap (`placeholder swap failed: AbortError`) and both ends up resuming — matches the user's "override whatever the other source is" report and finally maps the historic flip-around/triple-press vocabulary onto a concrete log signature.
- **No triple/ping-pong** in copy; handlers work on first track once applied; interruption-override bug present — i.e. the copy reproduces the main player's REAL 27.x misbehavior. The wedge-adjacent bisection target is now live inside the test env.
- **Backup vintage identified**: the copy's IndexedDB hit `VersionError: requested version (3) < existing (5)` — the deployed main player's own DB, same Pages origin. Implications: (a) `media player backup` is an OLDER snapshot than the deployed PWA; every "the main player has a fix for this" difference (thumbnail batch lag/black frames, track delete/OPFS purge) is the missing later fixes, not new bugs. (b) Same-origin DB access needed isolation: copy now uses `media-player-db-copy` (renamed; also protects the real library from copy writes). (c) The copy's CSS pinned `html/body/#root` globally killing test-page scroll — scoped to `#main-copy-root` (88vh wrapper). (d) Recommendations: refresh the copy from the LIVE main player source once available to inherit the deployed fixes verbatim; console `Permissions-Policy: unrecognized feature` warnings are GitHub Pages response headers — unrelated noise.

### Round 6 (2026-11-10) — Arena = no snap on-device (confirmed post-deploy-rerun); Windows freeze hold; paused-navigation keep-alive; copy refreshed from LIVE source
- **Arena is now snapless on device** (user confirmed after the deploy rerun): unpauses clean, seek handlers incl. drag bar + ±10s intact, 51-track playlist fine, YouTube interrupt flawless (YouTube overrides cleanly; returning resumes; anchor parked state resumes with one press — the reconcile from round 3 at work).
- **Windows repeat loop persists at holdRate=1e-7** → not a rate eps. error; the src-swap keep-alive itself confuses desktop Chromium's audio pipeline. User's mute suggestion adopted: **platform-aware pause** (`IS_APPLE_MOBILE`): on desktop (Windows/mac) `pause()` NO LONGER swaps src — freeze-engine posture instead: element keeps playing at `volume 0.001` + rate 0 (fallback 0.0625), new owner state `frozen` (blue chip in HandoffStatus), volume/rate restored inline at resume (direct-resume branch + loadIndex resets). `frozen` SessionOwner added (new exhaustive map entry). iOS path byte-identical.
- **Paused-navigation session kill fixed**: prev/next pressed while user-paused then left idle → loaded-but-not-playing element expired the iOS session. `loadIndex` now schedules a `loadedmetadata` re-anchor: builds a fresh duration-matched silent WAV for the NEW track and activates it at position 0 synchronously as possible — one tap = play, session never expires. Caveat: that play() is requested outside a gesture stack; if iOS ever rejects it the log line will read `placeholder swap failed` (best-effort no-regression).
- **Remaining Arena nit**: prev while *playing* pauses audio (extra unpause needed to play the previous track) — by current design (anchor take-over on pause), user wants it changed for smoothness.
- **Carbon copy REFRESHED from the live main player source** (`media-player/src`, 37 files — the deployed build with delete tracks + thumbnail-batch fixes, DB v5 schema with `thumbs` store): the round-5 "backup is older" symptoms (black thumbnails, no track deletion) are expected gone. Re-applied scope patches: `media-player-db-copy`, #main-copy-root viewport/skin. Next: verify copy parity against deployed PWA, then bisect the interruption tussle at replica fidelity.

### Round 7 (2026-11-11) — Windows resilient mapping VERIFIED; spam-proofing regression root-caused (sticky intent fix); standard playbackState discipline falsified for the interruption anchor
- **Windows freeze hold + resilient press mapping verified on device**: pause → unpause via the user center now works (`frozen hold: pause press = resume`); pausing again works. Note: Chromium keeps `||` while frozen (element-derived icon, element is playing-muted) — cosmetic, the press under it works. **Interruptions smooth on BOTH Windows and iOS** — no wedge, no takeover tussle, contradicting the expected resilience-ON wedge from the main player. Arena keeps winning every comparison.
- **Spam-proofing regression root-caused from the user's log**: spam-backwards while playing captured `autoplay=false` during the swap's owner=idle window (`ownerRef` is unreliable mid-swap) → the paced catch-up loaded the final track as *paused navigation* → parked anchor + silence instead of playing. THE fix: sticky `playIntentRef` (true from play request until a real pause; `requestNav` reads it at catch-up FIRE time, so a play press during the coalesce window makes the catch-up play). This also explains most of the "UI shows one track, audio sounds like another" spam confusion (anchor-parked state + ≤750ms UI-ahead-of-audio window, which is inherent to the coalescing model and matches the main player).
- **User suggestion adopted (parked takeover)**: the parked re-anchor now yields to a play intent — `parked skip: play intent arrived → track takes over`. Covers "unpause was my last action before idle" → audio resumes immediately on return, no anchor dance.
- **Single-press unpause restored** (echoGate-conditional reconcile): with the flag OFF (default), a pause press reaching a paused track element = user intent → resume. With echoGate ON, the interrupted-reality ignore is preserved (resuming would steal the session back — bug 314264 pattern).
- **playbackState discipline `standard` (anchor=paused) FALSIFIED for the interruption anchor on iOS 27.2**: triple-tap pause/unpause every single time (echo delivers presses as pause regardless of declaration → declared-paused icon mismatch loops through resume). `no-paused` and `untouched` clean. The shipped no-paused posture wins again.
- **One session-kill still seen during long spam** (log: coalesced spam → 63s idle → session dead → `play` recovered via direct-resume on the track element): retest with sticky-intent fix; wrap-around navigation + the (now-fixed) parked state are the suspects.

### Round 8 (2026-11-11) — COMBO BISECTION COMPLETE: the winning posture is fully mapped; iOS spam officially smooth
- **Winning combo (all verified on-device, Arena)**: playbackState `no-paused` (always playing) + **echoGate ON** + videoTeardown OFF + audioSession `playback` (or `unset`). Interruptions, handlers on first lock (incl. seek bar with muted video), parking, 2-minute parked lock unpause — all clean.
- **Every alternative falsified**: `standard` anchor-paused → triple-tap pause/unpause (round 7); **echoGate OFF → the YouTube override/ping-pong returns** (the interrupted-reality ignore in remotePause is LOAD-BEARING for interruptions — this pins the override bug on the echo handling, a real bisection result); audioSession `transient` → session killed on backwards spam (falsified for this posture).
- **iOS backwards spam officially smooth**: no pause states, no session kills through long spam incl. wrap-around and a large list — the round-7 kill did NOT reproduce. Coalescing pacing accepted: audio keeps playing during spam (UI ≤750ms ahead, same model as the main player).
- **"building same-element placeholder" during autoplay spam = BY DESIGN**: the engine's global `loadedmetadata` handler pre-builds the anchor on every track load (handoff mode) so a later iOS pause swap is instant; no activation follows, no visible effect. Not a bug.
- **Windows**: pause/unpause verified; simultaneous YouTube+track audio observed = Edge tab mixing quirk, not ours. Backup of the workspace replaced with this build by the user.
- **Remaining test checklist before port**: dual-play style + interruption; videoTeardown ON (parked-video path); repeat one/all end-of-list; force-close relaunch → Arena tab restore; soak (parked >5min); interruption DURING parked anchor / Windows frozen hold.
- **Port spec (proposed)**: transplant the Arena engine into the main player over its store/IDB/OPFS layer; pin flags to the winning combo as constants (keep the flags line in logs for diagnostics). Arena consumes blob URLs; main player derives blob URLs from IndexedDB — adaptation is modest (PlaylistTrack ≈ Track + duration).

### Round 9 (2026-11-11) — ARENA ENGINE PORTED INTO THE CARBON COPY (posture graft, commit b6a5e98)
- **Remaining matrix cells all passed on-device** (user): dual-play + interruption = single-tap YouTube win; videoTeardown ON = no difference (guarded path + video re-arm confirmed); repeat all/one clean incl. lock-handler restarts (shuffle not in test env — verify post-port); force-close relaunch behavior expected (Arena holds no library); >5min parked soak + interruption-while-paused = still one tap; Windows frozen + interruption = YouTube takes the paused session cleanly. User-center vs lock-screen button desync noted = iOS's own two-button inconsistency.
- **Port strategy — posture graft, NOT a rewrite**: the copy's engine already shares Arena's skeleton (same-element swap, coalesced nav @ 750ms floor, bounded play(), swap mutex, boot probe, video/reorder/store plumbing). What it lacked was Arena's session semantics, so the port replaced ONLY the session layer in `main-copy/hooks/useAudioEngine.ts` (+ `useMediaSession.ts`):
  1. **No-paused posture**: `getLockPlaybackState` now declares the anchor "playing" (it IS playing silence) — was "paused", the triple-tap source. Parked navigation anchors override to "paused" at their call sites (incl. both visibility-refresh writes).
  2. **Simple echo gate**: hidden + anchored pause press = ignored (bug 305592). The whole echo-aware machinery (pair windows, external-pause gates, `armConfirmedResume`, `resumeArmTokenRef`, ECHO/PAIR/CONFIRM constants) RETIRED — round 8 proved the simple gate wins.
  3. **Engine-aware center presses (resilient pinned)**: both play and pause route through `remotePauseOrResume`; it decides from engine reality — frozen → resume; parked → resume; hidden+anchored → echo-ignore; element-paused-track (interruption reality) → ignore; else pause(). `useMediaSession` no longer consults `isLockResilientToggle`.
  4. **Windows frozen hold**: desktop `pause()` no longer swaps src — volume 0.001 + rate 0 (new owner `frozen`), playbackState "paused", volume/rate restored on direct resume + fresh loads. The visible→hidden deferred-anchor machinery is bypassed (iOS swaps immediately, arena-style); `pendingAnchorPosRef` paths remain as dead-but-harmless code.
  5. **Parked-nav keep-alive**: non-autoplay loads on Apple mobile schedule a `loadedmetadata` re-anchor (duration-matched WAV, declared "paused"); a play intent makes the track take over (`parked skip: play intent arrived`). Sticky `playIntentRef` set in play()/loadTrack, cleared in pause().
- Kept intact: store/IDB URL derivation, video attach/mask handling, thumbnail probes, shuffle/repeat/reorder, boot probe, volume, warm-cycle + video experiments (flag-gated, OFF). Boot log now prints the pinned posture line.
- **Next**: on-device verification of the copy with the ported engine (full regression pass), then — if clean — the same graft into the LIVE `media-player/src` engine. If the ported copy still wedges, the delta is NOT the posture → bisection continues inside the copy's environment (thumbnail probes, OPFS sources, store cadence).

### Round 10 (2026-11-11) — POSTURE EXONERATED; the wedge lives in the copy's residual machinery; Phase-A churn elimination deployed
- **Device verdict on the ported copy** (user, all legacy flags off): interruption tussle + triple-tap + handler-attach issues ALL return — i.e. the copy with Arena's session semantics behaves like the original copy. **This exonerates the posture**: no-paused + echo gate + resilient presses are necessary (round 8) but NOT sufficient. The wedge is in the copy's residual differences from Arena.
- **Key symptom**: triple-tap ONLY on the FIRST lock, then single-press works — a "settled state" signature, pointing at churn that runs around play-start/track-change time. (Minimal-handlers already defaults ON, so per-track re-applies were already skipped.)
- **Phase A deployed (commit 1c84dc6)** — churn elimination to arena parity: (1) RETIRED the App play-start-edge `reapplyHandlers` (ungated in-active-session re-apply on every unpause — arena never does this); (2) RETIRED the iOS 26.2-era 120ms + 500ms re-publish timers in `activateSourceInner`; (3) RETIRED the direct-resume 120ms corrective re-publish. Round-8 rationale: extra playbackState/positionState churn on 27.2 feeds the mismatch loops; arena publishes exactly once per activation.
- **Remaining known copy↔arena structural differences (Phase B candidates, in order of suspicion)**: (a) the ASYNC GAP — copy's `loadTrack`/`activateSource` await IDB URL derivation + the swap mutex BEFORE src set, so `play()` never runs in the raw gesture stack; arena sets src synchronously (test env has File-derived URLs). Suspect for the spam swap-failure/500ms-timeout symptoms. (b) thumbnail probe videos at lock establishment (load-bearing for copy seeks — round-4 finding; leave alone unless falsified). (c) `awaitPlay` 500ms timeout + element rebuild machinery (symptom management, harmless when healthy). (d) UX deltas: copy prev-while-paused autoplays (arena parks), next-at-end no-ops (arena pauses) — not wedges.
- **Decision tree**: Phase A clean → bisect which retirement mattered (likely none needed — proceed to live-player graft). Phase A still wedged → Phase B: make the track URL available synchronously (cache blob URLs / preload adjacent) so the swap path matches arena's zero-await gesture stack.

### Round 11 (2026-11-11) — PHASE A VERDICT: triple-tap FIXED (churn was the cause); tussle root found (onPause playbackState write); Phase-B URL cache deployed (commit dad39d0)
- **Phase A on-device results** (user): triple-tap GONE — single tap pause/unpause even after refresh (the play-start-edge re-apply + re-publish churn WAS the triple-tap cause). Windows pause/unpause still clean. Library features (thumbs, delete, drag-reorder, playlists, shuffle/repeat) unaffected. Still broken: interruption tussle; handlers don't attach on refresh + failing seeks (the retired play-start-edge reapply was ALSO the copy's only post-refresh attach path — boot apply lands before iOS has a session, minimal-applies skips track changes); spam still kills the session after enough next/prev (next track doesn't load until return to app, repeated swap failure + 500ms awaitPlay timeout).
- **Tussle root cause found by arena diffing**: arena's `onPause` NEVER writes playbackState — it only flips store state. The copy's onPause additionally wrote `getLockPlaybackState('anchor')`, which the round-9 port made an UNCONDITIONAL 'playing' — i.e. the copy re-asserted "I am playing" from inside an interruption, on every native pause iOS used to hand the session to YouTube. That declared-vs-element mismatch feeds iOS's reconcile echo (round-8 pattern) → echo dispatches play → track steals the session back → paused again → re-asserted → ping-pong = the track-repeatedly-overrides-YouTube tussle. FIX: onPause now flips store state only (arena parity).
- **Refresh-attach fix**: one-shot `firstLoadAppliedRef` apply in useMediaSession — applies the handler set ONCE at the first loaded track per page load (bounded churn, unlike the retired per-unpause edge apply). Boot apply + mode toggles unchanged.
- **Phase B deployed: track-URL cache** (in `main-copy/lib/idb.ts`, the single choke point): LRU Map (max 5) of fileName→blob URL. `getTrackFileURL` returns cache hits synchronously (zero await between gesture and src — matches arena's zero-await stack); the old 26.2-era belief "caching loses the PWA gesture" is falsified by arena (rounds 7-8). Correctness: fileName is unique per import RUN only, so `saveTrackFile`/`deleteTrackFile`/`clearTrackFiles` invalidate entries (delete + re-import with same name must not serve stale audio). The sounding URL (`setActiveTrackUrl`, called at every blobUrlRef assignment) is never revoked; eviction/invalidation revokes around it. Engine side: loadTrack revokes only non-cached URLs (audit fixed the stale-gen abandon + boot-probe-audio revoke points that would have poisoned cache-owned URLs), and `preloadAdjacent(idx)` warms the cache with idx±1 after every load (background, never awaited) so even first-playthrough nav is cache-hit.
- Targets: spam session-death (hidden IDB awaits stretching under throttling → swap fail → awaitPlay 500ms timeout), and interruption responsiveness. **Next**: on-device — (1) interruption (tussle should be gone with the onPause fix), (2) refresh → handlers attach + seeks work, (3) sustained spam both directions incl. wrap-around (session should survive; watch 'cache hit (zero-await)' + 'preload cached' log lines), (4) delete a track then re-import same-named file and play it (cache invalidation check), (5) quick regression: parked nav, Windows freeze, video, playlists.

### Round 12 (2026-11-12) — PHASE B VERDICT: spam-proofing CONFIRMED FIXED; remaining cluster = handler-attach reliability (commit f6b852d)
- **Phase B on-device results** (user): sustained spam as fast as possible, both directions, incl. repeat+shuffle — session never dies. Delete + re-import same-named file plays the NEW file (cache invalidation verified). Triple-tap still gone. Windows pause + dual-play (both sources overlap = expected desktop behavior) + session keep-alive all clean. Playlists follow new order. **Spam-proofing, the round-11 headline, is officially fixed.**
- **Interruption narrowed**: 2 taps / 1 interruption vs arena's 1 tap / 0. Pause-first sequence = 0 interruptions (echo gate catches: hidden+anchored press ignored). Root hypothesis ties to handlers: with the handler set greyed/missing at interruption time, iOS answers with its NATIVE default play/pause acting directly on our paused element — that native play IS the "1 interruption". Arena always has handlers attached → 0.
- **Decisive user observation**: with minimal-applies ON (the old default), the handler set does NOT survive a track change on 27.2 — the lock buttons grey out ON THE TAP. With minimal OFF (per-track re-apply), spam + handlers stay live indefinitely. ⇒ Per-track re-apply is REQUIRED; the round-10 minimal-applies premise (same-set re-applies inert) is falsified for the round-9+ posture. The round-10 triple-tap fix came from the play-start-edge apply retirement + re-publish timer retirement, NOT from minimal-applies.
- **Round-12 fixes**: (1) `isMinimalHandlers` default flipped to FALSE (per-track re-apply restored; user already validated spam works under it). (2) One-shot `firstPlayAppliedRef` apply at the FIRST play per page load in App — covers the refresh hole (boot/first-load applies land before iOS accepts a session; first play is the first gesture-adjacent attach moment) with bounded churn, unlike the retired per-unpause edge apply.
- **Seek handlers**: still fail on video tracks unless video-paused-mode is ON (they even appear after manual reapply but don't act until pause+resume). Known round-4 finding: parked thumbnail probes are load-bearing for copy seeks. Parked as Phase C — engine stability first.
- **Next on-device**: (1) interruption retest — expect 0 interruptions/1 tap now that handlers stay attached through track changes (the native-default-play path requires a missing set); (2) refresh → tap same track → lock → handlers live without pause/unpause (watch 'first-play one-shot handler apply'); (3) EventLog should print minimal-handlers=0 (note: if localStorage has the flag explicitly set, clear it or toggle once); (4) spam + triple-tap watch (per-track apply could theoretically refeed churn — watch the first lock); (5) regression skim. If interruption = 0, the copy matches arena everywhere except seeks/video-paused → the LIVE-PLAYER PORT becomes the next move (same graft sequence: posture + onPause parity + URL cache + handler-attach scheme).

### Round 13 (2026-11-12) — refresh-attach FIXED; handler set survives nav + spam (no greying, no triple-tap); 1-interruption delta persists → hide-time playbackState writes retired (commit 6e5ebbc)
- **Round-12 build results** (user): refresh handlers apply after regular refresh AND force-close; minimal-handlers=0 confirmed persistent; no triple-taps anywhere incl. first lock; spam still solid, no session death; next/prev no longer grey the handlers; playlists/drag-reorder/thumbnails (cached across refresh)/deletion (no residue) all clean; arena sanity check re-confirmed 0 interruptions there.
- **Interruption delta persists**: playing-interruption = 1 interruption/2 taps (paused-interruption = 0). Since handlers ARE attached now, the native-default-play hypothesis is dead — the steal is OUR code. Line-by-line arena diff found a real copy-only delta: **arena's visibilitychange handler does NOTHING on hide** (only handles visible), while the copy's hide handler wrote `playbackState='playing'` on every hide for both track kind and non-parked anchor kind. Per the bug-305592 research note, 27.x playbackState writes have NATIVE side effects — `'playing'` calls `clientWillBeginPlayback()`, i.e. a playback claim fired exactly while the takeover hands the session to YouTube = the steal. The paused-first case stays clean because there the hide (and its write) happens BEFORE YouTube starts, not mid-handoff.
- **Fix (commit 6e5ebbc)**: both hide-time playbackState writes retired (track-kind write + non-parked anchor write); the PARKED anchor keeps its hide-time 'paused' declaration (one-press-resume contract). publishPosition on hide kept (last-known-good for the lock bar; not a playback claim). Visible-side writes left untouched this round (minimal delta; visible-time writes can't fire mid-handoff).
- **Phase C status (video seeks with video-paused OFF)**: read of `seek()` shows it already syncs BOTH elements (audio + mask video) and aborts probes via 'media-seek' — the plumbing is fine; the failure is which timeline iOS's lock binds to when TWO elements play (dual-play). Empirical anchors: video-paused ON = works (single playing timeline); pause+resume = works; autoplay = re-enables. Needs discriminating logs before a fix: on a failed seek with video-paused OFF, does `seek X.XXs (source=...)` appear in the EventLog? Does the in-app position move? That separates "handler never fires" from "seek runs but lock bar bound to the mask video's timeline".
- **Next on-device**: (1) interruption retest — if the hide-write removal kills the delta, the copy matches arena everywhere and the LIVE-PLAYER PORT is next; if still 1, capture the EventLog around the steal moment (the log already discriminates every candidate: 'MediaSession play/pause' lines = press-routed steal; 'track → placeholder swap'/'track resumed' without a MediaSession line = automatic dispatch steal; no engine play logs = mask-video session reshaping per bug 308083). (2) failed-seek log capture (above) for Phase C.

### Round 14 (2026-11-12) — hide-write retirement VERIFIED: interruption FIXED + Phase-C seeks FIXED; last bug = stochastic refresh greying → revive-on-hidden (flag currently OFF in user's storage)
- **Interruption FIXED** (user, both directions): single tap now concedes to YouTube / resumes our track — the 16:59 log shows the clean concede (`remote pause ignored: element already paused (interrupted reality)`, no steal). The round-13 hide-time playbackState-write retirement was the delta. **The copy now matches arena on every engine behavior.**
- **Phase-C seeks FIXED by the same retirement** (no code touched): with video-paused OFF + dual-play, the 13:51 log shows `seek 31.60s (source=track)` firing while hidden with both bars syncing. Interpretation: the hide-time 'playing' claim was what iOS bound the lock scrubber against (native claim mid-handoff + seek → bar bound to the wrong timeline). Removed → single clean binding. The parked-probe machinery stays untouched (round-4 finding preserved).
- **Regression skim clean**: mass seeks, single-press pause/unpause, first-lock triple-tap absent, spam proofing holds with coalescing visible and no errors, playlists/reorder/deletion fine, Windows pause/unpause fine.
- **Last bug — stochastic refresh greying** (returns after regular refresh / fast lock after play; force-close relaunch always fine): discriminating logs show the applies ALL fire in failing runs (boot + first-load + first-play one-shot) but iOS ignores them when the lock comes <~1s after playback start (working run had ~8s settle). The session isn't established when the registrations land; once hidden nothing re-applies.
- **Remedy already in the build**: `lock-revive-on-hidden` (handler-only mode flip at hide, 300ms restore — the empirically proven un-grey from rounds 1-5; same-set re-applies are inert, flips aren't). Its DEFAULT is ON but the user's localStorage carries an explicit OFF from earlier A/B toggling (boot line lock-revive-on-hidden=0) → user toggles it ON. It makes NO playbackState writes, so it cannot reintroduce the interruption steal; watch for regression anyway since it fires every hide (the now-sacred handoff moment).
- **Open question (prevnext scrubber)**: user reports the lock scrubber unusable with prevnext mode as saved default even after force close (handlers guaranteed live). seekto is registered in BOTH modes, so mode shouldn't matter — need one discriminating log: drag the scrubber with live prevnext handlers → does 'seek X.XXs' appear? Splits "scrubber not shown by iOS" from "drag doesn't dispatch".
- **State**: engine behavior now matches arena everywhere tested. Remaining before the LIVE-PLAYER PORT: (1) revive-on-hidden retest (greying fix + interruption-regression watch), (2) prevnext scrubber classification, (3) final-port UX deltas to reconcile (prev-while-paused autoplays vs arena parks; next-at-end no-op vs arena pauses; shuffle exists only in the copy/live player, not arena).

### Round 15 (2026-11-12) — revive-on-hidden VERIFIED (greying fixed 0/32, no interruption regression); prevnext scrubber was the greying; small-library sustained-spam session death fixed via hidden-rebuild deferral (commit cd34903)
- **Revive retest** (user set delay 150ms): 32 refresh/swap tests, ZERO missing/stuck handler sets (the flip+restore at hide lands after the session settles). No interruption regression — YouTube still wins in one tap. The user's flag was OFF only because of the all-off baseline discipline; the flag is now part of the working combo.
- **Prevnext scrubber mystery resolved**: it was the greying all along — with live handlers the scrubber drags fine in both modes; `seekto` is registered regardless of mode. No separate bug.
- **Windows note (platform, not actionable)**: the Windows media overlay greys the ±10 buttons (seekbackward/forward) — only prev/next/scrubber appear usable. Recorded as a platform limitation for the live-port expectations.
- **Small-library sustained-spam session death** (3-track playlist or 3-track library, moderate ~1/s spam, wrap-around): log chain = `play() timed out after 500ms` ×3 → **`rebuilding media element (#3)` while hidden** → session dead on return (|| shown, no audio). Large libraries didn't hit it because bursts ended before failures accumulated; a 3-track wrap sustains spam indefinitely. The REBUILD is the killer: it destroys the session-owning element while hidden.
- **Fix (commit cd34903)**: (1) `rebuildMediaElement` never runs while hidden — it arms `hiddenRecoveryRef='rebuild'` and defers; the wedged element keeps holding the (stale) session until visible. (2) Hidden stand-down in `loadTrack`: at 2+ consecutive swap failures while hidden, stop attempting swaps entirely (each retry deepens the wedge); the index change stays pending. (3) Visible recovery branch: serves the deferred rebuild (which reloads the current index = the pending catch-up) or a direct `loadTrack(curIdx)`, then returns. Net: hidden spam can no longer destroy the session; recovery happens in front of the user.
- **Deferred observation**: during paced catch-up the just-activated track plays ~0.4s (a few notes) before the next correction — inherent to per-press swaps at moderate rates (fast spam collapses silently via the coalescer; arena behaves the same). Not a defect.
- **Next on-device**: (1) small-library spam retest incl. the extreme both-presses case — expect session to survive, recovery on return; (2) confirm the deferred-rebuild log lines (`rebuild deferred (hidden)` → `hidden recovery on visible: rebuild`); (3) full regression skim (the stand-down touches loadTrack's entry — watch normal hidden nav, parked nav, playlist nav). If clean → the LIVE-PLAYER PORT is next (graft sequence: posture, onPause parity, URL cache, handler-attach scheme incl. one-shots, hide-write parity, revive-on-hidden as anti-grey, hidden-rebuild deferral; plus UX-delta reconciliation: prev-while-paused parking, next-at-end pause, shuffle).

### Open
- Whether bug 305592's interruption-pause fires at every lock (background-entry) or only for true system interruptions — the echoGate log line answers it on device (if the gate ever fires on a plain lock with no other audio active, background-entry counts).
- `no-paused` may regress the pre-27 frozen-bar interpolation math — if the bar starts running while frozen, that combination is falsified for iOS ≤ this build, revert to `standard`.

