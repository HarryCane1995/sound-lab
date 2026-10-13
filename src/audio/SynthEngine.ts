import { copyParams, type AnalysisNodes, type SynthParams, type Waveform } from '../types'
import { CONTROL_LEAD_FRAMES, SynthVoice } from './SynthVoice'
import { MAX_RETIRING_VOICES, MAX_VOICES, VoiceManager, voiceMatches } from './VoiceManager'
import type { VoiceNote, VoiceScope, VoiceSnapshot } from './voiceTypes'
import { getClassicComparisonGain, getHarmonicCoefficients, getHarmonicScale } from '../harmonics/model'
import { clearPeriodicWaveCache, getPeriodicWaveCache, PERIODIC_WAVE_CACHE_LIMIT, type PeriodicWaveCache } from './PeriodicWaveCache'
import { disposeEnvelopeWorklet, ensureEnvelopeWorklet, envelopeWorkletReady, getEnvelopeServiceDiagnostics } from './EnvelopeControl'

const MIN_FREQUENCY = 440 * 2 ** ((0 - 69) / 12)
const MIX_HEADROOM = 0.25
const AUDITION_ID = 'audition'

interface Graph {
  input: GainNode
  filter: BiquadFilterNode
  dry: GainNode
  wet: GainNode
  amplitude: GainNode
  compressor: DynamicsCompressorNode
  master: GainNode
  limiter: WaveShaperNode
  time: AnalyserNode
  frequency: AnalyserNode
  lfo: OscillatorNode
  pitchModulation: GainNode
  filterModulation: GainNode
}
interface NoteRequest { token: number; note: VoiceNote }
export interface AudioClock { time: number; state: string; sampleRate: number }
interface ScheduledRequest { request: NoteRequest; startAt: number; endAt: number }
interface MetronomeTick {
  oscillator: OscillatorNode; gain: GainNode; sourceId: string;
  start: number; end: number; peak: number; cancelledAt: number | null; cancelledFrom: number;
}
const METRONOME_LIMIT = 8

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

function bendKey(sourceId: string, channel: number): string { return JSON.stringify([sourceId, channel]) }

/**
 * Sixteen independent notes share one lazy context, filter, pitch/filter LFO and
 * protected output. Release counts toward the limit; stealing has bounded fades.
 */
export class SynthEngine {
  private params: SynthParams
  private context: AudioContext | null = null
  private graph: Graph | null = null
  private waveCache: PeriodicWaveCache | null = null
  private waveBuildCount = 0
  private voices = new VoiceManager()
  // Intents survive voice stealing until the corresponding physical Note Off.
  private intents = new Map<string, NoteRequest>()
  private pending = new Map<string, NoteRequest>()
  private scheduled = new Map<string, ScheduledRequest>()
  private metronome = new Set<MetronomeTick>()
  private contextListeners = new Set<(state: string) => void>()
  private cancellationListeners = new Set<() => void>()
  private sourceBends = new Map<string, { sourceId: string; channel: number; value: number }>()
  private requestToken = 0
  private instanceId = 0
  private maintenanceTimer: ReturnType<typeof setTimeout> | null = null
  private capacityTimer: ReturnType<typeof setTimeout> | null = null
  private capacityWait: Promise<void> | null = null
  private capacityResolve: (() => void) | null = null
  private disposed = false
  private resumePromise: Promise<void> | null = null
  private disposePromise: Promise<void> | null = null
  private auditionPitchBend = 0
  private lastVelocity = 127

  constructor(initial: SynthParams) { this.params = sanitized(initial) }

  /** Controls stay audio-free; only an audition follows global Frequency. */
  setParams(params: SynthParams): void {
    if (this.disposed) return
    this.params = sanitized(params)
    for (const request of this.pending.values()) {
      if (request.note.origin === 'audition') request.note.frequency = this.params.frequency
    }
    if (!this.context || !this.graph || this.context.state === 'closed') return
    const now = this.context.currentTime
    const graph = this.graph
    this.maintain(now)
    this.smooth(graph.amplitude.gain, this.params.amplitude, now)
    this.smooth(graph.filter.frequency, Math.min(this.params.filter.cutoff, this.context.sampleRate * 0.49), now)
    // The UI uses a unitless Q; Web Audio low-pass Q is specified in dB.
    this.smooth(graph.filter.Q, 20 * Math.log10(this.params.filter.q), now)
    this.smooth(graph.dry.gain, this.params.filter.bypass ? 1 : 0, now)
    this.smooth(graph.wet.gain, this.params.filter.bypass ? 0 : 1, now)
    this.smooth(graph.lfo.frequency, this.params.lfo.rate, now)
    const depth = this.params.lfo.enabled ? this.params.lfo.depth : 0
    this.smooth(graph.pitchModulation.gain, this.params.lfo.target === 'pitch' ? depth * 100 : 0, now)
    this.smooth(graph.filterModulation.gain, this.params.lfo.target === 'filter' ? depth * 2400 : 0, now)
    for (const voice of this.voices.all) voice.setParams(this.params, now)
    this.scheduleMaintenance()
  }

