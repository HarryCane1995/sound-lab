import { TARGETS } from './targets'
import type { EncoderMode, MidiBinding } from './types'

export const STORAGE_KEY = 'sound-lab.midi.v1'
export interface MidiSettings {
  version: 1
  selectedInput: { id: string; name: string } | null
  bindings: MidiBinding[]
}
const modes: EncoderMode[] = ['absolute', 'relative-twos-complement', 'relative-binary-offset', 'relative-sign-magnitude']
const emptySettings = (): MidiSettings => ({ version: 1, selectedInput: null, bindings: [] })
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
export function bindingSignal(binding: MidiBinding): string { return JSON.stringify([binding.sourceId, binding.channel, binding.kind, binding.number]) }

function isBinding(value: unknown): value is MidiBinding {
  if (!isRecord(value)) return false
  const target = TARGETS.find(target => target.id === value.target)
  return text(value.id) && text(value.sourceId) && text(value.sourceName) && !!target
    && Number.isInteger(value.channel) && Number(value.channel) >= 1 && Number(value.channel) <= 16
    && (value.kind === 'cc' || (value.kind === 'note' && target.kind === 'action'))
    && Number.isInteger(value.number) && Number(value.number) >= 0 && Number(value.number) <= 127
    && modes.includes(value.mode as EncoderMode) && (target.kind === 'continuous' || value.mode === 'absolute')
}

export function loadMidiSettings(): { settings: MidiSettings; error: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { settings: emptySettings(), error: null }
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.bindings) || data.bindings.length > TARGETS.length
      || !data.bindings.every(isBinding)
      || !(data.selectedInput === null || (isRecord(data.selectedInput) && text(data.selectedInput.id) && text(data.selectedInput.name)))) throw new Error('Invalid MIDI settings')
    const bindings = data.bindings as MidiBinding[]
    if (new Set(bindings.map(binding => binding.id)).size !== bindings.length
      || new Set(bindings.map(binding => binding.target)).size !== bindings.length
      || new Set(bindings.map(bindingSignal)).size !== bindings.length) throw new Error('Conflicting MIDI settings')
    return { settings: { version: 1, selectedInput: data.selectedInput as MidiSettings['selectedInput'], bindings }, error: null }
  } catch {
    return { settings: emptySettings(), error: 'Не удалось прочитать MIDI-настройки. Привязки можно настроить заново; сохранение требует доступного localStorage.' }
  }
}

export function saveMidiSettings(settings: MidiSettings): string | null {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); return null }
  catch { return 'MIDI-настройки работают в этой сессии, но localStorage недоступен: изменения не сохранены.' }
}
