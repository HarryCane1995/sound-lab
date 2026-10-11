import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const browserName = /msedge/i.test(process.env.SOUND_LAB_BROWSER || '') ? 'edge' : 'chrome'
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const frequency = midi => 440 * 2 ** ((midi - 69) / 12)
    const results = []
    const check = (name, metrics, assertions) => {
      results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    }
    const makeNote = (midi, options = {}) => ({ id: `A:1:${midi}`, midi, frequency: frequency(midi), velocity: 127, sourceId: 'A', sourceName: 'Simulated MIDI A', channel: 1, origin: 'midi', ...options })
    const NativeAudioContext = window.AudioContext
    const contexts = []
    const gainOutputs = new WeakMap()
    class RecordedAudioContext extends NativeAudioContext {
      oscillators = []
      starts = 0
      constructor(options) { super(options); contexts.push(this) }
      createGain() {
        const gain = super.createGain()
        const nativeConnect = gain.connect.bind(gain)
        gain.connect = (destination, ...args) => { gainOutputs.set(gain, destination); return nativeConnect(destination, ...args) }
        return gain
      }
      createOscillator() {
        const oscillator = super.createOscillator()
        const record = { oscillator, ended: false, disconnected: false, destination: null, stoppedVoiceLevels: [] }
        this.oscillators.push(record)
        oscillator.addEventListener('ended', () => { record.ended = true })
        const nativeStart = oscillator.start.bind(oscillator)
        oscillator.start = (...args) => { this.starts++; nativeStart(...args) }
        const nativeConnect = oscillator.connect.bind(oscillator)
        oscillator.connect = (destination, ...args) => { record.destination = destination; return nativeConnect(destination, ...args) }
        const nativeStop = oscillator.stop.bind(oscillator)
        oscillator.stop = (...args) => {
          if ((args[0] ?? 0) <= this.currentTime + 0.00001) {
            const carrier = record.destination
            const envelope = gainOutputs.get(carrier)
            const velocity = gainOutputs.get(envelope)
            if (carrier instanceof GainNode && envelope instanceof GainNode && velocity instanceof GainNode) {
              record.stoppedVoiceLevels.push(Math.abs(carrier.gain.value * envelope.gain.value * velocity.gain.value))
            }
          }
          return nativeStop(...args)
        }
        const nativeDisconnect = oscillator.disconnect.bind(oscillator)
        oscillator.disconnect = (...args) => { record.disconnected = true; return nativeDisconnect(...args) }
        return oscillator
      }
    }
    window.AudioContext = RecordedAudioContext
    const engines = []
    const create = (changes = {}) => {
      const params = {
        ...copyParams(DEFAULT_PARAMS), frequency: 220, amplitude: 0.3,
        adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.18 },
        filter: { cutoff: 8000, q: 0.707, bypass: true },
        lfo: { enabled: false, rate: 3, depth: 0, target: 'pitch' }, ...changes,
      }
      const engine = new SynthEngine(params)
      engines.push(engine)
      return { engine, update: patch => { Object.assign(params, patch); engine.setParams(params) }, params }
    }
    const analyse = engine => {
      const analysis = engine.getAnalysis()
      if (!analysis) return { rms: 0, peak: 0, bins: new Float32Array(), binWidth: 1 }
      analysis.time.fftSize = 2048
      analysis.frequency.fftSize = 16384
      analysis.frequency.smoothingTimeConstant = 0
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      const bins = new Float32Array(analysis.frequency.frequencyBinCount)
      analysis.frequency.getFloatFrequencyData(bins)
      return {
        rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length),
        peak: Math.max(...samples.map(value => Math.abs(value))), bins,
        binWidth: analysis.sampleRate / analysis.frequency.fftSize,
      }
    }
    const near = (data, hz, radius = data.binWidth * 2) => {
      let index = Math.max(1, Math.floor((hz - radius) / data.binWidth))
      let db = -Infinity
      for (let i = index; i <= Math.min(data.bins.length - 1, Math.ceil((hz + radius) / data.binWidth)); i++) {
        if (data.bins[i] > db) { db = data.bins[i]; index = i }
      }
      return { hz: index * data.binWidth, db }
    }
    // Integrating nearby FFT bins avoids mistaking window scalloping for a
    // velocity change. All bins come from the native post-mix analyser.
    const component = (data, hz) => {
      let energy = 0
      for (let i = Math.max(1, Math.round(hz / data.binWidth) - 3); i <= Math.min(data.bins.length - 1, Math.round(hz / data.binWidth) + 3); i++) energy += 10 ** (data.bins[i] / 10)
      return Math.sqrt(energy)
    }
    const bandDb = (data, low, high) => {
      let power = 0
      for (let i = Math.ceil(low / data.binWidth); i <= Math.min(data.bins.length - 1, Math.floor(high / data.binWidth)); i++) power += 10 ** (data.bins[i] / 10)
      return 10 * Math.log10(Math.max(1e-20, power))
    }
    const active = engine => engine.getVoices().filter(voice => !voice.retiring)
    const ids = engine => active(engine).filter(voice => voice.gateOpen).map(voice => voice.id).sort()
    const close = async engine => { await engine.dispose(); await sleep(25) }
    try {
      const { engine: lazy } = create()
      const initialContexts = contexts.length
      await lazy.noteOnVoice(makeNote(60, { velocity: 0 }))
      lazy.noteOffVoice('nonexistent')
      check('Polyphonic voices keep audio lazy', { state: lazy.getState(), contexts: contexts.length }, [
        ['velocity zero and unknown Note Off allocate no context', contexts.length === initialContexts && lazy.getAnalysis() === null],
        ['no pending or held voice is created', lazy.getState().pendingCount === 0 && lazy.getState().voiceCount === 0],
      ])
      await close(lazy)

      const { engine: chord, update: updateChord } = create()
      const contextBeforeChord = contexts.length
      await Promise.all([60, 64, 67].map(midi => chord.noteOnVoice(makeNote(midi))))
      analyse(chord) // Resize the native FFT before accumulating its full window.
      await sleep(410)
      const chordContext = contexts.at(-1)
      const chordVoices = active(chord)
      const chordData = analyse(chord)
      const triadPeaks = [60, 64, 67].map(midi => ({ midi, expected: frequency(midi), ...near(chordData, frequency(midi)) }))
      check('C4 E4 G4 coexist in native output spectrum', { state: chord.getState(), peaks: triadPeaks, rms: chordData.rms }, [
        ['all three independently gated voices exist', chordVoices.length === 3 && chordVoices.every(voice => voice.gateOpen)],
        ['three measured fundamentals match their MIDI notes', triadPeaks.every(peak => Math.abs(peak.hz - peak.expected) <= chordData.binWidth && peak.db > -55)],
        ['one shared native AudioContext serves the chord', contexts.length === contextBeforeChord + 1 && chordContext.state === 'running'],
      ])
      updateChord({ frequency: 777, amplitude: 0.25 })
      await sleep(120)
      check('Manual frequency does not retune held keys', { voices: active(chord) }, [
        ['each keyboard voice retains its original base frequency', active(chord).every(voice => Math.abs(voice.frequency - frequency(voice.midi)) < 1e-6)],
        ['global edits preserve voice instances', active(chord).every(voice => chordVoices.some(before => before.instanceId === voice.instanceId))],
      ])
      updateChord({ amplitude: 0.3 })
      // The FFT integrates 341 ms; let the amplitude edit leave that window
      // completely before comparing an unchanged voice across Note Off.
      await sleep(430)
      const beforeRelease = analyse(chord)
      chord.noteOffVoice('A:1:64')
      const duringRelease = active(chord)
      await sleep(450)
      const afterRelease = analyse(chord)
      check('Releasing E4 leaves C4 and G4 sounding', { duringRelease, after: chord.getState(), beforeLevels: [60, 64, 67].map(midi => component(beforeRelease, frequency(midi))), afterLevels: [60, 64, 67].map(midi => component(afterRelease, frequency(midi))) }, [
        ['only E4 enters its independent Release', duringRelease.find(voice => voice.midi === 64)?.phase === 'release' && duringRelease.filter(voice => voice.midi !== 64).every(voice => voice.gateOpen)],
        ['E4 output decays by at least 40 dB', near(afterRelease, frequency(64)).db < near(beforeRelease, frequency(64)).db - 40],
        ['C4 and G4 output levels remain stable', [60, 67].every(midi => Math.abs(20 * Math.log10(component(afterRelease, frequency(midi)) / component(beforeRelease, frequency(midi)))) < 1)],
        ['C4 and G4 envelopes are not restarted', active(chord).every(voice => voice.instanceId === chordVoices.find(original => original.id === voice.id)?.instanceId && voice.phase === 'sustain')],
      ])
      const startsBeforeDuplicate = chordContext.starts
      const duplicateInstance = active(chord).find(voice => voice.midi === 60)?.instanceId
      await chord.noteOnVoice(makeNote(60, { velocity: 20 }))
      check('Duplicate gated Note On is idempotent', { voices: active(chord), starts: chordContext.starts }, [
        ['a duplicate creates no oscillator or voice', active(chord).length === 2 && chordContext.starts === startsBeforeDuplicate],
        ['duplicate preserves original instance envelope and velocity', active(chord).find(voice => voice.midi === 60)?.instanceId === duplicateInstance && active(chord).find(voice => voice.midi === 60)?.velocity === 127],
      ])
      chord.noteOffVoice('A:1:60')
      chord.noteOffVoice('A:1:60')
      const releasingInstance = active(chord).find(voice => voice.midi === 60)?.instanceId
      await chord.noteOnVoice(makeNote(60, { velocity: 64 }))
      const repeatedVoices = active(chord).filter(voice => voice.midi === 60)
      check('Repressing a released identity creates an independent attack', { voices: repeatedVoices, state: chord.getState() }, [
        ['old Release overlaps the new gated instance', repeatedVoices.length === 2 && repeatedVoices.some(voice => voice.instanceId === releasingInstance && !voice.gateOpen) && repeatedVoices.some(voice => voice.instanceId !== releasingInstance && voice.gateOpen)],
        ['an unrelated held note remains gated', active(chord).find(voice => voice.midi === 67)?.gateOpen],
      ])
      await close(chord)

      const { engine: stagger, update: updateStagger } = create({ adsr: { attack: 0.35, decay: 0.1, sustain: 0.6, release: 0.35 } })
      await stagger.noteOnVoice(makeNote(60))
      analyse(stagger)
      await sleep(260)
      await stagger.noteOnVoice(makeNote(64))
      await sleep(70)
      const independentAttacks = active(stagger)
      check('Staggered notes have independent Attack histories', { voices: independentAttacks }, [
        ['first envelope is substantially ahead of second', independentAttacks.find(voice => voice.midi === 60).envelope > independentAttacks.find(voice => voice.midi === 64).envelope + 0.35],
        ['second note is in Attack without restarting first', independentAttacks.find(voice => voice.midi === 64).phase === 'attack' && independentAttacks.find(voice => voice.midi === 60).createdAt < independentAttacks.find(voice => voice.midi === 64).createdAt],
      ])
      // Both voices must occupy a full FFT window at Sustain; otherwise the
      // reference also includes the louder Decay and overstates its level.
      await sleep(850)
      const attackData = analyse(stagger)
      stagger.noteOffVoice('A:1:60')
      await sleep(100)
      await stagger.noteOnVoice(makeNote(67))
      await sleep(80)
      const independentPhases = active(stagger)
      check('Release Sustain and Attack coexist', { voices: independentPhases, spectrumRms: analyse(stagger).rms }, [
        ['C4 releases while E4 sustains and G4 attacks', independentPhases.find(voice => voice.midi === 60).phase === 'release' && independentPhases.find(voice => voice.midi === 64).phase === 'sustain' && independentPhases.find(voice => voice.midi === 67).phase === 'attack'],
        ['unreleased E4 retains actual output energy', Math.abs(20 * Math.log10(component(analyse(stagger), frequency(64)) / component(attackData, frequency(64)))) < 1.5],
      ])
      const beforeAdsrChange = active(stagger).map(voice => voice.instanceId)
      updateStagger({ adsr: { attack: 0.15, decay: 0.1, sustain: 0.3, release: 0.22 } })
      await sleep(300)
      check('Live ADSR changes preserve voice histories', { voices: active(stagger) }, [
        ['active voices retain their instance identities', active(stagger).every(voice => beforeAdsrChange.includes(voice.instanceId))],
        ['held voices reach the new sustain without retrigger', active(stagger).filter(voice => voice.gateOpen).every(voice => Math.abs(voice.envelope - 0.3) < 0.015)],
      ])
      stagger.releaseVoices({})
      const overlappingRelease = active(stagger)
      await sleep(420)
      check('Multiple Releases overlap and clean themselves up', { during: overlappingRelease, after: stagger.getDiagnostics(), rms: analyse(stagger).rms }, [
        ['both held notes enter Release simultaneously', overlappingRelease.length >= 2 && overlappingRelease.every(voice => !voice.gateOpen && voice.phase === 'release')],
        ['finished Releases remove carriers and become silent', stagger.getState().voiceCount === 0 && stagger.getDiagnostics().carrierCount === 0 && analyse(stagger).rms < 0.00001],
      ])
      await close(stagger)

      const { engine: velocities } = create({ amplitude: 0.18 })
      await Promise.all([[60, 120], [64, 70], [67, 35]].map(([midi, velocity]) => velocities.noteOnVoice(makeNote(midi, { velocity }))))
      analyse(velocities)
      await sleep(430)
      const velocityData = analyse(velocities)
      const velocityLevels = [60, 64, 67].map(midi => component(velocityData, frequency(midi)))
      check('Per-voice velocity changes actual chord balance', { levels: velocityLevels, ratios: [velocityLevels[1] / velocityLevels[0], velocityLevels[2] / velocityLevels[0]], voices: active(velocities) }, [
        ['E4 follows its own 70/120 velocity ratio', Math.abs(velocityLevels[1] / velocityLevels[0] - 70 / 120) < 0.035],
        ['G4 follows its own 35/120 velocity ratio', Math.abs(velocityLevels[2] / velocityLevels[0] - 35 / 120) < 0.035],
        ['all notes retain full independent sustain envelopes', active(velocities).every(voice => Math.abs(voice.envelope - 1) < 0.001)],
      ])
      await velocities.noteOnVoice(makeNote(64, { velocity: 0 }))
      await sleep(450)
      const afterVelocityZero = analyse(velocities)
      check('Velocity zero releases only its own note', { voices: active(velocities), state: velocities.getState() }, [
        ['only E4 is removed', JSON.stringify(ids(velocities)) === JSON.stringify(['A:1:60', 'A:1:67'])],
        ['C4 and G4 retain their signal levels', [60, 67].every(midi => Math.abs(20 * Math.log10(component(afterVelocityZero, frequency(midi)) / component(velocityData, frequency(midi)))) < 1)],
      ])
      await close(velocities)

      const { engine: bend } = create({ amplitude: 0.15 })
      const bendNotes = [60, 64, 67].map(midi => makeNote(midi)).concat([
        makeNote(75, { id: 'A:2:75', channel: 2 }),
        makeNote(81, { id: 'B:1:81', sourceId: 'B', sourceName: 'Simulated MIDI B' }),
        makeNote(84, { id: 'pc:84', sourceId: 'local', sourceName: 'PC keyboard', channel: null, origin: 'local' }),
      ])
      await Promise.all(bendNotes.map(note => bend.noteOnVoice(note)))
      analyse(bend)
      await sleep(380)
      const bendInstances = active(bend).map(voice => voice.instanceId)
      const bendContext = contexts.at(-1)
      const startsBeforeBend = bendContext.starts
      bend.setSourcePitchBend('A', 1, 2)
      await sleep(430)
      const bentSpectrum = analyse(bend)
      const bendMeasurements = bendNotes.map(note => ({ id: note.id, expected: note.frequency * 2 ** ((note.sourceId === 'A' && note.channel === 1 ? 2 : 0) / 12), peak: near(bentSpectrum, note.frequency * 2 ** ((note.sourceId === 'A' && note.channel === 1 ? 2 : 0) / 12)) }))
      check('Pitch Bend affects every voice in exactly one source and channel', { voices: active(bend), measured: bendMeasurements }, [
        ['whole A channel 1 chord inherits two semitones', active(bend).filter(voice => voice.sourceId === 'A' && voice.channel === 1).every(voice => voice.pitchBend === 2)],
        ['other source channel and local voices stay centered', active(bend).filter(voice => voice.sourceId !== 'A' || voice.channel !== 1).every(voice => voice.pitchBend === 0)],
        ['native output contains all six expected pitches', bendMeasurements.every(value => Math.abs(value.peak.hz - value.expected) <= bentSpectrum.binWidth && value.peak.db > -60)],
        ['bend creates no voice oscillator or ADSR retrigger', bendContext.starts === startsBeforeBend && active(bend).every(voice => bendInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
      ])
      await bend.noteOnVoice(makeNote(55))
      await sleep(130)
      bend.noteOffVoice('A:1:60')
      bend.setSourcePitchBend('A', 1, -2)
      check('New notes and Release tails share scoped bend state', { voices: active(bend) }, [
        ['new A channel 1 note inherits stored bend', active(bend).find(voice => voice.midi === 55)?.pitchBend === -2],
        ['releasing A channel 1 voice updates along with chord', active(bend).find(voice => voice.midi === 60)?.phase === 'release' && active(bend).find(voice => voice.midi === 60)?.pitchBend === -2],
      ])
      bend.setSourcePitchBend('A', 1, 0)
      await sleep(120)
      check('Pitch Bend center restores all scoped voices', { voices: active(bend) }, [
        ['all retained base frequencies and detunes are restored', active(bend).every(voice => voice.pitchBend === 0 && voice.frequency === frequency(voice.midi))],
      ])
      await close(bend)

      const { engine: modulated, update: updateModulated } = create({ amplitude: 0.2 })
      await Promise.all([48, 60, 72].map(midi => modulated.noteOnVoice(makeNote(midi))))
      analyse(modulated)
      modulated.setSourcePitchBend('A', 1, 2)
      updateModulated({ lfo: { enabled: true, rate: 2, depth: 1, target: 'pitch' } })
      await sleep(250)
      const lfoInstances = active(modulated).map(voice => voice.instanceId)
      modulated.getAnalysis().frequency.fftSize = 4096 // Short window follows actual vibrato movement.
      await sleep(120)
      const pitchTracks = [[], [], []]
      for (let sample = 0; sample < 22; sample++) {
        const analysis = modulated.getAnalysis()
        analysis.frequency.fftSize = 4096
        analysis.frequency.smoothingTimeConstant = 0
        const bins = new Float32Array(analysis.frequency.frequencyBinCount)
        analysis.frequency.getFloatFrequencyData(bins)
        const data = { bins, binWidth: analysis.sampleRate / analysis.frequency.fftSize }
        for (const [index, midi] of [48, 60, 72].entries()) {
          const center = frequency(midi) * 2 ** (2 / 12)
          pitchTracks[index].push(near(data, center, center * 0.09).hz)
        }
        await sleep(45)
      }
      check('Pitch LFO adds to scoped bend across a chord', { tracks: pitchTracks, voices: active(modulated) }, [
        ['each actual frequency moves on both sides of its bent center', pitchTracks.every((track, index) => { const center = frequency([48, 60, 72][index]) * 2 ** (2 / 12); return Math.min(...track) < center && Math.max(...track) > center && Math.max(...track) - Math.min(...track) > center * 0.05 })],
        ['LFO and bend preserve all voice envelopes', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.pitchBend === 2 && voice.phase === 'sustain')],
      ])
      updateModulated({ lfo: { enabled: false, rate: 2, depth: 0, target: 'pitch' } })
      modulated.setSourcePitchBend('A', 1, 0)
      await sleep(180)
      let maxWaveCarriers = 0
      for (let index = 0; index < 40; index++) {
        updateModulated({ waveform: ['sine', 'square', 'sawtooth', 'triangle'][index % 4] })
        maxWaveCarriers = Math.max(maxWaveCarriers, modulated.getDiagnostics().totalCarrierCount)
        await sleep(3)
      }
      updateModulated({ waveform: 'sawtooth' })
      await sleep(430)
      const waveDiagnostics = modulated.getDiagnostics()
      const waveData = analyse(modulated)
      check('Live chord waveform crossfades remain bounded and clean', { maxWaveCarriers, diagnostics: waveDiagnostics, highBandDb: bandDb(waveData, 1000, 7000) }, [
        ['each of three voices uses at most two carriers during crossfade', maxWaveCarriers <= 6],
        ['all retired carriers are cleaned after crossfade', waveDiagnostics.totalCarrierCount === 3 && active(modulated).every(voice => voice.carrierCount === 1)],
        ['voice identities and envelopes survive waveform replacement', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
        ['final sawtooth harmonics are present in native spectrum', bandDb(waveData, 1000, 7000) > -55],
      ])
      updateModulated({ filter: { cutoff: 300, q: 0.707, bypass: false } })
      await sleep(430)
      const filteredData = analyse(modulated)
      updateModulated({ filter: { cutoff: 900, q: 0.707, bypass: false }, lfo: { enabled: true, rate: 2, depth: 1, target: 'filter' } })
      const filterBands = []
      for (let index = 0; index < 12; index++) { await sleep(75); filterBands.push(bandDb(analyse(modulated), 1800, 7000)) }
      check('Shared filter and filter LFO process the real chord mix', { bypassHighBand: bandDb(waveData, 1000, 7000), filteredHighBand: bandDb(filteredData, 1000, 7000), filterBands }, [
        ['low-pass reduces real mixed high-frequency energy', bandDb(waveData, 1000, 7000) - bandDb(filteredData, 1000, 7000) > 15],
        ['filter LFO measurably changes mixed harmonic output', Math.max(...filterBands) - Math.min(...filterBands) > 5],
        ['shared processing neither replaces nor retunes voices', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.frequency === frequency(voice.midi))],
      ])
      await close(modulated)

      const { engine: limits } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 2 } })
      for (let midi = 40; midi < 56; midi++) { await limits.noteOnVoice(makeNote(midi)); await sleep(2) }
      const fullVoices = active(limits)
      check('Sixteen independently held voices fit the declared limit', { state: limits.getState(), diagnostics: limits.getDiagnostics() }, [
        ['all sixteen managed voices are gated', fullVoices.length === 16 && limits.getState().voiceCount === 16 && limits.getState().heldCount === 16],
        ['sixteen voices share one carrier each at steady state', limits.getDiagnostics().totalCarrierCount === 16],
      ])
      limits.noteOffVoice('A:1:50')
      await limits.noteOnVoice(makeNote(56))
      const releaseFirst = limits.getVoices()
      check('Voice stealing prefers a Release before an older held note', { voices: releaseFirst, state: limits.getState() }, [
        ['released voice leaves managed pool first', !active(limits).some(voice => voice.id === 'A:1:50') && active(limits).some(voice => voice.id === 'A:1:40')],
        ['new note starts within the sixteen-voice managed pool', active(limits).length === 16 && active(limits).some(voice => voice.id === 'A:1:56' && voice.gateOpen)],
        ['stolen Release has only a bounded short fade tail', releaseFirst.filter(voice => voice.retiring).length <= 4],
      ])
      await sleep(65)
      await limits.noteOnVoice(makeNote(57))
      const oldestFirst = active(limits)
      limits.noteOffVoice('A:1:40')
      check('At capacity the oldest held voice is stolen safely', { voices: oldestFirst, state: limits.getState() }, [
        ['oldest held identity leaves managed pool', !oldestFirst.some(voice => voice.id === 'A:1:40') && oldestFirst.some(voice => voice.id === 'A:1:41')],
        ['Note Off of stolen identity cannot release a replacement', active(limits).find(voice => voice.id === 'A:1:57')?.gateOpen && limits.getState().heldCount === 16],
      ])
      let maximumManaged = 0
      let maximumRetiring = 0
      let maximumCarriers = 0
      for (let index = 0; index < 85; index++) {
        const midi = 36 + index % 60
        await limits.noteOnVoice(makeNote(midi, { id: `burst:${index}` }))
        if (index % 2 === 0) limits.noteOffVoice(`burst:${index}`)
        const diagnostics = limits.getDiagnostics()
        maximumManaged = Math.max(maximumManaged, limits.getState().voiceCount)
        maximumRetiring = Math.max(maximumRetiring, diagnostics.retiringCount)
        maximumCarriers = Math.max(maximumCarriers, diagnostics.totalCarrierCount)
      }
      check('Rapid long-Release playing cannot accumulate unlimited nodes', { maximumManaged, maximumRetiring, maximumCarriers, diagnostics: limits.getDiagnostics() }, [
        ['managed pool stays at or below sixteen including Release', maximumManaged <= 16],
        ['forced fade tails stay at or below four', maximumRetiring <= 4],
        ['carrier graph remains globally bounded', maximumCarriers <= 40],
      ])
      limits.panic()
      await sleep(110)
      check('Panic smoothly clears a full polyphonic graph', { state: limits.getState(), diagnostics: limits.getDiagnostics(), signal: analyse(limits).rms }, [
        ['Panic closes every gate and cancels pending notes', limits.getState().heldCount === 0 && limits.getState().pendingCount === 0],
        ['all forced fades finish with no surviving carrier', limits.getVoices().length === 0 && limits.getDiagnostics().totalCarrierCount === 0],
        ['actual mixed output becomes silent promptly', analyse(limits).rms < 0.00001],
      ])
      await close(limits)

      const { engine: queued } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 2 } })
      for (let midi = 40; midi < 56; midi++) await queued.noteOnVoice(makeNote(midi))
      await sleep(80)
      const queuedContext = contexts.at(-1)
      const queuedAdmissions = []
      for (let index = 0; index < 24; index++) queuedAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `queued:${index}` })))
      const queuedBeforeOff = queued.getState()
      queued.noteOffVoice('queued:23')
      await Promise.all(queuedAdmissions)
      await sleep(80)
      const stopLevels = queuedContext.oscillators.flatMap(record => record.stoppedVoiceLevels)
      check('Overlapping steals wait for a zero-level tail before destroying a native oscillator', { queuedBeforeOff, diagnostics: queued.getDiagnostics(), stoppedVoiceLevels: stopLevels }, [
        ['overflow admission queues instead of exceeding the bounded tail pool', queuedBeforeOff.pendingCount > 0 && queued.getDiagnostics().retiringCount <= 4 && queued.getState().voiceCount <= 16],
        ['Note Off cancels an admission waiting for a steal slot', !queued.getVoices().some(voice => voice.id === 'queued:23') && queued.getState().pendingCount === 0],
        ['every immediate carrier destruction occurs after its audible gain is zero', stopLevels.length > 0 && stopLevels.every(level => level < 0.0001)],
      ])
      const pendingScopeAdmissions = []
      for (let index = 0; index < 24; index++) pendingScopeAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `scope-queue:${index}`, sourceId: 'C', sourceName: 'Simulated MIDI C', channel: 3 })))
      queued.releaseVoices({ sourceId: 'C', channel: 3 }, true)
      await Promise.all(pendingScopeAdmissions)
      await sleep(80)
      check('Scoped All Sound Off cancels queued steal admissions', { state: queued.getState(), voices: queued.getVoices() }, [
        ['no canceled queued source voice can resurrect', !queued.getVoices().some(voice => voice.sourceId === 'C') && queued.getState().pendingCount === 0],
        ['other source retains held voices', active(queued).some(voice => voice.sourceId === 'A' && voice.gateOpen)],
      ])
      const pendingPanicAdmissions = []
      for (let index = 0; index < 24; index++) pendingPanicAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `panic-queue:${index}` })))
      queued.panic()
      await Promise.all(pendingPanicAdmissions)
      await sleep(100)
      check('Panic cancels queued steals as well as sounding voices', { state: queued.getState(), diagnostics: queued.getDiagnostics() }, [
        ['no queued voice or carrier survives Panic', queued.getState().pendingCount === 0 && queued.getVoices().length === 0 && queued.getDiagnostics().totalCarrierCount === 0],
        ['all destroyed carriers reach a zero voice level first', queuedContext.oscillators.flatMap(record => record.stoppedVoiceLevels).every(level => level < 0.0001)],
      ])
      await close(queued)

      const { engine: headroom } = create({ amplitude: 1 })
      for (let index = 0; index < 16; index++) await headroom.noteOnVoice(makeNote(60, { id: `unison:${index}` }))
      analyse(headroom)
      await sleep(450)
      const headroomSignal = analyse(headroom)
      check('Sixteen full-level unison voices have protected output headroom', { rms: headroomSignal.rms, peak: headroomSignal.peak, state: headroom.getState() }, [
        ['sixteen voices remain genuinely audible', headroom.getState().heldCount === 16 && headroomSignal.rms > 0.015],
        ['native time samples stay below digital full scale', Number.isFinite(headroomSignal.peak) && headroomSignal.peak < 0.995],
      ])
      await close(headroom)

      const { engine: scoped } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.25 } })
      await Promise.all([
        makeNote(60), makeNote(60, { id: 'B:1:60', sourceId: 'B' }),
        makeNote(64, { id: 'A:2:64', channel: 2 }),
        makeNote(67, { id: 'pc:67', sourceId: 'local', channel: null, origin: 'local' }),
      ].map(note => scoped.noteOnVoice(note)))
      analyse(scoped)
      await sleep(120)
      scoped.noteOffVoice('A:1:60')
      check('Equal notes from two sources have independent identities', { voices: active(scoped) }, [
        ['A Note Off releases A without changing B', active(scoped).find(voice => voice.id === 'A:1:60')?.phase === 'release' && active(scoped).find(voice => voice.id === 'B:1:60')?.gateOpen],
      ])
      scoped.releaseVoices({ sourceId: 'A', channel: 2 })
      const allNotesOff = active(scoped)
      check('Scoped All Notes Off uses normal Release', { voices: allNotesOff }, [
        ['only matching held channel enters Release', allNotesOff.find(voice => voice.id === 'A:2:64')?.phase === 'release' && allNotesOff.find(voice => voice.id === 'B:1:60')?.gateOpen && allNotesOff.find(voice => voice.id === 'pc:67')?.gateOpen],
      ])
      await scoped.noteOnVoice(makeNote(65, { id: 'A:2:65', channel: 2 }))
      scoped.releaseVoices({ sourceId: 'A', channel: 2 }, true)
      await sleep(85)
      check('Scoped All Sound Off ends held and Release voices promptly', { voices: scoped.getVoices() }, [
        ['matching channel carriers are removed after short safety fade', !scoped.getVoices().some(voice => voice.sourceId === 'A' && voice.channel === 2)],
        ['other source and local keyboard retain their gates', ids(scoped).includes('B:1:60') && ids(scoped).includes('pc:67')],
      ])
      scoped.releaseVoices({ sourceId: 'B' }, true)
      await sleep(85)
      check('Disconnect cleanup preserves the other sources', { voices: scoped.getVoices(), state: scoped.getState() }, [
        ['all disconnected source voices are gone', !scoped.getVoices().some(voice => voice.sourceId === 'B')],
        ['local keyboard remains sounding independently', active(scoped).find(voice => voice.id === 'pc:67')?.gateOpen && analyse(scoped).rms > 0.003],
      ])
      await scoped.noteOn(220)
      await sleep(80)
      scoped.noteOff()
      await sleep(400)
      check('Audition Stop does not stop keyboard voices', { voices: scoped.getVoices(), state: scoped.getState() }, [
        ['audition has stopped while local key remains gated', !scoped.getState().auditionGateOpen && active(scoped).find(voice => voice.id === 'pc:67')?.gateOpen],
        ['audition Release cleans up independently', !active(scoped).some(voice => voice.origin === 'audition') && scoped.getState().heldCount === 1],
      ])
      await close(scoped)

      const { engine: soak, update: updateSoak } = create({ adsr: { attack: 0.005, decay: 0.01, sustain: 0.7, release: 0.025 } })
      await soak.prepare()
      analyse(soak)
      const soakContext = contexts.at(-1)
      let soakMaximumVoices = 0
      let soakMaximumCarriers = 0
      for (let index = 0; index < 160; index++) {
        const note = makeNote(48 + index % 36, { id: `soak:${index}` })
        await soak.noteOnVoice(note)
        if (index % 13 === 0) updateSoak({ waveform: ['sine', 'square', 'triangle'][index % 3] })
        await sleep(4)
        soak.noteOffVoice(note.id)
        soakMaximumVoices = Math.max(soakMaximumVoices, soak.getState().voiceCount)
        soakMaximumCarriers = Math.max(soakMaximumCarriers, soak.getDiagnostics().totalCarrierCount)
      }
      await sleep(250)
      const soakDiagnostics = soak.getDiagnostics()
      check('Extended repeated playing releases finished voice resources', { soakMaximumVoices, soakMaximumCarriers, diagnostics: soakDiagnostics, nativeOscillatorsCreated: soakContext.oscillators.length, nativeOscillatorsEnded: soakContext.oscillators.filter(record => record.ended).length }, [
        ['series remains within voice and carrier caps', soakMaximumVoices <= 16 && soakMaximumCarriers <= 40],
        ['every completed voice is destroyed', soakDiagnostics.createdVoiceCount >= 160 && soakDiagnostics.createdVoiceCount === soakDiagnostics.destroyedVoiceCount],
        ['empty manager retains no voice carrier', soak.getVoices().length === 0 && soakDiagnostics.totalCarrierCount === 0 && analyse(soak).rms < 0.00001],
        ['all native voice oscillators have ended', soakContext.oscillators.filter(record => !record.ended).length <= 1],
      ])
      await soak.noteOnVoice(makeNote(60))
      await soak.dispose()
      await soak.dispose()
      await soak.noteOnVoice(makeNote(64))
      await sleep(35)
      check('Dispose closes the shared context and all native nodes', { state: soak.getState(), diagnostics: soak.getDiagnostics(), nativeOscillators: soakContext.oscillators.map(record => ({ ended: record.ended, disconnected: record.disconnected })) }, [
        ['disposed context stays closed and no voice can restart', soak.getState().contextState === 'closed' && soak.getState().voiceCount === 0 && soak.getState().pendingCount === 0],
        ['all native oscillators are disconnected', soakContext.oscillators.every(record => record.disconnected)],
        ['disposed engine exposes no analyser', soak.getAnalysis() === null],
      ])

      // These tests defer only native resume completion. Oscillators, routing,
      // context and signal samples remain real Web Audio objects.
      class DeferredAudioContext extends RecordedAudioContext {
        holdResume = true
        resumeCalls = 0
        get state() { return this.holdResume ? 'suspended' : super.state }
        async resume() { this.resumeCalls++; await sleep(100); this.holdResume = false; if (super.state !== 'closed') await super.resume() }
      }
      window.AudioContext = DeferredAudioContext
      const { engine: deferred } = create()
      const pendingC = deferred.noteOnVoice(makeNote(60))
      const pendingE = deferred.noteOnVoice(makeNote(64))
      const pendingG = deferred.noteOnVoice(makeNote(67))
      const deferredContext = contexts.at(-1)
      const pendingDuplicate = deferred.noteOnVoice(makeNote(64))
      deferred.noteOffVoice('A:1:60')
      await Promise.all([pendingC, pendingE, pendingG, pendingDuplicate])
      await sleep(150)
      check('Delayed resume honors per-identity Note Off and deduplicates pending notes', { state: deferred.getState(), voices: deferred.getVoices(), resumeCalls: deferredContext.resumeCalls }, [
        ['released C4 never resurrects after resume', !deferred.getVoices().some(voice => voice.id === 'A:1:60')],
        ['E4 and G4 each start exactly one independent voice', JSON.stringify(ids(deferred)) === JSON.stringify(['A:1:64', 'A:1:67']) && deferred.getState().voiceCount === 2],
        ['simultaneous pending notes share one native resume', deferredContext.resumeCalls === 1 && deferred.getState().pendingCount === 0],
      ])
      await close(deferred)
      const { engine: deferredScoped } = create()
      const pendingScoped = [makeNote(60), makeNote(64, { id: 'A:2:64', channel: 2 }), makeNote(67, { id: 'B:1:67', sourceId: 'B' })].map(note => deferredScoped.noteOnVoice(note))
      deferredScoped.releaseVoices({ sourceId: 'A', channel: 1 }, true)
      await Promise.all(pendingScoped)
      await sleep(100)
      check('Scoped cleanup cancels only matching pending voices', { state: deferredScoped.getState(), voices: deferredScoped.getVoices() }, [
        ['matching pending source/channel stays canceled', !deferredScoped.getVoices().some(voice => voice.id === 'A:1:60')],
        ['other channel and source finish initialization', JSON.stringify(ids(deferredScoped)) === JSON.stringify(['A:2:64', 'B:1:67'])],
      ])
      await close(deferredScoped)
      const { engine: deferredRepress } = create()
      const canceledFirstPress = deferredRepress.noteOnVoice(makeNote(60, { velocity: 120 }))
      deferredRepress.noteOffVoice('A:1:60')
      const replacementPress = deferredRepress.noteOnVoice(makeNote(60, { velocity: 35 }))
      await Promise.all([canceledFirstPress, replacementPress])
      await sleep(120)
      check('Repress during resume replaces only the canceled pending request', { state: deferredRepress.getState(), voices: deferredRepress.getVoices() }, [
        ['exactly the later press starts with its own velocity', active(deferredRepress).length === 1 && active(deferredRepress)[0].id === 'A:1:60' && active(deferredRepress)[0].velocity === 35],
        ['canceled press does not leave a duplicate or pending entry', deferredRepress.getState().pendingCount === 0 && deferredRepress.getDiagnostics().createdVoiceCount === 1],
      ])
      await close(deferredRepress)
      const { engine: deferredPanic } = create()
      const panicPending = [60, 64, 67].map(midi => deferredPanic.noteOnVoice(makeNote(midi)))
      deferredPanic.panic()
      await Promise.all(panicPending)
      await sleep(100)
      check('Panic cancels every pending polyphonic note', { state: deferredPanic.getState(), rms: analyse(deferredPanic).rms }, [
        ['late resume cannot recreate a canceled chord', deferredPanic.getState().voiceCount === 0 && deferredPanic.getState().pendingCount === 0 && deferredPanic.getDiagnostics().totalCarrierCount === 0],
        ['native output stays silent', analyse(deferredPanic).rms < 0.00001],
      ])
      await close(deferredPanic)
      const { engine: deferredDispose } = create()
      const disposalPending = [60, 64, 67].map(midi => deferredDispose.noteOnVoice(makeNote(midi)))
      await deferredDispose.dispose()
      await Promise.all(disposalPending)
      check('Dispose cancels an entire pending chord', { state: deferredDispose.getState(), diagnostics: deferredDispose.getDiagnostics() }, [
        ['context remains closed without pending or active voices', deferredDispose.getState().contextState === 'closed' && deferredDispose.getState().voiceCount === 0 && deferredDispose.getState().pendingCount === 0],
        ['all node references are released', deferredDispose.getDiagnostics().totalCarrierCount === 0 && deferredDispose.getAnalysis() === null],
      ])
      return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
    } finally {
      window.AudioContext = NativeAudioContext
      await Promise.all(engines.map(engine => engine.dispose()))
    }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../test-results/poly-audio-${browserName}.json`, import.meta.url), JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Polyphonic native Web Audio tests failed')
  console.log(`PASS: ${report.results.length} polyphonic audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally {
  await session.close()
}
