import { copyParams, type SynthMode, type SynthParams, type Waveform } from '../types'
import { getClassicComparisonGain, getHarmonicCoefficients } from '../harmonics/model'
import { getPeriodicWaveCache, harmonicKey, type PeriodicWaveCache } from './PeriodicWaveCache'
import { createEnvelopeControl, type EnvelopeLease, type EnvelopeProcessorState } from './EnvelopeControl'
import type { EnvelopePhase, VoiceNote, VoiceSnapshot } from './voiceTypes'

const MIN_ENVELOPE_SECONDS = 0.004
const WAVE_FADE_SECONDS = 0.025
const SMOOTH_SECONDS = 0.025
// Native Windows captures deliver control plans up to four render quanta after
// the main-thread currentTime snapshot. Keep one further quantum of headroom;
// this schedules the original ADSR ahead, without stretching its attack/tail.
export const CONTROL_LEAD_FRAMES = 640

interface Ramp { start: number; end: number; from: number; to: number }
interface EnvelopeRamp extends Ramp { phase: EnvelopePhase }
interface Timbre { mode: SynthMode; waveform: Waveform; key: string; level: number; coefficients: number[] | null }
interface Carrier { oscillator: OscillatorNode; gain: GainNode; waveform: Waveform; mode: SynthMode; key: string; level: number; smoothing: boolean }
export interface VoiceTiming { startAt: number; endAt: number }

function rampValue(ramp: Ramp, now: number): number {
  if (now <= ramp.start) return ramp.from
  if (now >= ramp.end) return ramp.to
  return ramp.from + (ramp.to - ramp.from) * (now - ramp.start) / (ramp.end - ramp.start)
}

function smooth(param: AudioParam, value: number, now: number): void {
  param.cancelAndHoldAtTime(now)
  param.setTargetAtTime(value, now, 0.008)
}

/** One independently gated note. The engine owns the context, filter and LFO. */
export class SynthVoice {
  readonly instanceId: number
  readonly createdAt: number
  private allocatedClock: number
  private startClock = Infinity
  private armed = false
  private startupReversal = true
  private readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (reason: unknown) => void
  readonly note: VoiceNote
  private gate = true
  private scheduledEnd: number | null = null
  releasingAt: number | null = null
  retiring = false
  private params: SynthParams
  private envelope: GainNode
  private envelopeControl!: EnvelopeLease
  private envelopeRevision = 0
  private envelopeAcknowledgement: EnvelopeProcessorState | null = null
  private velocityGain: GainNode
  private carrier: Carrier | null = null
  private retiringCarrier: Carrier | null = null
  private waveformFadeEnds = Infinity
  private releaseEnds = Infinity
  private fixedRelease = false
  private envelopeRamps: EnvelopeRamp[] = []
  private frequencyRamp: Ramp
  private pitchBend: number
  private destroyed = false
  private context: AudioContext
  private pitchModulation: GainNode
  private waveCache: PeriodicWaveCache

