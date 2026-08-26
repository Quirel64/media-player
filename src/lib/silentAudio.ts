/**
 * Silent WAV generator for iOS session keep-alive.
 * Anchor duration matches track duration so lock screen seek bar never flashes wrong length.
 * Capped to 15 min and 8kHz mono to keep memory low — silence quality is irrelevant.
 */
const MAX_SECONDS = 15 * 60
const SAMPLE_RATE = 8000

export function createSilentWavBlob(durationSeconds: number): Blob {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, MAX_SECONDS))
  const numSamples = Math.floor(seconds * SAMPLE_RATE)
  const blockAlign = 2 // 16-bit mono
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  // data stays zeroed = silence

  return new Blob([buffer], { type: 'audio/wav' })
}
