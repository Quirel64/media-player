# iOS 27.x WebKit media-session behavior changes (device-proven)

**Purpose**: platform-level rules extracted from the 27.2 wedge saga (rounds 2–21,
Nov 2026). Written so future fixes target a *rule*, not a symptom. Every rule is
backed by on-device logs from an iPhone 12 (iOS 27.2, Safari + standalone PWA);
WebKit bug references where known. Test env: `custom-lock-screen-media-player`
(copy tab = current engine, Arena tab = reference engine, Archive tab = pre-flag
baseline). Full round-by-round log: `CONTEXT.md`.

**Baseline**: on iOS 26.2 the same engine code ran a write-heavy posture
(frequent `playbackState`/`positionState` republishes, hide-time writes,
per-track handler churn, literal press routing) without the wedge. Every rule
below is a *change* observed between 26.2 and 27.2.

---

## Rule 1 — Session action dispatch is state-blind and echo-prone

**Rule**: WebKit dispatches media-session actions (`play`/`pause`) based on its
own internal state machine, not on the app's declared `playbackState`. Three
device-proven dispatch patterns:

1. **Press kind is unreliable**: lock-screen / user-center presses arrive as
   the `pause` action even when the UI shows the opposite affordance and the
   session declares the matching state (WebKit bug 305592).
2. **Interruption auto-dispatch**: when another app begins audible playback,
   WebKit auto-dispatches a `pause` action to background sessions — no user
   press involved.
3. **Cross-app reconcile pair**: when another app's playback *begins or
   resumes* while our session is paused, WebKit dispatches a `pause`→`play`
   pair to our session within the same second (proven 14:11 log: pressing play
   *inside the YouTube app* delivered `pause` + `play` to our session). The
   `play` half is the system reconciling, not user intent.

**Consequence**: a handler that routes on press kind or press count will act on
system-initiated dispatches as if they were user intent.

**Fix pattern**: classify every press by *engine reality* (element state, source
kind) + *echo context* (recent external pause evidence, ignored-press
recency). Never honor a play action unconditionally.

---

## Rule 2 — Declarative state writes are now native playback claims

**Rule**: `mediaSession.playbackState` and `setPositionState()` writes act as
native playback claims (`clientWillBeginPlayback`): writing `playing` asserts
route ownership at the OS level.

- A write during a takeover handoff (interruption) asserts ownership *against*
  the incoming app → steal/tussle behavior (the 1-interruption delta).
- A write that mismatches element reality feeds a native **reconcile loop**:
  iOS notices the mismatch and dispatches corrective actions back at the app
  (Rule 1, pattern 3) — the dispatch storm that wedged sessions.
- Hide-time writes fire exactly while the session is being handed off.

**Consequence**: state writes are no longer "display hints"; they are claims
with side effects.

**Fix pattern**: write `playbackState`/`positionState` exactly once per state
transition, *after* the element settles; never write on hide; never write from
`onPause`; never re-assert against a native pause.

---

## Rule 3 — Session liveness is stricter and element-bound

**Rule**: the media session's survival is tied to a *specific element* staying
active.

- An element that is paused or truly silent loses the session within ~30s.
  Keeping a *playing* silent element (WAV at rate ~0) holds the route while
  "paused" (the anchor keep-alive).
- Destroying or rebuilding the session-owning element **while the page is
  hidden** kills the session outright, with no recovery path until the page is
  visible again (proven: small-library sustained-spam session death).

**Fix pattern**: never tear down or rebuild the session-owning element while
hidden — defer recovery to visible. While paused-by-intent, keep a silent
playing element alive rather than relying on the declared state.

---

## Rule 4 — Gesture/activation requirements tightened

**Rule**: programmatic `play()` on a media element requires activation.

- A *fresh* element (no activation history) rejects `play()` outside a
  user-gesture stack with `NotAllowedError`.
- **Media-session action presses grant full activation** — a `play()` from a
  session press handler succeeds even while the page is hidden.
- Activation is per-element and persists: an element that has played once can
  be played programmatically again (within the same gesture chain — see Rule 6
  for the async-gap caveat).

**Consequence**: async work (IndexedDB round-trips) between the gesture and
`play()` can fall outside the gesture window on cache misses.

**Fix pattern**: keep the audio source one synchronous step from the press
(blob-URL cache with zero-await hits); treat `NotAllowedError` as
"needs a gesture, not a wedge"; park after rebuilds instead of autoplaying.

---

## Rule 5 — Hidden-page timers are clamped harder

**Rule**: `setTimeout` in a hidden page fires at ~1s+ granularity regardless of
the requested delay (pre-existing, but now interacts with every sub-second
background schedule).

**Consequence**: a 150ms flip/restore sequence on hide lands seconds late —
visible on the lock screen as lingering handler flips; a 500ms `play()` timeout
fires late relative to real progress.

**Fix pattern**: don't rely on precise sub-second timing while hidden; use
element/event state as the authority instead of timeouts.

---

## Rule 6 — Event-loop starvation under churn: promises lag reality

**Rule**: under heavy event churn (hidden page + rapid handler/metadata
updates), promise resolutions can be starved far past any reasonable timeout
while the element is *actually performing* the action — `play()` rejected
"timed out" with the track audibly playing.

**Consequence**: timeout-based failure detection produces false failures →
failure-counting machinery (rebuilds, stand-downs) triggers on healthy
elements.

**Fix pattern**: classify a timeout by checking element state (`paused`,
`ended`, current src) before counting it as a failure; the element is the
authority, the promise is not.

---

## Targeting guide (symptom → rule → pattern)

| Symptom | Rule | Pattern |
|---|---|---|
| Lock controls greyed / handlers dead | 1, 2 | engine-aware presses; write-once-on-settle; handler-apply hygiene |
| Session/player dies after hidden churn | 3 | never rebuild while hidden; keep-alive element |
| Player steals from / loses to other apps | 1, 2 | echo classification; no writes during handoff; pause→play pair filter |
| Silent after resume / NotAllowedError | 4 | zero-await URL cache; gesture classification; parked reloads |
| Seeking while locked wedges | 2 | no hide-time writes |
| Lock-screen scrubber/name/duration mismatch | 2, 6 | publish once on settle; element-state authority |
| Background schedules land late | 5 | event/state-driven logic |