  constructor(
    context: AudioContext,
    destination: AudioNode,
    pitchModulation: GainNode,
    note: VoiceNote,
    params: SynthParams,
    instanceId: number,
    pitchBend: number,
    timing?: VoiceTiming,
  ) {
    this.context = context
    this.pitchModulation = pitchModulation
    this.waveCache = getPeriodicWaveCache(context)
    this.note = { ...note }
    this.params = copyParams(params)
    this.instanceId = instanceId
    this.pitchBend = pitchBend
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const now = context.currentTime
    this.createdAt = now
    this.allocatedClock = now
    this.frequencyRamp = { start: now, end: now, from: note.frequency, to: note.frequency }
    this.envelope = context.createGain()
    this.velocityGain = context.createGain()
    // The native gain timeline never changes while the voice is running.
    // Its audio-rate input supplies the complete musical envelope instead.
    this.envelope.gain.value = 0
    this.velocityGain.gain.value = note.velocity / 127
    this.envelope.connect(this.velocityGain)
    this.velocityGain.connect(destination)
    const timbre = this.getTimbre()
    this.carrier = this.createCarrier(timbre, timbre.level, now, false)
    // Future transport notes keep their exact synchronous bootstrap. A live
    // note reserves a silent lane until this task's synchronous reversals finish.
    const scheduledAt = context.currentTime
    this.startClock = timing && timing.startAt > scheduledAt ? timing.startAt : this.controlTime(scheduledAt)
    this.scheduledEnd = timing ? Math.max(this.startsAt + 0.001, timing.endAt + this.startsAt - timing.startAt) : null
    if (timing) {
      this.attack(this.startsAt)
      this.armed = true
      this.startupReversal = false
    }
    this.envelopeControl = createEnvelopeControl(context, instanceId, timing ? {
      type: 'plan', revision: this.envelopeRevision, at: this.startsAt, ramps: this.envelopeRamps,
    } : undefined)
    this.envelopeControl.port.onmessage = (event: MessageEvent<EnvelopeProcessorState>) => {
      const state = event.data
      if (this.destroyed || state?.type !== 'state' || state.instanceId !== this.instanceId) return
      // A delayed acknowledgement from the previous plan cannot authorize
      // cleanup after a retrigger, live ADSR edit or shortened forced release.
      if (state.slot !== this.envelopeControl.slot || state.generation !== this.envelopeControl.generation
        || state.revision !== this.envelopeRevision) return
      this.envelopeAcknowledgement = state
    }
    this.envelopeControl.connect(this.envelope.gain)
    this.allocatedClock = context.currentTime
    if (timing) {
      this.carrier.oscillator.start(this.startsAt)
      this.resolveReady()
    } else {
      // No attack or source start is sent before this microtask: even if audio
      // advances during a busy synchronous caller, ON/OFF cannot leak an attack.
      queueMicrotask(() => {
        this.startupReversal = false
        try { this.commitStartup() } catch (error) {
          this.rejectReady(error)
          this.destroy()
        }
      })
    }
  }

  get startsAt(): number { return this.startClock }
  get allocatedAt(): number { return this.allocatedClock }
  ready(): Promise<void> { return this.readyPromise }

  get gateOpen(): boolean {
    return this.gateAt(this.context.currentTime)
  }

  get awaitingStart(): boolean { return !this.destroyed && this.beforeStart(this.context.currentTime) }
  get plannedEndAt(): number | null { return this.scheduledEnd }

  /** A clock snapshot near onset can trail audio already being rendered. */
  canCancelBeforeStart(now = this.context.currentTime): boolean {
    return !this.destroyed && this.startFrame() - this.sampleFrame(now) >= CONTROL_LEAD_FRAMES
  }

  setParams(params: SynthParams, now: number): void {
    if (this.destroyed) return
    const previous = this.params
    this.params = copyParams(params)
    if (this.note.origin === 'audition' && this.note.frequency !== params.frequency) this.setFrequency(params.frequency, now)
    if (!this.armed) return // Apply the latest ADSR and timbre once, when armed.
    const adsrChanged = (Object.keys(params.adsr) as Array<keyof SynthParams['adsr']>)
      .some(key => previous.adsr[key] !== params.adsr[key])
    if (adsrChanged) this.updateEnvelope(previous, this.controlTime(this.context.currentTime))
    this.requestWaveform(now)
  }

  setPitchBend(semitones: number, now: number): void {
    this.pitchBend = semitones
    for (const carrier of this.carriers()) smooth(carrier.oscillator.detune, semitones * 100, now)
  }

  /** Used only by the legacy manual Play audition, never by duplicate keys. */
  retrigger(velocity: number, now: number): void {
    if (this.destroyed) return
    this.note.velocity = velocity
    smooth(this.velocityGain.gain, velocity / 127, now)
    this.gate = true
    this.scheduledEnd = null
    this.releasingAt = null
    this.releaseEnds = Infinity
    this.fixedRelease = false
    if (!this.armed) return
    this.attack(Math.max(this.startsAt, this.controlTime(this.context.currentTime)))
  }

