import type { MidiMessage } from './types'

export function midiNoteName(note: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`
}

export function midiNoteFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12)
}

/** Web MIDI supplies complete messages; running status is handled by the browser. */
export function parseMidiMessage(data: ArrayLike<number>, source: { id: string; name?: string | null }, timestamp = performance.now()): MidiMessage | null {
  const raw = Array.from(data)
  const status = raw[0]
  if (!Number.isInteger(status) || status < 0x80 || status > 0xff) return null
  if (status >= 0xf0) return { type: 'system', channel: null, value: raw[1] ?? 0, sourceId: source.id, sourceName: source.name || 'MIDI input', timestamp, raw }
  const command = status & 0xf0
  const required = command === 0xc0 || command === 0xd0 ? 2 : 3
  if (raw.length !== required || raw.slice(1).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 127)) return null
  const first = raw[1]
  const second = raw[2]
  const base = { channel: (status & 0x0f) + 1, sourceId: source.id, sourceName: source.name || 'MIDI input', timestamp, raw }
  switch (command) {
    case 0x80: return { ...base, type: 'noteoff', note: first, velocity: second, value: second }
    case 0x90: return { ...base, type: second === 0 ? 'noteoff' : 'noteon', note: first, velocity: second, value: second }
    case 0xa0: return { ...base, type: 'polyaftertouch', note: first, value: second }
    case 0xb0: return { ...base, type: 'cc', controller: first, value: second }
    case 0xc0: return { ...base, type: 'programchange', value: first }
    case 0xd0: return { ...base, type: 'aftertouch', value: first }
    case 0xe0: {
      const value = first | (second << 7)
      // Asymmetric divisors reach exactly -1, 0 and +1 at both ends and center.
      const bend = (value - 8192) / (value < 8192 ? 8192 : 8191)
      return { ...base, type: 'pitchbend', value, bend }
    }
    default: return null
  }
}
