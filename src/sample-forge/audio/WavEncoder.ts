/** RIFF/WAVE mono signed PCM24; exact render buffer also feeds preview. */
export function encodeWav24(pcm: Float32Array, sampleRate = 48000): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || pcm.length > 0x1fffffff) throw new Error('Недопустимый формат WAV.')
  const dataBytes = pcm.length * 3
  const padding = dataBytes & 1
  const bytes = new Uint8Array(44 + dataBytes + padding)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => { for (let index = 0; index < value.length; ++index) view.setUint8(offset + index, value.charCodeAt(index)) }
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 3, true); view.setUint16(32, 3, true); view.setUint16(34, 24, true)
  ascii(36, 'data'); view.setUint32(40, dataBytes, true)
  for (let index = 0; index < pcm.length; ++index) {
    const value = pcm[index]
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Недопустимые уровни PCM для WAV.')
    const integer = Math.round(value < 0 ? value * 0x800000 : value * 0x7fffff)
    const offset = 44 + index * 3
    view.setUint8(offset, integer & 0xff); view.setUint8(offset + 1, (integer >> 8) & 0xff); view.setUint8(offset + 2, (integer >> 16) & 0xff)
  }
  return bytes
}
