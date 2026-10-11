import { copyParams, type SynthParams, type Waveform } from '../types'
import type { EnvelopePhase, VoiceNote, VoiceSnapshot } from './voiceTypes'

const MIN_ENVELOPE_SECONDS = 0.004
const WAVE_FADE_SECONDS = 0.025
const SMOOTH_SECONDS = 0.025

interface Ramp { start: number; end: number; from: number; to: number }
interface EnvelopeRamp extends Ramp { phase: EnvelopePhase }
interface Carrier { oscillator: OscillatorNode; gain: GainNode; waveform: Waveform }

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
  readonly note: VoiceNote
  gateOpen = true
  releasingAt: number | null = null
  retiring = false
  private params: SynthParams
  private envelope: GainNode
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

  constructor(
    context: AudioContext,
    destination: AudioNode,
    pitchModulation: GainNode,
    note: VoiceNote,
    params: SynthParams,
    instanceId: number,
    pitchBend: number,
  ) {
    this.context = context
    this.pitchModulation = pitchModulation
    this.note = { ...note }
    this.params = copyParams(params)
    this.instanceId = instanceId
    this.pitchBend = pitchBend
    const now = context.currentTime
    this.createdAt = now
    this.frequencyRamp = { start: now, end: now, from: note.frequency, to: note.frequency }
    this.envelope = context.createGain()
    this.velocityGain = context.createGain()
    this.envelope.gain.value = 0
    this.velocityGain.gain.value = note.velocity / 127
    this.envelope.connect(this.velocityGain)
    this.velocityGain.connect(destination)
    this.carrier = this.createCarrier(params.waveform, 1, now)
    this.attack(now)
  }

  setParams(params: SynthParams, now: number): void {
    if (this.destroyed) return
    const previous = this.params
    this.params = copyParams(params)
    if (this.note.origin === 'audition' && this.note.frequency !== params.frequency) this.setFrequency(params.frequency, now)
    const adsrChanged = (Object.keys(params.adsr) as Array<keyof SynthParams['adsr']>)
      .some(key => previous.adsr[key] !== params.adsr[key])
    if (adsrChanged) this.updateEnvelope(previous, now)
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
    this.gateOpen = true
    this.releasingAt = null
    this.releaseEnds = Infinity
    this.fixedRelease = false
    this.attack(now)
  }

  release(seconds?: number, force = false): void {
    if (this.destroyed || (!this.gateOpen && !force)) return
    const now = this.context.currentTime
    const value = this.envelopeValue(now)
    const previousEnd = !this.gateOpen && this.fixedRelease ? this.releaseEnds : Infinity
    this.gateOpen = false
    this.releasingAt ??= now
    this.fixedRelease ||= force || seconds !== undefined
    this.releaseEnds = Math.min(previousEnd, now + Math.max(MIN_ENVELOPE_SECONDS, seconds ?? this.params.adsr.release))
    this.scheduleEnvelope([{ start: now, end: this.releaseEnds, from: value, to: 0, phase: 'release' }], now)
  }

  /** Audio time, rather than wall time, decides when a suspended tail finishes. */
  maintain(now: number): boolean {
    if (this.destroyed) return true
    if (!this.gateOpen && now >= this.releaseEnds + 0.005) {
      this.destroy()
      return true
    }
    this.requestWaveform(now)
    return false
  }

  nextMaintenanceAt(): number {
    return Math.min(this.releaseEnds + 0.005, this.retiringCarrier ? this.waveformFadeEnds : Infinity)
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

  getWaveform(): Waveform { return this.carrier?.waveform ?? this.params.waveform }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.gateOpen = false
    for (const carrier of this.carriers()) this.destroyCarrier(carrier)
    this.carrier = null
    this.retiringCarrier = null
    this.envelope.disconnect()
    this.velocityGain.disconnect()
    this.envelopeRamps = []
  }

  private setFrequency(frequency: number, now: number): void {
    const current = rampValue(this.frequencyRamp, now)
    this.note.frequency = frequency
    this.frequencyRamp = { start: now, end: now + SMOOTH_SECONDS, from: current, to: frequency }
    for (const carrier of this.carriers()) {
      carrier.oscillator.frequency.cancelAndHoldAtTime(now)
      carrier.oscillator.frequency.linearRampToValueAtTime(frequency, this.frequencyRamp.end)
    }
  }

  private createCarrier(waveform: Waveform, gain: number, now: number): Carrier {
    const carrier: Carrier = { oscillator: this.context.createOscillator(), gain: this.context.createGain(), waveform }
    carrier.oscillator.type = waveform
    carrier.oscillator.frequency.setValueAtTime(rampValue(this.frequencyRamp, now), now)
    if (this.frequencyRamp.end > now) carrier.oscillator.frequency.linearRampToValueAtTime(this.frequencyRamp.to, this.frequencyRamp.end)
    carrier.oscillator.detune.setValueAtTime(this.pitchBend * 100, now)
    carrier.gain.gain.value = gain
    this.pitchModulation.connect(carrier.oscillator.detune)
    carrier.oscillator.connect(carrier.gain)
    carrier.gain.connect(this.envelope)
    carrier.oscillator.start(now)
    return carrier
  }

  private requestWaveform(now: number): void {
    if (this.destroyed || !this.carrier) return
    if (this.retiringCarrier) {
      if (now < this.waveformFadeEnds) return // Coalesce rapid controls; never create a third carrier.
      this.destroyCarrier(this.retiringCarrier)
      this.retiringCarrier = null
      this.waveformFadeEnds = Infinity
    }
    if (this.carrier.waveform === this.params.waveform) return
    const outgoing = this.carrier
    const incoming = this.createCarrier(this.params.waveform, 0, now)
    incoming.gain.gain.linearRampToValueAtTime(1, now + WAVE_FADE_SECONDS)
    outgoing.gain.gain.cancelScheduledValues(now)
    outgoing.gain.gain.setValueAtTime(1, now)
    outgoing.gain.gain.linearRampToValueAtTime(0, now + WAVE_FADE_SECONDS)
    outgoing.oscillator.stop(now + WAVE_FADE_SECONDS + 0.005)
    this.carrier = incoming
    this.retiringCarrier = outgoing
    this.waveformFadeEnds = now + WAVE_FADE_SECONDS + 0.005
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
    for (const ramp of this.envelopeRamps) if (now < ramp.end) return ramp.phase
    return this.gateOpen ? 'sustain' : 'idle'
  }

  private scheduleEnvelope(ramps: EnvelopeRamp[], now: number): void {
    const value = this.envelopeValue(now)
    const param = this.envelope.gain
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now)
    else { param.cancelScheduledValues(now); param.setValueAtTime(value, now) }
    for (const ramp of ramps) param.linearRampToValueAtTime(ramp.to, ramp.end)
    this.envelopeRamps = ramps
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
    const value = this.envelopeValue(now)
    const phase = this.envelopePhase(now)
    const current = this.envelopeRamps.find(ramp => now < ramp.end)
    if (this.gateOpen) {
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
}
