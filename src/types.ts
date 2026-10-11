export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle'
export type LfoTarget = 'pitch' | 'filter'

export interface ADSR {
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface SynthParams {
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
  waveform: 'sine',
  frequency: 220,
  amplitude: 0.25,
  adsr: { attack: 0.02, decay: 0.2, sustain: 0.75, release: 0.35 },
  filter: { cutoff: 8000, q: 0.707, bypass: true },
  lfo: { enabled: false, rate: 4, depth: 0.15, target: 'pitch' },
}

export function copyParams(params: SynthParams): SynthParams {
  return { ...params, adsr: { ...params.adsr }, filter: { ...params.filter }, lfo: { ...params.lfo } }
}
