import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser()
const browserName = /msedge/i.test(process.env.SOUND_LAB_BROWSER || '') ? 'edge' : 'chrome'
try {
  const report = await session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const results = []
    const check = (name, metrics, assertions) => {
      results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    }
    const rms = engine => {
      const analysis = engine.getAnalysis()
      if (!analysis) return 0
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    }
    const measuredFrequency = engine => {
      const analysis = engine.getAnalysis()
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      const crossings = []
      for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] <= 0 && samples[i] > 0) crossings.push(i - 1 - samples[i - 1] / (samples[i] - samples[i - 1]))
      }
      return crossings.length > 1 ? analysis.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]) : 0
    }
    const relativeNear = (actual, expected, tolerance = 0.04) => Math.abs(actual / expected - 1) < tolerance
    const NativeAudioContext = window.AudioContext
    const contexts = []
    class RecordedAudioContext extends NativeAudioContext {
      oscillators = []
      oscillatorStarts = 0
      constructor(options) { super(options); contexts.push(this) }
      createOscillator() {
        const oscillator = super.createOscillator()
        this.oscillators.push(oscillator)
        const start = oscillator.start.bind(oscillator)
        oscillator.start = (...args) => { this.oscillatorStarts++; start(...args) }
        return oscillator
      }
    }
    const engines = []
    window.AudioContext = RecordedAudioContext
    try {
      let params = copyParams(DEFAULT_PARAMS)
      params = { ...params, frequency: 440, amplitude: 0.2, adsr: { attack: 0.004, decay: 0.004, sustain: 1, release: 0.025 } }
      const engine = new SynthEngine(params)
      engines.push(engine)
      const update = change => { params = { ...params, ...change }; engine.setParams(params) }
      const initialContextCount = contexts.length
      engine.setPitchBend(2)
      await engine.noteOn(440, 0)
      check('Velocity zero stays lazy', { state: engine.getState(), contextCount: contexts.length }, [
        ['velocity zero does not create AudioContext', contexts.length === initialContextCount && engine.getAnalysis() === null],
        ['velocity zero leaves the gate closed', !engine.getState().gateOpen],
      ])
      engine.setPitchBend(0)
      await engine.prepare()
      const context = contexts.at(-1)
      const analysis = engine.getAnalysis()
      analysis.time.fftSize = 2048
      await sleep(80)
      check('Connection gesture prepares silent audio', { state: engine.getState(), rms: rms(engine), oscillators: context.oscillators.length }, [
        ['prepare creates a running native AudioContext', engine.getState().contextState === 'running'],
        ['prepare never opens the gate or emits sound', !engine.getState().gateOpen && !engine.getState().audible && rms(engine) < 0.00001],
      ])

      const velocityRms = {}
      const velocityEnvelopes = {}
      await engine.noteOn(440)
      await sleep(300)
      const legacyRms = rms(engine)
      for (const velocity of [127, 64, 32, 1]) {
        await engine.noteOn(440, velocity)
        await sleep(220)
        velocityRms[velocity] = rms(engine)
        velocityEnvelopes[velocity] = engine.getDiagnostics().envelope
        engine.noteOff()
        await sleep(80)
      }
      const velocityRatios = Object.fromEntries([1, 32, 64, 127].map(value => [value, velocityRms[value] / velocityRms[127]]))
      check('Native audio responds linearly to MIDI velocity', { velocityRms, velocityRatios, velocityEnvelopes, legacyRms }, [
        ['velocity 1 produces nonzero quiet sound with polyphonic headroom', velocityRms[1] > 0.00002 && relativeNear(velocityRatios[1], 1 / 127)],
        ['velocity 32 follows the 32/127 coefficient', relativeNear(velocityRatios[32], 32 / 127)],
        ['velocity 64 follows the 64/127 coefficient', relativeNear(velocityRatios[64], 64 / 127)],
        ['velocity 127 retains the original output level', relativeNear(velocityRms[127], legacyRms)],
        ['all velocities share the full ADSR envelope', Object.values(velocityEnvelopes).every(value => Math.abs(value - 1) < 0.001)],
      ])

      await engine.noteOn(440, 64)
      await sleep(150)
      const amplitudeHigh = rms(engine)
      update({ amplitude: 0.1 })
      await sleep(130)
      const amplitudeLow = rms(engine)
      update({ adsr: { ...params.adsr, sustain: 0.4 } })
      await sleep(130)
      const lowerSustain = rms(engine)
      const independentDiagnostics = engine.getDiagnostics()
      check('Velocity, amplitude and ADSR remain independent', { amplitudeHigh, amplitudeLow, lowerSustain, diagnostics: independentDiagnostics, params }, [
        ['amplitude still independently scales RMS', relativeNear(amplitudeHigh / amplitudeLow, 2)],
        ['sustain still independently scales RMS', relativeNear(lowerSustain / amplitudeLow, 0.4)],
        ['velocity coefficient stays at 64/127', independentDiagnostics.velocity === 64 && independentDiagnostics.velocityGain === 64 / 127],
        ['ADSR reaches its own sustain value', Math.abs(independentDiagnostics.envelope - 0.4) < 0.001],
      ])
      update({ amplitude: 0.2, adsr: { ...params.adsr, sustain: 1 } })
      await engine.noteOn(440)
      await sleep(160)
      const defaultRms = rms(engine)
      await engine.noteOn(440, 0)
      await sleep(90)
      check('Legacy default velocity and MIDI zero release', { defaultRms, explicit127Rms: velocityRms[127], zeroRms: rms(engine), state: engine.getState() }, [
        ['omitted velocity restores full legacy output', relativeNear(defaultRms, velocityRms[127]) && engine.getDiagnostics().velocity === 127],
        ['velocity zero closes the active gate and becomes silent', !engine.getState().gateOpen && rms(engine) < 0.00001],
      ])

      const lowestMidiFrequency = 440 * 2 ** ((0 - 69) / 12)
      analysis.time.fftSize = 32768 // More than five periods at MIDI note zero.
      await engine.noteOn(lowestMidiFrequency, 64)
      await sleep(850)
      const lowestMeasured = measuredFrequency(engine)
      const lowestCarrierFrequency = context.oscillators.at(-1).frequency.value
      check('Lowest MIDI note keeps its exact base frequency', { expected: lowestMidiFrequency, measured: lowestMeasured, carrierFrequency: lowestCarrierFrequency, signalRms: rms(engine) }, [
        ['MIDI zero is not clamped to the manual 20 Hz boundary', Math.abs(lowestCarrierFrequency - lowestMidiFrequency) < 0.00001],
        ['native low-frequency cycles match MIDI zero', Math.abs(lowestMeasured - lowestMidiFrequency) < 0.02 && rms(engine) > 0.004],
      ])
      analysis.time.fftSize = 2048

      await engine.noteOn(440)
      await sleep(150)
      const carrier = context.oscillators.at(-1)
      const oscillatorCount = context.oscillators.length
      const oscillatorStarts = context.oscillatorStarts
      const frequencies = {}
      const envelopeValues = []
      for (const bend of [-2, 2, 0]) {
        engine.setPitchBend(bend)
        await sleep(140)
        frequencies[bend] = measuredFrequency(engine)
        envelopeValues.push(engine.getDiagnostics().envelope)
      }
      check('Pitch Bend changes continuous native oscillator pitch', { frequencies, oscillatorCount: context.oscillators.length, oscillatorStarts: context.oscillatorStarts, envelopeValues, baseFrequency: carrier.frequency.value }, [
        ['minus two semitones matches measured frequency', Math.abs(frequencies[-2] - 440 * 2 ** (-2 / 12)) < 0.7],
        ['plus two semitones matches measured frequency', Math.abs(frequencies[2] - 440 * 2 ** (2 / 12)) < 0.7],
        ['center restores exactly the base pitch', Math.abs(frequencies[0] - 440) < 0.7],
        ['bend preserves the carrier and starts no oscillator', context.oscillators.length === oscillatorCount && context.oscillators.at(-1) === carrier && context.oscillatorStarts === oscillatorStarts],
        ['bend keeps the envelope and base frequency unchanged', envelopeValues.every(value => value === 1) && carrier.frequency.value === 440],
      ])

      engine.setPitchBend(2)
      update({ lfo: { enabled: true, rate: 3, depth: 1, target: 'pitch' } })
      await sleep(180)
      const bendWithLfo = []
      for (let i = 0; i < 32; i++) { bendWithLfo.push(measuredFrequency(engine)); await sleep(20) }
      const bentCenter = 440 * 2 ** (2 / 12)
      check('Pitch Bend adds to the existing pitch LFO', { minHz: Math.min(...bendWithLfo), maxHz: Math.max(...bendWithLfo), bentCenter }, [
        ['LFO moves below and above the bent center', Math.min(...bendWithLfo) < bentCenter - 15 && Math.max(...bendWithLfo) > bentCenter + 15],
        ['combined pitch stays within the expected 100-cent vibrato', Math.min(...bendWithLfo) > bentCenter * 2 ** (-1.1 / 12) && Math.max(...bendWithLfo) < bentCenter * 2 ** (1.1 / 12)],
      ])
      update({ waveform: 'triangle', lfo: { ...params.lfo, enabled: false } })
      await sleep(170)
      const replacement = context.oscillators.at(-1)
      const replacementFrequency = measuredFrequency(engine)
      check('Waveform replacement inherits current bend', { replacementFrequency, detune: replacement.detune.value, diagnostics: engine.getDiagnostics() }, [
        ['new carrier inherits the two-semitone detune', replacement !== carrier && Math.abs(replacement.detune.value - 200) < 0.001],
        ['replacement produces the bent frequency', Math.abs(replacementFrequency - bentCenter) < 0.7],
      ])
      engine.setPitchBend(100)
      await sleep(100)
      const clampedHigh = engine.getDiagnostics().pitchBend
      engine.setPitchBend(-100)
      await sleep(100)
      const clampedLow = engine.getDiagnostics().pitchBend
      engine.setPitchBend(NaN)
      await sleep(100)
      check('Pitch Bend bounds invalid external values', { clampedHigh, clampedLow, recovered: engine.getDiagnostics().pitchBend }, [
        ['extreme bend is clamped to two octaves', clampedHigh === 24 && clampedLow === -24],
        ['nonfinite bend safely returns to center', engine.getDiagnostics().pitchBend === 0],
      ])

      // Delay only native resume completion; the graph and its silence are real.
      class DeferredAudioContext extends RecordedAudioContext {
        holdResume = true
        resumeCalls = 0
        get state() { return this.holdResume ? 'suspended' : super.state }
        async resume() { this.resumeCalls++; await sleep(70); this.holdResume = false; await super.resume() }
      }
      window.AudioContext = DeferredAudioContext
      const raceEngine = new SynthEngine(params)
      engines.push(raceEngine)
      const preparing = raceEngine.prepare()
      const deferredContext = contexts.at(-1)
      const pendingNote = raceEngine.noteOn(440, 64)
      raceEngine.noteOff()
      await Promise.all([preparing, pendingNote])
      await sleep(90)
      check('Prepare and Note Off share a safe pending resume', { state: raceEngine.getState(), rms: rms(raceEngine), resumeCalls: deferredContext.resumeCalls }, [
        ['prepare and note share one native resume', deferredContext.resumeCalls === 1],
        ['late resume cannot reopen the gate or sound', !raceEngine.getState().gateOpen && rms(raceEngine) < 0.00001],
      ])
      const disposalEngine = new SynthEngine(params)
      engines.push(disposalEngine)
      const preparingForDisposal = disposalEngine.prepare()
      const pendingDisposalNote = disposalEngine.noteOn(440, 32)
      await disposalEngine.dispose()
      await Promise.all([preparingForDisposal, pendingDisposalNote])
      await disposalEngine.prepare()
      await disposalEngine.noteOn(440, 127)
      disposalEngine.setPitchBend(2)
      check('Dispose cancels prepared audio and pending notes', { state: disposalEngine.getState(), diagnostics: disposalEngine.getDiagnostics() }, [
        ['disposed audio stays closed with no carriers', disposalEngine.getState().contextState === 'closed' && disposalEngine.getDiagnostics().carrierCount === 0],
        ['disposed audio cannot prepare or restart', !disposalEngine.getState().gateOpen && disposalEngine.getAnalysis() === null],
      ])

      return { results, failures: results.flatMap(result => result.checks.filter(check => !check.passed).map(check => `${result.name}: ${check.description}`)) }
    } finally {
      window.AudioContext = NativeAudioContext
      await Promise.all(engines.map(engine => engine.dispose()))
    }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../test-results/midi-audio-${browserName}.json`, import.meta.url), JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'MIDI native Web Audio tests failed')
  console.log(`PASS: ${report.results.length} MIDI audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions`)
} finally {
  await session.close()
}
