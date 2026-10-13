import type { RenderedKick } from './audio/KickRenderer'

export interface SamplePreviewBus { context: AudioContext; destination: AudioNode; monitorLevel: number }
interface PreviewVoice { source: AudioBufferSourceNode; gain: GainNode; done: Promise<void>; finish: () => void; fading: boolean }

/** One preview plus its short fade, on the existing synth context/output only. */
export class SamplePreview {
  private voice: PreviewVoice | null = null
  private retiring: PreviewVoice | null = null
  private token = 0
  private disposed = false
  private started = 0
  private ended = 0
  private lastPcm: Float32Array | null = null
  private provider: () => Promise<SamplePreviewBus | null>
  private changed: (playing: boolean) => void

  constructor(provider: () => Promise<SamplePreviewBus | null>, changed: (playing: boolean) => void = () => {}) {
    this.provider = provider; this.changed = changed
  }

  async prepareGesture(): Promise<void> { if (!this.disposed) await this.provider() }

  async play(render: RenderedKick): Promise<boolean> {
    const token = ++this.token
    if (this.disposed) return false
    const bus = await this.provider()
    if (this.disposed || token !== this.token || !bus || bus.context.state !== 'running') return false
    this.fadeCurrent()
    const retiring = this.retiring
    if (retiring) await retiring.done
    if (this.disposed || token !== this.token || bus.context.state !== 'running') return false
    const source = bus.context.createBufferSource(), gain = bus.context.createGain()
    const buffer = bus.context.createBuffer(1, render.pcm.length, render.sampleRate)
    buffer.copyToChannel(render.pcm, 0)
    source.buffer = buffer
    gain.gain.value = 1
    source.connect(gain).connect(bus.destination)
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const voice: PreviewVoice = { source, gain, done, fading: false, finish: () => {
      source.disconnect(); gain.disconnect(); source.buffer = null
      if (this.voice === voice) this.voice = null
      if (this.retiring === voice) this.retiring = null
      ++this.ended; resolveDone()
      this.changed(this.voice !== null)
    } }
    source.addEventListener('ended', voice.finish, { once: true })
    this.voice = voice
    this.lastPcm = render.pcm
    ++this.started
    source.start(bus.context.currentTime + 0.001)
    this.changed(true)
    return true
  }

  private fadeCurrent(): void {
    const voice = this.voice
    if (!voice || voice.fading) return
    this.voice = null; this.retiring = voice; voice.fading = true
    const context = voice.source.context
    if (context.state !== 'running') {
      try { voice.source.stop() } catch { /* A suspended/closed graph is inaudible. */ }
      voice.source.removeEventListener('ended', voice.finish)
      voice.finish()
      return
    }
    const at = context.currentTime
    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.setValueAtTime(1, at)
    voice.gain.gain.linearRampToValueAtTime(0, at + 0.005)
    try { voice.source.stop(at + 0.006) } catch { /* The one-shot may already have ended. */ }
  }

  stop(): void {
    ++this.token
    this.fadeCurrent()
    const retiring = this.retiring
    if (retiring && retiring.source.context.state !== 'running') {
      retiring.source.removeEventListener('ended', retiring.finish)
      try { retiring.source.stop() } catch { /* Already stopped. */ }
      retiring.finish()
    }
    this.changed(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.stop(); this.disposed = true; this.lastPcm = null
  }

  diagnostics() { return { activeSources: Number(this.voice !== null) + Number(this.retiring !== null), started: this.started, ended: this.ended, disposed: this.disposed, pcm: this.lastPcm } }
}
