export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle'
export type LfoTarget = 'pitch' | 'filter'
export type SynthMode = 'classic' | 'additive'

export interface AdditiveConfig {
  levels: number[]
  phases: (0 | 180)[]
  enabled: boolean[]
  solo: number | null // Harmonic number 1–16; temporary, never destroys levels.
  compare: boolean // Match the Classic comparison to the additive RMS.
}

export function defaultAdditive(): AdditiveConfig {
  return { levels: Array.from({ length: 16 }, (_, i) => i === 0 ? 100 : 0), phases: Array(16).fill(0), enabled: Array(16).fill(true), solo: null, compare: false }
}

export function copyAdditive(value?: Partial<AdditiveConfig> | null): AdditiveConfig {
  const initial = defaultAdditive()
  return {
    levels: initial.levels.map((fallback, i) => Number.isFinite(value?.levels?.[i]) ? Math.min(100, Math.max(0, value!.levels![i])) : fallback),
    phases: initial.phases.map((_, i) => value?.phases?.[i] === 180 ? 180 : 0),
    enabled: initial.enabled.map((_, i) => value?.enabled?.[i] !== false),
    solo: Number.isInteger(value?.solo) && value!.solo! >= 1 && value!.solo! <= 16 ? value!.solo! : null,
    compare: value?.compare === true,
  }
}

export interface ADSR {
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface SynthParams {
  mode: SynthMode
  additive: AdditiveConfig
  waveform: Waveform
  frequency: number
  amplitude: number
  adsr: ADSR
  filter: { cutoff: number; q: number; bypass: boolean }
  lfo: { enabled: boolean; rate: number; depth: number; target: LfoTarget }
}

export interface AnalysisNodes {
  time: AnalyserNode
  frequency: AnalyserNode
  sampleRate: number
}

export interface Preset {
  id: string
  name: string
  description: string
  params: SynthParams
}

export interface Lesson {
  id: string
  title: string
  shortTitle: string
  explanation: string
  experiment: string
  listen: string
  observe: string
  params: SynthParams
}

export const DEFAULT_PARAMS: SynthParams = {
  mode: 'classic',
  additive: defaultAdditive(),
  waveform: 'sine',
  frequency: 220,
  amplitude: 0.25,
  adsr: { attack: 0.02, decay: 0.2, sustain: 0.75, release: 0.35 },
  filter: { cutoff: 8000, q: 0.707, bypass: true },
  lfo: { enabled: false, rate: 4, depth: 0.15, target: 'pitch' },
}

export function copyParams(params: SynthParams): SynthParams {
  return { ...params, mode: params.mode === 'additive' ? 'additive' : 'classic', additive: copyAdditive(params.additive), adsr: { ...params.adsr }, filter: { ...params.filter }, lfo: { ...params.lfo } }
}
