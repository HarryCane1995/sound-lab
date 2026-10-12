import type { SynthEngine } from '../audio/SynthEngine'
import type { PhraseNote, PlaybackState } from './types'

const LOOKAHEAD = 0.1
const TICK_MS = 25
const START_LEAD = 0.012

/** Audio-clock lookahead; JavaScript queues native starts and native gates. */
export class PhrasePlayer {
  private readonly engine: SynthEngine
  private readonly onUpdate: (state: PlaybackState) => void
  private readonly identity = crypto.randomUUID()
  private readonly unsubscribe: () => void
  private readonly unsubscribeCancellation: () => void
  private notes: PhraseNote[] = []
  private state: PlaybackState = { status: 'stopped', position: 0, duration: 0 }
  private loop = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private sourceId: string | null = null
  private anchor = 0
  private initialOffset = 0
  private nextCycle = 0
  private nextIndex = 0
  private endCycle = 0
  private latestEnd = 0
  private disposed = false
  private preparing = false
  private skippedNotes = 0
  private lateNotes = 0
  private admitted = new Map<string, { cycle: number; end: number }>()

  constructor(engine: SynthEngine, onUpdate: (state: PlaybackState) => void) {
    this.engine = engine
    this.onUpdate = onUpdate
    this.unsubscribe = engine.subscribeContextState(state => {
      if (state !== 'running' && (this.state.status === 'playing' || this.preparing)) this.pause()
    })
    this.unsubscribeCancellation = engine.subscribeCancellation(() => this.stop())
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
  }

  configure(notes: PhraseNote[], duration: number, loop: boolean): void {
    if (this.disposed) return
    this.stop()
    this.notes = notes.filter(note => Number.isFinite(note.start) && Number.isFinite(note.end)
      && note.start >= 0 && note.end > note.start && Number.isFinite(note.midi) && note.velocity > 0)
      .map(note => ({ ...note })).sort((a, b) => a.start - b.start)
    this.state.duration = Math.max(0.001, Number.isFinite(duration) ? duration : 0,
      ...this.notes.map(note => note.end))
    this.loop = loop
    this.emit()
  }

  async play(offset?: number): Promise<void> {
    if (this.disposed || !this.notes.length) return
    if (this.state.status === 'playing' && offset === undefined) return
    const desired = offset ?? (this.state.status === 'paused' ? this.state.position : 0)
    this.cancelSource()
    const generation = ++this.generation
    this.preparing = true
    try { await this.engine.prepare() }
    finally { if (generation === this.generation) this.preparing = false }
    if (this.disposed || generation !== this.generation) return
    const clock = this.engine.getAudioClock()
    if (!clock || clock.state !== 'running' || (typeof document !== 'undefined' && document.hidden)) return
    const duration = this.state.duration
    const bounded = Math.max(0, Math.min(duration, Number.isFinite(desired) ? desired : 0))
    const position = this.loop ? bounded % duration : bounded
    if (position >= duration) { this.stop(); return }
    this.sourceId = `phrase-playback:${this.identity}:${generation}`
    this.initialOffset = position
    this.anchor = clock.time + START_LEAD - position
    this.latestEnd = this.anchor + duration
    this.skippedNotes = 0
    this.lateNotes = 0
    this.nextCycle = 0
    this.nextIndex = 0
    this.endCycle = this.loop ? Infinity : 0
    this.state = { status: 'playing', position, duration }
    this.tick()
  }

  pause(): void {
    if (this.disposed) return
    const position = this.getState().position
    ++this.generation
    this.preparing = false
    this.cancelSource()
    this.state = { ...this.state, status: 'paused', position }
    this.emit()
  }

  stop(): void {
    if (this.disposed) return
    ++this.generation
    this.preparing = false
    this.cancelSource()
    this.state = { ...this.state, status: 'stopped', position: 0 }
    this.emit()
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    if (this.state.status !== 'playing') return
    const clock = this.engine.getAudioClock()
    const currentCycle = Math.max(0, Math.floor(((clock?.time ?? this.anchor) - this.anchor) / this.state.duration))
    this.endCycle = loop ? Infinity : currentCycle
    if (!loop) {
      for (const [id, note] of this.admitted) {
        if (note.cycle <= currentCycle) continue
        this.engine.noteOffVoice(id, true)
        this.admitted.delete(id)
      }
      this.latestEnd = Math.max(this.anchor + (currentCycle + 1) * this.state.duration,
        ...[...this.admitted.values()].map(note => note.end))
      if (this.nextCycle > currentCycle) { this.nextCycle = currentCycle + 1; this.nextIndex = 0 }
    }
  }

