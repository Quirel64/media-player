import { useCallback } from 'react'
import type { Track } from '../lib/types'
import { saveTracks, getAllTracks, savePlaylist, clearAllTracks, deleteTrack, getPlaylist } from '../lib/idb'
import { saveFileToOPFS, clearOPFS, deleteFileFromOPFS } from '../lib/opfs'
import { generateTrackId } from '../lib/shuffle'
import { usePlayerStore } from '../stores/playerStore'

const MEDIA_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|mp4|m4v|webm|avi|mkv|mov)$/i
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|avi|mkv|mov)$/i
const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']

function isMediaFile(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true
  return MEDIA_EXTENSIONS.test(file.name)
}

function isVideoFile(file: File): boolean {
  if (VIDEO_MIME_TYPES.includes(file.type) || file.type.startsWith('video/')) return true
  return VIDEO_EXTENSIONS.test(file.name)
}

function getUniqueFileName(existingNames: Set<string>, originalName: string): string {
  if (!existingNames.has(originalName)) {
    existingNames.add(originalName)
    return originalName
  }
  let counter = 1
  const ext = originalName.lastIndexOf('.')
  const base = ext > 0 ? originalName.slice(0, ext) : originalName
  const suffix = ext > 0 ? originalName.slice(ext) : ''
  while (existingNames.has(`${base} (${counter})${suffix}`)) {
    counter++
  }
  const unique = `${base} (${counter})${suffix}`
  existingNames.add(unique)
  return unique
}