  release(seconds?: number, force = false): void {
    if (this.destroyed) return
    const currentTime = this.context.currentTime
    if (this.context.state !== 'running') { this.destroy(); return }
    const sameTaskReversal = this.note.origin !== 'sequence' && this.startupReversal
    if (sameTaskReversal || (this.note.origin === 'sequence' && this.beforeStart(currentTime))) {
      // Only distant queued starts are provably safe to disconnect. Close to
      // onset, replace the future attack atomically and wait for rendered zero;
      // a late command joins any already-rendering samples via the processor.
      if (!sameTaskReversal && this.canCancelBeforeStart(currentTime)) { this.destroy(); return }
      const now = this.sampleFrame(currentTime) / this.context.sampleRate
      this.gate = false
      this.scheduledEnd = null
      this.releasingAt = now
      this.fixedRelease = true
      this.releaseEnds = now + MIN_ENVELOPE_SECONDS
      this.scheduleEnvelope([{ start: now, end: this.releaseEnds, from: 0, to: 0, phase: 'release' }], now)
      return
    }
    if (!this.gateOpen && !force) return
    const now = this.controlTime(this.context.currentTime)
    const silentStart = this.sampleFrame(now) <= this.startFrame()
    const value = silentStart ? 0 : this.envelopeValue(now)
    const previousEnd = !this.gateOpen && this.fixedRelease ? this.releaseEnds : Infinity
    if (previousEnd <= now) return // An existing technical tail reaches zero sooner.
    this.gate = false
    this.scheduledEnd = null
    this.releasingAt = Math.min(this.releasingAt ?? now, now)
    this.fixedRelease ||= force || seconds !== undefined
    // Cancelling at the very start has no energy to release. Its zero-only
    // technical tail still needs a native ACK, without retaining a silent slot
    // for the preset's full musical Release.
    const duration = silentStart ? MIN_ENVELOPE_SECONDS : Math.max(MIN_ENVELOPE_SECONDS, seconds ?? this.params.adsr.release)
    this.releaseEnds = Math.min(previousEnd, now + duration)
    this.scheduleEnvelope([{ start: now, end: this.releaseEnds, from: value, to: 0, phase: 'release' }], now)
  }

  /** Audio time, rather than wall time, decides when a suspended tail finishes. */
  maintain(now: number): boolean {
    if (this.destroyed) return true
    if (!this.gateOpen && now >= this.releaseEnds + 0.005 && this.getEnvelopeControlState().safeToDestroy) {
      this.destroy()
      return true
    }
    this.requestWaveform(now)
    return false
  }

  nextMaintenanceAt(): number {
    const releaseAt = this.releaseEnds + 0.005
    // If a busy main thread has not delivered the zero ACK yet, poll at most
    // once per five milliseconds instead of rescheduling an expired deadline.
    const cleanupAt = releaseAt <= this.context.currentTime && !this.getEnvelopeControlState().safeToDestroy
      ? this.context.currentTime + 0.005 : releaseAt
    return Math.min(cleanupAt, this.retiringCarrier ? this.waveformFadeEnds : Infinity)
  }

  getEnvelopeControlState() {
    const acknowledgement = this.envelopeAcknowledgement
    const zero = acknowledgement?.revision === this.envelopeRevision && acknowledgement.zeroFrame !== null
    const notStarted = !this.armed || this.beforeStart(this.context.currentTime)
    const cancelSafeBeforeStart = this.canCancelBeforeStart()
    return {
      instanceId: this.instanceId,
      slot: this.envelopeControl.slot,
      generation: this.envelopeControl.generation,
      revision: this.envelopeRevision,
      acknowledgedRevision: acknowledgement?.revision ?? null,
      appliedFrame: acknowledgement?.appliedFrame ?? null,
      renderedThroughFrame: acknowledgement?.renderedThroughFrame ?? null,
      endFrame: acknowledgement?.endFrame ?? null,
      zeroFrame: acknowledgement?.zeroFrame ?? null,
      readyFrame: acknowledgement?.readyFrame ?? null,
      firstProcessFrame: acknowledgement?.firstProcessFrame ?? null,
      zero,
      connected: !this.destroyed,
      destroyed: this.destroyed,
      notStarted,
      startupReversalOpen: this.startupReversal && !this.destroyed,
      cancelSafeBeforeStart,
      contextState: this.context.state,
      safeToDestroy: this.destroyed || cancelSafeBeforeStart || this.context.state !== 'running' || zero,
    }
  }

