import type { SynthParams } from '../types'

export type RecordingMode = 'free' | 'tempo'
export type Quantization = 'off' | '1/4' | '1/8' | '1/16' | '1/32'
export interface PhraseNote {
  id: string
  eventId: string
  sourceId: string
  sourceName: string
  channel: number | null
  midi: number
  velocity: number
  start: number
  end: number
}
export interface Phrase {
  version: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  duration: number
  bpm: number
  recordingMode: RecordingMode
  notes: PhraseNote[]
  sound: SynthParams | null
}
export interface LivePhraseNote {
  id: string
  sourceId: string
  sourceName: string
  channel: number | null
  midi: number
  velocity: number
}
export interface PlaybackState {
  status: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
}
export const MAX_PHRASE_SECONDS = 600
export const MAX_PHRASE_NOTES = 10000
export const MAX_LIBRARY_PHRASES = 200
