import { copyAdditive, type AdditiveConfig, type SynthMode, type SynthParams } from '../types'

export const ACTIVE_HARMONICS_KEY = 'sound-lab.harmonics.v1'
export const HARMONIC_PATCH_KEY = 'sound-lab.harmonic-patch.v1'
export interface HarmonicState { version: 1; mode: SynthMode; additive: AdditiveConfig }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function validConfig(value: unknown): value is AdditiveConfig {
  if (!record(value)) return false
  return Array.isArray(value.levels) && value.levels.length === 16 && value.levels.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)
    && Array.isArray(value.phases) && value.phases.length === 16 && value.phases.every(n => n === 0 || n === 180)
    && Array.isArray(value.enabled) && value.enabled.length === 16 && value.enabled.every(n => typeof n === 'boolean')
}

/** Separate keys: MIDI settings and unrelated local data are never written. */
export function loadHarmonicState(key = ACTIVE_HARMONICS_KEY): { state: HarmonicState | null; error: string | null } {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return { state: null, error: null }
    if (raw.length > 10000) throw new Error('Oversized harmonic state')
    const data: unknown = JSON.parse(raw)
    if (!record(data) || data.version !== 1 || (data.mode !== 'classic' && data.mode !== 'additive') || !validConfig(data.additive)) throw new Error('Invalid harmonic state')
    return { state: { version: 1, mode: data.mode, additive: { ...copyAdditive(data.additive), solo: null, compare: false } }, error: null }
  } catch {
    return { state: null, error: 'Сохранённые гармоники недоступны, повреждены или имеют неподдерживаемую версию. Можно продолжать с текущими настройками.' }
  }
}

export function saveHarmonicState(params: Pick<SynthParams, 'mode' | 'additive'>, key = ACTIVE_HARMONICS_KEY): string | null {
  try {
    const state: HarmonicState = { version: 1, mode: params.mode, additive: { ...copyAdditive(params.additive), solo: null, compare: false } }
    localStorage.setItem(key, JSON.stringify(state))
    return null
  } catch {
    return 'Гармоники работают в этой сессии, но localStorage недоступен: настройки не сохранены.'
  }
}
