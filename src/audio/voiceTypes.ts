export type VoiceOrigin = 'local' | 'midi' | 'audition'
export type EnvelopePhase = 'attack' | 'decay' | 'sustain' | 'release' | 'idle'

export interface VoiceNote {
  id: string
  midi: number | null
  frequency: number
  velocity: number
  sourceId: string
  sourceName: string
  channel: number | null
  origin: VoiceOrigin
}

export interface VoiceSnapshot extends VoiceNote {
  instanceId: number
  gateOpen: boolean
  phase: EnvelopePhase
  envelope: number
  pitchBend: number
  carrierCount: number
  createdAt: number
  releasingAt: number | null
  retiring: boolean
}

export interface VoiceScope {
  sourceId?: string
  channel?: number
}