  getSnapshot(now: number): VoiceSnapshot {
    return {
      ...this.note,
      instanceId: this.instanceId,
      gateOpen: this.gateOpen && !this.destroyed,
      phase: this.destroyed ? 'idle' : this.envelopePhase(now),
      envelope: this.destroyed ? 0 : this.envelopeValue(now),
      pitchBend: this.pitchBend,
      carrierCount: this.carriers().length,
      createdAt: this.createdAt,
      releasingAt: this.releasingAt,
      retiring: this.retiring,
    }
  }

  getWaveform(): Waveform {
    return this.carrier?.mode === 'classic' ? this.carrier.waveform : this.params.waveform
  }

  getMode(): SynthMode { return this.carrier?.mode ?? this.params.mode }

  hasPendingTimbre(): boolean {
    const timbre = this.getTimbre()
    return this.carrier?.key !== timbre.key || this.carrier.level !== timbre.level
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.gate = false
    for (const carrier of this.carriers()) this.destroyCarrier(carrier)
    this.carrier = null
    this.retiringCarrier = null
    this.envelope.disconnect()
    this.envelopeControl.port.postMessage({ type: 'dispose-lane' })
    this.envelopeControl.disconnect()
    this.envelopeControl.port.onmessage = null
    this.envelopeControl.port.close()
    this.velocityGain.disconnect()
    this.envelopeRamps = []
    this.resolveReady()
  }

  private commitStartup(): void {
    if (this.destroyed || !this.gate) { this.resolveReady(); return }
    if (this.context.state !== 'running') { this.destroy(); return }
    const carrier = this.carrier!
    const timbre = this.getTimbre()
    if (timbre.coefficients) carrier.oscillator.setPeriodicWave(this.waveCache.get(timbre.coefficients))
    else carrier.oscillator.type = timbre.waveform
    carrier.waveform = timbre.waveform
    carrier.mode = timbre.mode
    carrier.key = timbre.key
    carrier.level = timbre.level
    const now = this.context.currentTime
    carrier.gain.gain.setValueAtTime(timbre.level, now)
    this.allocatedClock = now
    this.startClock = this.controlTime(now)
    this.armed = true
    this.attack(this.startsAt)
    carrier.oscillator.start(this.startsAt)
    this.resolveReady()
  }

  private setFrequency(frequency: number, now: number): void {
    const current = rampValue(this.frequencyRamp, now)
    this.note.frequency = frequency
    this.frequencyRamp = { start: now, end: now + SMOOTH_SECONDS, from: current, to: frequency }
    for (const carrier of this.carriers()) {
      carrier.oscillator.frequency.cancelAndHoldAtTime(now)
      carrier.oscillator.frequency.setValueAtTime(current, now)
      carrier.oscillator.frequency.linearRampToValueAtTime(frequency, this.frequencyRamp.end)
    }
  }

  private getTimbre(): Timbre {
    const mode = this.params.mode
    const waveform = this.params.waveform
    const coefficients = mode === 'additive' ? getHarmonicCoefficients(this.params.additive) : null
    return {
      mode, waveform, coefficients,
      key: mode === 'additive' ? `additive:${harmonicKey(coefficients!)}` : `classic:${waveform}`,
      level: mode === 'classic' && this.params.additive.compare
        ? getClassicComparisonGain(this.params.additive, waveform) : 1,
    }
  }

