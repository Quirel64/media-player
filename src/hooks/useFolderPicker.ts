import { useCallback } from 'react'
import type { Track } from '../lib/types'
import { saveTracks, getAllTracks, savePlaylist, clearAllTracks } from '../lib/idb'
import { saveFileToOPFS, clearOPFS } from '../lib/opfs'
import { generateTrackId, generatePlaylistId } from '../lib/shuffle'
import { usePlayerStore } from '../stores/playerStore'

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|webm|mp4|m4v)$/i

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  return AUDIO_EXTENSIONS.test(file.name)
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
  setQueue: (t: Track[]) => void,
  setOriginalOrder: (t: Track[]) => void,
  setCurrentTrackIndex: (i: number) => void
): Promise<Track[] | null> {
  const audioFiles = files.filter(isAudioFile)

  if (audioFiles.length === 0) return null

  const folderName =
    audioFiles[0].webkitRelativePath?.split('/')[0] || 'Selected Files'

  const existingNames = new Set<string>()

  const tracks: Track[] = await Promise.all(
    audioFiles.map(async (file) => {
      const uniqueFileName = getUniqueFileName(existingNames, file.name)

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
      }

      try {
        await saveFileToOPFS(uniqueFileName, file)
      } catch (e) {
        console.error('Failed to save file to OPFS:', file.name, e)
      }

      return track
    })
  )

  // Get durations
  for (const track of tracks) {
    const file = audioFiles.find((f) => f.name === track.fileName || getUniqueFileName(new Set(), f.name) === track.fileName)
    if (file) {
      try {
        const url = URL.createObjectURL(file)
        const audio = new Audio()
        await new Promise<void>((res) => {
          audio.onloadedmetadata = () => {
            track.duration = audio.duration
            URL.revokeObjectURL(url)
            res()
          }
          audio.onerror = () => {
            URL.revokeObjectURL(url)
            res()
          }
          audio.src = url
        })
      } catch {
        // duration stays 0
      }
    }
  }

  await saveTracks(tracks)

  const playlist = {
    id: generatePlaylistId(folderName),
    name: folderName,
    tracks,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await savePlaylist(playlist)

  setQueue(tracks)
  setOriginalOrder(tracks)
  setCurrentTrackIndex(0)

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
      input.accept = 'audio/*,video/mp4'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        const result = await processFiles(files, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }

      input.oncancel = () => resolve(null)
      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const pickFiles = useCallback(async (): Promise<Track[] | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = 'audio/*,video/mp4,.mp3,.wav,.ogg,.flac,.m4a,.aac,.wma,.opus,.webm,.mp4,.m4v'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        const result = await processFiles(files, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }

      input.oncancel = () => resolve(null)
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

  return { pickFolder, pickFiles, loadSavedTracks, clearAll }
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
