import { copyParams, type AnalysisNodes, type SynthParams, type Waveform } from '../types'

const SMOOTH_SECONDS = 0.025
const MIN_ENVELOPE_SECONDS = 0.004
const WAVE_FADE_SECONDS = 0.025
// Keep the complete MIDI note range, including C-1; manual controls start at 20 Hz.
const MIN_FREQUENCY = 440 * 2 ** ((0 - 69) / 12)

type EnvelopePhase = 'attack' | 'decay' | 'sustain' | 'release' | 'idle'
interface Ramp {
  start: number
  end: number
  from: number
  to: number
}
interface EnvelopeRamp extends Ramp { phase: EnvelopePhase }
interface Carrier {
  oscillator: OscillatorNode
  gain: GainNode
  waveform: Waveform
}
interface Graph {
  input: GainNode
  filter: BiquadFilterNode
  dry: GainNode
  wet: GainNode
  envelope: GainNode
  amplitude: GainNode
  velocityGain: GainNode
  compressor: DynamicsCompressorNode
  master: GainNode
  limiter: WaveShaperNode
  time: AnalyserNode
  frequency: AnalyserNode
  lfo: OscillatorNode
  pitchModulation: GainNode
  filterModulation: GainNode
}

function bounded(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function sanitized(params: SynthParams): SynthParams {
  const copy = copyParams(params)
  copy.frequency = bounded(copy.frequency, MIN_FREQUENCY, 20000, 220)
  copy.amplitude = bounded(copy.amplitude, 0, 1, 0.25)
  copy.adsr.attack = bounded(copy.adsr.attack, 0, 20, 0.02)
  copy.adsr.decay = bounded(copy.adsr.decay, 0, 20, 0.2)
  copy.adsr.sustain = bounded(copy.adsr.sustain, 0, 1, 0.75)
  copy.adsr.release = bounded(copy.adsr.release, 0, 30, 0.35)
  copy.filter.cutoff = bounded(copy.filter.cutoff, 20, 20000, 8000)
  copy.filter.q = bounded(copy.filter.q, 0.05, 20, 0.707)
  copy.lfo.rate = bounded(copy.lfo.rate, 0.05, 30, 4)
  copy.lfo.depth = bounded(copy.lfo.depth, 0, 1, 0.15)
  return copy
}

function rampValue(ramp: Ramp, now: number): number {
  if (now <= ramp.start) return ramp.from
  if (now >= ramp.end) return ramp.to
  return ramp.from + (ramp.to - ramp.from) * ((now - ramp.start) / (ramp.end - ramp.start))
}

/**
 * One monophonic voice. AudioContext is created by noteOn() or a user-gesture
 * prepare(), so constructing the engine or moving controls stays audio-free.
 * Carrier replacement uses a 25 ms crossfade, with at most two carriers alive.
 */
export class SynthEngine {
  private params: SynthParams
  private context: AudioContext | null = null
  private graph: Graph | null = null
  private carrier: Carrier | null = null
  private retiringCarrier: Carrier | null = null
  private waveformFadeEnds = 0
  private waveformTimer: ReturnType<typeof setTimeout> | null = null
  private frequencyRamp: Ramp
  private envelopeRamps: EnvelopeRamp[] = []
  private gateOpen = false
  private releaseEnds = 0
  private requestVersion = 0
  private disposed = false
  private resumePromise: Promise<void> | null = null
  private disposePromise: Promise<void> | null = null
  private velocity = 127
  private pitchBend = 0

  constructor(initial: SynthParams) {
    this.params = sanitized(initial)
    this.frequencyRamp = { start: 0, end: 0, from: this.params.frequency, to: this.params.frequency }
  }

  /** Applies controls before or after initialization, without opening the gate. */
  setParams(params: SynthParams): void {
    if (this.disposed) return
    const previous = this.params
    this.params = sanitized(params)
    const context = this.context
    const graph = this.graph
    if (!context || !graph || context.state === 'closed') return
    const now = context.currentTime

    if (previous.frequency !== this.params.frequency) {
      const current = rampValue(this.frequencyRamp, now)
      this.frequencyRamp = { start: now, end: now + SMOOTH_SECONDS, from: current, to: this.params.frequency }
      for (const carrier of this.carriers()) {
        carrier.oscillator.frequency.cancelScheduledValues(now)
        carrier.oscillator.frequency.setValueAtTime(current, now)
        carrier.oscillator.frequency.linearRampToValueAtTime(this.params.frequency, now + SMOOTH_SECONDS)
      }
    }
    this.smooth(graph.amplitude.gain, this.params.amplitude, now)
    this.smooth(graph.filter.frequency, Math.min(this.params.filter.cutoff, context.sampleRate * 0.49), now)
    // Web Audio low-pass Q is expressed in dB; the interface uses the familiar
    // unitless quality factor (0.707 gives a flat Butterworth response).
    this.smooth(graph.filter.Q, 20 * Math.log10(this.params.filter.q), now)
    this.smooth(graph.dry.gain, this.params.filter.bypass ? 1 : 0, now)
    this.smooth(graph.wet.gain, this.params.filter.bypass ? 0 : 1, now)
    this.smooth(graph.lfo.frequency, this.params.lfo.rate, now)

    // Modulate in cents, keeping pitch positive and filter movement proportional
    // across the complete cutoff range. Both destinations fade during a switch.
    const depth = this.params.lfo.enabled ? this.params.lfo.depth : 0
    this.smooth(graph.pitchModulation.gain, this.params.lfo.target === 'pitch' ? depth * 100 : 0, now)
    this.smooth(graph.filterModulation.gain, this.params.lfo.target === 'filter' ? depth * 2400 : 0, now)

    const adsrChanged = (Object.keys(this.params.adsr) as Array<keyof SynthParams['adsr']>)
      .some(key => previous.adsr[key] !== this.params.adsr[key])
    if (adsrChanged) this.updateEnvelope(previous, now)
    this.requestWaveform(now)
  }

  /** Unlocks audio from a connection gesture without opening the note gate. */
  async prepare(): Promise<void> {
    if (this.disposed) return
    if (!this.context) this.initialize()
    try {
      await this.resumeContext(this.context!)
    } catch (error) {
      if (!this.disposed) throw error
    }
  }

  /** A later Note Off always cancels a pending resume, including MIDI input. */
  async noteOn(frequency?: number, velocity = 127): Promise<void> {
    if (this.disposed) return
    const nextVelocity = bounded(velocity, 0, 127, 127)
    if (nextVelocity === 0) {
      this.noteOff()
      return
    }
    const version = ++this.requestVersion
    if (frequency !== undefined) this.setParams({ ...this.params, frequency })
    if (!this.context) this.initialize()
    const context = this.context!
    if (context.state === 'closed') return

    if (context.state !== 'running') {
      try {
        await this.resumeContext(context)
      } catch (error) {
        if (!this.disposed && version === this.requestVersion) throw error
        return
      }
    }
    if (this.disposed || version !== this.requestVersion || context.state !== 'running') return
    const now = context.currentTime
    this.velocity = nextVelocity
    this.smooth(this.graph!.velocityGain.gain, nextVelocity / 127, now)
    this.requestWaveform(now)
    this.gateOpen = true
    this.releaseEnds = 0
    this.attack(now)
  }

  /** Adds a continuous cents offset to the oscillator and the pitch LFO. */
  setPitchBend(semitones: number): void {
    if (this.disposed) return
    this.pitchBend = bounded(semitones, -24, 24, 0)
    if (!this.context || this.context.state === 'closed') return
    const now = this.context.currentTime
    for (const carrier of this.carriers()) this.smooth(carrier.oscillator.detune, this.pitchBend * 100, now)
  }

  /** Release starts at the current envelope value, including during attack. */
  noteOff(): void {
    if (this.disposed) return
    ++this.requestVersion
    this.gateOpen = false
    this.release(this.params.adsr.release)
  }

  /** Short click-free release used for blur, hidden documents and pointer loss. */
  panic(): void {
    if (this.disposed) return
    ++this.requestVersion
    this.gateOpen = false
    this.release(0.025)
  }

  getAnalysis(): AnalysisNodes | null {
    if (!this.context || !this.graph || this.disposed || this.context.state === 'closed') return null
    return { time: this.graph.time, frequency: this.graph.frequency, sampleRate: this.context.sampleRate }
  }

  getState(): { contextState: string; gateOpen: boolean; audible: boolean } {
    const context = this.context
    return {
      contextState: this.disposed ? 'closed' : context?.state ?? 'not-created',
      gateOpen: this.gateOpen,
      audible: !this.disposed && context?.state === 'running' && (this.gateOpen || context.currentTime < this.releaseEnds),
    }
  }

  /** Read-only instrumentation for audio regression tests; no graph mutation. */
  getDiagnostics(): { carrierCount: number; envelope: number; phase: EnvelopePhase; waveform: Waveform; pendingWaveform: Waveform | null; disposed: boolean; velocity: number; velocityGain: number; pitchBend: number } {
    const now = this.context?.currentTime ?? 0
    const waveform = this.carrier?.waveform ?? this.params.waveform
    return {
      carrierCount: this.carriers().length,
      envelope: this.envelopeValue(now),
      phase: this.envelopePhase(now),
      waveform,
      pendingWaveform: waveform !== this.params.waveform ? this.params.waveform : null,
      disposed: this.disposed,
      velocity: this.velocity,
      velocityGain: this.velocity / 127,
      pitchBend: this.pitchBend,
    }
  }

  /** Idempotent teardown, including cancellation of Note On and crossfade tasks. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    ++this.requestVersion
    this.gateOpen = false
    this.clearWaveformTimer()
    const context = this.context
    if (!context) return
    this.release(0.015)
    this.disposePromise = (async () => {
      // Allow the scheduled fade to reach the output before closing the context.
      if (context.state === 'running') await new Promise<void>(resolve => setTimeout(resolve, 25))
      context.removeEventListener('statechange', this.onContextStateChange)
      for (const carrier of this.carriers()) this.destroyCarrier(carrier)
      this.carrier = null
      this.retiringCarrier = null
      if (this.graph) {
        try { this.graph.lfo.stop() } catch { /* Context can already be closed. */ }
        for (const node of Object.values(this.graph)) node.disconnect()
      }
      this.graph = null
      this.envelopeRamps = []
      this.releaseEnds = 0
      if (context.state !== 'closed') await context.close()
      this.context = null
    })()
    return this.disposePromise
  }

  private initialize(): void {
    // A high-rate Windows device may default to 192 kHz. Request 48 kHz for a
    // modest synthesis/visualization cost; Chrome resamples to the output device.
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.context = context
    const graph: Graph = {
      input: context.createGain(),
      filter: context.createBiquadFilter(),
      dry: context.createGain(),
      wet: context.createGain(),
      envelope: context.createGain(),
      amplitude: context.createGain(),
      velocityGain: context.createGain(),
      compressor: context.createDynamicsCompressor(),
      master: context.createGain(),
      limiter: context.createWaveShaper(),
      time: context.createAnalyser(),
      frequency: context.createAnalyser(),
      lfo: context.createOscillator(),
      pitchModulation: context.createGain(),
      filterModulation: context.createGain(),
    }
    this.graph = graph
    const now = context.currentTime
    const params = this.params
    graph.filter.type = 'lowpass'
    graph.filter.frequency.value = Math.min(params.filter.cutoff, context.sampleRate * 0.49)
    graph.filter.Q.value = 20 * Math.log10(params.filter.q)
    graph.dry.gain.value = params.filter.bypass ? 1 : 0
    graph.wet.gain.value = params.filter.bypass ? 0 : 1
    graph.envelope.gain.value = 0
    graph.amplitude.gain.value = params.amplitude
    graph.velocityGain.gain.value = this.velocity / 127
    graph.master.gain.value = 0.55
    graph.compressor.threshold.value = -6
    graph.compressor.knee.value = 6
    graph.compressor.ratio.value = 20
    graph.compressor.attack.value = 0.003
    graph.compressor.release.value = 0.15

    // Identity in the normal range; smoothly bounds exceptional resonant peaks.
    // Thus a quiet sine remains a sine instead of acquiring limiter harmonics.
    const curve = new Float32Array(4097)
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1
      const magnitude = Math.abs(x)
      curve[i] = magnitude <= 0.75 ? x : Math.sign(x) * (0.75 + 0.2 * Math.tanh((magnitude - 0.75) / 0.2))
    }
    graph.limiter.curve = curve
    graph.limiter.oversample = '2x'
    // At 48 kHz, 16384 samples cover several periods even at 20 Hz and provide
    // 2.93 Hz FFT bins. Adapt if a browser/device chooses another sample rate.
    const analysisFftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(context.sampleRate / 20 * 4)))
    graph.time.fftSize = analysisFftSize
    graph.time.smoothingTimeConstant = 0
    graph.frequency.fftSize = analysisFftSize
    graph.frequency.smoothingTimeConstant = 0.65
    graph.frequency.minDecibels = -100
    graph.frequency.maxDecibels = -10
    graph.lfo.type = 'sine'
    graph.lfo.frequency.value = params.lfo.rate
    const depth = params.lfo.enabled ? params.lfo.depth : 0
    graph.pitchModulation.gain.value = params.lfo.target === 'pitch' ? depth * 100 : 0
    graph.filterModulation.gain.value = params.lfo.target === 'filter' ? depth * 2400 : 0

    graph.input.connect(graph.dry)
    graph.input.connect(graph.filter)
    graph.filter.connect(graph.wet)
    graph.dry.connect(graph.envelope)
    graph.wet.connect(graph.envelope)
    graph.envelope.connect(graph.amplitude)
    graph.amplitude.connect(graph.velocityGain)
    graph.velocityGain.connect(graph.compressor)
    graph.compressor.connect(graph.master)
    graph.master.connect(graph.limiter)
    graph.limiter.connect(graph.time)
    graph.time.connect(graph.frequency)
    graph.frequency.connect(context.destination)
    graph.lfo.connect(graph.pitchModulation)
    graph.lfo.connect(graph.filterModulation)
    graph.filterModulation.connect(graph.filter.detune)
    this.frequencyRamp = { start: now, end: now, from: params.frequency, to: params.frequency }
    this.carrier = this.createCarrier(params.waveform, 1, now)
    graph.lfo.start(now)
    context.addEventListener('statechange', this.onContextStateChange)
  }

  private createCarrier(waveform: Waveform, gain: number, now: number): Carrier {
    const context = this.context!
    const graph = this.graph!
    const carrier: Carrier = { oscillator: context.createOscillator(), gain: context.createGain(), waveform }
    carrier.oscillator.type = waveform
    carrier.oscillator.frequency.setValueAtTime(rampValue(this.frequencyRamp, now), now)
    carrier.oscillator.detune.setValueAtTime(this.pitchBend * 100, now)
    if (this.frequencyRamp.end > now) carrier.oscillator.frequency.linearRampToValueAtTime(this.frequencyRamp.to, this.frequencyRamp.end)
    carrier.gain.gain.setValueAtTime(gain, now)
    graph.pitchModulation.connect(carrier.oscillator.detune)
    carrier.oscillator.connect(carrier.gain)
    carrier.gain.connect(graph.input)
    carrier.oscillator.start(now)
    return carrier
  }

  private requestWaveform(now: number): void {
    if (!this.carrier || !this.context || this.disposed) return
    if (this.retiringCarrier) {
      if (now < this.waveformFadeEnds) {
        this.scheduleWaveformCleanup()
        return // Coalesce fast input to the newest requested waveform.
      }
      this.destroyCarrier(this.retiringCarrier)
      this.retiringCarrier = null
      this.clearWaveformTimer()
    }
    if (this.carrier.waveform === this.params.waveform) return
    const outgoing = this.carrier
    const incoming = this.createCarrier(this.params.waveform, 0, now)
    incoming.gain.gain.linearRampToValueAtTime(1, now + WAVE_FADE_SECONDS)
    outgoing.gain.gain.cancelScheduledValues(now)
    outgoing.gain.gain.setValueAtTime(1, now)
    outgoing.gain.gain.linearRampToValueAtTime(0, now + WAVE_FADE_SECONDS)
    outgoing.oscillator.stop(now + WAVE_FADE_SECONDS + 0.005)
    this.retiringCarrier = outgoing
    this.carrier = incoming
    this.waveformFadeEnds = now + WAVE_FADE_SECONDS + 0.005
    this.scheduleWaveformCleanup()
  }

  private scheduleWaveformCleanup(): void {
    if (this.waveformTimer !== null || !this.retiringCarrier || this.context?.state !== 'running' || this.disposed) return
    const remaining = Math.max(1, (this.waveformFadeEnds - this.context.currentTime) * 1000 + 2)
    this.waveformTimer = setTimeout(() => {
      this.waveformTimer = null
      if (this.context?.state === 'running' && !this.disposed) this.requestWaveform(this.context.currentTime)
    }, remaining)
  }

  private clearWaveformTimer(): void {
    if (this.waveformTimer !== null) clearTimeout(this.waveformTimer)
    this.waveformTimer = null
  }

  private readonly onContextStateChange = (): void => {
    if (this.context?.state === 'running') this.scheduleWaveformCleanup()
    else this.clearWaveformTimer()
  }

  private carriers(): Carrier[] {
    return [this.carrier, this.retiringCarrier].filter((carrier): carrier is Carrier => carrier !== null)
  }

  private destroyCarrier(carrier: Carrier): void {
    try { carrier.oscillator.stop() } catch { /* Already stopped or closed. */ }
    try { this.graph?.pitchModulation.disconnect(carrier.oscillator.detune) } catch { /* Connection already removed. */ }
    carrier.oscillator.disconnect()
    carrier.gain.disconnect()
  }

  private smooth(param: AudioParam, value: number, now: number): void {
    // Target ramps have no future endpoints to remove. Canceling a preceding
    // target preserves its value at now, then the next target starts smoothly.
    param.cancelAndHoldAtTime(now)
    param.setTargetAtTime(value, now, 0.008)
  }

  private async resumeContext(context: AudioContext): Promise<void> {
    if (context.state === 'running' || context.state === 'closed') return
    const resume = this.resumePromise ?? context.resume()
    this.resumePromise = resume
    try {
      await resume
    } finally {
      if (this.resumePromise === resume) this.resumePromise = null
    }
  }

  private envelopeValue(now: number): number {
    if (this.envelopeRamps.length === 0) return 0
    for (const ramp of this.envelopeRamps) {
      if (now <= ramp.end) return rampValue(ramp, now)
    }
    return this.envelopeRamps[this.envelopeRamps.length - 1].to
  }

  private envelopePhase(now: number): EnvelopePhase {
    for (const ramp of this.envelopeRamps) {
      if (now < ramp.end) return ramp.phase
    }
    return this.gateOpen ? 'sustain' : 'idle'
  }

  private holdEnvelope(now: number): number {
    const value = this.envelopeValue(now)
    const param = this.graph!.envelope.gain
    // A modeled fallback is useful for browsers without cancelAndHoldAtTime;
    // Chrome/Edge use the native hold, including an interrupted linear ramp.
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now)
    else {
      param.cancelScheduledValues(now)
      param.setValueAtTime(value, now)
    }
    return value
  }

  private scheduleEnvelope(ramps: EnvelopeRamp[], now: number): void {
    this.holdEnvelope(now)
    const param = this.graph!.envelope.gain
    for (const ramp of ramps) param.linearRampToValueAtTime(ramp.to, ramp.end)
    this.envelopeRamps = ramps
  }

  private attack(now: number): void {
    const value = this.envelopeValue(now)
    const attackEnd = now + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.attack)
    const decayEnd = attackEnd + Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.decay)
    this.scheduleEnvelope([
      { start: now, end: attackEnd, from: value, to: 1, phase: 'attack' },
      { start: attackEnd, end: decayEnd, from: 1, to: this.params.adsr.sustain, phase: 'decay' },
    ], now)
  }

  private release(seconds: number): void {
    if (!this.context || !this.graph || this.context.state === 'closed') return
    const now = this.context.currentTime
    const value = this.envelopeValue(now)
    this.releaseEnds = value > 0 ? now + Math.max(MIN_ENVELOPE_SECONDS, seconds) : now
    this.scheduleEnvelope([
      { start: now, end: now + Math.max(MIN_ENVELOPE_SECONDS, seconds), from: value, to: 0, phase: 'release' },
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
    } else if (phase === 'release' && current && previous.adsr.release !== this.params.adsr.release) {
      const remaining = (current.end - now) * Math.max(MIN_ENVELOPE_SECONDS, this.params.adsr.release) / Math.max(MIN_ENVELOPE_SECONDS, previous.adsr.release)
      this.releaseEnds = now + Math.max(MIN_ENVELOPE_SECONDS, remaining)
      this.scheduleEnvelope([{ start: now, end: this.releaseEnds, from: value, to: 0, phase: 'release' }], now)
    }
  }
}
