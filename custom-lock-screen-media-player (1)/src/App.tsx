import { useState, useRef, useEffect, ChangeEvent } from 'react';

interface MediaFile {
  file: File;
  url: string;
  type: 'video' | 'audio';
}

export default function App() {
  const [mediaFile, setMediaFile] = useState<MediaFile | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const animationFrameRef = useRef<number>(0);

  // Handle file selection
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check if it's a video or audio file
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/') || file.name.endsWith('.mp4');
    
    if (!isVideo && !isAudio) {
      alert('Please select a video or audio file (MP4 supported)');
      return;
    }

    const type = isVideo ? 'video' : 'audio';
    const url = URL.createObjectURL(file);
    
    setMediaFile({ file, url, type });
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    
    // Clean up old object URL if exists
    if (mediaRef.current) {
      const oldMedia = mediaRef.current as HTMLVideoElement | HTMLAudioElement;
      if (oldMedia.src) {
        URL.revokeObjectURL(oldMedia.src);
      }
    }
  };

  // Initialize media element when file is set
  useEffect(() => {
    if (!mediaFile) return;
    
    // Clean up any existing animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // Create appropriate media element
    const mediaElement = mediaFile.type === 'video' 
      ? document.createElement('video') 
      : document.createElement('audio');
    
    mediaElement.src = mediaFile.url;
    mediaElement.volume = volume;
    mediaElement.controls = false;
    
    // Set up event listeners
    const handleTimeUpdate = () => {
      setCurrentTime(mediaElement.currentTime);
      
      // Update Media Session position state
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setPositionState({
          duration: mediaElement.duration || 0,
          position: mediaElement.currentTime,
          playbackRate: mediaElement.playbackRate,
        });
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(mediaElement.duration || 0);
      
      // Update Media Session metadata
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: mediaFile.file.name.replace(/\.[^/.]+$/, ''),
          artist: 'Media Player',
          album: 'User Upload',
          artwork: [],
        });
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    };

    mediaElement.addEventListener('timeupdate', handleTimeUpdate);
    mediaElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    mediaElement.addEventListener('ended', handleEnded);
    
    mediaRef.current = mediaElement;

    // Set up Media Session action handlers
    const setupMediaSession = () => {
      if (!('mediaSession' in navigator)) return;

      // Set playback state
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

      // Action handlers - ONLY seekbackward/seekforward for 10-second skip buttons
      // Do NOT set previoustrack/nexttrack handlers
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          mediaElement.play().catch(e => console.error('Play error:', e));
          setIsPlaying(true);
          navigator.mediaSession.playbackState = 'playing';
        });

        navigator.mediaSession.setActionHandler('pause', () => {
          mediaElement.pause();
          setIsPlaying(false);
          navigator.mediaSession.playbackState = 'paused';
        });

        // These handlers enable the 10-second skip buttons on iOS lock screen
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const skipTime = details.seekOffset || 10; // Default 10 seconds
          mediaElement.currentTime = Math.max(0, mediaElement.currentTime - skipTime);
          setCurrentTime(mediaElement.currentTime);
          
          // Update position state
          navigator.mediaSession.setPositionState({
            duration: mediaElement.duration || 0,
            position: mediaElement.currentTime,
            playbackRate: mediaElement.playbackRate,
          });
        });

        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const skipTime = details.seekOffset || 10; // Default 10 seconds
          mediaElement.currentTime = Math.min(
            mediaElement.duration || 0,
            mediaElement.currentTime + skipTime
          );
          setCurrentTime(mediaElement.currentTime);
          
          // Update position state
          navigator.mediaSession.setPositionState({
            duration: mediaElement.duration || 0,
            position: mediaElement.currentTime,
            playbackRate: mediaElement.playbackRate,
          });
        });

        // This handler enables the seek bar on iOS lock screen
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (details.seekTime != null) {
            mediaElement.currentTime = details.seekTime;
            setCurrentTime(details.seekTime);
            
            // Update position state
            navigator.mediaSession.setPositionState({
              duration: mediaElement.duration || 0,
              position: details.seekTime,
              playbackRate: mediaElement.playbackRate,
            });
          }
        });

        // Stop handler
        navigator.mediaSession.setActionHandler('stop', () => {
          mediaElement.pause();
          setIsPlaying(false);
          navigator.mediaSession.playbackState = 'paused';
        });
      } catch (error) {
        console.error('Media Session error:', error);
      }
    };

    setupMediaSession();

    // Cleanup
    return () => {
      mediaElement.removeEventListener('timeupdate', handleTimeUpdate);
      mediaElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      mediaElement.removeEventListener('ended', handleEnded);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      // Clean up object URL
      URL.revokeObjectURL(mediaFile.url);
    };
  }, [mediaFile, volume]);

  // Update playback state when isPlaying changes
  useEffect(() => {
    if (!mediaRef.current || !('mediaSession' in navigator)) return;
    
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // Update volume
  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = volume;
    }
  }, [volume]);

  // Play/pause toggle
  const togglePlay = async () => {
    if (!mediaRef.current) return;
    
    const mediaElement = mediaRef.current;
    
    if (isPlaying) {
      mediaElement.pause();
      setIsPlaying(false);
    } else {
      try {
        await mediaElement.play();
        setIsPlaying(true);
      } catch (error) {
        console.error('Play failed:', error);
        // Try again with user interaction
        mediaElement.play().catch(e => console.error('Second play attempt failed:', e));
      }
    }
  };

  // Seek to position
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
      setCurrentTime(time);
      
      // Update Media Session position state
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setPositionState({
          duration: duration,
          position: time,
          playbackRate: mediaRef.current.playbackRate,
        });
      }
    }
  };

  // Skip backward 10 seconds
  const skipBackward = () => {
    if (mediaRef.current) {
      const newTime = Math.max(0, mediaRef.current.currentTime - 10);
      mediaRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setPositionState({
          duration: duration,
          position: newTime,
          playbackRate: mediaRef.current.playbackRate,
        });
      }
    }
  };

  // Skip forward 10 seconds
  const skipForward = () => {
    if (mediaRef.current) {
      const newTime = Math.min(duration, mediaRef.current.currentTime + 10);
      mediaRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setPositionState({
          duration: duration,
          position: newTime,
          playbackRate: mediaRef.current.playbackRate,
        });
      }
    }
  };

  // Format time display (MM:SS or HH:MM:SS for long durations)
  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Remove media file
  const removeMedia = () => {
    if (mediaRef.current) {
      const mediaElement = mediaRef.current;
      mediaElement.pause();
      
      // Clean up object URL
      if (mediaElement.src) {
        URL.revokeObjectURL(mediaElement.src);
      }
      
      // Clean up event listeners
      mediaElement.removeEventListener('timeupdate', () => {});
      mediaElement.removeEventListener('loadedmetadata', () => {});
      mediaElement.removeEventListener('ended', () => {});
    }
    
    setMediaFile(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-center mb-2">
            iOS Media Player Test
          </h1>
          <p className="text-center text-slate-400">
            Upload MP4 file • Play media • Lock screen to see controls
          </p>
        </header>

        {/* File Upload Section */}
        <section className="bg-slate-800/50 rounded-xl p-6 mb-8 border border-slate-700">
          <h2 className="text-xl font-semibold mb-4">Upload Media File</h2>
          <p className="text-slate-400 text-sm mb-4">
            Select an MP4 video or audio file to play. The media will continue playing 
            when you leave the app or lock your screen.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4">
            <label className="flex-1 cursor-pointer">
              <input
                type="file"
                accept="video/mp4,audio/mp4,video/*,audio/*"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="bg-violet-600 hover:bg-violet-700 transition-colors rounded-lg p-4 text-center font-medium">
                {mediaFile ? 'Change File' : 'Select MP4 File'}
              </div>
            </label>
            
            {mediaFile && (
              <button
                onClick={removeMedia}
                className="bg-slate-700 hover:bg-slate-600 transition-colors rounded-lg p-4 font-medium"
              >
                Remove
              </button>
            )}
          </div>
          
          {mediaFile && (
            <div className="mt-4 p-3 bg-slate-700/30 rounded-lg">
              <p className="text-sm">
                <strong>File:</strong> {mediaFile.file.name}
              </p>
              <p className="text-sm text-slate-400">
                Type: {mediaFile.type} • Size: {(mediaFile.file.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
          )}
        </section>

        {/* Player Section */}
        {mediaFile && (
          <section className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
            <h2 className="text-xl font-semibold mb-4">Now Playing</h2>
            
            {/* Media Element (hidden, we use custom controls) */}
            {mediaFile.type === 'video' ? (
              <video
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                className="hidden"
                playsInline
                webkit-playsinline
                x5-playsinline
              />
            ) : (
              <audio
                ref={mediaRef as React.RefObject<HTMLAudioElement>}
                className="hidden"
              />
            )}

            {/* Custom Player UI */}
            <div className="space-y-6">
              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-slate-400">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
                
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-500"
                />
              </div>

              {/* Playback Controls */}
              <div className="flex items-center justify-center gap-4 md:gap-8">
                <button
                  onClick={skipBackward}
                  className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 transition-colors disabled:opacity-50"
                  disabled={currentTime <= 0}
                  title="Skip back 10 seconds"
                >
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                    <path d="M12 4.5C7 4.5 3 8.5 3 12s4 7.5 9 7.5 9-7.5 9-7.5-4-4-9-4zm0 13c-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7-3.14 7-7 7z"/>
                    <text x="12" y="16" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold">10</text>
                  </svg>
                </button>
                
                <button
                  onClick={togglePlay}
                  className="p-4 rounded-full bg-violet-600 hover:bg-violet-700 transition-colors shadow-lg shadow-violet-500/25"
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                  )}
                </button>
                
                <button
                  onClick={skipForward}
                  className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 transition-colors disabled:opacity-50"
                  disabled={currentTime >= duration}
                  title="Skip forward 10 seconds"
                >
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M14.5 12L6 6v12l8.5-6zm-11-2.5L10 12l-6.5 2.5V7.5z"/>
                    <text x="18" y="16" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold">10</text>
                  </svg>
                </button>
              </div>

              {/* Volume Control */}
              <div className="flex items-center gap-4">
                <svg className="w-5 h-5 text-slate-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                </svg>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-500"
                />
                <svg className="w-5 h-5 text-slate-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                </svg>
              </div>
            </div>

            {/* Instructions */}
            <div className="mt-6 p-4 bg-violet-600/10 border border-violet-500/20 rounded-lg">
              <h3 className="font-semibold mb-2">📱 iOS Lock Screen Controls:</h3>
              <ol className="text-sm text-slate-400 space-y-1">
                <li>1. Upload an MP4 file and press Play</li>
                <li>2. Lock your iPhone (press side button)</li>
                <li>3. Wake your phone - you should see the media controls</li>
                <li>4. The controls should show <strong>10-second skip buttons</strong> (⏪10 and 10⏩) with a working seek bar</li>
                <li>5. If you see &lt;&lt; and &gt;&gt; arrows instead, the Media Session wasn't set up correctly</li>
              </ol>
              <p className="mt-3 text-xs text-violet-400">
                Note: This uses the Media Session API with seekbackward/seekforward handlers to enable 
                the 10-second skip buttons on iOS lock screen.
              </p>
            </div>
          </section>
        )}

        {/* Empty State */}
        {!mediaFile && (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-slate-800/50 mb-6">
              <svg className="w-10 h-10 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">No media selected</h3>
            <p className="text-slate-400">Upload an MP4 file to begin testing</p>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-8 pt-6 border-t border-slate-700 text-center text-sm text-slate-500">
          <p>Media Player Test App • Built with React + Vite + Media Session API</p>
        </footer>
      </div>
    </div>
  );
}
