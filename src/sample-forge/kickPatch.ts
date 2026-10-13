/** All envelope times are milliseconds; levels are linear 0…1, not dB. */
export interface KickPatch {
  version: 1
  startFrequency: number
  endFrequency: number
  pitchDecay: number
  pitchCurve: number
  attack: number
  bodyDecay: number
  clickAmount: number
  clickDecay: number
  noiseColor: 'white' | 'pink' | 'brown'
  drive: number
  tone: number
  outputLevel: number
  seed: number
}

export type KickNumericParameter = Exclude<keyof KickPatch, 'version' | 'noiseColor' | 'seed'>

export const KICK_PARAMETER_RANGES: Record<KickNumericParameter, { min: number; max: number; step: number; unit: string; logarithmic?: boolean }> = {
  startFrequency: { min: 70, max: 400, step: 1, unit: 'Hz', logarithmic: true },
  endFrequency: { min: 30, max: 100, step: 1, unit: 'Hz', logarithmic: true },
  pitchDecay: { min: 5, max: 180, step: 1, unit: 'ms', logarithmic: true },
  pitchCurve: { min: 0.25, max: 4, step: 0.01, unit: '' },
  attack: { min: 0, max: 20, step: 0.1, unit: 'ms' },
  bodyDecay: { min: 80, max: 900, step: 1, unit: 'ms', logarithmic: true },
  clickAmount: { min: 0, max: 1, step: 0.01, unit: '' },
  clickDecay: { min: 2, max: 35, step: 0.1, unit: 'ms', logarithmic: true },
  drive: { min: 0, max: 1, step: 0.01, unit: '' },
  tone: { min: 150, max: 16000, step: 1, unit: 'Hz', logarithmic: true },
  outputLevel: { min: 0, max: 1, step: 0.01, unit: '' },
}

export const DEFAULT_KICK_PATCH: Readonly<KickPatch> = Object.freeze({
  version: 1, startFrequency: 160, endFrequency: 55, pitchDecay: 60, pitchCurve: 0.7,
  attack: 2, bodyDecay: 350, clickAmount: 0.12, clickDecay: 8, noiseColor: 'white',
  drive: 0.15, tone: 10000, outputLevel: 0.7, seed: 202608,
})

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const numericKeys = Object.keys(KICK_PARAMETER_RANGES) as KickNumericParameter[]

/** Defensive UI/storage recovery; untrusted imports must use validateKickPatch. */
export function normalizeKickPatch(value: unknown): KickPatch {
  const source = record(value) ? value : {}
  const result: KickPatch = { ...DEFAULT_KICK_PATCH }
  for (const key of numericKeys) {
    const range = KICK_PARAMETER_RANGES[key]
    const candidate = source[key]
    result[key] = typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(range.max, Math.max(range.min, candidate)) : DEFAULT_KICK_PATCH[key]
  }
  // A Kick always descends or holds pitch, never rises accidentally.
  result.startFrequency = Math.max(result.endFrequency, result.startFrequency)
  result.noiseColor = source.noiseColor === 'pink' || source.noiseColor === 'brown' ? source.noiseColor : 'white'
  result.seed = typeof source.seed === 'number' && Number.isInteger(source.seed) && source.seed >= 0 && source.seed <= 0xffffffff
    ? source.seed : DEFAULT_KICK_PATCH.seed
  return result
}

/** Strict allowlisted schema for JSON import and persistent bank integrity. */
export function validateKickPatch(value: unknown): KickPatch {
  if (!record(value) || value.version !== 1 || !['white', 'pink', 'brown'].includes(String(value.noiseColor))
    || typeof value.seed !== 'number' || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    throw new Error('Недопустимый формат Kick Patch.')
  }
  for (const key of numericKeys) {
    const candidate = value[key]
    const { min, max } = KICK_PARAMETER_RANGES[key]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > max) {
      throw new Error(`Недопустимый параметр Kick: ${key}.`)
    }
  }
  if ((value.startFrequency as number) < (value.endFrequency as number)) throw new Error('Start Frequency должна быть не ниже End Frequency.')
  return normalizeKickPatch(value)
}

export function copyKickPatch(value: KickPatch = { ...DEFAULT_KICK_PATCH }): KickPatch { return normalizeKickPatch(value) }

/** Canonical field order avoids object insertion-order differences in backups. */
export function canonicalKickPatch(value: KickPatch): string { return JSON.stringify(validateKickPatch(value)) }

export function kickPatchFingerprint(value: KickPatch): string {
  const text = canonicalKickPatch(value)
  let first = 0x811c9dc5, second = 0x9e3779b9
  for (let index = 0; index < text.length; ++index) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193)
    second = Math.imul(second ^ text.charCodeAt(index), 0x85ebca6b)
  }
  return `kick-v1-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

/** Mulberry32: uint32 seed, stable without Math.random, including seed zero. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
