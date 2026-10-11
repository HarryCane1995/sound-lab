import { copyParams, type AnalysisNodes, type SynthParams, type Waveform } from '../types'
import { SynthVoice } from './SynthVoice'
import { MAX_RETIRING_VOICES, MAX_VOICES, VoiceManager, voiceMatches } from './VoiceManager'
import type { VoiceNote, VoiceScope, VoiceSnapshot } from './voiceTypes'

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
  private voices = new VoiceManager()
  // Intents survive voice stealing until the corresponding physical Note Off.
  private intents = new Map<string, NoteRequest>()
  private pending = new Map<string, NoteRequest>()
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
        if (context.state !== 'running') {
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
    } catch (error) {
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
    this.voices.release(id, immediate)
    this.wakeCapacity()
    this.scheduleMaintenance()
  }

  releaseVoices(scope: VoiceScope, immediate = false): void {
    if (this.disposed) return
    for (const [id, request] of this.intents) {
      if (!voiceMatches(request.note, scope)) continue
      this.intents.delete(id)
      this.pending.delete(id)
    }
    this.voices.releaseScope(scope, immediate)
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
    this.intents.clear()
    this.pending.clear()
    this.sourceBends.clear()
    this.auditionPitchBend = 0
    if (this.context) for (const voice of this.voices.all) voice.setPitchBend(0, this.context.currentTime)
    this.voices.releaseScope({}, true)
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
      pendingCount: this.pending.size,
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
    return {
      carrierCount: totalCarrierCount, totalCarrierCount,
      envelope: latest?.envelope ?? 0,
      phase: latest?.phase ?? 'idle',
      waveform, pendingWaveform: waveform !== this.params.waveform ? this.params.waveform : null,
      disposed: this.disposed, velocity, velocityGain: velocity / 127,
      pitchBend: latest?.pitchBend ?? this.auditionPitchBend,
      voices: snapshots, voiceCount: this.voices.count, managedCount: this.voices.count,
      retiringCount: this.voices.retiringCount, pendingCount: this.pending.size,
      maxVoices: MAX_VOICES, maxRetiringVoices: MAX_RETIRING_VOICES,
      mixHeadroom: MIX_HEADROOM,
      createdVoiceCount: this.voices.createdCount, destroyedVoiceCount: this.voices.destroyedCount,
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.intents.clear()
    this.pending.clear()
    this.sourceBends.clear()
    this.clearMaintenance()
    this.wakeCapacity()
    const context = this.context
    if (!context) return
    this.voices.releaseScope({}, true)
    this.disposePromise = (async () => {
      if (context.state === 'running') await new Promise<void>(resolve => setTimeout(resolve, 30))
      context.removeEventListener('statechange', this.onContextStateChange)
      this.voices.destroyAll()
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

  private async resumeContext(context: AudioContext): Promise<void> {
    if (context.state === 'running' || context.state === 'closed') return
    const resume = this.resumePromise ?? context.resume()
    this.resumePromise = resume
    try { await resume }
    finally { if (this.resumePromise === resume) this.resumePromise = null }
  }

  private maintain(now: number): void {
    const before = this.voices.count + this.voices.retiringCount
    this.voices.maintain(now)
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
    const at = this.voices.nextMaintenanceAt()
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
    } else this.clearMaintenance()
  }
}