  /** Unlock from a gesture without allocating or playing a voice. */
  async prepare(): Promise<void> {
    if (this.disposed) return
    if (!this.context) this.initialize()
    try { await this.resumeContext(this.context!) }
    catch (error) { if (!this.disposed) throw error }
  }

  getAudioClock(): AudioClock | null {
    const context = this.context
    return context && !this.disposed
      ? { time: context.currentTime, state: context.state, sampleRate: context.sampleRate } : null
  }

  /** A one-shot monitor bypasses musical controls but shares final protection. */
  getSamplePreviewBus(): { context: AudioContext; destination: AudioNode; monitorLevel: number } | null {
    if (this.disposed || !this.context || !this.graph || this.context.state === 'closed') return null
    return { context: this.context, destination: this.graph.master, monitorLevel: this.graph.master.gain.value }
  }

  subscribeContextState(listener: (state: string) => void): () => void {
    this.contextListeners.add(listener)
    return () => { this.contextListeners.delete(listener) }
  }

  /** Panic invalidates transport promises and timers as well as audio nodes. */
  subscribeCancellation(listener: () => void): () => void {
    this.cancellationListeners.add(listener)
    return () => { this.cancellationListeners.delete(listener) }
  }

  /** Native ON and Off automation. False lets the lookahead scheduler retry. */
  scheduleNote(note: VoiceNote, startAt: number, endAt: number): boolean {
    const context = this.context
    if (this.disposed || !context || !this.graph || context.state !== 'running' || !envelopeWorkletReady(context)
      || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return false
    if (this.intents.has(note.id)) return true
    const velocity = bounded(note.velocity, 0, 127, 127)
    if (velocity === 0) return true
    const now = context.currentTime
    this.maintain(now)
    // Reserving a free slot ahead of time is silent. With a full chord, wait
    // until its actual deadline before shortening an audible note for stealing.
    if (this.voices.count >= MAX_VOICES && startAt > now + 0.005) return false
    if (!this.voices.makeRoom()) return false
    const actualStart = Math.max(now, startAt)
    const actualEnd = actualStart + (endAt - startAt)
    const request: NoteRequest = {
      token: ++this.requestToken,
      note: { ...note, velocity, frequency: bounded(note.frequency, MIN_FREQUENCY, 20000, this.params.frequency) },
    }
    const voice = new SynthVoice(context, this.graph.input, this.graph.pitchModulation,
      request.note, this.params, ++this.instanceId, 0, { startAt: actualStart, endAt: actualEnd })
    this.intents.set(note.id, request)
    this.scheduled.set(note.id, { request, startAt: voice.startsAt, endAt: voice.plannedEndAt ?? actualEnd })
    this.voices.add(voice)
    this.lastVelocity = velocity
    this.scheduleMaintenance()
    return true
  }

  /** A small independently cancellable tick pool on the existing context. */
  scheduleMetronome(when: number, accent: boolean, sourceId = 'metronome'): void {
    const context = this.context
    if (this.disposed || !context || !this.graph || context.state !== 'running' || !Number.isFinite(when)) return
    this.maintain(context.currentTime)
    if (this.metronome.size >= METRONOME_LIMIT) return
    const start = Math.max(when, context.currentTime)
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const peak = accent ? 0.08 : 0.055
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(accent ? 1250 : 900, start)
    gain.gain.setValueAtTime(0, context.currentTime)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.003)
    gain.gain.linearRampToValueAtTime(0, start + 0.045)
    oscillator.connect(gain)
    gain.connect(this.graph.amplitude)
    const tick: MetronomeTick = { oscillator, gain, sourceId, start, end: start + 0.05, peak, cancelledAt: null, cancelledFrom: 0 }
    this.metronome.add(tick)
    oscillator.start(start)
    oscillator.stop(tick.end)
    this.scheduleMaintenance()
  }

