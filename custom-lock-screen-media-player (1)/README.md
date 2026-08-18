# iOS Media Player Test App

This is a simple web application that demonstrates how to properly configure the Media Session API to get the desired iOS lock screen controls with 10-second skip buttons and a functional seek bar.

## Problem Solved

The user was experiencing an issue where their iOS web app showed lock screen controls with `<<` and `>>` arrows (next/previous track) instead of the desired 10-second skip buttons (`⏪10` and `10⏩`) with a working seek bar.

### Root Cause

The Media Session API on iOS displays **different lock screen interfaces based on which action handlers you register**:

- **Interface 1 (Desired)**: 10-second skip buttons + functional seek bar → Triggered by `seekbackward` and `seekforward` handlers
- **Interface 2 (Undesired)**: `<<` and `>>` arrows + non-functional seek bar → Triggered by `previoustrack` and `nexttrack` handlers

**You cannot have both sets of handlers active at the same time on iOS.**

The user's original code had both sets of handlers registered, causing iOS to show the wrong interface.

## Solution

This app demonstrates the correct approach:

1. **Only register** `seekbackward` and `seekforward` handlers (not `previoustrack`/`nexttrack`)
2. **Always register** `seekto` handler for the seek bar functionality
3. **Continuously update** the Media Session position state as playback progresses
4. **Set proper metadata** (title, artist, artwork) for the lock screen display

## How to Use

1. Open the app in Safari on your iPhone
2. Upload an MP4 file (video or audio)
3. Press the Play button
4. Lock your iPhone (press the side button)
5. Wake your phone - you should see the media controls with:
   - 10-second skip buttons (⏪10 and 10⏩)
   - A functional seek bar
   - Play/Pause button
   - Volume control

## Technical Details

### Media Session API Setup

```typescript
// Only set these handlers for 10-second skip buttons
navigator.mediaSession.setActionHandler('seekbackward', (details) => {
  const skipTime = details.seekOffset || 10;
  mediaElement.currentTime = Math.max(0, mediaElement.currentTime - skipTime);
  // Update position state
  navigator.mediaSession.setPositionState({
    duration: mediaElement.duration,
    position: mediaElement.currentTime,
    playbackRate: mediaElement.playbackRate,
  });
});

navigator.mediaSession.setActionHandler('seekforward', (details) => {
  const skipTime = details.seekOffset || 10;
  mediaElement.currentTime = Math.min(
    mediaElement.duration,
    mediaElement.currentTime + skipTime
  );
  // Update position state
  navigator.mediaSession.setPositionState({
    duration: mediaElement.duration,
    position: mediaElement.currentTime,
    playbackRate: mediaElement.playbackRate,
  });
});

// Required for seek bar functionality
navigator.mediaSession.setActionHandler('seekto', (details) => {
  if (details.seekTime != null) {
    mediaElement.currentTime = details.seekTime;
    // Update position state
    navigator.mediaSession.setPositionState({
      duration: mediaElement.duration,
      position: details.seekTime,
      playbackRate: mediaElement.playbackRate,
    });
  }
});

// DO NOT set these handlers if you want 10-second skip buttons
// navigator.mediaSession.setActionHandler('previoustrack', ...);
// navigator.mediaSession.setActionHandler('nexttrack', ...);
```

### Key Requirements for iOS

1. **PWA Support**: The app should be installable as a PWA (Progressive Web App) for best results
2. **Audio Focus**: The media must be playing when the user locks the screen
3. **Position Updates**: Continuously update `navigator.mediaSession.setPositionState()` as the media plays
4. **Handler Timing**: Set action handlers **after** the media element is created and ready

### iOS Limitations

- iOS only shows **one set** of skip buttons: either 10-second skips OR next/previous track
- The seek bar only works if you handle `seekto` and continuously update position state
- You cannot customize the button icons or layout on iOS lock screen
- The skip interval defaults to 10 seconds but can be customized via `details.seekOffset`

## References

- [Media Session API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API)
- [Web.dev: Media Session API](https://web.dev/articles/media-session)
- [Stack Overflow: iOS Media Session controls](https://stackoverflow.com/questions/76245015/media-session-api-on-ios-16-does-it-require-name-url-of-website)

## Build & Run

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

Then open `http://localhost:5173` in your browser or deploy the `dist` folder to a web server.

## Testing on iOS

1. Add the app to your home screen (PWA install)
2. Open from home screen (not Safari)
3. Upload and play a media file
4. Lock your phone and verify the controls
