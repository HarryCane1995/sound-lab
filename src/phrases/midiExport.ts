import { validatePhrase } from './storage'
import type { Phrase, PhraseNote } from './types'

export const MIDI_PPQ = 480
function variable(value: number): number[] {
  const bytes = [value & 127]
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 127) | 128)
  return bytes
}
const ascii = (value: string) => [...value].map(c => c.charCodeAt(0))
const u32 = (value: number) => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255]

/** Format 0 SMF: simultaneous notes remain separate events. Channel allocation
 * separates overlapping identical pitches so one source's Off cannot cut another. */
export function exportMidi(phrase: Phrase, notes: PhraseNote[] = phrase.notes): Uint8Array<ArrayBuffer> {
  validatePhrase(phrase)
  const tick = (seconds: number) => Math.max(0, Math.round(seconds * phrase.bpm / 60 * MIDI_PPQ))
  const tempo = Math.round(60_000_000 / phrase.bpm)
  const events: { tick: number; order: number; bytes: number[] }[] = []
  const channels: Map<number, number>[] = Array.from({ length: 16 }, () => new Map())
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.end - b.end)
  for (const note of sorted) {
    const start = tick(note.start), end = Math.max(start + 1, tick(note.end))
    const available = channels.findIndex(channel => (channel.get(note.midi) ?? -1) <= start)
    if (available < 0) throw new Error('В MIDI больше 16 перекрывающихся одинаковых нот. Уменьшите их число перед экспортом.')
    channels[available].set(note.midi, end)
    events.push({ tick: start, order: 1, bytes: [0x90 | available, note.midi, note.velocity] }, { tick: end, order: 0, bytes: [0x80 | available, note.midi, 0] })
  }
  const track = [0, 0xff, 0x51, 3, tempo >>> 16 & 255, tempo >>> 8 & 255, tempo & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8]
  let previous = 0
  for (const event of events.sort((a, b) => a.tick - b.tick || a.order - b.order)) { track.push(...variable(event.tick - previous), ...event.bytes); previous = event.tick }
  track.push(...variable(Math.max(previous, tick(phrase.duration)) - previous), 0xff, 0x2f, 0)
  return new Uint8Array([...ascii('MThd'), ...u32(6), 0, 0, 0, 1, MIDI_PPQ >>> 8, MIDI_PPQ & 255, ...ascii('MTrk'), ...u32(track.length), ...track])
}