  cancelMetronome(sourceId?: string): void {
    const now = this.context?.currentTime ?? 0
    for (const tick of this.metronome) {
      if (sourceId !== undefined && tick.sourceId !== sourceId) continue
      if (now <= tick.start || this.context?.state !== 'running') { this.destroyTick(tick); continue }
      if (tick.cancelledAt !== null || now >= tick.end) continue
      const value = now < tick.start + 0.003
        ? tick.peak * (now - tick.start) / 0.003
        : tick.peak * Math.max(0, 1 - (now - tick.start - 0.003) / 0.042)
      tick.gain.gain.cancelAndHoldAtTime(now)
      tick.gain.gain.setValueAtTime(value, now)
      tick.gain.gain.linearRampToValueAtTime(0, now + 0.008)
      tick.cancelledAt = now
      tick.cancelledFrom = value
      tick.end = now + 0.01
      tick.oscillator.stop(tick.end)
    }
    this.scheduleMaintenance()
  }

  /** Legacy manual Play API. Its audition is isolated from all keyboard notes. */
  async noteOn(frequency?: number, velocity = 127): Promise<void> {
    if (this.disposed) return
    const nextVelocity = bounded(velocity, 0, 127, 127)
    if (nextVelocity === 0) { this.noteOff(); return }
    if (frequency !== undefined) this.setParams({ ...this.params, frequency })
    const existing = this.voices.findHeld(AUDITION_ID)
    if (existing && this.context) {
      existing.retrigger(nextVelocity, this.context.currentTime)
      this.lastVelocity = nextVelocity
      this.scheduleMaintenance()
      return
    }
    // Play can restart an audition stolen by a full chord; physical duplicates
    // still use noteOnVoice and retain their stolen-key tombstones.
    if (!this.pending.has(AUDITION_ID)) this.intents.delete(AUDITION_ID)
    await this.noteOnVoice({
      id: AUDITION_ID, midi: null, frequency: this.params.frequency,
      velocity: nextVelocity, sourceId: 'audition', sourceName: 'Play',
      channel: null, origin: 'audition',
    })
  }

  noteOff(): void { this.noteOffVoice(AUDITION_ID) }

  async noteOnVoice(note: VoiceNote): Promise<void> {
    if (this.disposed) return
    const velocity = bounded(note.velocity, 0, 127, 127)
    if (velocity === 0) { this.noteOffVoice(note.id); return }
    if (this.intents.has(note.id)) return
    const request: NoteRequest = {
      token: ++this.requestToken,
      note: { ...note, velocity, frequency: bounded(note.frequency, MIN_FREQUENCY, 20000, this.params.frequency) },
    }
    this.intents.set(note.id, request)
    this.pending.set(note.id, request)
    try {
      if (!this.context) this.initialize()
      const context = this.context!
      // Only saturated stealing bursts wait. Reservation and node creation stay
      // in the same synchronous turn, so concurrent starts cannot overbook slots.
      while (true) {
        if (this.disposed || this.intents.get(note.id) !== request || this.pending.get(note.id) !== request) return
        if (context.state === 'closed') {
          this.intents.delete(note.id)
          return
        }
        if (context.state !== 'running' || !envelopeWorkletReady(context)) {
          await this.resumeContext(context)
          continue
        }
        this.maintain(context.currentTime)
        if (this.voices.makeRoom()) break
        await this.waitForCapacity()
      }
      if (request.note.origin === 'audition') request.note.frequency = this.params.frequency
      const pitchBend = request.note.origin === 'audition' ? this.auditionPitchBend
        : request.note.origin === 'midi' && request.note.channel !== null
          ? this.sourceBends.get(bendKey(request.note.sourceId, request.note.channel))?.value ?? 0 : 0
      const voice = new SynthVoice(context, this.graph!.input, this.graph!.pitchModulation,
        request.note, this.params, ++this.instanceId, pitchBend)
      this.voices.add(voice)
      this.lastVelocity = velocity
      this.scheduleMaintenance()
      // The shared service is already warm. Only the live startup microtask is
      // awaited, so a synchronous ON/OFF reversal cannot dispatch an attack.
      await voice.ready()
      this.maintain(context.currentTime)
      this.wakeCapacity()
      this.scheduleMaintenance()
    } catch (error) {
      if (this.context) this.maintain(this.context.currentTime)
      this.wakeCapacity()
      if (!this.disposed && this.intents.get(note.id) === request) {
        this.intents.delete(note.id)
        throw error
      }
    } finally {
      if (this.pending.get(note.id) === request) this.pending.delete(note.id)
    }
  }

