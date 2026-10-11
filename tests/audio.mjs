import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const results = []
    const check = (name, metrics, assertions) => {
      results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    }
    const engine = new SynthEngine(DEFAULT_PARAMS)
    let params = copyParams(DEFAULT_PARAMS)
    const update = change => {
      params = { ...params, ...change }
      engine.setParams(params)
    }
    const rms = (target = engine) => {
      const analysis = target.getAnalysis()
      if (!analysis) return 0
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    }
    const spectrum = () => {
      const analysis = engine.getAnalysis()
      const bins = new Float32Array(analysis.frequency.frequencyBinCount)
      analysis.frequency.getFloatFrequencyData(bins)
      return { bins, binWidth: analysis.sampleRate / analysis.frequency.fftSize }
    }
    const peak = (data, low, high) => {
      let index = Math.max(1, Math.floor(low / data.binWidth))
      let db = -Infinity
      for (let i = index; i <= Math.min(data.bins.length - 1, Math.ceil(high / data.binWidth)); i++) {
        if (data.bins[i] > db) { db = data.bins[i]; index = i }
      }
      return { hz: index * data.binWidth, db }
    }
    const harmonic = (data, hz) => peak(data, hz - data.binWidth * 2, hz + data.binWidth * 2).db
    const bandDb = (data, low, high) => {
      let energy = 0
      for (let i = Math.ceil(low / data.binWidth); i <= Math.min(data.bins.length - 1, Math.floor(high / data.binWidth)); i++) energy += 10 ** (data.bins[i] / 10)
      return 10 * Math.log10(Math.max(1e-20, energy))
    }
    const zeroCrossFrequency = () => {
      const analysis = engine.getAnalysis()
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      const crossings = []
      for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] <= 0 && samples[i] > 0) crossings.push(i - 1 - samples[i - 1] / (samples[i] - samples[i - 1]))
      }
      return crossings.length > 1 ? analysis.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]) : 0
    }

    try {
      const lazyBefore = engine.getState()
      update({ frequency: 440, amplitude: 0.3, adsr: { attack: 0.004, decay: 0.004, sustain: 1, release: 0.08 } })
      check('Lazy initialization', { before: lazyBefore, afterControls: engine.getState() }, [
        ['constructor creates no AudioContext', lazyBefore.contextState === 'not-created'],
        ['controls create no AudioContext', engine.getState().contextState === 'not-created' && engine.getAnalysis() === null],
      ])
      await engine.noteOn(220)
      params.frequency = 220
      const analysis = engine.getAnalysis()
      // Approximately 20 ms resolves ADSR independently of the device's rate;
      // a separate ~170 ms FFT window resolves harmonic structure accurately.
      analysis.time.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(analysis.sampleRate * 0.02)))
      analysis.frequency.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(analysis.sampleRate / 6)))
      analysis.frequency.smoothingTimeConstant = 0 // Deterministic spectral measurements.
      await sleep(230)
      const first = spectrum()
      const fundamental220 = peak(first, 100, 1000)
      update({ frequency: 440 })
      await sleep(230)
      const fundamental440 = peak(spectrum(), 100, 1000)
      check('Real oscillator frequency', { sampleRate: analysis.sampleRate, timeFftSize: analysis.time.fftSize, frequencyFftSize: analysis.frequency.fftSize, fundamental220, fundamental440, binWidth: first.binWidth }, [
        ['220 Hz fundamental within one FFT bin', Math.abs(fundamental220.hz - 220) <= first.binWidth],
        ['440 Hz fundamental follows control', Math.abs(fundamental440.hz - 440) <= first.binWidth],
      ])

      const waves = {}
      update({ frequency: 220 })
      for (const waveform of ['sine', 'square', 'sawtooth', 'triangle']) {
        update({ waveform })
        await sleep(240)
        const data = spectrum()
        const fundamental = harmonic(data, 220)
        waves[waveform] = {
          fundamental,
          secondRelativeDb: harmonic(data, 440) - fundamental,
          thirdRelativeDb: harmonic(data, 660) - fundamental,
          rms: rms(),
        }
      }
      check('Waveform harmonic structure', waves, [
        ['sine has negligible third harmonic', waves.sine.thirdRelativeDb < -45],
        ['square has a strong odd harmonic', waves.square.thirdRelativeDb > -15 && waves.square.thirdRelativeDb < -5],
        ['square suppresses the second harmonic', waves.square.secondRelativeDb < -40],
        ['sawtooth contains its second harmonic', waves.sawtooth.secondRelativeDb > -12],
        ['triangle third is weaker than square third', waves.triangle.thirdRelativeDb < waves.square.thirdRelativeDb - 6],
        ['all four waveforms produce real audio', Object.values(waves).every(value => value.rms > 0.015)],
      ])

      update({ waveform: 'sine', amplitude: 0.1 })
      await sleep(230)
      const quietRms = rms()
      update({ amplitude: 0.3 })
      await sleep(150)
      const referenceRms = rms()
      check('Amplitude changes actual RMS', { quietRms, louderRms: referenceRms, ratio: referenceRms / quietRms }, [
        ['3x amplitude yields approximately 3x RMS', referenceRms / quietRms > 2.75 && referenceRms / quietRms < 3.25],
        ['safe initial output below 0.2 RMS', referenceRms > 0.07 && referenceRms < 0.2],
      ])

      update({ waveform: 'sawtooth', amplitude: 0.18, filter: { cutoff: 500, q: 0.707, bypass: true } })
      await sleep(250)
      const bypassBand = bandDb(spectrum(), 1000, 6000)
      update({ filter: { cutoff: 500, q: 0.707, bypass: false } })
      await sleep(250)
      const filteredBand = bandDb(spectrum(), 1000, 6000)
      update({ filter: { cutoff: 660, q: 0.5, bypass: false } })
      await sleep(250)
      const lowQThird = harmonic(spectrum(), 660)
      update({ filter: { cutoff: 660, q: 6, bypass: false } })
      await sleep(250)
      const resonantThird = harmonic(spectrum(), 660)
      check('Low-pass bypass and resonance', { bypassBand, filteredBand, attenuationDb: bypassBand - filteredBand, lowQThird, resonantThird, resonanceBoostDb: resonantThird - lowQThird }, [
        ['low-pass removes high-frequency energy', bypassBand - filteredBand > 15],
        ['Q increases the harmonic at cutoff', resonantThird - lowQThird > 10],
      ])

      engine.noteOff()
      await sleep(130)
      update({ waveform: 'sine', amplitude: 0.3, filter: { cutoff: 8000, q: 0.707, bypass: true }, adsr: { attack: 0.4, decay: 0.3, sustain: 0.35, release: 0.25 } })
      await engine.noteOn()
      await sleep(90)
      const attackEarly = rms() / referenceRms
      await sleep(220)
      const attackLate = rms() / referenceRms
      await sleep(180)
      const decay = rms() / referenceRms
      await sleep(300)
      const sustain = rms() / referenceRms
      engine.noteOff()
      await sleep(100)
      const releaseEarly = rms() / referenceRms
      await sleep(220)
      const releaseEnd = rms() / referenceRms
      check('Actual ADSR phases', { attackEarly, attackLate, decay, sustain, releaseEarly, releaseEnd, state: engine.getState() }, [
        ['attack starts quietly', attackEarly > 0.08 && attackEarly < 0.4],
        ['attack increases amplitude', attackLate > 0.55 && attackLate > attackEarly * 2],
        ['decay is above sustain and below peak', decay > sustain * 1.3 && decay < 0.95],
        ['sustain reaches configured 35 percent', sustain > 0.27 && sustain < 0.43],
        ['release fades from sustain', releaseEarly > 0.05 && releaseEarly < sustain],
        ['release ends in silence and closed gate', releaseEnd < 0.005 && !engine.getState().gateOpen && !engine.getState().audible],
      ])

      update({ adsr: { attack: 0.6, decay: 0.2, sustain: 0.5, release: 0.15 } })
      await engine.noteOn()
      await sleep(110)
      const interruptedLevel = rms() / referenceRms
      engine.noteOff()
      await sleep(190)
      const interruptedEnd = rms() / referenceRms
      await engine.noteOn()
      await sleep(150)
      const beforeRetrigger = rms() / referenceRms
      await engine.noteOn()
      await sleep(70)
      const afterRetrigger = rms() / referenceRms
      engine.panic()
      await sleep(70)
      check('Interrupted attack, retrigger and panic', { interruptedLevel, interruptedEnd, beforeRetrigger, afterRetrigger, panicRms: rms() }, [
        ['attack was interrupted before peak', interruptedLevel > 0.07 && interruptedLevel < 0.35],
        ['Note Off cancels future attack and decay', interruptedEnd < 0.005],
        ['retrigger continues from current envelope', afterRetrigger >= beforeRetrigger * 0.95],
        ['panic reaches silence promptly', rms() < 0.0005 && !engine.getState().gateOpen],
      ])

      update({ waveform: 'sine', frequency: 440, adsr: { attack: 0.004, decay: 0.004, sustain: 1, release: 0.08 }, lfo: { enabled: true, rate: 4, depth: 1, target: 'pitch' } })
      await engine.noteOn()
      await sleep(250)
      const pitchSamples = []
      for (let i = 0; i < 25; i++) { pitchSamples.push(zeroCrossFrequency()); await sleep(20) }
      update({ lfo: { ...params.lfo, enabled: false } })
      await sleep(150)
      const stableSamples = []
      for (let i = 0; i < 8; i++) { stableSamples.push(zeroCrossFrequency()); await sleep(20) }
      check('Pitch LFO changes actual cycle periods', { minHz: Math.min(...pitchSamples), maxHz: Math.max(...pitchSamples), disabledMinHz: Math.min(...stableSamples), disabledMaxHz: Math.max(...stableSamples) }, [
        ['vibrato moves above and below 440 Hz', Math.min(...pitchSamples) < 425 && Math.max(...pitchSamples) > 455],
        ['normalized depth stays within ±100 cents', Math.min(...pitchSamples) > 410 && Math.max(...pitchSamples) < 470],
        ['disable restores stable pitch', Math.max(...stableSamples) - Math.min(...stableSamples) < 1.5],
      ])

      update({ waveform: 'sawtooth', frequency: 220, filter: { cutoff: 1000, q: 0.707, bypass: false }, lfo: { enabled: true, rate: 2, depth: 1, target: 'filter' } })
      await sleep(280)
      const filterSamples = []
      for (let i = 0; i < 12; i++) { filterSamples.push(bandDb(spectrum(), 2000, 6000)); await sleep(65) }
      const filterMovementDb = Math.max(...filterSamples) - Math.min(...filterSamples)
      check('Filter LFO moves real spectrum', { highBandMinDb: Math.min(...filterSamples), highBandMaxDb: Math.max(...filterSamples), filterMovementDb }, [
        ['filter modulation changes upper harmonics', filterMovementDb > 8],
      ])

      update({ filter: { cutoff: 8000, q: 0.707, bypass: true }, lfo: { enabled: false, rate: 4, depth: 0, target: 'pitch' } })
      let maxCarriers = 0
      const waveforms = ['sine', 'square', 'sawtooth', 'triangle']
      for (let i = 0; i < 60; i++) {
        update({ waveform: waveforms[i % waveforms.length] })
        maxCarriers = Math.max(maxCarriers, engine.getDiagnostics().carrierCount)
        await sleep(3)
      }
      update({ waveform: 'triangle' })
      await sleep(250)
      const rapidDiagnostics = engine.getDiagnostics()
      const rapidSpectrum = spectrum()
      const rapidThirdRelative = harmonic(rapidSpectrum, 660) - harmonic(rapidSpectrum, 220)
      check('Rapid waveform changes stay bounded', { maxCarriers, diagnostics: rapidDiagnostics, thirdRelativeDb: rapidThirdRelative, rms: rms() }, [
        ['at most two carrier nodes alive', maxCarriers <= 2],
        ['retired node cleaned up', rapidDiagnostics.carrierCount === 1],
        ['final requested waveform applied', rapidDiagnostics.waveform === 'triangle' && rapidDiagnostics.pendingWaveform === null],
        ['final triangle verified in audio', rapidThirdRelative < -15 && rapidThirdRelative > -25 && rms() > 0.015],
      ])

      // Only the resume promise is delayed: all nodes and analyser samples are
      // native Web Audio. This deterministically exercises a user releasing a
      // key while the browser is still granting/resuming its audio context.
      const NativeAudioContext = window.AudioContext
      class DeferredAudioContext extends NativeAudioContext {
        holdResume = true
        get state() { return this.holdResume ? 'suspended' : super.state }
        async resume() { await sleep(60); this.holdResume = false; await super.resume() }
      }
      let raceEngine
      let disposalEngine
      try {
        window.AudioContext = DeferredAudioContext
        raceEngine = new SynthEngine(DEFAULT_PARAMS)
        const pendingNote = raceEngine.noteOn()
        raceEngine.noteOff()
        await pendingNote
        await sleep(100)
        check('Note Off cancels pending resume', { state: raceEngine.getState(), rms: rms(raceEngine) }, [
          ['resumed context has no reopened gate', !raceEngine.getState().gateOpen],
          ['pending note produces no late audio', rms(raceEngine) < 0.0001],
        ])
        disposalEngine = new SynthEngine(DEFAULT_PARAMS)
        const pendingDisposalNote = disposalEngine.noteOn()
        await disposalEngine.dispose()
        await pendingDisposalNote
        check('Dispose cancels pending resume', { state: disposalEngine.getState(), diagnostics: disposalEngine.getDiagnostics() }, [
          ['disposed context remains closed', disposalEngine.getState().contextState === 'closed'],
          ['all carriers disconnected', disposalEngine.getDiagnostics().carrierCount === 0],
          ['no analyser exposed after disposal', disposalEngine.getAnalysis() === null],
        ])
      } finally {
        window.AudioContext = NativeAudioContext
        await raceEngine?.dispose()
        await disposalEngine?.dispose()
      }
      await engine.dispose()
      await engine.dispose()
      await engine.noteOn()
      check('Idempotent final cleanup', { state: engine.getState(), diagnostics: engine.getDiagnostics() }, [
        ['context closed and gate released', engine.getState().contextState === 'closed' && !engine.getState().gateOpen],
        ['no carrier survives disposal', engine.getDiagnostics().carrierCount === 0],
        ['disposed engine cannot restart', engine.getAnalysis() === null && !engine.getState().audible],
      ])
      return { results, failures: results.flatMap(result => result.checks.filter(check => !check.passed).map(check => `${result.name}: ${check.description}`)) }
    } finally {
      await engine.dispose()
    }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL('../test-results/audio.json', import.meta.url), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Real Web Audio regression tests failed')
  console.log(`PASS: ${report.results.length} audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions`)
} finally {
  await session.close()
}
