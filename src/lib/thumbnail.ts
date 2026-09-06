/**
 * Thumbnail helper — prototype.
 * Audio: embedded picture via ID3/MP4 tags (jsmediatags if available).
 * Video: first frame via hidden <video> + canvas.
 * Returns data URL or null (caller falls back to SVG icon).
 */

export async function getTrackThumbnail(file: File, type: 'audio' | 'video'): Promise<string | null> {
  if (type === 'video') return getVideoThumbnail(file)
  return getAudioThumbnail(file)
}

async function getAudioThumbnail(file: File): Promise<string | null> {
  // Try jsmediatags if dynamically available (not a hard dep yet)
  try {
    const mod = await import('jsmediatags' as unknown as string).catch(() => null) as unknown as {
      read: (f: File, cbs: { onSuccess: (r: { tags: { picture?: { data: number[]; format: string } } }) => void; onError: () => void }) => void
    } | null
    if (mod?.read) {
      const pic = await new Promise<{ data: number[]; format: string } | null>((res) => {
        try {
          mod.read(file, {
            onSuccess: (r) => res(r.tags.picture ?? null),
            onError: () => res(null),
          })
        } catch { res(null) }
      })
      if (pic?.data) {
        const bytes = new Uint8Array(pic.data)
        const blob = new Blob([bytes], { type: pic.format || 'image/jpeg' })
        return URL.createObjectURL(blob)
      }
    }
  } catch { /* ignore — no tags */ }
  return null
}

async function getVideoThumbnail(file: File, seekSec = 0.5): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'metadata'
      video.src = url

      const cleanup = () => {
        URL.revokeObjectURL(url)
        video.removeAttribute('src')
        video.load()
      }

      const timeout = setTimeout(() => {
        cleanup()
        resolve(null)
      }, 4000)

      video.addEventListener('loadedmetadata', () => {
        const t = Math.min(seekSec, Math.max(0, (video.duration || 1) * 0.1))
        try { video.currentTime = t } catch { cleanup(); clearTimeout(timeout); resolve(null) }
      }, { once: true })

      video.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas')
          const w = video.videoWidth || 320, h = video.videoHeight || 180
          const scale = Math.min(1, 320 / w)
          canvas.width = Math.round(w * scale)
          canvas.height = Math.round(h * scale)
          const ctx = canvas.getContext('2d')
          if (!ctx) { cleanup(); clearTimeout(timeout); resolve(null); return }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
          cleanup()
          clearTimeout(timeout)
          resolve(dataUrl)
        } catch {
          cleanup(); clearTimeout(timeout); resolve(null)
        }
      }, { once: true })

      video.addEventListener('error', () => { cleanup(); clearTimeout(timeout); resolve(null) }, { once: true })
      video.load()
    } catch {
      resolve(null)
    }
  })
}

// Expose for console: (window as any).getTrackThumbnail
if (typeof window !== 'undefined') {
  ;(window as unknown as { getTrackThumbnail: typeof getTrackThumbnail }).getTrackThumbnail = getTrackThumbnail
}
