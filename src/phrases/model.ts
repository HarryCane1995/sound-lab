import { copyParams, type SynthParams } from '../types'
import { MAX_PHRASE_NOTES, MAX_PHRASE_SECONDS, type LivePhraseNote, type Phrase, type PhraseNote, type Quantization, type RecordingMode } from './types'

export const phraseId = () => crypto.randomUUID()
export const copyPhrase = (phrase: Phrase): Phrase => ({ ...phrase, notes: phrase.notes.map(note => ({ ...note })), sound: phrase.sound ? copyParams(phrase.sound) : null })
export const phraseName = (name: string) => name.trim().slice(0, 120) || 'Новая фраза'

/** Musical intervals use a monotonic clock. Date.now is only creation metadata. */
export class PhraseCapture {
  private phrase: Phrase | null = null
  private held = new Map<string, PhraseNote>()
  private started = 0
  private clock: () => number
  constructor(clock: () => number = () => performance.now()) { this.clock = clock }
  get recording(): boolean { return this.phrase !== null }
  get elapsed(): number { return this.phrase ? Math.min(MAX_PHRASE_SECONDS, Math.max(0, (this.clock() - this.started) / 1000)) : 0 }
  start(bpm: number, recordingMode: RecordingMode, sound: SynthParams | null = null, startedAt?: number): void {
    this.started = startedAt ?? this.clock(); this.held.clear()
    const now = Date.now()
    this.phrase = { version: 1, id: phraseId(), name: 'Новая фраза', createdAt: now, updatedAt: now, duration: 0, bpm, recordingMode, notes: [], sound: sound ? copyParams(sound) : null }
  }
  noteOn(note: LivePhraseNote): void {
    if (!this.phrase || this.held.has(note.id) || this.phrase.notes.length >= MAX_PHRASE_NOTES || note.velocity <= 0) return
    const start = this.elapsed
    if (start >= MAX_PHRASE_SECONDS) return
    const entry: PhraseNote = { ...note, id: phraseId(), eventId: note.id, start, end: start + 0.001 }
    this.phrase.notes.push(entry); this.held.set(note.id, entry)
  }
  noteOff(id: string): void {
    const note = this.held.get(id)
    if (!note) return
    note.end = Math.min(MAX_PHRASE_SECONDS, Math.max(note.start + 0.001, this.elapsed))
    this.held.delete(id)
  }
  releaseSource(sourceId: string, channel?: number): void {
    for (const [id, note] of this.held) if (note.sourceId === sourceId && (channel === undefined || channel === note.channel)) this.noteOff(id)
  }
  snapshot(): Phrase | null {
    if (!this.phrase) return null
    const copy = copyPhrase(this.phrase)
    for (const note of copy.notes) if (this.held.get(note.eventId)?.id === note.id) note.end = Math.max(note.start + 0.001, this.elapsed)
    copy.duration = Math.max(this.elapsed, ...copy.notes.map(note => note.end), 0.001)
    return copy
  }
  stop(): Phrase | null {
    if (!this.phrase) return null
    for (const id of [...this.held.keys()]) this.noteOff(id)
    const result = this.snapshot()
    this.phrase = null; this.held.clear()
    return result?.notes.length ? result : null
  }
}

/** Off means a fresh exact copy. Quantization never writes back to the take. */
export function quantizeNotes(notes: PhraseNote[], bpm: number, grid: Quantization): PhraseNote[] {
  if (grid === 'off') return notes.map(note => ({ ...note }))
  const division = Number(grid.slice(2))
  const step = 60 / Math.max(30, Math.min(300, bpm)) * 4 / division
  const orderedStarts = notes.map(note => note.start).sort((a, b) => a - b)
  return notes.map(note => {
    const start = Math.max(0, Math.round(note.start / step) * step)
    // Preserve overlaps: starts and ends use the same monotone map; never
    // truncate one note to fit the next. A sub-grid note occupies one cell.
    let end = Math.max(start + step, Math.round(note.end / step) * step)
    // Rounding must not turn an existing legato overlap into a gap or mere
    // touching boundary. Find the latest onset strictly inside this note.
    let low = 0, high = orderedStarts.length
    while (low < high) { const middle = (low + high) >>> 1; if (orderedStarts[middle] < note.end) low = middle + 1; else high = middle }
    if (low > 0) end = Math.max(end, Math.round(orderedStarts[low - 1] / step) * step + step)
    return { ...note, start, end }
  }).sort((a, b) => a.start - b.start)
}

export function playbackDuration(phrase: Phrase, notes: PhraseNote[]): number {
  return Math.max(0.001, phrase.duration, ...notes.map(note => note.end))
}
