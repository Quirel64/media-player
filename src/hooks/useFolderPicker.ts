import { useCallback } from 'react'
import type { Track } from '../lib/types'
import { saveTracks, getAllTracks, savePlaylist, clearAllTracks } from '../lib/idb'
import { saveFileToOPFS, clearOPFS } from '../lib/opfs'
import { generateTrackId, generatePlaylistId } from '../lib/shuffle'
import { usePlayerStore } from '../stores/playerStore'

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
      input.accept = 'audio/*'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        const audioFiles = files.filter((f) =>
          f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus)$/i.test(f.name)
        )

        if (audioFiles.length === 0) {
          resolve(null)
          return
        }

        const folderName = audioFiles[0].webkitRelativePath?.split('/')[0] || 'Unknown Folder'

        const tracks: Track[] = await Promise.all(
          audioFiles.map(async (file) => {
            const track: Track = {
              id: generateTrackId({
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
              }),
              name: file.name.replace(/\.[^/.]+$/, ''),
              fileName: file.name,
              size: file.size,
              lastModified: file.lastModified,
              duration: 0,
              artist: extractArtist(file.name),
              album: extractAlbum(file.name),
              folderName,
            }

            try {
              await saveFileToOPFS(file.name, file)
            } catch (e) {
              console.error('Failed to save file to OPFS:', file.name, e)
            }

            return track
          })
        )

        // Get durations from audio element
        for (const track of tracks) {
          const audio = new Audio()
          try {
            const file = audioFiles.find((f) => f.name === track.fileName)
            if (file) {
              const url = URL.createObjectURL(file)
              audio.src = url
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
              })
            }
          } catch {
            // duration stays 0
          }
        }

        await saveTracks(tracks)

        // Save as playlist
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

        resolve(tracks)
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

  return { pickFolder, loadSavedTracks, clearAll }
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
