import { SynthVoice } from './SynthVoice'
import type { VoiceScope } from './voiceTypes'

export const MAX_VOICES = 16
export const MAX_RETIRING_VOICES = 4
const STEAL_FADE_SECONDS = 0.012

export function voiceMatches(note: { sourceId: string; channel: number | null }, scope: VoiceScope): boolean {
  return (scope.sourceId === undefined || scope.sourceId === note.sourceId)
    && (scope.channel === undefined || scope.channel === note.channel)
}

/** Counts Release tails toward allocation, with a small bounded stealing fade. */
export class VoiceManager {
  private managed = new Map<number, SynthVoice>()
  private retiring = new Map<number, SynthVoice>()
  private held = new Map<string, SynthVoice>()
  createdCount = 0
  destroyedCount = 0

  get count(): number { return this.managed.size }
  get retiringCount(): number { return this.retiring.size }
  get heldCount(): number { return [...this.held.values()].filter(voice => voice.gateOpen).length }
  get all(): SynthVoice[] { return [...this.managed.values(), ...this.retiring.values()] }
  findHeld(id: string): SynthVoice | undefined { return this.held.get(id) }

  makeRoom(): boolean {
    if (this.managed.size < MAX_VOICES) return true
    // A saturated burst waits for a tail to reach zero. Hard truncation here
    // would introduce a discontinuity even though oscillator counts are bounded.
    if (this.retiring.size >= MAX_RETIRING_VOICES) {
      const future = [...this.managed.values()].find(voice => voice.note.origin === 'sequence' && voice.canCancelBeforeStart())
      if (!future) return false
      this.managed.delete(future.instanceId)
      if (this.held.get(future.note.id) === future) this.held.delete(future.note.id)
      future.destroy()
      ++this.destroyedCount
      return true
    }
    this.steal()
    return true
  }

  add(voice: SynthVoice): void {
    if (this.managed.size >= MAX_VOICES) throw new Error('Voice capacity was not reserved')
    this.managed.set(voice.instanceId, voice)
    this.held.set(voice.note.id, voice)
    ++this.createdCount
  }

  release(id: string, immediate: boolean): void {
    const voice = this.held.get(id)
    if (!voice) return
    this.held.delete(id)
    voice.release(immediate ? 0.025 : undefined)
  }

  releaseScope(scope: VoiceScope, immediate: boolean, discardSilentSequences = false): void {
    for (const voice of this.all) {
      if (!voiceMatches(voice.note, scope)) continue
      if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id)
      if (discardSilentSequences && voice.note.origin === 'sequence') { voice.destroy(); continue }
      // All Sound Off also shortens already releasing voices, unlike Notes Off.
      if (immediate) voice.release(0.025, true)
      else if (voice.gateOpen || voice.awaitingStart) voice.release()
    }
  }

  maintain(now: number): void {
    for (const collection of [this.managed, this.retiring]) {
      for (const [id, voice] of collection) {
        if (!voice.maintain(now)) continue
        collection.delete(id)
        if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id)
        ++this.destroyedCount
      }
    }
  }

  nextMaintenanceAt(): number {
    return this.all.reduce((earliest, voice) => Math.min(earliest, voice.nextMaintenanceAt()), Infinity)
  }

  destroyAll(): void {
    for (const voice of this.all) { voice.destroy(); ++this.destroyedCount }
    this.managed.clear()
    this.retiring.clear()
    this.held.clear()
  }

  private steal(): void {
    const voices = [...this.managed.values()]
    const released = voices.filter(voice => !voice.gateOpen)
    const candidate = (released.length ? released : voices).sort((a, b) => {
      const aTime = released.length ? a.releasingAt ?? a.createdAt : a.createdAt
      const bTime = released.length ? b.releasingAt ?? b.createdAt : b.createdAt
      return aTime - bTime || a.instanceId - b.instanceId
    })[0]
    this.managed.delete(candidate.instanceId)
    if (this.held.get(candidate.note.id) === candidate) this.held.delete(candidate.note.id)
    candidate.retiring = true
    candidate.release(STEAL_FADE_SECONDS, true)
    if (candidate.getEnvelopeControlState().destroyed) ++this.destroyedCount
    else this.retiring.set(candidate.instanceId, candidate)
  }
}
