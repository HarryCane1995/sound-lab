export interface HeldNote {
  id: string
  midi: number
  velocity: number
  sourceId: string
  sourceName: string
  channel: number | null
  origin: 'local' | 'midi'
}

/** Physical held-key registry. Releasing a key never restarts another note. */
export class HeldNotes {
  private notes = new Map<string, HeldNote>()

  get size() { return this.notes.size }
  get values(): HeldNote[] { return [...this.notes.values()] }

  press(note: HeldNote): boolean {
    if (this.notes.has(note.id)) return false
    this.notes.set(note.id, { ...note })
    return true
  }

  release(id: string): boolean { return this.notes.delete(id) }

  removeWhere(predicate: (note: HeldNote) => boolean): void {
    for (const [id, note] of this.notes) if (predicate(note)) this.notes.delete(id)
  }

  clear(): void { this.notes.clear() }
}

export const midiNoteId = (sourceId: string, channel: number, note: number) =>
  `midi:${JSON.stringify([sourceId, channel, note])}`