  /** A specific Note Off cannot release another source, channel or stolen key. */
  noteOffVoice(id: string, immediate = false): void {
    if (this.disposed) return
    this.intents.delete(id)
    this.pending.delete(id)
    this.scheduled.delete(id)
    this.voices.release(id, immediate)
    if (this.context) this.maintain(this.context.currentTime)
    this.wakeCapacity()
    this.scheduleMaintenance()
  }

  releaseVoices(scope: VoiceScope, immediate = false): void {
    if (this.disposed) return
    for (const [id, request] of this.intents) {
      if (!voiceMatches(request.note, scope)) continue
      this.intents.delete(id)
      this.pending.delete(id)
      this.scheduled.delete(id)
    }
    this.voices.releaseScope(scope, immediate, this.context?.state !== 'running')
    if (this.context) this.maintain(this.context.currentTime)
    this.wakeCapacity()
    this.scheduleMaintenance()
  }

  /** Manual audition bend; incoming MIDI uses setSourcePitchBend instead. */
  setPitchBend(semitones: number): void {
    if (this.disposed) return
    this.auditionPitchBend = bounded(semitones, -24, 24, 0)
    if (!this.context || this.context.state === 'closed') return
    const now = this.context.currentTime
    for (const voice of this.voices.all) {
      if (voice.note.origin === 'audition') voice.setPitchBend(this.auditionPitchBend, now)
    }
  }

  /** Includes Release tails and future notes, while leaving other sources alone. */
  setSourcePitchBend(sourceId: string, channel: number, semitones: number): void {
    if (this.disposed) return
    const value = bounded(semitones, -24, 24, 0)
    const key = bendKey(sourceId, channel)
    if (value === 0) this.sourceBends.delete(key)
    else this.sourceBends.set(key, { sourceId, channel, value })
    if (!this.context || this.context.state === 'closed') return
    const now = this.context.currentTime
    for (const voice of this.voices.all) {
      if (voice.note.origin === 'midi' && voice.note.sourceId === sourceId && voice.note.channel === channel) voice.setPitchBend(value, now)
    }
  }

  /** Cancels pending starts and smoothly shortens every held/releasing voice. */
  panic(): void {
    if (this.disposed) return
    for (const listener of this.cancellationListeners) listener()
    this.intents.clear()
    this.pending.clear()
    this.scheduled.clear()
    this.sourceBends.clear()
    this.auditionPitchBend = 0
    if (this.context?.state === 'running') {
      for (const voice of this.voices.all) voice.setPitchBend(0, this.context.currentTime)
      this.voices.releaseScope({}, true)
    } else {
      this.voices.destroyAll()
      this.resetProcessingState()
    }
    this.cancelMetronome()
    if (this.context) this.maintain(this.context.currentTime)
    this.wakeCapacity()
    this.scheduleMaintenance()
  }

  getAnalysis(): AnalysisNodes | null {
    if (!this.context || !this.graph || this.disposed || this.context.state === 'closed') return null
    return { time: this.graph.time, frequency: this.graph.frequency, sampleRate: this.context.sampleRate }
  }

  /** Includes short retiring tails; filter by retiring for the 16-slot allocator. */
  getVoices(): VoiceSnapshot[] {
    const now = this.context?.currentTime ?? 0
    return this.voices.all.map(voice => voice.getSnapshot(now))
  }

  getState(): {
    contextState: string; gateOpen: boolean; audible: boolean;
    voiceCount: number; heldCount: number; pendingCount: number; auditionGateOpen: boolean;
  } {
    const context = this.context
    const snapshots = this.getVoices()
    return {
      contextState: this.disposed ? 'closed' : context?.state ?? 'not-created',
      gateOpen: snapshots.some(voice => voice.gateOpen),
      audible: !this.disposed && context?.state === 'running' && snapshots.some(voice => voice.phase !== 'idle'),
      voiceCount: this.voices.count,
      heldCount: this.voices.heldCount,
      pendingCount: this.pending.size + [...this.scheduled.values()].filter(note => note.startAt > (context?.currentTime ?? 0)).length,
      auditionGateOpen: snapshots.some(voice => voice.origin === 'audition' && voice.gateOpen),
    }
  }

