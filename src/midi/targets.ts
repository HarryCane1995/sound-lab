import { copyParams } from '../types'
import type { SynthParams, Waveform } from '../types'
import type { MidiTarget, MidiTargetId } from './types'

export const TARGETS: MidiTarget[] = [
  { id: 'frequency', label: 'Frequency · Частота', kind: 'continuous' },
  { id: 'amplitude', label: 'Amplitude · Громкость', kind: 'continuous' },
  { id: 'waveform', label: 'Waveform · Форма волны', kind: 'discrete' },
  { id: 'synthesis.mode', label: 'Classic / Additive · Режим синтеза', kind: 'action' },
  { id: 'adsr.attack', label: 'Attack · Атака', kind: 'continuous' },
  { id: 'adsr.decay', label: 'Decay · Спад', kind: 'continuous' },
  { id: 'adsr.sustain', label: 'Sustain · Удержание', kind: 'continuous' },
  { id: 'adsr.release', label: 'Release · Затухание', kind: 'continuous' },
  { id: 'filter.cutoff', label: 'Cutoff · Частота среза', kind: 'continuous' },
  { id: 'filter.q', label: 'Resonance · Резонанс', kind: 'continuous' },
  { id: 'filter.bypass', label: 'Filter Bypass · Обход фильтра', kind: 'action' },
  { id: 'lfo.rate', label: 'LFO Rate · Скорость', kind: 'continuous' },
  { id: 'lfo.depth', label: 'LFO Depth · Глубина', kind: 'continuous' },
  { id: 'lfo.enabled', label: 'LFO · Включение', kind: 'action' },
  { id: 'lfo.target', label: 'LFO Target · Цель', kind: 'action' },
  { id: 'waveform.next', label: 'Следующая форма волны', kind: 'action' },
  { id: 'waveform.sine', label: 'Волна · Sine', kind: 'action' },
  { id: 'waveform.square', label: 'Волна · Square', kind: 'action' },
  { id: 'waveform.sawtooth', label: 'Волна · Sawtooth', kind: 'action' },
  { id: 'waveform.triangle', label: 'Волна · Triangle', kind: 'action' },
  { id: 'preset.pure-sine', label: 'Пресет · Чистая синусоида', kind: 'action' },
  { id: 'preset.8-bit-lead', label: 'Пресет · 8-bit Lead', kind: 'action' },
  { id: 'preset.soft-bass', label: 'Пресет · Мягкий бас', kind: 'action' },
  { id: 'preset.sharp-saw-lead', label: 'Пресет · Яркий saw lead', kind: 'action' },
  { id: 'preset.evolving-pad', label: 'Пресет · Мягкий пэд', kind: 'action' },
  { id: 'reset', label: 'Reset · Сброс параметров', kind: 'action' },
  { id: 'panic', label: 'Panic · Все ноты выключены', kind: 'action' },
]

export const clampNormalized = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const waves: Waveform[] = ['sine', 'square', 'sawtooth', 'triangle']
const ranges: Partial<Record<MidiTargetId, { min: number; max: number; log?: boolean }>> = {
  frequency: { min: 20, max: 20000, log: true }, amplitude: { min: 0, max: 1 },
  'adsr.attack': { min: 0.005, max: 4 }, 'adsr.decay': { min: 0.01, max: 3 },
  'adsr.sustain': { min: 0, max: 1 }, 'adsr.release': { min: 0.01, max: 5 },
  'filter.cutoff': { min: 20, max: 20000, log: true }, 'filter.q': { min: 0.1, max: 10 },
  'lfo.rate': { min: 0.1, max: 12, log: true }, 'lfo.depth': { min: 0, max: 1 },
}

function readValue(params: SynthParams, target: MidiTargetId): number {
  switch (target) {
    case 'frequency': return params.frequency
    case 'amplitude': return params.amplitude
    case 'adsr.attack': return params.adsr.attack
    case 'adsr.decay': return params.adsr.decay
    case 'adsr.sustain': return params.adsr.sustain
    case 'adsr.release': return params.adsr.release
    case 'filter.cutoff': return params.filter.cutoff
    case 'filter.q': return params.filter.q
    case 'lfo.rate': return params.lfo.rate
    case 'lfo.depth': return params.lfo.depth
    default: return 0
  }
}

export function getTargetNormalized(params: SynthParams, target: MidiTargetId): number {
  if (target === 'waveform') return waves.indexOf(params.waveform) / 3
  const range = ranges[target]
  if (!range) return 0
  const value = readValue(params, target)
  return clampNormalized(range.log ? Math.log(value / range.min) / Math.log(range.max / range.min) : (value - range.min) / (range.max - range.min))
}

export function setTargetNormalized(params: SynthParams, target: MidiTargetId, normalized: number): SynthParams {
  const next = copyParams(params)
  const position = clampNormalized(normalized)
  if (target === 'waveform') { next.waveform = waves[Math.min(3, Math.floor(position * 4))]; next.mode = 'classic'; next.additive.compare = false; return next }
  const range = ranges[target]
  if (!range) return next
  const value = range.log ? range.min * (range.max / range.min) ** position : range.min + (range.max - range.min) * position
  switch (target) {
    case 'frequency': next.frequency = value; break
    case 'amplitude': next.amplitude = value; break
    case 'adsr.attack': next.adsr.attack = value; break
    case 'adsr.decay': next.adsr.decay = value; break
    case 'adsr.sustain': next.adsr.sustain = value; break
    case 'adsr.release': next.adsr.release = value; break
    case 'filter.cutoff': next.filter.cutoff = value; break
    case 'filter.q': next.filter.q = value; break
    case 'lfo.rate': next.lfo.rate = value; break
    case 'lfo.depth': next.lfo.depth = value; break
  }
  return next
}