  getState(): PlaybackState {
    if (this.state.status !== 'playing') return { ...this.state }
    const clock = this.engine.getAudioClock()
    if (!clock) return { ...this.state }
    const elapsed = Math.max(this.initialOffset, clock.time - this.anchor)
    const position = this.endCycle === 0
      ? Math.min(this.state.duration, elapsed) : elapsed % this.state.duration
    return { ...this.state, position }
  }

  getDiagnostics(): { skippedNotes: number; lateNotes: number; scheduledNotes: number } {
    return { skippedNotes: this.skippedNotes, lateNotes: this.lateNotes, scheduledNotes: this.admitted.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.unsubscribe()
    this.unsubscribeCancellation()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
  }

  private tick(): void {
    if (this.disposed || this.state.status !== 'playing' || !this.sourceId) return
    const clock = this.engine.getAudioClock()
    if (!clock || clock.state !== 'running') { this.pause(); return }
    let blockedAt: number | null = null
    let attempts = 0
    while (attempts++ < 256 && this.nextCycle <= this.endCycle) {
      if (this.nextIndex >= this.notes.length) {
        if (this.nextCycle >= this.endCycle) break
        ++this.nextCycle
        this.nextIndex = 0
      }
      const note = this.notes[this.nextIndex]
      if (this.nextCycle === 0 && note.end <= this.initialOffset) { ++this.nextIndex; continue }
      const cycleAt = this.anchor + this.nextCycle * this.state.duration
      const start = cycleAt + (this.nextCycle === 0 ? Math.max(note.start, this.initialOffset) : note.start)
      const end = cycleAt + note.end
      if (start > clock.time + LOOKAHEAD) break
      if (start < clock.time - LOOKAHEAD) { ++this.skippedNotes; ++this.nextIndex; continue }
      const id = `${this.sourceId}:${this.nextCycle}:${this.nextIndex}:${note.id}`
      const accepted = this.engine.scheduleNote({
        id, midi: note.midi, frequency: 440 * 2 ** ((note.midi - 69) / 12),
        velocity: note.velocity, sourceId: this.sourceId, sourceName: 'Phrase',
        channel: note.channel, origin: 'sequence',
      }, start, end)
      if (!accepted) { blockedAt = start; break }
      if (start < clock.time - 0.001) ++this.lateNotes
      const actualEnd = end + Math.max(0, (this.engine.getAudioClock()?.time ?? clock.time) - start)
      this.latestEnd = Math.max(this.latestEnd, actualEnd)
      this.admitted.set(id, { cycle: this.nextCycle, end: actualEnd })
      ++this.nextIndex
    }
    for (const [id, note] of this.admitted) if (clock.time >= note.end) this.admitted.delete(id)
    const end = Math.max(this.anchor + (this.endCycle + 1) * this.state.duration, this.latestEnd)
    if (Number.isFinite(end) && clock.time >= end) {
      this.clearTimer()
      this.state = { ...this.state, status: 'stopped', position: this.state.duration }
      // Native Off is already scheduled. Allow its Release to finish naturally.
      this.emit()
      return
    }
    this.state = this.getState()
    this.emit()
    this.clearTimer()
    const wait = blockedAt === null ? TICK_MS
      : blockedAt > clock.time + 0.005 ? Math.max(1, Math.min(TICK_MS, (blockedAt - clock.time - 0.004) * 1000)) : 5
    this.timer = setTimeout(() => { this.timer = null; this.tick() }, wait)
  }

  private cancelSource(): void {
    this.clearTimer()
    if (this.sourceId) {
      this.engine.releaseVoices({ sourceId: this.sourceId }, true)
      this.engine.cancelMetronome(this.sourceId)
    }
    this.sourceId = null
    this.admitted.clear()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private emit(): void { this.onUpdate({ ...this.state }) }
  private readonly onVisibility = (): void => {
    if (document.hidden && (this.state.status === 'playing' || this.preparing)) this.pause()
  }
}