  /** Read-only instrumentation, retaining the audition's legacy scalar fields. */
  getDiagnostics() {
    const snapshots = this.getVoices()
    const latest = [...snapshots].reverse().find(voice => voice.origin === 'audition') ?? snapshots.at(-1)
    const latestVoice = this.voices.all.find(voice => voice.instanceId === latest?.instanceId)
    const waveform: Waveform = latestVoice?.getWaveform() ?? this.params.waveform
    const totalCarrierCount = snapshots.reduce((sum, voice) => sum + voice.carrierCount, 0)
    const velocity = latest?.velocity ?? this.lastVelocity
    const envelopeControls = this.voices.all.map(voice => voice.getEnvelopeControlState())
    return {
      carrierCount: totalCarrierCount, totalCarrierCount,
      envelope: latest?.envelope ?? 0,
      phase: latest?.phase ?? 'idle',
      waveform, pendingWaveform: waveform !== this.params.waveform ? this.params.waveform : null,
      disposed: this.disposed, velocity, velocityGain: velocity / 127,
      pitchBend: latest?.pitchBend ?? this.auditionPitchBend,
      mode: this.params.mode, carrierMode: latestVoice?.getMode() ?? this.params.mode,
      pendingTimbre: latestVoice?.hasPendingTimbre() ?? false,
      additiveScale: getHarmonicScale(this.params.additive),
      additiveCoefficients: getHarmonicCoefficients(this.params.additive),
      comparisonGain: this.params.mode === 'classic' && this.params.additive.compare
        ? getClassicComparisonGain(this.params.additive, this.params.waveform) : 1,
      periodicWaveCacheSize: this.waveCache?.size ?? 0,
      periodicWaveBuildCount: this.waveCache?.buildCount ?? this.waveBuildCount,
      periodicWaveCacheLimit: PERIODIC_WAVE_CACHE_LIMIT,
      voices: snapshots, voiceCount: this.voices.count, managedCount: this.voices.count,
      retiringCount: this.voices.retiringCount, pendingCount: this.pending.size,
      scheduledNoteCount: this.scheduled.size,
      scheduledFutureCount: [...this.scheduled.values()].filter(note => note.startAt > (this.context?.currentTime ?? 0)).length,
      metronomeCount: this.metronome.size, maxMetronomeTicks: METRONOME_LIMIT,
      maxVoices: MAX_VOICES, maxRetiringVoices: MAX_RETIRING_VOICES,
      envelopeControlCount: envelopeControls.filter(control => control.connected).length,
      maxEnvelopeControls: MAX_VOICES + MAX_RETIRING_VOICES,
      ...getEnvelopeServiceDiagnostics(this.context),
      envelopeControls,
      controlLeadFrames: CONTROL_LEAD_FRAMES,
      controlLeadSeconds: CONTROL_LEAD_FRAMES / (this.context?.sampleRate ?? 48000),
      mixHeadroom: MIX_HEADROOM,
      createdVoiceCount: this.voices.createdCount, destroyedVoiceCount: this.voices.destroyedCount,
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    for (const listener of this.cancellationListeners) listener()
    this.cancellationListeners.clear()
    this.intents.clear()
    this.pending.clear()
    this.scheduled.clear()
    this.sourceBends.clear()
    this.clearMaintenance()
    this.wakeCapacity()
    const context = this.context
    if (!context) {
      this.emitContextState('closed')
      this.contextListeners.clear()
      return
    }
    this.voices.releaseScope({}, true)
    this.cancelMetronome()
    this.disposePromise = (async () => {
      // Audio time can lag wall time or stop during suspension. Let the forced
      // Release reach zero before destroying a running graph, with a bounded
      // escape if the browser has stopped advancing its audio clock.
      const cleanupAt = context.currentTime + CONTROL_LEAD_FRAMES / context.sampleRate + 0.025 + 0.005
      const wallDeadline = performance.now() + 250
      const controlsSilent = () => this.voices.all.every(voice => voice.getEnvelopeControlState().safeToDestroy)
      while (context.state === 'running' && (context.currentTime < cleanupAt || !controlsSilent()) && performance.now() < wallDeadline) {
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, Math.max(1, (cleanupAt - context.currentTime) * 1000))))
      }
      // A stopped audio clock or missing render ACK must not turn the bounded
      // dispose escape into a hard cut of an active voice. Suspend first, then
      // discard the silent graph; a later resume is impossible after dispose.
      if (context.state === 'running' && !controlsSilent()) await context.suspend()
      context.removeEventListener('statechange', this.onContextStateChange)
      this.voices.destroyAll()
      disposeEnvelopeWorklet(context)
      for (const tick of this.metronome) this.destroyTick(tick)
      this.emitContextState('closed')
      this.contextListeners.clear()
      this.waveBuildCount = this.waveCache?.buildCount ?? this.waveBuildCount
      clearPeriodicWaveCache(context)
      this.waveCache = null
      if (this.graph) {
        try { this.graph.lfo.stop() } catch { /* May already be closed. */ }
        for (const node of Object.values(this.graph)) node.disconnect()
      }
      this.graph = null
      if (context.state !== 'closed') await context.close()
      this.context = null
    })()
    return this.disposePromise
  }

  private initialize(): void {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.context = context
    this.waveCache = getPeriodicWaveCache(context)
    const graph: Graph = {
      input: context.createGain(), filter: context.createBiquadFilter(),
      dry: context.createGain(), wet: context.createGain(), amplitude: context.createGain(),
      compressor: context.createDynamicsCompressor(), master: context.createGain(),
      limiter: context.createWaveShaper(), time: context.createAnalyser(), frequency: context.createAnalyser(),
      lfo: context.createOscillator(), pitchModulation: context.createGain(), filterModulation: context.createGain(),
    }
    this.graph = graph
    const params = this.params
    // Fixed headroom avoids pumping the remaining chord when one note is added
    // or removed; the compressor and limiter handle exceptional resonant peaks.
    graph.input.gain.value = MIX_HEADROOM
    graph.filter.type = 'lowpass'
    graph.filter.frequency.value = Math.min(params.filter.cutoff, context.sampleRate * 0.49)
    graph.filter.Q.value = 20 * Math.log10(params.filter.q)
    graph.dry.gain.value = params.filter.bypass ? 1 : 0
    graph.wet.gain.value = params.filter.bypass ? 0 : 1
    graph.amplitude.gain.value = params.amplitude
    graph.master.gain.value = 0.55
    graph.compressor.threshold.value = -6
    graph.compressor.knee.value = 6
    graph.compressor.ratio.value = 20
    graph.compressor.attack.value = 0.003
    graph.compressor.release.value = 0.15
    const curve = new Float32Array(4097)
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1
      const magnitude = Math.abs(x)
      curve[i] = magnitude <= 0.75 ? x : Math.sign(x) * (0.75 + 0.2 * Math.tanh((magnitude - 0.75) / 0.2))
    }
    graph.limiter.curve = curve
    graph.limiter.oversample = '2x'
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
    graph.dry.connect(graph.amplitude)
    graph.wet.connect(graph.amplitude)
    graph.amplitude.connect(graph.compressor)
    graph.compressor.connect(graph.master)
    graph.master.connect(graph.limiter)
    graph.limiter.connect(graph.time)
    graph.time.connect(graph.frequency)
    graph.frequency.connect(context.destination)
    graph.lfo.connect(graph.pitchModulation)
    graph.lfo.connect(graph.filterModulation)
    graph.filterModulation.connect(graph.filter.detune)
    graph.lfo.start()
    context.addEventListener('statechange', this.onContextStateChange)
  }

  private smooth(param: AudioParam, value: number, now: number): void {
    param.cancelAndHoldAtTime(now)
    param.setTargetAtTime(value, now, 0.008)
  }

  /** A suspended graph retains IIR and lookahead samples even after its voices
   * are removed. Panic must discard those samples before a later resume. */
  private resetProcessingState(): void {
    const context = this.context, graph = this.graph
    if (!context || !graph || context.state === 'closed') return
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = Math.min(this.params.filter.cutoff, context.sampleRate * 0.49)
    filter.Q.value = 20 * Math.log10(this.params.filter.q)
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = graph.compressor.threshold.value
    compressor.knee.value = graph.compressor.knee.value
    compressor.ratio.value = graph.compressor.ratio.value
    compressor.attack.value = graph.compressor.attack.value
    compressor.release.value = graph.compressor.release.value
    const limiter = context.createWaveShaper()
    limiter.curve = graph.limiter.curve
    limiter.oversample = graph.limiter.oversample

    graph.input.disconnect(graph.filter)
    graph.filterModulation.disconnect(graph.filter.detune)
    graph.filter.disconnect()
    graph.amplitude.disconnect(graph.compressor)
    graph.compressor.disconnect()
    graph.master.disconnect(graph.limiter)
    graph.limiter.disconnect()
    graph.filter = filter; graph.compressor = compressor; graph.limiter = limiter
    graph.input.connect(filter)
    graph.filterModulation.connect(filter.detune)
    filter.connect(graph.wet)
    graph.amplitude.connect(compressor)
    compressor.connect(graph.master)
    graph.master.connect(limiter)
    limiter.connect(graph.time)
  }

  private async resumeContext(context: AudioContext): Promise<void> {
    if (context.state === 'closed' || (context.state === 'running' && envelopeWorkletReady(context))) return
    // Call resume in the gesture's synchronous turn; loading the shared module
    // may be asynchronous. Pending notes recheck their cancellation tokens after
    // both operations, so Panic/Note Off/dispose cannot reopen a cancelled gate.
    const resume = this.resumePromise ?? Promise.all([
      context.state === 'running' ? Promise.resolve() : context.resume(),
      ensureEnvelopeWorklet(context, () => { this.panic() }),
    ]).then(() => {})
    this.resumePromise = resume
    try { await resume }
    finally { if (this.resumePromise === resume) this.resumePromise = null }
  }

  private maintain(now: number): void {
    const before = this.voices.count + this.voices.retiringCount
    this.voices.maintain(now)
    for (const [id, scheduled] of this.scheduled) {
      if (now < scheduled.endAt) continue
      if (this.intents.get(id) === scheduled.request) this.intents.delete(id)
      this.scheduled.delete(id)
    }
    for (const tick of this.metronome) if (now >= tick.end) this.destroyTick(tick)
    if (before > this.voices.count + this.voices.retiringCount) this.wakeCapacity()
  }

  /** All queued starts share one short timer, with no extra audio nodes. */
  private waitForCapacity(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.capacityWait) return this.capacityWait
    this.capacityWait = new Promise<void>(resolve => { this.capacityResolve = resolve })
    const at = this.voices.nextMaintenanceAt()
    const wait = this.context?.state === 'running' && Number.isFinite(at)
      ? Math.max(1, Math.min(20, (at - this.context.currentTime) * 1000 + 2)) : 20
    this.capacityTimer = setTimeout(() => this.wakeCapacity(), wait)
    return this.capacityWait
  }

  private wakeCapacity(): void {
    if (this.capacityTimer !== null) clearTimeout(this.capacityTimer)
    this.capacityTimer = null
    const resolve = this.capacityResolve
    this.capacityWait = null
    this.capacityResolve = null
    resolve?.()
  }

  private scheduleMaintenance(): void {
    this.clearMaintenance()
    if (this.disposed || this.context?.state !== 'running') return
    const at = Math.min(this.voices.nextMaintenanceAt(),
      ...[...this.scheduled.values()].map(note => note.endAt),
      ...[...this.metronome].map(tick => tick.end))
    if (!Number.isFinite(at)) return
    const wait = Math.max(1, (at - this.context.currentTime) * 1000 + 2)
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = null
      if (this.disposed || this.context?.state !== 'running') return
      this.maintain(this.context.currentTime)
      this.scheduleMaintenance()
      this.wakeCapacity()
    }, wait)
  }

  private clearMaintenance(): void {
    if (this.maintenanceTimer !== null) clearTimeout(this.maintenanceTimer)
    this.maintenanceTimer = null
  }

  private readonly onContextStateChange = (): void => {
    if (this.context?.state === 'running') {
      this.maintain(this.context.currentTime)
      this.scheduleMaintenance()
    } else {
      this.clearMaintenance()
      this.cancelMetronome()
    }
    this.emitContextState(this.context?.state ?? 'closed')
  }

  private emitContextState(state: string): void {
    for (const listener of this.contextListeners) listener(state)
  }

  private destroyTick(tick: MetronomeTick): void {
    try { tick.oscillator.stop() } catch { /* Already stopped or cancelled. */ }
    tick.oscillator.disconnect()
    tick.gain.disconnect()
    this.metronome.delete(tick)
  }
}
