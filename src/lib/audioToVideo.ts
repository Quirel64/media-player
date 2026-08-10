const DEFAULT_SIZE = 256

function drawDefaultArt(ctx: CanvasRenderingContext2D, size: number) {
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#4f46e5')
  grad.addColorStop(1, '#7c3aed')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${size * 0.4}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('♪', size / 2, size / 2)
}

export function createAudioVideo(audioBlobUrl: string): HTMLVideoElement {
  const canvas = document.createElement('canvas')
  canvas.width = DEFAULT_SIZE
  canvas.height = DEFAULT_SIZE
  const ctx = canvas.getContext('2d')!

  drawDefaultArt(ctx, DEFAULT_SIZE)

  // Create video stream from canvas (1 FPS for static image)
  const canvasStream = canvas.captureStream(1)

  // Create audio element (hidden, not in DOM)
  const audio = new Audio()
  audio.crossOrigin = 'anonymous'
  audio.preload = 'auto'
  audio.src = audioBlobUrl

  // Create separate audio context for the audio-video bridge
  const audioCtx = new AudioContext()
  const source = audioCtx.createMediaElementSource(audio)
  const dest = audioCtx.createMediaStreamDestination()
  source.connect(dest)
  source.connect(audioCtx.destination)

  // Combine canvas video + audio streams
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ])

  // Create the video element
  const video = document.createElement('video')
  video.playsInline = true
  video.setAttribute('webkit-playsinline', 'true')
  video.muted = false
  video.srcObject = combinedStream
  video.style.width = '100%'
  video.style.maxHeight = '100%'
  video.style.objectFit = 'contain'
  video.style.borderRadius = '12px'
  video.style.touchAction = 'manipulation'
  video.controls = true

  // Store references for cleanup
  ;(video as any).__audioCtx = audioCtx
  ;(video as any).__audio = audio
  ;(video as any).__canvasStream = canvasStream
  ;(video as any).__combinedStream = combinedStream

  // Sync play/pause with audio
  video.onplay = () => {
    if (audioCtx.state === 'suspended') audioCtx.resume()
    audio.play().catch(() => {})
  }
  video.onpause = () => {
    audio.pause()
  }
  video.onseeking = () => {
    // Sync audio seek to video seek
    audio.currentTime = video.currentTime
  }

  // Sync ended event
  audio.onended = () => {
    video.dispatchEvent(new Event('ended'))
  }

  // Duration from audio
  audio.onloadedmetadata = () => {
    Object.defineProperty(video, 'duration', {
      get: () => audio.duration,
      configurable: true,
    })
    video.dispatchEvent(new Event('loadedmetadata'))
    video.dispatchEvent(new Event('durationchange'))
  }

  // Proxy currentTime to audio
  Object.defineProperty(video, 'currentTime', {
    get() {
      return audio.currentTime
    },
    set(time: number) {
      audio.currentTime = time
    },
    configurable: true,
  })

  return video
}

export function destroyAudioVideo(video: HTMLVideoElement) {
  const audioCtx = (video as any).__audioCtx as AudioContext | undefined
  const audio = (video as any).__audio as HTMLAudioElement | undefined
  const canvasStream = (video as any).__canvasStream as MediaStream | undefined
  const combinedStream = (video as any).__combinedStream as MediaStream | undefined

  audio?.pause()
  audioCtx?.close()
  canvasStream?.getTracks().forEach((t) => t.stop())
  combinedStream?.getTracks().forEach((t) => t.stop())
  video.srcObject = null
}
