/**
 * Thumbnail helper.
 * Audio: embedded picture via ID3/MP4 tags (jsmediatags if available).
 * Video: first frame via hidden <video> + canvas.
 * Returns data URL or null (caller falls back to SVG icon).
 *
 * Results are memoized in a module-level cache (data URLs, so no object-URL
 * lifecycle). Views seed their thumbs state from it, so a thumbnail generated
 * in one view shows instantly in another — including while audio plays, when
 * fresh probes are deliberately paused (lock-screen timeline hygiene).
 */

const thumbnailCache = new Map<string, string | null>()
const MAX_CACHED_THUMBNAILS = 500

export function getCachedThumbnails(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, url] of thumbnailCache) if (url) out[key] = url
  return out
}

export async function getTrackThumbnail(file: File, type: 'audio' | 'video', cacheKey?: string): Promise<string | null> {
  if (cacheKey !== undefined && thumbnailCache.has(cacheKey)) {
    return thumbnailCache.get(cacheKey) ?? null
  }
  const url = type === 'video' ? await getVideoThumbnail(file) : await getAudioThumbnail(file)
  if (cacheKey !== undefined) {
    if (url || type === 'audio') {
      if (thumbnailCache.size >= MAX_CACHED_THUMBNAILS) {
        const oldest = thumbnailCache.keys().next().value
        if (oldest !== undefined) thumbnailCache.delete(oldest)
      }
      thumbnailCache.set(cacheKey, url)
    }
  }
  return url
}

async function getAudioThumbnail(_file: File): Promise<string | null> {
  // Audio embedded art via jsmediatags not installed yet — fallback to icon
  // To enable: npm i jsmediatags and restore dynamic import with @vite-ignore
  return null
}

async function getVideoThumbnail(file: File, seekSec = 3.5): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      // Probe hygiene: this element screenshots ONE frame and must never
      // surface anywhere — muted, non-remote, inline, zero volume. A parked
      // probe (~3.5s seek) otherwise registers a competing lock-screen
      // timeline: the phantom 4s seek bar that fights the real one.
      video.muted = true
      ;(video as unknown as { defaultMuted: boolean }).defaultMuted = true
      try {
        video.volume = 0
      } catch { /* ignore */ }
      try {
        ;(video as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true
      } catch { /* ignore */ }
      video.playsInline = true
      video.setAttribute('webkit-playsinline', 'true')
      video.setAttribute('x-webkit-airplay', 'deny')
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