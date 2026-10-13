export interface KickAudioMetrics {
  peak: number
  peakDbfs: number
  rms: number
  rmsDbfs: number
  dcOffset: number
  duration: number
  frames: number
  attenuationDb: number
  spectralCentroidHz: number
  lowBandRatio: number
}

export function amplitudeDbfs(value: number): number { return value > 0 ? 20 * Math.log10(value) : -120 }

/** Edge-tapered whole-file FFT keeps the short attack in the measurement. */
export function spectrumFeatures(pcm: Float32Array, sampleRate: number): { spectralCentroidHz: number; lowBandRatio: number } {
  const size = 2 ** Math.ceil(Math.log2(Math.max(2, pcm.length)))
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  // A whole-file Hann would attenuate the first 8 ms by >40 dB, hiding the very
  // click that distinguishes kicks. A short cosine edge taper removes leakage
  // while retaining the body and transient at their actual relative levels.
  for (let index = 0; index < pcm.length; ++index) {
    const edge = Math.min(1, index / 32, (pcm.length - 1 - index) / 128)
    real[index] = pcm[index] * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge)))
  }
  for (let index = 1, reversed = 0; index < size; ++index) {
    let bit = size >> 1
    for (; reversed & bit; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index < reversed) [real[index], real[reversed]] = [real[reversed], real[index]]
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length
    const rootReal = Math.cos(angle), rootImag = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let factorReal = 1, factorImag = 0
      for (let offset = 0; offset < length / 2; ++offset) {
        const first = start + offset, second = first + length / 2
        const valueReal = real[second] * factorReal - imag[second] * factorImag
        const valueImag = real[second] * factorImag + imag[second] * factorReal
        real[second] = real[first] - valueReal; imag[second] = imag[first] - valueImag
        real[first] += valueReal; imag[first] += valueImag
        const nextReal = factorReal * rootReal - factorImag * rootImag
        factorImag = factorReal * rootImag + factorImag * rootReal; factorReal = nextReal
      }
    }
  }
  let energy = 0, weighted = 0, lowEnergy = 0
  for (let index = 1; index < size / 2; ++index) {
    const hz = index * sampleRate / size
    const power = real[index] ** 2 + imag[index] ** 2
    energy += power
    weighted += power * hz
    if (hz < 150) lowEnergy += power
  }
  return { spectralCentroidHz: energy > 0 ? weighted / energy : 0, lowBandRatio: energy > 0 ? lowEnergy / energy : 0 }
}

export function measureKickPcm(pcm: Float32Array, sampleRate: number, attenuationDb = 0): KickAudioMetrics {
  let peak = 0, power = 0, sum = 0
  for (const value of pcm) {
    if (!Number.isFinite(value)) throw new Error('Рендер Kick содержит некорректные PCM-значения.')
    peak = Math.max(peak, Math.abs(value)); power += value * value; sum += value
  }
  const rms = Math.sqrt(power / Math.max(1, pcm.length))
  return { peak, peakDbfs: amplitudeDbfs(peak), rms, rmsDbfs: amplitudeDbfs(rms),
    dcOffset: sum / Math.max(1, pcm.length), duration: pcm.length / sampleRate, frames: pcm.length, attenuationDb,
    ...spectrumFeatures(pcm, sampleRate) }
}