async function processFiles(
  files: File[],
  existingQueue: Track[],
  setQueue: (t: Track[]) => void,
  setOriginalOrder: (t: Track[]) => void,
  setCurrentTrackIndex: (i: number) => void
): Promise<Track[] | null> {
  const mediaFiles = files.filter(isMediaFile)

  if (mediaFiles.length === 0) return null

  const folderName =
    mediaFiles[0].webkitRelativePath?.split('/')[0] || 'Selected Files'

  const existingNames = new Set<string>(existingQueue.map((t) => t.fileName))
  // Map from uniqueFileName back to original File for duration lookup
  const fileMap = new Map<string, File>()

  const tracks: Track[] = await Promise.all(
    mediaFiles.map(async (file) => {
      const uniqueFileName = getUniqueFileName(existingNames, file.name)
      fileMap.set(uniqueFileName, file)

      const track: Track = {
        id: generateTrackId({
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        }),
        name: file.name.replace(/\.[^/.]+$/, ''),
        fileName: uniqueFileName,
        size: file.size,
        lastModified: file.lastModified,
        duration: 0,
        artist: extractArtist(file.name),
        album: extractAlbum(file.name),
        folderName,
        mediaType: isVideoFile(file) ? 'video' : 'audio',
      }

      try {
        await saveFileToOPFS(uniqueFileName, file)
      } catch (e) {
        console.error('Failed to save file to OPFS:', file.name, e)
      }

      return track
    })
  )

  // Get durations using the original File objects
  for (const track of tracks) {
    const file = fileMap.get(track.fileName)
    if (file) {
      try {
        const url = URL.createObjectURL(file)
        const el = track.mediaType === 'video' ? document.createElement('video') : new Audio()
        await new Promise<void>((res) => {
          const timeout = setTimeout(() => {
            URL.revokeObjectURL(url)
            res()
          }, 5000)
          el.onloadedmetadata = () => {
            clearTimeout(timeout)
            const d = el.duration
            track.duration = Number.isFinite(d) && d > 0 ? d : 0
            URL.revokeObjectURL(url)
            res()
          }
          el.onerror = () => {
            clearTimeout(timeout)
            URL.revokeObjectURL(url)
            res()
          }
          el.src = url
        })
      } catch {
        // duration stays 0
      }
    }
  }

  const combined = [...existingQueue, ...tracks]

  // Save ALL tracks to IndexedDB (not just new ones)
  await saveTracks(combined)

  // Use a consistent ID so the library playlist gets updated, not duplicated
  const existingPlaylist = await getPlaylist('library')
  const playlist = {
    id: 'library',
    name: 'Library',
    tracks: combined,
    createdAt: existingPlaylist?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  await savePlaylist(playlist)

  setQueue(combined)
  setOriginalOrder(combined)
  setCurrentTrackIndex(existingQueue.length)

  return tracks
}

export function useFolderPicker() {
  const setQueue = usePlayerStore((s) => s.setQueue)
  const setOriginalOrder = usePlayerStore((s) => s.setOriginalOrder)
  const setCurrentTrackIndex = usePlayerStore((s) => s.setCurrentTrackIndex)

  const pickFolder = useCallback(async (): Promise<Track[] | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
      input.multiple = true
      input.accept = 'audio/*,video/*'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        if (files.length === 0) { resolve(null); return }
        const existingQueue = usePlayerStore.getState().queue
        const result = await processFiles(files, existingQueue, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }

      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const pickFiles = useCallback(async (): Promise<Track[] | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = 'audio/*,video/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.wma,.opus,.mp4,.m4v,.webm,.avi,.mkv,.mov'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        if (files.length === 0) { resolve(null); return }
        const existingQueue = usePlayerStore.getState().queue
        const result = await processFiles(files, existingQueue, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }

      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const loadSavedTracks = useCallback(async (): Promise<Track[]> => {
    const tracks = await getAllTracks()
    if (tracks.length > 0) {
      setQueue(tracks)
      setOriginalOrder(tracks)
      setCurrentTrackIndex(0)
    }
    return tracks
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const clearAll = useCallback(async () => {
    await clearAllTracks()
    await clearOPFS()
    setQueue([])
    setOriginalOrder([])
    setCurrentTrackIndex(0)
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const removeTrack = useCallback(async (track: Track) => {
    // Remove from OPFS
    await deleteFileFromOPFS(track.fileName)
    // Remove from IndexedDB
    await deleteTrack(track.id)
    // Update queue
    const { queue, currentTrackIndex, originalOrder } = usePlayerStore.getState()
    const newQueue = queue.filter((t) => t.id !== track.id)
    const newOriginalOrder = originalOrder.filter((t) => t.id !== track.id)
    setQueue(newQueue)
    setOriginalOrder(newOriginalOrder)
    // Adjust current track index
    if (newQueue.length === 0) {
      setCurrentTrackIndex(0)
    } else if (currentTrackIndex >= newQueue.length) {
      setCurrentTrackIndex(newQueue.length - 1)
    } else {
      setCurrentTrackIndex(currentTrackIndex)
    }
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const removeTracks = useCallback(async (tracks: Track[]) => {
    for (const track of tracks) {
      await deleteFileFromOPFS(track.fileName)
      await deleteTrack(track.id)
    }
    const removedIds = new Set(tracks.map((t) => t.id))
    const { queue, currentTrackIndex, originalOrder } = usePlayerStore.getState()
    const newQueue = queue.filter((t) => !removedIds.has(t.id))
    const newOriginalOrder = originalOrder.filter((t) => !removedIds.has(t.id))
    setQueue(newQueue)
    setOriginalOrder(newOriginalOrder)
    if (newQueue.length === 0) {
      setCurrentTrackIndex(0)
    } else if (currentTrackIndex >= newQueue.length) {
      setCurrentTrackIndex(newQueue.length - 1)
    } else {
      setCurrentTrackIndex(currentTrackIndex)
    }
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  return { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTrack, removeTracks }
}

function extractArtist(fileName: string): string {
  const name = fileName.replace(/\.[^/.]+$/, '')
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (dashMatch) return dashMatch[1].trim()
  return 'Unknown Artist'
}

function extractAlbum(fileName: string): string {
  const name = fileName.replace(/\.[^/.]+$/, '')
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (dashMatch) return dashMatch[2].trim()
  return 'Unknown Album'
}
