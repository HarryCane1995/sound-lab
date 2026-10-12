import type { AnalysisNodes } from '../../types'

/** One read per visual frame; arrays are retained until the actual Analyser changes. */
export class AnalysisDataProvider {
  private getAnalysis: () => AnalysisNodes | null
  private analysis: AnalysisNodes | null = null
  private time: Float32Array<ArrayBuffer> = new Float32Array(0)
  private frequency: Float32Array<ArrayBuffer> = new Float32Array(0)
  private lastStamp = -Infinity
  reads = 0
  active = false
  sampleRate = 48000
  rms = 0
  peakFrequency = 0
  peakDb = -100

  constructor(getAnalysis: () => AnalysisNodes | null) { this.getAnalysis = getAnalysis }

  read(stamp: number) {
    if (stamp === this.lastStamp) return { time: this.time, frequency: this.frequency, sampleRate: this.sampleRate, active: this.active }
    this.lastStamp = stamp
    const analysis = this.getAnalysis()
    if (analysis?.time !== this.analysis?.time || analysis?.frequency !== this.analysis?.frequency ||
      (analysis && (this.time.length !== analysis.time.fftSize || this.frequency.length !== analysis.frequency.frequencyBinCount))) {
      this.analysis = analysis
      this.time = new Float32Array(analysis?.time.fftSize ?? 0)
      this.frequency = new Float32Array(analysis?.frequency.frequencyBinCount ?? 0)
    }
    this.active = analysis?.time.context.state === 'running'
    if (analysis && this.active) {
      analysis.time.getFloatTimeDomainData(this.time)
      analysis.frequency.getFloatFrequencyData(this.frequency)
      this.sampleRate = analysis.sampleRate
      this.reads++
    } else {
      // Suspended contexts expose the last old analyser block, not live output.
      this.time.fill(0)
      this.frequency.fill(-Infinity)
    }
    let squareSum = 0
    for (let i = 0; i < this.time.length; i++) squareSum += this.time[i] * this.time[i]
    this.rms = this.time.length ? Math.sqrt(squareSum / this.time.length) : 0
    this.peakDb = -100
    this.peakFrequency = 0
    for (let i = 1; i < this.frequency.length; i++) {
      if (Number.isFinite(this.frequency[i]) && this.frequency[i] > this.peakDb) {
        this.peakDb = this.frequency[i]
        this.peakFrequency = i * this.sampleRate / (this.frequency.length * 2)
      }
    }
    return { time: this.time, frequency: this.frequency, sampleRate: this.sampleRate, active: this.active }
  }

  spectrumAt(hz: number, radiusHz = 8) {
    const width = this.sampleRate / Math.max(2, this.frequency.length * 2)
    const first = Math.max(1, Math.floor((hz - radiusHz) / width))
    const last = Math.min(this.frequency.length - 1, Math.ceil((hz + radiusHz) / width))
    let db = -100
    for (let i = first; i <= last; i++) if (Number.isFinite(this.frequency[i])) db = Math.max(db, this.frequency[i])
    return db
  }
}