  private createCarrier(timbre: Timbre, gain: number, now: number, start = true): Carrier {
    const carrier: Carrier = {
      oscillator: this.context.createOscillator(), gain: this.context.createGain(),
      waveform: timbre.waveform, mode: timbre.mode, key: timbre.key, level: timbre.level, smoothing: false,
    }
    if (timbre.coefficients) carrier.oscillator.setPeriodicWave(this.waveCache.get(timbre.coefficients))
    else carrier.oscillator.type = timbre.waveform
    carrier.oscillator.frequency.setValueAtTime(rampValue(this.frequencyRamp, now), now)
    if (this.frequencyRamp.end > now) carrier.oscillator.frequency.linearRampToValueAtTime(this.frequencyRamp.to, this.frequencyRamp.end)
    carrier.oscillator.detune.setValueAtTime(this.pitchBend * 100, now)
    carrier.gain.gain.value = gain
    carrier.gain.gain.setValueAtTime(gain, now)
    this.pitchModulation.connect(carrier.oscillator.detune)
    carrier.oscillator.connect(carrier.gain)
    carrier.gain.connect(this.envelope)
    if (start) carrier.oscillator.start(Math.max(now, this.startsAt))
    return carrier
  }

  private requestWaveform(now: number): void {
    if (this.destroyed || !this.armed || !this.carrier) return
    if (this.retiringCarrier) {
      if (now < this.waveformFadeEnds) return // Coalesce rapid controls; never create a third carrier.
      this.destroyCarrier(this.retiringCarrier)
      this.retiringCarrier = null
      this.waveformFadeEnds = Infinity
    }
    const timbre = this.getTimbre()
    if (this.carrier.key === timbre.key) {
      if (this.carrier.level !== timbre.level) {
        smooth(this.carrier.gain.gain, timbre.level, now)
        this.carrier.level = timbre.level
        this.carrier.smoothing = true
      }
      return
    }
    const outgoing = this.carrier
    const incoming = this.createCarrier(timbre, 0, now, false)
    const fadeAt = this.controlTime(this.context.currentTime)
    incoming.oscillator.start(Math.max(fadeAt, this.startsAt))
    incoming.gain.gain.setValueAtTime(0, fadeAt)
    incoming.gain.gain.linearRampToValueAtTime(timbre.level, fadeAt + WAVE_FADE_SECONDS)
    const outgoingGain = outgoing.gain.gain.value
    outgoing.gain.gain.cancelAndHoldAtTime(fadeAt)
    if (!outgoing.smoothing) outgoing.gain.gain.setValueAtTime(outgoingGain, fadeAt)
    outgoing.gain.gain.linearRampToValueAtTime(0, fadeAt + WAVE_FADE_SECONDS)
    outgoing.oscillator.stop(fadeAt + WAVE_FADE_SECONDS + 0.005)
    this.carrier = incoming
    this.retiringCarrier = outgoing
    this.waveformFadeEnds = fadeAt + WAVE_FADE_SECONDS + 0.005
  }

  private carriers(): Carrier[] {
    return [this.carrier, this.retiringCarrier].filter((carrier): carrier is Carrier => carrier !== null)
  }

  private destroyCarrier(carrier: Carrier): void {
    try { carrier.oscillator.stop() } catch { /* Already stopped or closed. */ }
    try { this.pitchModulation.disconnect(carrier.oscillator.detune) } catch { /* Connection already gone. */ }
    carrier.oscillator.disconnect()
    carrier.gain.disconnect()
  }

  private envelopeValue(now: number): number {
    for (const ramp of this.envelopeRamps) if (now <= ramp.end) return rampValue(ramp, now)
    return this.envelopeRamps.at(-1)?.to ?? 0
  }

  private envelopePhase(now: number): EnvelopePhase {
    if (!this.armed || this.beforeStart(now)) return 'idle'
    for (const ramp of this.envelopeRamps) {
      if (now < ramp.start) return this.envelopeValue(now) > 0 ? 'sustain' : 'idle'
      if (now < ramp.end) return ramp.phase
    }
    return this.gateAt(now) ? 'sustain' : 'idle'
  }

