export interface HeldNote {
  id: string
  midi: number
  velocity: number
  sourceId: string
  sourceName: string
  channel: number | null
  origin: 'local' | 'midi'
}

/** Shared monophonic last-note priority, independent of React and audio nodes. */
export class HeldNotes {
  private notes = new Map<string, HeldNote>()

  get size() { return this.notes.size }
  get active(): HeldNote | null { return [...this.notes.values()].at(-1) ?? null }

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
