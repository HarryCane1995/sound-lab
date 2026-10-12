import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const browserName = testBrowserName()
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams, copyAdditive, defaultAdditive } = await import('/src/types.ts')
    const { HARMONIC_TEMPLATES } = await import('/src/content/harmonics.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const frequency = midi => 440 * 2 ** ((midi - 69) / 12)
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const config = (levels, phases = {}) => {
      const additive = defaultAdditive()
      additive.levels.fill(0)
      for (const [number, level] of Object.entries(levels)) additive.levels[Number(number) - 1] = level
      for (const [number, phase] of Object.entries(phases)) additive.phases[Number(number) - 1] = phase
      return additive
    }
    const note = (midi = 57, options = {}) => ({ id: `A:1:${midi}`, midi, frequency: frequency(midi), velocity: 127, sourceId: 'A', sourceName: 'Simulated MIDI A', channel: 1, origin: 'midi', ...options })
    const NativeAudioContext = window.AudioContext
    const contexts = []
    class RecordedAudioContext extends NativeAudioContext {
      periodicWaves = []
      oscillatorStarts = 0
      constructor(options) { super(options); contexts.push(this) }
      createPeriodicWave(real, imag, options) {
        const wave = super.createPeriodicWave(real, imag, options)
        this.periodicWaves.push({ real: [...real], imag: [...imag], disableNormalization: options?.disableNormalization === true, wave })
        return wave
      }
      createOscillator() {
        const oscillator = super.createOscillator()
        const nativeStart = oscillator.start.bind(oscillator)
        oscillator.start = (...args) => { this.oscillatorStarts++; return nativeStart(...args) }
        return oscillator
      }
    }
    window.AudioContext = RecordedAudioContext
    const engines = []
    const create = (changes = {}) => {
      let params = { ...copyParams(DEFAULT_PARAMS), mode: 'additive', additive: config({ 1: 100 }), frequency: 220, amplitude: 0.2, adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.16 }, filter: { cutoff: 12000, q: 0.707, bypass: true }, lfo: { enabled: false, rate: 3, depth: 0, target: 'pitch' }, ...changes }
      const engine = new SynthEngine(params)
      engines.push(engine)
      return { engine, update: change => { params = { ...params, ...change }; engine.setParams(params) }, getParams: () => copyParams(params) }
    }
    const setupAnalysis = (engine, timeFftSize = 2048, frequencyFftSize = 16384) => {
      const analysis = engine.getAnalysis()
      if (analysis) {
        analysis.time.fftSize = timeFftSize
        analysis.frequency.fftSize = frequencyFftSize
        analysis.frequency.smoothingTimeConstant = 0
      }
      return analysis
    }
    const analyse = engine => {
      const analysis = engine.getAnalysis()
      if (!analysis) return { rms: 0, peak: 0, samples: new Float32Array(), bins: new Float32Array(), binWidth: 1, sampleRate: 48000 }
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      const bins = new Float32Array(analysis.frequency.frequencyBinCount)
      analysis.frequency.getFloatFrequencyData(bins)
      return { samples, bins, binWidth: analysis.sampleRate / analysis.frequency.fftSize, sampleRate: analysis.sampleRate, rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length), peak: Math.max(...samples.map(Math.abs)) }
    }
    const peak = (data, hz, radius = data.binWidth * 2) => {
      let index = Math.max(1, Math.floor((hz - radius) / data.binWidth))
      let db = -Infinity
      for (let i = index; i <= Math.min(data.bins.length - 1, Math.ceil((hz + radius) / data.binWidth)); i++) if (data.bins[i] > db) { db = data.bins[i]; index = i }
      return { hz: index * data.binWidth, db }
    }
    const component = (data, hz) => {
      let power = 0
      for (let i = Math.max(1, Math.round(hz / data.binWidth) - 3); i <= Math.min(data.bins.length - 1, Math.round(hz / data.binWidth) + 3); i++) power += 10 ** (data.bins[i] / 10)
      return Math.sqrt(power)
    }
    const harmonicRatios = (data, base, count = 8) => Array.from({ length: count }, (_, index) => component(data, base * (index + 1)) / component(data, base))
    const wrapped = radians => Math.atan2(Math.sin(radians), Math.cos(radians))
    const phase = (data, hz) => {
      let sine = 0
      let cosine = 0
      for (let i = 0; i < data.samples.length; i++) {
        const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (data.samples.length - 1))
        const angle = 2 * Math.PI * hz * i / data.sampleRate
        sine += data.samples[i] * Math.sin(angle) * weight
        cosine += data.samples[i] * Math.cos(angle) * weight
      }
      return Math.atan2(cosine, sine)
    }
    const active = engine => engine.getVoices().filter(voice => !voice.retiring)
    const settle = async (engine, delay = 430) => { setupAnalysis(engine); await sleep(delay); return analyse(engine) }
    const close = async engine => { await engine.dispose(); await sleep(20) }
    try {
      const { engine: lazy } = create()
      const contextsBefore = contexts.length
      lazy.setParams({ ...copyParams(DEFAULT_PARAMS), mode: 'additive', additive: config({ 1: 100, 16: 100 }) })
      check('Additive controls keep AudioContext lazy', { state: lazy.getState(), contexts: contexts.length }, [
        ['coefficient edits allocate no context or native oscillator', contexts.length === contextsBefore && lazy.getAnalysis() === null],
        ['no voice is opened by a mode or harmonic edit', lazy.getState().voiceCount === 0 && !lazy.getState().gateOpen],
      ])
      await close(lazy)

      const { engine, update } = create()
      await engine.noteOnVoice(note())
      const context = contexts.at(-1)
      const pure = await settle(engine)
      const base = 220
      const pureWave = context.periodicWaves.at(-1)
      check('H1 alone produces a real sine fundamental', { spectrum: [1, 2, 3, 4].map(number => peak(pure, base * number)), rms: pure.rms, nativeWave: { real: pureWave.real, imag: pureWave.imag, disableNormalization: pureWave.disableNormalization } }, [
        ['native output fundamental matches 220 Hz', Math.abs(peak(pure, base).hz - base) <= pure.binWidth && pure.rms > 0.008],
        ['higher harmonics are absent from real analyser data', [2, 3, 4].every(number => peak(pure, base * number).db - peak(pure, base).db < -45)],
        ['PeriodicWave uses sixteen sine coefficients and zero DC/cosines', pureWave.imag.length === 17 && pureWave.imag[0] === 0 && pureWave.imag[1] === 1 && pureWave.imag.slice(2).every(value => value === 0) && pureWave.real.every(value => value === 0)],
        ['browser auto-normalization is explicitly disabled', pureWave.disableNormalization],
      ])
      const initialInstances = active(engine).map(voice => voice.instanceId)
      update({ additive: config({ 1: 100, 2: 50 }) })
      const second = await settle(engine)
      check('Adding H2 creates its expected output peak', { ratios: harmonicRatios(second, base, 4), diagnostics: engine.getDiagnostics() }, [
        ['second harmonic is half the fundamental', Math.abs(component(second, base * 2) / component(second, base) - 0.5) < 0.025],
        ['third harmonic remains absent', peak(second, base * 3).db - peak(second, base).db < -45],
      ])
      update({ additive: config({ 1: 100, 2: 50, 3: 25 }) })
      const third = await settle(engine)
      check('Adding H3 changes only the requested harmonic recipe', { ratios: harmonicRatios(third, base, 4), voices: active(engine) }, [
        ['H2 and H3 retain their independent 50 and 25 percent ratios', Math.abs(component(third, base * 2) / component(third, base) - 0.5) < 0.025 && Math.abs(component(third, base * 3) / component(third, base) - 0.25) < 0.025],
        ['live changes keep the same gated envelope and voice identity', active(engine).every(voice => initialInstances.includes(voice.instanceId) && voice.phase === 'sustain' && voice.envelope === 1)],
      ])
      const mutedConfig = config({ 1: 100, 2: 50, 3: 25 })
      mutedConfig.enabled[1] = false
      update({ additive: mutedConfig })
      const muted = await settle(engine)
      check('H2 mute removes its peak while preserving stored values', { ratios: harmonicRatios(muted, base, 4), storedLevel: mutedConfig.levels[1] }, [
        ['muted second harmonic drops by more than forty dB', peak(muted, base * 2).db - peak(muted, base).db < -40],
        ['H3 to H1 ratio remains unchanged', Math.abs(component(muted, base * 3) / component(muted, base) - 0.25) < 0.025],
        ['muting leaves the fifty-percent H2 level available', mutedConfig.levels[1] === 50],
      ])
      update({ additive: { ...mutedConfig, enabled: Array(16).fill(true), solo: 3 } })
      const solo = await settle(engine)
      check('Solo isolates a harmonic without retuning the underlying note', { spectrum: [1, 2, 3, 4].map(number => peak(solo, base * number)), voices: active(engine) }, [
        ['H3 is audible while H1 and H2 are suppressed', peak(solo, base * 3).db > -60 && [1, 2].every(number => peak(solo, base * number).db - peak(solo, base * 3).db < -40)],
        ['base note and envelope are preserved', active(engine)[0].frequency === base && active(engine)[0].instanceId === initialInstances[0] && active(engine)[0].gateOpen],
      ])

      update({ additive: config({ 1: 100, 3: 50 }) })
      setupAnalysis(engine, 16384)
      await sleep(440)
      const phaseZero = analyse(engine)
      const relativeZero = wrapped(phase(phaseZero, base * 3) - 3 * phase(phaseZero, base))
      update({ additive: config({ 1: 100, 3: 50 }, { 3: 180 }) })
      await sleep(440)
      const phaseFlipped = analyse(engine)
      const relativeFlipped = wrapped(phase(phaseFlipped, base * 3) - 3 * phase(phaseFlipped, base))
      check('Harmonic phase inversion changes measured waveform and preserves spectrum', { relativeZero, relativeFlipped, rmsBefore: phaseZero.rms, rmsAfter: phaseFlipped.rms, imaginary: context.periodicWaves.at(-1).imag }, [
        ['native H3 sine coefficient changes polarity', context.periodicWaves.at(-1).imag[3] < 0],
        ['time-domain fitted relative phase changes by pi', Math.abs(wrapped(relativeFlipped - relativeZero)) > Math.PI - 0.15],
        ['phase inversion retains harmonic energy and RMS', Math.abs(phaseFlipped.rms / phaseZero.rms - 1) < 0.025 && Math.abs(component(phaseFlipped, base * 3) / component(phaseFlipped, base) - 0.5) < 0.025],
      ])

      const templateResults = []
      for (const template of HARMONIC_TEMPLATES) {
        update({ additive: copyAdditive(template.config) })
        const data = await settle(engine)
        const ratios = harmonicRatios(data, base, 8)
        templateResults.push({ id: template.id, ratios, rms: data.rms, coefficients: engine.getDiagnostics().additiveCoefficients })
      }
      const square = templateResults.find(template => template.id === 'square-approx')
      const saw = templateResults.find(template => template.id === 'sawtooth-approx')
      const triangle = templateResults.find(template => template.id === 'triangle-approx')
      const sawTemplate = HARMONIC_TEMPLATES.find(template => template.id === 'sawtooth-approx')
      const triangleTemplate = HARMONIC_TEMPLATES.find(template => template.id === 'triangle-approx')
      check('Six harmonic templates produce their intended native spectra', { templates: templateResults }, [
        ['all six templates emit finite nonzero output', templateResults.length === 6 && templateResults.every(template => Number.isFinite(template.rms) && template.rms > 0.001)],
        ['Square Approx uses odd 1 over n harmonics', [3, 5, 7].every(number => Math.abs(square.ratios[number - 1] - 1 / number) < 0.025) && [2, 4, 6, 8].every(number => square.ratios[number - 1] < 0.01)],
        ['Sawtooth Approx contains every 1 over n harmonic', [2, 3, 4, 5, 6, 7, 8].every(number => Math.abs(saw.ratios[number - 1] - 1 / number) < 0.025)],
        ['Sawtooth Approx alternates signed harmonic phase', [2, 4, 6, 8].every(number => sawTemplate.config.phases[number - 1] === 180) && [1, 3, 5, 7].every(number => sawTemplate.config.phases[number - 1] === 0)],
        ['Triangle Approx uses only odd 1 over n squared harmonics', [3, 5, 7].every(number => Math.abs(triangle.ratios[number - 1] - 1 / number ** 2) < 0.015) && [2, 4, 6, 8].every(number => triangle.ratios[number - 1] < 0.01)],
        ['Triangle Approx alternates phase on successive odd harmonics', triangleTemplate.config.phases[2] === 180 && triangleTemplate.config.phases[4] === 0 && triangleTemplate.config.phases[6] === 180],
      ])
      update({ additive: config(Object.fromEntries(Array.from({ length: 16 }, (_, index) => [index + 1, 100]))) })
      const full = await settle(engine)
      const fullWave = context.periodicWaves.at(-1)
      check('Explicit L1 normalization keeps harmonic levels predictable', { scale: engine.getDiagnostics().additiveScale, imaginary: fullWave.imag, fullRms: full.rms, pureRms: pure.rms }, [
        ['sixteen full harmonics each receive coefficient one sixteenth', fullWave.imag.slice(1).every(value => Math.abs(value - 1 / 16) < 1e-7)],
        ['orthogonal harmonic RMS matches the normalized sum', Math.abs(full.rms / pure.rms - 0.25) < 0.02],
        ['peak remains finite and safely below full scale', Number.isFinite(full.peak) && full.peak < 0.2],
      ])
      update({ additive: config({}) })
      const zero = await settle(engine)
      check('All-zero harmonic recipe produces genuine finite silence', { rms: zero.rms, peak: zero.peak, diagnostics: engine.getDiagnostics() }, [
        ['native output samples are finite and silent', zero.samples.every(Number.isFinite) && zero.rms < 0.000001 && zero.peak < 0.00001],
        ['zero recipe preserves held note history for later edits', active(engine)[0].gateOpen && active(engine)[0].instanceId === initialInstances[0]],
      ])

      update({ additive: { ...copyAdditive(HARMONIC_TEMPLATES.find(template => template.id === 'square-approx').config), compare: true } })
      const additiveComparison = await settle(engine)
      const beforeModeInstances = active(engine).map(voice => voice.instanceId)
      update({ mode: 'classic', waveform: 'square' })
      const classicMatched = await settle(engine)
      const classicComparisonGain = engine.getDiagnostics().comparisonGain
      const comparisonLevels = HARMONIC_TEMPLATES.find(template => template.id === 'square-approx').config.levels.map(level => level / 100)
      const comparisonScale = 1 / Math.max(1, comparisonLevels.reduce((sum, value) => sum + Math.abs(value), 0))
      const expectedComparisonGain = Math.sqrt(comparisonLevels.reduce((sum, value) => sum + (value * comparisonScale) ** 2, 0) / 2)
      update({ additive: { ...copyAdditive(HARMONIC_TEMPLATES.find(template => template.id === 'square-approx').config), compare: false } })
      const classicFull = await settle(engine)
      update({ mode: 'additive' })
      const additiveRestored = await settle(engine)
      check('Classic comparison and mode changes preserve notes and recipe', { additiveRms: additiveComparison.rms, matchedClassicRms: classicMatched.rms, fullClassicRms: classicFull.rms, restoredAdditiveRms: additiveRestored.rms, classicComparisonGain, expectedComparisonGain, voices: active(engine) }, [
        ['comparison gain exactly follows the explicit ideal-RMS formula', Math.abs(classicComparisonGain - expectedComparisonGain) < 1e-7],
        // Native built-in waves normalize their band-limited table; the
        // documented ideal-wave comparison is approximate in real output.
        ['comparison keeps native Classic RMS within twenty percent of Additive', Math.abs(classicMatched.rms / additiveComparison.rms - 1) < 0.2],
        ['comparison reduces the audible level gap relative to full Classic', Math.abs(classicMatched.rms - additiveComparison.rms) < Math.abs(classicFull.rms - additiveComparison.rms)],
        ['disabling comparison restores full Classic level', classicFull.rms > classicMatched.rms * 1.5],
        ['return to Additive restores the original recipe output', Math.abs(additiveRestored.rms / additiveComparison.rms - 1) < 0.03],
        ['mode crossfades do not retrigger envelope or replace the voice', active(engine).every(voice => beforeModeInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
      ])
      const additionalComparisons = []
      for (const [templateId, waveform] of [['sawtooth-approx', 'sawtooth'], ['triangle-approx', 'triangle']]) {
        const recipe = copyAdditive(HARMONIC_TEMPLATES.find(template => template.id === templateId).config)
        update({ mode: 'additive', additive: { ...recipe, compare: true } })
        const additive = await settle(engine)
        update({ mode: 'classic', waveform })
        const matched = await settle(engine)
        const measuredGain = engine.getDiagnostics().comparisonGain
        const raw = recipe.levels.map(level => level / 100)
        const scale = 1 / Math.max(1, raw.reduce((sum, value) => sum + value, 0))
        const expectedGain = Math.min(1, Math.sqrt(raw.reduce((sum, value) => sum + (value * scale) ** 2, 0) / 2) * Math.sqrt(3))
        update({ additive: { ...recipe, compare: false } })
        const fullClassic = await settle(engine)
        additionalComparisons.push({ waveform, additiveRms: additive.rms, matchedRms: matched.rms, fullClassicRms: fullClassic.rms, measuredGain, expectedGain })
      }
      check('Sawtooth and Triangle comparisons use transparent approximate level matching', { comparisons: additionalComparisons }, [
        ['both gains exactly follow their ideal-wave RMS formula', additionalComparisons.every(value => Math.abs(value.measuredGain - value.expectedGain) < 1e-7)],
        ['both native comparison levels remain within twenty percent', additionalComparisons.every(value => Math.abs(value.matchedRms / value.additiveRms - 1) < 0.2)],
        ['comparison attenuates a large level gap and never worsens a unity-gain match', additionalComparisons.every(value => value.expectedGain < 0.999
          ? Math.abs(value.matchedRms - value.additiveRms) < Math.abs(value.fullClassicRms - value.additiveRms)
          : Math.abs(value.matchedRms - value.fullClassicRms) < value.additiveRms * 0.02)],
      ])
      await close(engine)

      const { engine: poly, update: updatePoly } = create({ amplitude: 0.08, adsr: { attack: 0.2, decay: 0.05, sustain: 1, release: 0.35 } })
      const beforePolyContexts = contexts.length
      // Submit each chord group together so per-note preparation cannot turn
      // the intended simultaneous group into an arpeggio.
      await Promise.all(Array.from({ length: 8 }, (_, index) => poly.noteOnVoice(note(48 + index))))
      setupAnalysis(poly)
      await sleep(90)
      await Promise.all(Array.from({ length: 8 }, (_, index) => poly.noteOnVoice(note(56 + index))))
      const staggeredVoices = active(poly)
      await sleep(650)
      const polyData = analyse(poly)
      const polyContext = contexts.at(-1)
      const polyPeaks = Array.from({ length: 16 }, (_, index) => ({ midi: 48 + index, ...peak(polyData, frequency(48 + index), polyData.binWidth) }))
      check('All sixteen Additive voices have independent pitch and envelopes', { voices: staggeredVoices, peaks: polyPeaks, diagnostics: poly.getDiagnostics() }, [
        ['all sixteen independently gated voices share one context', active(poly).length === 16 && active(poly).every(voice => voice.gateOpen) && contexts.length === beforePolyContexts + 1],
        ['staggered groups retain distinct Attack histories', staggeredVoices.filter(voice => voice.midi < 56).every(voice => voice.envelope > 0.3) && staggeredVoices.filter(voice => voice.midi >= 56).every(voice => voice.envelope < 0.2)],
        ['all sixteen real fundamentals are present', polyPeaks.every(value => Math.abs(value.hz - frequency(value.midi)) <= polyData.binWidth && value.db > -70)],
        ['identical recipes reuse one native PeriodicWave across voices', polyContext.periodicWaves.length === 1],
      ])
      const polyInstances = active(poly).map(voice => voice.instanceId)
      poly.noteOffVoice('A:1:51')
      await sleep(60)
      updatePoly({ additive: config({ 1: 100, 2: 20, 3: 10 }) })
      await sleep(120)
      const releaseVoice = active(poly).find(voice => voice.midi === 51)
      check('Live coefficients preserve each Additive ADSR history', { voices: active(poly) }, [
        ['released note continues Release while other fifteen sustain', releaseVoice?.phase === 'release' && active(poly).filter(voice => voice.midi !== 51).every(voice => voice.gateOpen && voice.phase === 'sustain')],
        ['coefficient edits preserve all original instances', active(poly).every(voice => polyInstances.includes(voice.instanceId))],
      ])
      let maxCarriers = 0
      let maxCache = 0
      for (let index = 0; index < 100; index++) {
        updatePoly({ mode: index % 11 === 0 ? 'classic' : 'additive', additive: config({ 1: 100, 2: index, 3: 100 - index }) })
        const diagnostics = poly.getDiagnostics()
        maxCarriers = Math.max(maxCarriers, diagnostics.totalCarrierCount)
        maxCache = Math.max(maxCache, diagnostics.periodicWaveCacheSize)
        await sleep(3)
      }
      updatePoly({ mode: 'additive', additive: config({ 1: 100, 2: 25 }) })
      await sleep(450)
      check('Rapid harmonic and mode edits keep the polyphonic graph bounded', { maxCarriers, maxCache, diagnostics: poly.getDiagnostics() }, [
        ['no voice ever requires more than two crossfade carriers', maxCarriers <= 32],
        ['coalesced edits leave exactly one carrier per surviving voice', poly.getDiagnostics().totalCarrierCount === 15 && active(poly).every(voice => voice.carrierCount === 1)],
        ['PeriodicWave cache never exceeds its declared limit', maxCache <= 64 && poly.getDiagnostics().periodicWaveCacheSize <= 64],
        ['rapid edits never replace surviving voice histories', active(poly).every(voice => polyInstances.includes(voice.instanceId) && voice.gateOpen)],
      ])
      poly.panic()
      await sleep(100)
      check('Additive Panic clears every voice and actual output', { state: poly.getState(), diagnostics: poly.getDiagnostics(), rms: analyse(poly).rms }, [
        ['all carrier nodes and pending notes are gone', poly.getDiagnostics().totalCarrierCount === 0 && poly.getState().pendingCount === 0 && poly.getVoices().length === 0],
        ['real output reaches silence promptly', analyse(poly).rms < 0.000001],
      ])
      await poly.dispose()
      check('Additive dispose releases context and PeriodicWave cache', { state: poly.getState(), diagnostics: poly.getDiagnostics() }, [
        ['closed engine exposes no audio graph or cached wave', poly.getState().contextState === 'closed' && poly.getAnalysis() === null && poly.getDiagnostics().periodicWaveCacheSize === 0],
      ])

      const { engine: bent, update: updateBent } = create({ additive: config({ 1: 100, 2: 50, 3: 30 }), amplitude: 0.12 })
      await Promise.all([48, 55, 60].map(midi => bent.noteOnVoice(note(midi))))
      await bent.noteOnVoice(note(76, { id: 'B:2:76', sourceId: 'B', channel: 2 }))
      await settle(bent)
      const bentInstances = active(bent).map(voice => voice.instanceId)
      const startsBeforeBend = contexts.at(-1).oscillatorStarts
      bent.setSourcePitchBend('A', 1, 2)
      const bentData = await settle(bent)
      const bentComponents = [48, 55, 60].flatMap(midi => [1, 2, 3].map(harmonic => ({ midi, harmonic, expected: frequency(midi) * 2 ** (2 / 12) * harmonic, ...peak(bentData, frequency(midi) * 2 ** (2 / 12) * harmonic) })))
      check('Pitch Bend moves every harmonic of all scoped Additive voices', { components: bentComponents, voices: active(bent) }, [
        ['all nine bent harmonic peaks are present in native spectrum', bentComponents.every(value => Math.abs(value.hz - value.expected) <= bentData.binWidth && value.db > -75)],
        ['other source and channel remain centered', active(bent).find(voice => voice.id === 'B:2:76')?.pitchBend === 0 && peak(bentData, frequency(76)).db > -65],
        ['bend adds no oscillator and keeps all ADSR histories', contexts.at(-1).oscillatorStarts === startsBeforeBend && active(bent).every(voice => bentInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
      ])
      updateBent({ lfo: { enabled: true, rate: 2, depth: 1, target: 'pitch' } })
      setupAnalysis(bent, 2048, 4096)
      await sleep(130)
      const vibratoPeaks = []
      const bentCenter = frequency(60) * 2 ** (2 / 12)
      for (let index = 0; index < 20; index++) { vibratoPeaks.push(peak(analyse(bent), bentCenter, bentCenter * 0.08).hz); await sleep(45) }
      check('Pitch LFO adds to scoped bend with native Additive carriers', { minHz: Math.min(...vibratoPeaks), maxHz: Math.max(...vibratoPeaks), center: bentCenter }, [
        ['actual fundamental moves across its bent center', Math.min(...vibratoPeaks) < bentCenter && Math.max(...vibratoPeaks) > bentCenter && Math.max(...vibratoPeaks) - Math.min(...vibratoPeaks) > 12],
        ['voice base frequencies and bend remain unchanged', active(bent).filter(voice => voice.sourceId === 'A').every(voice => voice.pitchBend === 2 && voice.frequency === frequency(voice.midi))],
      ])
      updateBent({ lfo: { enabled: false, rate: 2, depth: 0, target: 'pitch' }, filter: { cutoff: 250, q: 0.707, bypass: false } })
      const filtered = await settle(bent)
      updateBent({ filter: { cutoff: 250, q: 0.707, bypass: true } })
      const unfiltered = await settle(bent)
      check('Shared low-pass processes the Additive mixed spectrum', { filteredHighHarmonic: peak(filtered, frequency(60) * 2 ** (2 / 12) * 3).db, bypassHighHarmonic: peak(unfiltered, frequency(60) * 2 ** (2 / 12) * 3).db }, [
        ['filter attenuates a real upper harmonic by at least fifteen dB', peak(unfiltered, frequency(60) * 2 ** (2 / 12) * 3).db - peak(filtered, frequency(60) * 2 ** (2 / 12) * 3).db > 15],
      ])
      await close(bent)

      const { engine: alias, update: updateAlias } = create({ additive: config({ 1: 100, 5: 100 }) })
      await alias.noteOnVoice(note(null, { id: 'high:6000', midi: null, frequency: 6000, origin: 'local', sourceId: 'local', channel: null }))
      const aliasData = await settle(alias)
      check('Harmonics above Nyquist do not fold into artificial output peaks', { sampleRate: aliasData.sampleRate, fundamental: peak(aliasData, 6000), foldedFifth: peak(aliasData, 18000) }, [
        ['six-kilohertz fundamental remains audible', peak(aliasData, 6000).db > -55],
        ['thirty-kilohertz fifth harmonic does not alias to eighteen kilohertz', peak(aliasData, 18000).db - peak(aliasData, 6000).db < -45],
      ])
      updateAlias({ additive: config({ 1: 100, 2: 50, 3: 50 }) })
      alias.noteOffVoice('high:6000', true)
      await sleep(60)
      await alias.noteOnVoice(note(null, { id: 'high:9000', midi: null, frequency: 9000, origin: 'local', sourceId: 'local', channel: null }))
      const upperAlias = await settle(alias)
      check('In-range high harmonic survives while the next out-of-range harmonic is removed', { fundamental: peak(upperAlias, 9000), validSecond: peak(upperAlias, 18000), foldedThird: peak(upperAlias, 21000) }, [
        ['valid eighteen-kilohertz second harmonic remains present', peak(upperAlias, 18000).db - peak(upperAlias, 9000).db > -12],
        ['twenty-seven-kilohertz third harmonic does not fold to twenty-one kilohertz', peak(upperAlias, 21000).db - peak(upperAlias, 9000).db < -45],
      ])
      await close(alias)

      const { engine: cache, update: updateCache } = create()
      await cache.noteOnVoice(note())
      setupAnalysis(cache)
      await sleep(80)
      const cacheContext = contexts.at(-1)
      updateCache({ additive: config({ 1: 100, 2: 25 }) })
      await sleep(65)
      const buildsAfterRecipe = cache.getDiagnostics().periodicWaveBuildCount
      updateCache({ additive: config({ 1: 100 }) })
      await sleep(65)
      updateCache({ additive: config({ 1: 100, 2: 25 }) })
      await sleep(65)
      const buildsAfterReuse = cache.getDiagnostics().periodicWaveBuildCount
      const equivalent = config({ 1: 100, 2: 25, 16: 75 })
      equivalent.enabled[15] = false
      updateCache({ additive: equivalent })
      await sleep(65)
      check('PeriodicWave cache reuses effective recipes across edits', { buildsAfterRecipe, buildsAfterReuse, diagnostics: cache.getDiagnostics(), nativeBuilds: cacheContext.periodicWaves.length }, [
        ['returning to an existing recipe builds no new native wave', buildsAfterReuse === buildsAfterRecipe],
        ['disabled level changes share the same effective coefficient key', cache.getDiagnostics().periodicWaveBuildCount === buildsAfterReuse],
        ['instrumented native builds agree with cache diagnostics', cacheContext.periodicWaves.length === cache.getDiagnostics().periodicWaveBuildCount],
      ])
      for (let level = 1; level <= 75; level++) { updateCache({ additive: config({ 1: 100, 2: level }) }); await sleep(42) }
      await sleep(70)
      check('PeriodicWave cache evicts old recipes at a fixed sixty-four entry limit', { diagnostics: cache.getDiagnostics(), nativeBuilds: cacheContext.periodicWaves.length }, [
        ['more than sixty-four distinct native recipes were exercised', cache.getDiagnostics().periodicWaveBuildCount > 64],
        ['live cache remains capped at sixty-four', cache.getDiagnostics().periodicWaveCacheSize === 64 && cache.getDiagnostics().periodicWaveCacheLimit === 64],
        ['cache eviction does not leak carriers or replace voice identity', cache.getDiagnostics().totalCarrierCount === 1 && active(cache).length === 1 && active(cache)[0].instanceId === 1],
      ])
      await close(cache)

      class DeferredAudioContext extends RecordedAudioContext {
        holdResume = true
        get state() { return this.holdResume ? 'suspended' : super.state }
        async resume() { await sleep(90); this.holdResume = false; if (super.state !== 'closed') await super.resume() }
      }
      window.AudioContext = DeferredAudioContext
      const { engine: pending, update: updatePending } = create()
      const canceled = pending.noteOnVoice(note(60))
      const retained = pending.noteOnVoice(note(64))
      pending.noteOffVoice('A:1:60')
      updatePending({ additive: config({ 1: 100, 3: 40 }) })
      await Promise.all([canceled, retained])
      const pendingData = await settle(pending)
      check('Delayed resume uses current harmonic recipe and honors canceled voices', { state: pending.getState(), diagnostics: pending.getDiagnostics(), ratios: harmonicRatios(pendingData, frequency(64), 3) }, [
        ['canceled note never resurrects while retained note starts once', active(pending).length === 1 && active(pending)[0].midi === 64 && pending.getState().pendingCount === 0],
        ['retained voice renders latest H3 recipe after resume', Math.abs(component(pendingData, frequency(64) * 3) / component(pendingData, frequency(64)) - 0.4) < 0.025],
      ])
      await close(pending)
      const { engine: pendingDispose } = create({ additive: config({ 1: 100, 2: 50 }) })
      const pendingDisposalNotes = [60, 64, 67].map(midi => pendingDispose.noteOnVoice(note(midi)))
      await pendingDispose.dispose()
      await Promise.all(pendingDisposalNotes)
      check('Dispose cancels pending Additive voices and native wave allocation', { state: pendingDispose.getState(), diagnostics: pendingDispose.getDiagnostics() }, [
        ['closed engine retains no pending or active voice', pendingDispose.getState().contextState === 'closed' && pendingDispose.getState().pendingCount === 0 && pendingDispose.getDiagnostics().totalCarrierCount === 0],
        ['PeriodicWave cache and analyser are released', pendingDispose.getDiagnostics().periodicWaveCacheSize === 0 && pendingDispose.getAnalysis() === null],
      ])
      return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
    } finally {
      window.AudioContext = NativeAudioContext
      await Promise.all(engines.map(engine => engine.dispose()))
    }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../test-results/additive-audio-${browserName}.json`, import.meta.url), JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Additive native Web Audio tests failed')
  console.log(`PASS: ${report.results.length} additive audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally {
  await session.close()
}
