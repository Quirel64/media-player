import { create } from 'zustand'
import type { Track, RepeatMode } from '../lib/types'

interface PlayerStore {
  isPlaying: boolean
  currentTrackIndex: number
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  shuffleOn: boolean
  repeatMode: RepeatMode
  queue: Track[]
  originalOrder: Track[]
  trackVolumes: Record<string, number>
  setPlaying: (playing: boolean) => void
  setCurrentTrackIndex: (index: number) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setQueue: (tracks: Track[]) => void
  setOriginalOrder: (tracks: Track[]) => void
  setTrackVolume: (trackId: string, volume: number) => void
  getCurrentTrack: () => Track | null
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  isPlaying: false,
  currentTrackIndex: 0,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isMuted: false,
  shuffleOn: false,
  repeatMode: 'off',
  queue: [],
  originalOrder: [],
  trackVolumes: {},

  setPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTrackIndex: (index) => set({ currentTrackIndex: index }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration: duration }),
  setVolume: (volume) => set({ volume, isMuted: volume === 0 }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  toggleShuffle: () => set((s) => ({ shuffleOn: !s.shuffleOn })),
  cycleRepeat: () =>
    set((s) => ({
      repeatMode: s.repeatMode === 'off' ? 'all' : s.repeatMode === 'all' ? 'one' : 'off',
    })),
  setQueue: (tracks) => set({ queue: tracks }),
  setOriginalOrder: (tracks) => set({ originalOrder: tracks }),
  setTrackVolume: (trackId, volume) =>
    set((s) => ({ trackVolumes: { ...s.trackVolumes, [trackId]: volume } })),
  getCurrentTrack: () => {
    const { queue, currentTrackIndex } = get()
    return queue[currentTrackIndex] ?? null
  },
}))
