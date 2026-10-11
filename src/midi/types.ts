export type MidiTargetId =
  | 'frequency' | 'amplitude' | 'waveform' | 'synthesis.mode'
  | 'adsr.attack' | 'adsr.decay' | 'adsr.sustain' | 'adsr.release'
  | 'filter.cutoff' | 'filter.q' | 'filter.bypass'
  | 'lfo.rate' | 'lfo.depth' | 'lfo.enabled' | 'lfo.target'
  | 'waveform.next' | 'waveform.sine' | 'waveform.square' | 'waveform.sawtooth' | 'waveform.triangle'
  | 'preset.pure-sine' | 'preset.8-bit-lead' | 'preset.soft-bass' | 'preset.sharp-saw-lead' | 'preset.evolving-pad'
  | 'reset' | 'panic'

export type EncoderMode = 'absolute' | 'relative-twos-complement' | 'relative-binary-offset' | 'relative-sign-magnitude'

export interface MidiDevice {
  id: string
  name: string
  manufacturer: string
  state: string
}

export interface MidiMessage {
  type: 'noteon' | 'noteoff' | 'cc' | 'pitchbend' | 'aftertouch' | 'polyaftertouch' | 'programchange' | 'system'
  channel: number | null
  note?: number
  velocity?: number
  controller?: number
  value: number
  bend?: number
  sourceId: string
  sourceName: string
  timestamp: number
  raw: number[]
}

export interface MidiTarget {
  id: MidiTargetId
  label: string
  kind: 'continuous' | 'discrete' | 'action'
}

export interface MidiBinding {
  id: string
  target: MidiTargetId
  sourceId: string
  sourceName: string
  channel: number
  kind: 'cc' | 'note'
  number: number
  mode: EncoderMode
}

export interface MidiState {
  status: 'idle' | 'connecting' | 'ready' | 'no-devices' | 'denied' | 'unsupported' | 'disconnected' | 'error'
  message: string
  inputs: MidiDevice[]
  selectedId: string
  preferredName: string | null
  events: MidiMessage[]
  lastActivity: number
  learning: MidiTargetId | null
  bindings: MidiBinding[]
  conflict: { existing: MidiBinding; incoming: MidiBinding } | null
  storageError: string | null
  lastControlled: { target: MidiTargetId; timestamp: number } | null
}

export interface MidiCallbacks {
  onState: (state: MidiState) => void
  onMessage: (message: MidiMessage, consumed: boolean) => void
  onTarget: (target: MidiTargetId, normalized: number | null, message: MidiMessage) => void
  onDisconnect: (sourceId: string) => void
  getTargetNormalized: (target: MidiTargetId) => number
}

export const INITIAL_MIDI_STATE: MidiState = {
  status: 'idle', message: 'Подключите MIDI по USB и нажмите «Подключить MIDI».',
  inputs: [], selectedId: '', preferredName: null, events: [], lastActivity: 0,
  learning: null, bindings: [], conflict: null, storageError: null, lastControlled: null,
}
