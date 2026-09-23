f = r'C:\Users\markn\Downloads\development\game projects\file player\media-player\CONTEXT.md'
s = open(f, encoding='utf-8').read()
old = '7. **Library reorder on reload \u2014 FIXED 2026-09-06**: 64-track screenshot showed duplicates at 30/34 after restart. Root: `getAllTracks()` key-order (UUID random) scattered insertion order. Fix: `Track.createdAt` + `by-createdAt` index + playlist-first load (`useFolderPicker.ts:236`, `idb.ts:122`). Library vs Playlist confusion noted \u2014 see `## Library Ordering & Display`.\n\n\n## Planned Features'
new = '''7. **Library reorder on reload \u2014 FIXED 2026-09-06**: 64-track screenshot showed duplicates at 30/34 after restart. Root: `getAllTracks()` key-order (UUID random) scattered insertion order. Fix: `Track.createdAt` + `by-createdAt` index + playlist-first load (`useFolderPicker.ts:236`, `idb.ts:122`). Library vs Playlist confusion noted \u2014 see `## Library Ordering & Display`.
8. **Duration carryover bug \u2014 FIXED 2026-09-15**: double-tapping a track or next-track caused the bar duration to carry over from the old track. Root: `onTimeUpdate` overwrote `frozenPosRef.current` back to the stale position between `loadTrack` resetting it and `play()` reading it. Fix: `loadTrack` seeks `mediaRef.current.currentTime = 0` so `onTimeUpdate` updates `frozenPosRef` to 0. Also reads `media.duration` directly if `media.src` is unchanged so `onLoadedMetadata` isn't needed.
9. **Playlist dupe video black screen \u2014 FIXED 2026-09-15**: playlist duplicate tracks (same `fileName`, different `instanceId`) caused `play()` to revoke the cached blob URL and re-derive it. The video element's `src` pointed to the revoked URL \u2192 black screen. Fix: `activateSource` now does `v.src = url; v.load()` for video tracks. Also changed URL revocation check from `prevTrackIdRef.current !== track.id` to `prevFileNameRef.current !== track.fileName` so same-file dupes don't trigger unnecessary revocation.
10. **Seek bar freeze \u2014 FIXED 2026-09-15**: double-tapping the same track left `trackDurationRef.current = 0` because `onLoadedMetadata` didn't re-fire for the same `media.src`. Fix: `loadTrack` reads `mediaRef.current.duration` directly and sets `trackDurationRef.current`/`setDuration` if valid.

## Playlist feature \u2014 COMPLETE 2026-09-15
All core functionality verified on iOS 26.2 PWA + Windows:
- `PlaylistItem {id, trackId, order, addedAt}` dupes allowed, `Playlist {items}` ordered refs
- `usePlaylists.ts`: `createPlaylist`, `addTracksToPlaylist`, `deletePlaylist`, `playPlaylist`, `removeTracksFromPlaylist`
- `PlaylistsView.tsx`: Tracks/Queue/Edit modes, 2\u00d72 thumbnails, playing indicator, Select All in header
- `AddToPlaylistSheet.tsx`: select tracks \u2192 choose/create playlist
- Library Select \u2192 Add to Playlist (clears selection + jumps to Playlists tab)
- Every track tap forces fresh load (`frozenPos=0`, `v.load()`, `instanceId`-based `loadTrack` re-trigger)
- Lock screen: `skip10` mode, `remotePauseOrResume` resilient toggle, `HOLD_RATE=1e-7` session keeping
- Build ~414kB. Known benign: `video resume failed` in logs (benign `onPlaying` `v.play()` rejection, caught silently)

## Planned Features'''
assert old in s, f'NOT FOUND. Around line 131:'
idx = s.find('7. **Library reorder on reload')
print(repr(s[idx-5:idx+200]))
s2 = s.replace(old, new, 1)
assert s2 != s, 'NO REPLACEMENT'
open(f, 'w', encoding='utf-8').write(s2)
print('OK - CONTEXT.md updated')
