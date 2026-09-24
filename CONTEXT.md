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

## Fix 2026-09-16 — Storage investigation + diagnostic tools + thumbnails restored
**Investigation**: Tested whether thumbnails caused storage leak — they did NOT. Thumbnails restored.

**Confirmed Safari browser bug**: `getStorageEstimate()` stays at ~1089MB after deleting all tracks on iOS Safari. Safari "webdata" drops to 3.2MB, but `getStorageEstimate()` stays high. Only after force-close Safari does `getStorageEstimate()` drop to 0.65MB. Documents and Data stays at ~1.16GB until force-close. **This is a Safari bug — deleted OPFS/IndexedDB space is not released until the browser restarts.**

**Fixes applied (though insufficient to solve the Safari bug)**:
- `clearAllTracks()` calls `db.close(); dbInstance = null` after clearing
- `clearFileBlobs()` calls `db.close(); dbInstance = null` after clearing
- `resetDB()` no longer calls `await getDB()` — database is deleted and closed
- `clearOPFS()` calls `navigator.storage.estimate()` after clearing to trigger recalculation
- `clearAll()` logs warning and shows toast: "Safari may need a restart to fully release storage"

**Diagnostic tools added**:
- "Check Storage" button in EventLog calls `getStorageEstimate()` + `debugOPFS()`
- `window.getStorageEstimate()` and `window.debugOPFS()` exposed for console testing
- `EventLog.tsx` footer documents console commands

**Thumbnails**: Restored in `LibraryView.tsx` and `PlaylistsView.tsx` — confirmed NOT the cause of storage issues.

## Planned Features
1. **Skip mode toggle**: Switch between ±10s skip buttons and prev/next track buttons on lock screen. Test app has working implementation — simple `setMode()` toggle between `skip10` and `prevnext`. To integrate into main app settings or as a one-button cycle.
*done*
2. **Playlist feature** — *DONE 2026-09-15* ✓
   *base done 2026-09-15*: `PlaylistItem {id, trackId, order, addedAt}` dupes allowed, `Playlist {items}` is ordered refs, `TRACKS_STORE` single source, `OPFS` once, `DB_VERSION 4` migrates legacy `tracks[]` → `items[]` (`src/lib/types.ts:15`, `src/lib/idb.ts:4`). `usePlaylists.ts` create/add/play, `PlaylistsView` `src/components/playlist/PlaylistsView.tsx` + `AddToPlaylistSheet`, `Library` Select → Add to playlist (clears + jumps to Playlists) and Playlists `+ Create` / `Play` per `items` order. Library stays `createdAt` for now.
3. **low prio brother complaints**: addding a value system that influences the fisher yates algorythm based on values given by the user so that a certain track has a higher or lower chance of appearing when using the shuffle.
4. **low prio complaints2**: adding a stack feature where the user can add a track to a stack on top or below a queue which would play first over the current playlist preferably inside of a playlist so you can isolate each stack.
5. adding a manual grouping feature where users can sort their ow tracks in cases where auto grouping misses some tracks.
6. **low prio brother complaints3**: being able to set a sound value to each track which is that a certain track plays at a certain volume.
7. giving the app a better visual makeover with animations, startup and menu.
8. adding fullscreen mode to the video which would work for when you tilt the phone horizonatally for example or just a button tha t gives fullscreen.
9. making the group play in the groups order instead of the quee. (once playlists are implemented.)
10. allowing users to modify the order of the queue in a playlist or in the library queue mode.

