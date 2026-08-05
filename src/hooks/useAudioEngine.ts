import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'


let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null
let sourceNode: MediaElementAudioSourceNode | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
    gainNode = audioContext.createGain()
    gainNode.connect(audioContext.destination)
  }
  return audioContext
}

export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  const {
    isPlaying,
    currentTrackIndex,
    volume,
    isMuted,
    queue,
    setPlaying,
    setCurrentTime,
    setDuration,
    setCurrentTrackIndex,
  } = usePlayerStore()

  const currentTrack = queue[currentTrackIndex]

  const createAudioElement = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
      audioRef.current.addEventListener('timeupdate', () => {
        setCurrentTime(audioRef.current?.currentTime ?? 0)
      })
      audioRef.current.addEventListener('loadedmetadata', () => {
        setDuration(audioRef.current?.duration ?? 0)
      })
      audioRef.current.addEventListener('ended', () => {
        handleTrackEnd()
      })
      audioRef.current.addEventListener('error', () => {
        console.error('Audio playback error')
        setPlaying(false)
      })
    }
    return audioRef.current
  }, [])

  const handleTrackEnd = useCallback(() => {
    const { repeatMode, queue, currentTrackIndex } = usePlayerStore.getState()
    if (repeatMode === 'one') {
      const audio = audioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play()
      }
      return
    }
    if (currentTrackIndex < queue.length - 1) {
      setCurrentTrackIndex(currentTrackIndex + 1)
    } else if (repeatMode === 'all') {
      setCurrentTrackIndex(0)
    } else {
      setPlaying(false)
    }
  }, [setCurrentTrackIndex, setPlaying])

  const loadTrack = useCallback(async (trackIndex: number) => {
    const { queue } = usePlayerStore.getState()
    const track = queue[trackIndex]
    if (!track) return

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    const url = await getFileURLFromOPFS(track.fileName)
    if (!url) {
      console.error('File not found in OPFS:', track.fileName)
      return
    }
    blobUrlRef.current = url

    const audio = createAudioElement()
    audio.src = url
    audio.load()

    try {
      await audio.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }, [createAudioElement, setPlaying])

  const play = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return

    if (audioContext?.state === 'suspended') {
      await audioContext.resume()
    }

    try {
      await audio.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }, [setPlaying])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    setPlaying(false)
  }, [setPlaying])

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause()
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const seek = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time
      setCurrentTime(time)
    }
  }, [setCurrentTime])

  const nextTrack = useCallback(() => {
    const { currentTrackIndex, queue } = usePlayerStore.getState()
    if (currentTrackIndex < queue.length - 1) {
      setCurrentTrackIndex(currentTrackIndex + 1)
    }
  }, [setCurrentTrackIndex])

  const prevTrack = useCallback(() => {
    const { currentTrackIndex, currentTime } = usePlayerStore.getState()
    if (currentTime > 3) {
      seek(0)
    } else if (currentTrackIndex > 0) {
      setCurrentTrackIndex(currentTrackIndex - 1)
    }
  }, [setCurrentTrackIndex, seek])

  const goToTrack = useCallback((index: number) => {
    setCurrentTrackIndex(index)
  }, [setCurrentTrackIndex])

  // Load track when index changes
  useEffect(() => {
    if (currentTrack && queue.length > 0) {
      loadTrack(currentTrackIndex)
    }
  }, [currentTrackIndex, currentTrack?.id])

  // Update volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  // Apply per-track volume via Web Audio API GainNode
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return

    const ctx = getAudioContext()

    if (!sourceNode && audioRef.current) {
      sourceNode = ctx.createMediaElementSource(audioRef.current)
      sourceNode.connect(gainNode!)
    }

    const { trackVolumes } = usePlayerStore.getState()
    const trackGain = trackVolumes[currentTrack.id] ?? 1

    if (gainNode) {
      gainNode.gain.setTargetAtTime(trackGain, ctx.currentTime, 0.01)
    }
  }, [currentTrack, currentTrack?.id])

  // Cleanup
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  return {
    play,
    pause,
    togglePlay,
    seek,
    nextTrack,
    prevTrack,
    goToTrack,
    loadTrack,
    audioRef,
  }
}
