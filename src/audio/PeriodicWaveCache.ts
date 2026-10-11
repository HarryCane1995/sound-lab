import { HARMONIC_COUNT } from '../harmonics/model'

export const PERIODIC_WAVE_CACHE_LIMIT = 64
const contextCaches = new WeakMap<BaseAudioContext, PeriodicWaveCache>()

/** Native PeriodicWave objects belong to their creating audio context. */
export class PeriodicWaveCache {
  private context: BaseAudioContext
  private waves = new Map<string, PeriodicWave>()
  buildCount = 0

  constructor(context: BaseAudioContext) { this.context = context }
  get size(): number { return this.waves.size }

  get(coefficients: number[]): PeriodicWave {
    const key = harmonicKey(coefficients)
    const existing = this.waves.get(key)
    if (existing) {
      this.waves.delete(key)
      this.waves.set(key, existing)
      return existing
    }
    // Index zero is DC. Every nonzero term is a signed sine amplitude; browser
    // normalization stays disabled because the shared model already bounds L1.
    const real = new Float32Array(HARMONIC_COUNT + 1)
    const imag = new Float32Array(HARMONIC_COUNT + 1)
    imag.set(coefficients.slice(0, HARMONIC_COUNT), 1)
    const wave = this.context.createPeriodicWave(real, imag, { disableNormalization: true })
    ++this.buildCount
    this.waves.set(key, wave)
    if (this.waves.size > PERIODIC_WAVE_CACHE_LIMIT) this.waves.delete(this.waves.keys().next().value!)
    return wave
  }

  clear(): void { this.waves.clear() }
}

/** Float32 canonicalization keys exactly the coefficients supplied to native audio. */
export function harmonicKey(coefficients: number[]): string {
  return Array.from(new Float32Array(coefficients)).join(',')
}

export function getPeriodicWaveCache(context: BaseAudioContext): PeriodicWaveCache {
  let cache = contextCaches.get(context)
  if (!cache) {
    cache = new PeriodicWaveCache(context)
    contextCaches.set(context, cache)
  }
  return cache
}

export function clearPeriodicWaveCache(context: BaseAudioContext): void {
  contextCaches.get(context)?.clear()
  contextCaches.delete(context)
}