  private scheduleEnvelope(ramps: EnvelopeRamp[], now: number): void {
    const value = this.envelopeValue(now)
    const previous = this.envelopeRamps
    if (this.scheduledEnd !== null && now < this.scheduledEnd) {
      const endAt = this.scheduledEnd
      const held: EnvelopeRamp[] = []
      let endValue = value
      for (const ramp of ramps) {
        if (ramp.start >= endAt) break
        const end = Math.min(ramp.end, endAt)
        endValue = rampValue(ramp, end)
        held.push({ ...ramp, end, to: endValue })
        if (end === endAt) break
      }
      this.releasingAt = endAt
      this.releaseEnds = endAt + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.release)
      ramps = [...held, { start: endAt, end: this.releaseEnds, from: endValue, to: 0, phase: 'release' }]
    }
    const currentTime = this.context.currentTime
    const prefix = previous.filter(ramp => ramp.end > currentTime && ramp.start < now)
      .map(ramp => {
        const start = Math.max(ramp.start, currentTime)
        const end = Math.min(ramp.end, now)
        return { ...ramp, start, end, from: rampValue(ramp, start), to: rampValue(ramp, end) }
      }).filter(ramp => ramp.end > ramp.start)
    this.envelopeRamps = [...prefix, ...ramps]
    this.envelopeAcknowledgement = null
    const revision = ++this.envelopeRevision
    // Transport bootstraps use the claim; live startup and later edits use the
    // same port of the already processing shared control.
    if (this.envelopeControl) this.envelopeControl.port.postMessage({
      type: 'plan', revision, at: now,
      ramps: this.envelopeRamps,
    })
  }

  private attack(now: number): void {
    const attackEnd = now + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.attack)
    const decayEnd = attackEnd + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.decay)
    this.scheduleEnvelope([
      { start: now, end: attackEnd, from: this.envelopeValue(now), to: 1, phase: 'attack' },
      { start: attackEnd, end: decayEnd, from: 1, to: this.params.adsr.sustain, phase: 'decay' },
    ], now)
  }

  private updateEnvelope(previous: SynthParams, now: number): void {
    if (this.beforeStart(now)) { this.attack(this.startsAt); return }
    const value = this.envelopeValue(now)
    const phase = this.envelopePhase(now)
    const current = this.envelopeRamps.find(ramp => now < ramp.end)
    if (this.gateAt(now)) {
      if (phase === 'attack' && current) {
        const remaining = (current.end - now) * Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.attack) / Math.max(MIN_ENVELOPE_SECONDS, previous.adsr.attack)
        const attackEnd = now + Math.max(MIN_ENVELOPE_SECONDS, remaining)
        this.scheduleEnvelope([
          { start: now, end: attackEnd, from: value, to: 1, phase: 'attack' },
          { start: attackEnd, end: attackEnd + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.decay), from: 1, to: this.params.adsr.sustain, phase: 'decay' },
        ], now)
      } else if (phase === 'decay' && current) {
        const remaining = (current.end - now) * Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.decay) / Math.max(MIN_ENVELOPE_SECONDS, previous.adsr.decay)
        this.scheduleEnvelope([{ start: now, end: now + Math.max(MIN_ENVELOPE_SECONDS, remaining), from: value, to: this.params.adsr.sustain, phase: 'decay' }], now)
      } else {
        this.scheduleEnvelope([{ start: now, end: now + SMOOTH_SECONDS, from: value, to: this.params.adsr.sustain, phase: 'sustain' }], now)
      }
    } else if (!this.fixedRelease && phase === 'release' && current && previous.adsr.release !== this.params.adsr.release) {
      const remaining = (current.end - now) * Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.release) / Math.max(MIN_ENVELOPE_SECONDS, previous.adsr.release)
      this.releaseEnds = now + Math.max(MIN_ENVELOPE_SECONDS, remaining)
      this.scheduleEnvelope([{ start: now, end: this.releaseEnds, from: value, to: 0, phase: 'release' }], now)
    }
  }

  private gateAt(now: number): boolean {
    return this.gate && !this.destroyed && (this.note.origin !== 'sequence' || !this.beforeStart(now))
      && (this.scheduledEnd === null || now < this.scheduledEnd)
  }

  private sampleFrame(time: number): number { return Math.round(time * this.context.sampleRate) }
  private startFrame(): number { return Math.ceil(this.startsAt * this.context.sampleRate - 1e-7) }
  private beforeStart(now: number): boolean { return this.sampleFrame(now) < this.startFrame() }
  private controlTime(now: number): number {
    return (this.sampleFrame(now) + CONTROL_LEAD_FRAMES) / this.context.sampleRate
  }

}
