import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const browserName = testBrowserName()
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const NativeOfflineAudioContext = window.OfflineAudioContext
    const offlineContexts = []
    const nativeOffline = { active: 0, completed: 0, failed: 0, contextsCreated: 0, maxActive: 0, connectedNodes: 0 }
    const trackOfflineNode = node => {
      const destinations = new Set(), connect = node.connect.bind(node), disconnect = node.disconnect.bind(node)
      node.connect = (...args) => {
        const returned = connect(...args)
        if (!destinations.size) ++nativeOffline.connectedNodes
        destinations.add(args[0]); return returned
      }
      node.disconnect = (...args) => {
        const returned = disconnect(...args), hadConnection = destinations.size > 0
        if (!args.length) destinations.clear()
        else destinations.delete(args[0])
        if (hadConnection && !destinations.size) --nativeOffline.connectedNodes
        return returned
      }
      return node
    }
    class TrackedOfflineAudioContext extends NativeOfflineAudioContext {
      constructor(...args) { super(...args); offlineContexts.push(this); ++nativeOffline.contextsCreated }
      async startRendering() {
        ++nativeOffline.active; nativeOffline.maxActive = Math.max(nativeOffline.maxActive, nativeOffline.active)
        try { const buffer = await super.startRendering(); ++nativeOffline.completed; return buffer }
        catch (error) { ++nativeOffline.failed; throw error }
        finally { --nativeOffline.active }
      }
    }
    for (const method of ['createGain', 'createOscillator', 'createBufferSource', 'createBiquadFilter', 'createWaveShaper']) {
      TrackedOfflineAudioContext.prototype[method] = function (...args) { return trackOfflineNode(NativeOfflineAudioContext.prototype[method].apply(this, args)) }
    }
    window.OfflineAudioContext = TrackedOfflineAudioContext
    const offlineDiagnostics = () => ({ ...nativeOffline, closedContexts: offlineContexts.filter(value => value.state === 'closed').length })
    const { DEFAULT_KICK_PATCH, KICK_PARAMETER_RANGES, validateKickPatch, kickPatchFingerprint } = await import('/src/sample-forge/kickPatch.ts')
    const { generateVariantPatches, generateSampleBank } = await import('/src/sample-forge/VariationGenerator.ts')
    const { renderKick, KICK_PEAK_CEILING } = await import('/src/sample-forge/audio/KickRenderer.ts')
    const { SamplePreview } = await import('/src/sample-forge/SamplePreview.ts')
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const { PhrasePlayer } = await import('/src/phrases/PhrasePlayer.ts')
    const { createPcmRecorder } = await import('/tests/pcm-recorder.mjs')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const same = (first, second) => JSON.stringify(first) === JSON.stringify(second)
    const equalPcm = (first, second) => first.length === second.length && first.every((value, index) => value === second[index])
    const base = { ...DEFAULT_KICK_PATCH }
    const seed = 20261013
    const variants = generateVariantPatches(base, seed)
    const frequencies = ['startFrequency', 'endFrequency'], times = ['pitchDecay', 'bodyDecay', 'clickDecay', 'attack']
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
    const parameterKey = patch => kickPatchFingerprint({ ...patch, seed: 0 })
    const independentStats = pcm => {
      let peak = 0, power = 0, sum = 0
      for (const value of pcm) { peak = Math.max(peak, Math.abs(value)); power += value * value; sum += value }
      return { peak, rms: Math.sqrt(power / pcm.length), dc: sum / pcm.length, finite: pcm.every(Number.isFinite) }
    }
    // Independent 4096-point complex FFT of the actual first 85.3 ms. This
    // onset-focused diagnostic intentionally differs from production's whole-
    // file FFT, so parameter labels cannot substitute for measured diversity.
    const independentSpectrum = pcm => {
      const size = 4096, real = new Float64Array(size), imaginary = new Float64Array(size)
      for (let index = 0; index < Math.min(size, pcm.length); ++index) real[index] = pcm[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1)))
      for (let index = 1, reverse = 0; index < size; ++index) {
        let bit = size >> 1
        for (; reverse & bit; bit >>= 1) reverse ^= bit
        reverse ^= bit
        if (index < reverse) { const swap = real[index]; real[index] = real[reverse]; real[reverse] = swap }
      }
      for (let width = 2; width <= size; width *= 2) {
        for (let start = 0; start < size; start += width) {
          for (let offset = 0; offset < width / 2; ++offset) {
            const angle = -2 * Math.PI * offset / width, cosine = Math.cos(angle), sine = Math.sin(angle)
            const even = start + offset, odd = even + width / 2
            const re = real[odd] * cosine - imaginary[odd] * sine, im = real[odd] * sine + imaginary[odd] * cosine
            real[odd] = real[even] - re; imaginary[odd] = imaginary[even] - im
            real[even] += re; imaginary[even] += im
          }
        }
      }
      let energy = 0, weighted = 0, low = 0, high = 0, strongest = 1
      for (let index = 1; index < size / 2; ++index) {
        const power = real[index] ** 2 + imaginary[index] ** 2, hz = index * 48000 / size
        energy += power; weighted += power * hz
        if (hz < 150) low += power
        if (hz > 2000) high += power
        if (power > real[strongest] ** 2 + imaginary[strongest] ** 2) strongest = index
      }
      return { centroid: weighted / energy, lowRatio: low / energy, highRatio: high / energy, dominantHz: strongest * 48000 / size }
    }

    check('Pure Medium generator returns exactly sixteen variants and a separate base', { count: variants.length, characters: variants.map(value => value.character) }, [
      ['sixteen indexed variants exclude the base', variants.length === 16 && variants.every((value, index) => value.index === index && parameterKey(value.patch) !== parameterKey(base))],
      ['four variants cover each intended direction', ['sub', 'punch', 'tight', 'warm'].every(character => variants.filter(value => value.character === character).length === 4)],
      ['base patch remains unchanged', same(base, DEFAULT_KICK_PATCH)],
    ])

    const repeated = generateVariantPatches(base, seed), otherSeed = generateVariantPatches(base, seed + 1)
    check('Seed deterministically controls parameter and noise choices', { seed, seeds: variants.map(value => value.patch.seed) }, [
      ['same seed repeats all parameters and character assignments', same(variants, repeated)],
      ['another seed changes actual parameter choices', !same(variants.map(value => ({ ...value.patch, seed: 0 })), otherSeed.map(value => ({ ...value.patch, seed: 0 })))],
      ['per-variant uint32 noise seeds are distinct', new Set(variants.map(value => value.patch.seed)).size === 16 && variants.every(value => Number.isInteger(value.patch.seed) && value.patch.seed >= 0 && value.patch.seed <= 0xffffffff)],
    ])

    const extremeBases = [
      { ...base, ...Object.fromEntries(Object.entries(KICK_PARAMETER_RANGES).map(([key, range]) => [key, range.min])) },
      { ...base, ...Object.fromEntries(Object.entries(KICK_PARAMETER_RANGES).map(([key, range]) => [key, range.max])) },
    ]
    const boundaryDescriptors = extremeBases.flatMap(patch => [0, 1, 0xffffffff].flatMap(value => generateVariantPatches(patch, value)))
    const everyValid = [...variants, ...boundaryDescriptors].every(value => {
      try { validateKickPatch(value.patch); return value.patch.startFrequency >= value.patch.endFrequency } catch { return false }
    })
    check('Boundary seeds and extreme patches stay inside valid musical ranges', { checked: variants.length + boundaryDescriptors.length }, [
      ['all generated values satisfy strict KickPatch validation', everyValid],
      ['frequency and envelope times remain finite', boundaryDescriptors.every(value => [...frequencies, ...times].every(key => Number.isFinite(value.patch[key])))],
    ])

    const relativeDeviations = variants.map(value => Object.fromEntries(Object.keys(KICK_PARAMETER_RANGES).map(key => [key, Math.abs(value.patch[key] / base[key] - 1)])))
    check('Medium uses bounded relative changes instead of fully random patches', { maximumDeviation: Math.max(...relativeDeviations.flatMap(value => Object.values(value))), deviations: relativeDeviations }, [
      ['default continuous parameters deviate at most25 percent', relativeDeviations.every(value => Object.values(value).every(deviation => deviation <= 0.2500001))],
      ['each variant changes several independent timbre controls', relativeDeviations.every(value => Object.values(value).filter(deviation => deviation > 0.01).length >= 3)],
      ['Output Level remains the base value', variants.every(value => value.patch.outputLevel === base.outputLevel)],
    ])

    const nearZero = generateVariantPatches({ ...base, attack: 0, clickAmount: 0, drive: 0 }, 505)
    check('Parameters near zero receive bounded meaningful absolute steps', { click: nearZero.map(value => value.patch.clickAmount), drive: nearZero.map(value => value.patch.drive) }, [
      ['some punch variants gain an attack from a zero click base', nearZero.filter(value => value.character === 'punch').every(value => value.patch.clickAmount > 0 && value.patch.clickAmount <= 0.03)],
      ['warm and punch saturation can grow from zero safely', nearZero.filter(value => ['warm', 'punch'].includes(value.character)).every(value => value.patch.drive > 0 && value.patch.drive <= 0.03)],
      ['zero Attack never becomes negative', nearZero.every(value => value.patch.attack >= 0)],
    ])

    check('Fingerprints prevent duplicate synthesis parameters, not merely duplicate seeds', { fingerprints: variants.map(value => parameterKey(value.patch)) }, [
      ['all parameter fingerprints are unique after noise seed is removed', new Set(variants.map(value => parameterKey(value.patch))).size === 16],
      ['no fingerprint matches the base', variants.every(value => parameterKey(value.patch) !== parameterKey(base))],
      ['field insertion order does not change the canonical fingerprint', kickPatchFingerprint({ ...base }) === kickPatchFingerprint(Object.fromEntries(Object.entries(base).reverse()))],
    ])

    const untouched = generateVariantPatches(base, seed)
    variants[0].patch.startFrequency = 399
    const afterMutation = generateVariantPatches(base, seed)
    check('Generated patches are independent editable copies', {}, [
      ['editing a variant cannot mutate its base', same(base, DEFAULT_KICK_PATCH)],
      ['future seeded generation is independent of previous objects', same(untouched, afterMutation)],
      ['neighboring variants share no patch object reference', new Set(afterMutation.map(value => value.patch)).size === 16],
    ])
    let invalidSeeds = 0
    for (const value of [-1, 0x100000000, 0.5, Infinity, NaN, '42']) { try { generateVariantPatches(base, value) } catch { ++invalidSeeds } }
    check('Malformed seed inputs fail before audio allocation', { invalidSeeds }, [
      ['negative, overflowing, fractional, infinite and textual seeds reject', invalidSeeds === 6],
      ['pure generation allocates no native offline context', offlineDiagnostics().contextsCreated === 0],
    ])

    const progress = [], frozenInput = { ...base }
    const bankPromise = generateSampleBank(frozenInput, seed, { onProgress: value => progress.push(value) })
    frozenInput.bodyDecay = 900
    const bank = await bankPromise
    check('Native batch creates sixteen editable PCM/WAV variants with independent base', { id: bank.id, seed: bank.batchSeed, count: bank.samples.length, progress }, [
      ['bank contains exactly sixteen variants and a separate Base Kick', bank.samples.length === 16 && bank.base.character === 'base' && bank.copies.length === 0],
      ['sample IDs and names are unique', new Set(bank.samples.map(value => value.id)).size === 16 && new Set(bank.samples.map(value => value.name)).size === 16 && !bank.samples.some(value => value.id === bank.base.id)],
      ['generation provenance is complete', bank.batchSeed === seed && bank.intensity === 'medium' && typeof bank.generatorVersion === 'string' && bank.samples.every(value => value.seed === value.patch.seed && same(value.generatedPatch, value.patch))],
      ['all native renders correspond to their editable patch', bank.samples.every(value => value.render.fingerprint === kickPatchFingerprint(value.patch) && same(value.patch, value.render.patch))],
      ['progress is monotonic from zero to complete', progress[0] === 0 && progress.at(-1) === 1 && progress.every((value, index) => index === 0 || value >= progress[index - 1])],
    ])

    const audioStats = bank.samples.map(value => ({ id: value.id, ...independentStats(value.render.pcm), duration: value.render.pcm.length / 48000 }))
    check('Each variant passes independent PCM level, DC and one-shot quality checks', { audioStats }, [
      ['all samples contain audible finite PCM', audioStats.every(value => value.finite && value.rms > 0.0003 && value.peak > 0.005)],
      ['no variant clips or carries exported DC', audioStats.every(value => value.peak <= KICK_PEAK_CEILING + 1e-7 && Math.abs(value.dc) < 1e-7)],
      ['all durations are bounded Kick one-shots', audioStats.every(value => value.duration >= 0.07 && value.duration <= 1.05)],
      ['WAV data length matches each preview PCM', bank.samples.every(value => new DataView(value.render.wav.buffer, value.render.wav.byteOffset, value.render.wav.byteLength).getUint32(40, true) === value.render.pcm.length * 3)],
    ])

    const spectra = bank.samples.map(value => ({ name: value.name, ...independentSpectrum(value.render.pcm) }))
    const centroidSpread = Math.max(...spectra.map(value => value.centroid)) - Math.min(...spectra.map(value => value.centroid))
    const durationSpread = Math.max(...audioStats.map(value => value.duration)) - Math.min(...audioStats.map(value => value.duration))
    const featureKeys = spectra.map((value, index) => [value.centroid.toFixed(3), value.lowRatio.toFixed(5), audioStats[index].rms.toFixed(5)].join(':'))
    check('Sixteen variations differ in actual independent FFT/RMS/duration measurements', { spectra, centroidSpread, durationSpread, uniqueFeatureKeys: new Set(featureKeys).size }, [
      ['all sixteen measured feature vectors differ', new Set(featureKeys).size === 16],
      ['variation covers a measurable pitch/spectral spread', centroidSpread > 5 && spectra.every(value => value.dominantHz >= 20 && value.dominantHz <= 200)],
      ['decay durations span at least80 ms', durationSpread > 0.08],
      ['measured levels differ while staying safe', Math.max(...audioStats.map(value => value.rms)) / Math.min(...audioStats.map(value => value.rms)) > 1.1],
    ])

    const groupDuration = Object.fromEntries(['sub', 'punch', 'tight', 'warm'].map(character => [character, mean(bank.samples.filter(value => value.character === character).map(value => value.render.metrics.duration))]))
    check('Musical character directions have coherent, audible parameter consequences', { groupDuration }, [
      ['Sub preserves a longer low body than Tight', groupDuration.sub > groupDuration.tight * 1.15],
      ['Sub pitch endpoints move downward and Tight upward', bank.samples.filter(value => value.character === 'sub').every(value => value.patch.endFrequency < base.endFrequency) && bank.samples.filter(value => value.character === 'tight').every(value => value.patch.endFrequency > base.endFrequency)],
      ['Warm reduces brightness and increases moderate drive', bank.samples.filter(value => value.character === 'warm').every(value => value.patch.tone < base.tone && value.patch.drive > base.drive)],
    ])

    const repeatedSample = await renderKick(bank.samples[0].patch)
    check('Batch snapshots its base and each committed patch reproduces its WAV source', { baseDecay: bank.base.patch.bodyDecay, repeatedFrames: repeatedSample.pcm.length }, [
      ['mutating the caller during generation cannot change the base', bank.base.patch.bodyDecay === DEFAULT_KICK_PATCH.bodyDecay && frozenInput.bodyDecay === 900],
      ['committed parameters match deterministic pure generation', bank.samples.every((value, index) => same(value.patch, afterMutation[index].patch))],
      ['a saved variant re-renders exactly', equalPcm(repeatedSample.pcm, bank.samples[0].render.pcm) && equalPcm(repeatedSample.wav, bank.samples[0].render.wav)],
    ])

    const beforeCancel = offlineDiagnostics(), preCancelled = new AbortController(); preCancelled.abort()
    let preCancelRejected = false, duringCancelRejected = false
    try { await generateSampleBank(base, 4, { signal: preCancelled.signal }) } catch (error) { preCancelRejected = error.name === 'AbortError' }
    const duringCancel = new AbortController(), cancelProgress = []
    try { await generateSampleBank(base, 5, { signal: duringCancel.signal, onProgress: value => { cancelProgress.push(value); if (value >= 3 / 17) duringCancel.abort() } }) } catch (error) { duringCancelRejected = error.name === 'AbortError' }
    const afterCancel = offlineDiagnostics()
    check('Cancellation rejects partial banks and releases native work', { beforeCancel, afterCancel, cancelProgress }, [
      ['pre-cancelled batch creates no partial result', preCancelRejected],
      ['in-progress cancellation stops before all sixteen variants', duringCancelRejected && cancelProgress.at(-1) < 1 && afterCancel.contextsCreated - beforeCancel.contextsCreated === 3],
      ['cancelled generation retains no active graph', afterCancel.active === 0 && afterCancel.connectedNodes === 0 && afterCancel.closedContexts === afterCancel.contextsCreated],
    ])

    const oldBankFingerprint = bank.samples.map(value => value.render.fingerprint).join('|'), progressA = [], progressB = []
    const [bankA, bankB] = await Promise.all([
      generateSampleBank(base, 654, { onProgress: value => progressA.push(value) }),
      generateSampleBank(base, 655, { onProgress: value => progressB.push(value) }),
    ])
    const afterConcurrent = offlineDiagnostics()
    check('Rapid concurrent batches remain independent and native work stays bounded', { bankA: bankA.id, bankB: bankB.id, diagnostics: afterConcurrent }, [
      ['two requests yield separate complete banks', bankA.id !== bankB.id && bankA.samples.length === 16 && bankB.samples.length === 16 && bankA.batchSeed === 654 && bankB.batchSeed === 655],
      ['new generations do not mutate or remove previous bank', bank.samples.map(value => value.render.fingerprint).join('|') === oldBankFingerprint && bank.samples.length === 16],
      ['progress belongs to each request independently', progressA.at(-1) === 1 && progressB.at(-1) === 1],
      ['global native renderer concurrency never exceeds one', afterConcurrent.maxActive === 1 && afterConcurrent.active === 0 && afterConcurrent.connectedNodes === 0 && afterConcurrent.closedContexts === afterConcurrent.contextsCreated],
    ])

    let silentRejected = false
    try { await generateSampleBank({ ...base, outputLevel: 0 }, 999) } catch (error) { silentRejected = /тихий/.test(error.message) }
    check('Empty or too-quiet base fails quality acceptance instead of creating silent packs', {}, [
      ['zero Output Level is rejected as a batch source', silentRejected],
      ['quality rejection leaves no active offline resources', offlineDiagnostics().active === 0 && offlineDiagnostics().connectedNodes === 0],
    ])

    const NativeAudioContext = window.AudioContext, nativeContexts = []
    class TrackedAudioContext extends NativeAudioContext { constructor(options) { super(options); nativeContexts.push(this) } }
    window.AudioContext = TrackedAudioContext
    const params = { ...copyParams(DEFAULT_PARAMS), waveform: 'triangle', amplitude: 0.2,
      adsr: { attack: 0.002, decay: 0.004, sustain: 0.7, release: 0.04 }, filter: { bypass: false, cutoff: 700, q: 0.707 } }
    const engine = new SynthEngine(params), playedStates = []
    const provider = async () => { await engine.prepare(); return engine.getSamplePreviewBus() }
    const preview = new SamplePreview(provider, value => playedStates.push(value))
    let player = null, recorder = null, pair = null
    const tracked = [], liveBufferSources = new Set()
    let maximumNativeSources = 0
    try {
      await engine.noteOnVoice({ id: 'live-forge-test', sourceId: 'simulated-SMK25', sourceName: 'Simulated SMK-25', midi: 69, frequency: 440, velocity: 96, channel: 1, origin: 'midi' })
      await sleep(60)
      const liveBefore = engine.getVoices().find(value => value.id === 'live-forge-test'), bus = await provider(), context = bus.context
      const originalParams = JSON.stringify(engine.params), nativeSource = context.createBufferSource.bind(context)
      context.createBufferSource = () => {
        const source = nativeSource(), record = { source, gain: null, pcm: null, start: null }
        tracked.push(record)
        const nativeConnect = source.connect.bind(source), nativeStart = source.start.bind(source)
        source.connect = (...args) => { if (args[0] instanceof GainNode) record.gain = args[0]; return nativeConnect(...args) }
        source.start = (...args) => {
          record.pcm = source.buffer.getChannelData(0).slice(); record.start = args[0] ?? context.currentTime
          liveBufferSources.add(source); maximumNativeSources = Math.max(maximumNativeSources, liveBufferSources.size)
          source.addEventListener('ended', () => liveBufferSources.delete(source), { once: true })
          return nativeStart(...args)
        }
        return source
      }
      const started = await preview.play(bank.samples[0].render)
      check('Preview reuses the SynthEngine context and exact rendered PCM buffer', { contexts: nativeContexts.length, preview: { ...preview.diagnostics(), pcm: undefined }, monitorLevel: bus.monitorLevel }, [
        ['user-triggered preview starts on the existing single real-time context', started && nativeContexts.length === 1 && context === engine.getAnalysis().time.context],
        ['AudioBufferSourceNode receives exactly the WAV-source PCM', equalPcm(tracked.at(-1).pcm, bank.samples[0].render.pcm) && preview.diagnostics().pcm === bank.samples[0].render.pcm],
        ['preview monitor attenuation is explicit and safe', bus.monitorLevel > 0 && bus.monitorLevel <= 1],
      ])

      player = new PhrasePlayer(engine, () => {})
      player.configure([{ id: 'phrase-kick-test', eventId: 'phrase-kick-test', sourceId: 'recorded-source', sourceName: 'Recorded source', channel: 1, midi: 60, velocity: 80, start: 0, end: 0.06 }], 0.1, true)
      await player.play()
      await sleep(35)
      preview.stop(); await sleep(25)
      const liveAfter = engine.getVoices().find(value => value.id === 'live-forge-test')
      check('Preview transport cannot alter held MIDI, synth parameters or Phrase Recorder', { before: liveBefore, after: liveAfter, phrase: player.getState() }, [
        ['live MIDI voice retains ID, pitch, velocity and open gate', liveAfter?.instanceId === liveBefore.instanceId && liveAfter.frequency === 440 && liveAfter.velocity === 96 && liveAfter.gateOpen],
        ['main synth parameters remain unchanged', JSON.stringify(engine.params) === originalParams],
        ['PhrasePlayer keeps playing when preview stops', player.getState().status === 'playing'],
        ['preview stop releases only preview sources', preview.diagnostics().activeSources === 0 && engine.getState().heldCount >= 1],
      ])
      player.stop()

      const switches = await Promise.all(Array.from({ length: 12 }, (_, index) => preview.play(bank.samples[index % 16].render)))
      const burst = preview.diagnostics()
      check('Rapid preview commands cancel obsolete starts and preserve a bounded fade pool', { accepted: switches.filter(Boolean).length, burst: { ...burst, pcm: undefined }, maximumNativeSources }, [
        ['only the newest pending request starts', switches.filter(Boolean).length === 1 && switches.at(-1)],
        ['the newest sample is the one copied to the native source', equalPcm(tracked.at(-1).pcm, bank.samples[11].render.pcm)],
        ['at most one current preview and one fading preview exist', burst.activeSources <= 2 && maximumNativeSources <= 2],
      ])
      preview.stop(); await sleep(25)

      await preview.play(bank.base.render)
      const captured = tracked.at(-1)
      pair = context.createChannelMerger(2)
      captured.gain.connect(pair, 0, 0); captured.source.connect(pair, 0, 1)
      recorder = await createPcmRecorder(context, pair, { channels: 2 })
      const stopAt = context.currentTime
      preview.stop()
      await sleep(30)
      const pcm = await recorder.stop(); recorder = null
      let maximumGainError = 0, observedFade = 0, postStopPeak = 0
      for (let index = 0; index < pcm.samples.length; ++index) {
        const time = (pcm.firstFrame + index) / pcm.sampleRate, raw = pcm.channels[1][index]
        if (time >= stopAt && time <= stopAt + 0.005 && Math.abs(raw) > 0.005) {
          const expected = Math.max(0, 1 - (time - stopAt) / 0.005)
          maximumGainError = Math.max(maximumGainError, Math.abs(pcm.samples[index] / raw - expected)); ++observedFade
        }
        if (time > stopAt + 0.008) postStopPeak = Math.max(postStopPeak, Math.abs(pcm.samples[index]))
      }
      pair.disconnect(); pair = null
      check('Preview Stop performs a real native short fade before disconnecting its buffer', { stopAt, maximumGainError, observedFade, postStopPeak, missingFrames: pcm.missingFrames }, [
        ['actual output follows the native5ms gain ramp', observedFade > 80 && maximumGainError < 0.02],
        ['stopped preview is silent after its short technical tail', postStopPeak < 1e-7 && preview.diagnostics().activeSources === 0],
        ['no PCM continuity gaps were discarded', pcm.missingFrames === 0],
      ])

      await preview.play(bank.base.render)
      await context.suspend()
      preview.stop()
      const whileSuspended = preview.diagnostics()
      await context.resume(); await sleep(20)
      check('Stopping a suspended preview prevents its late return after context resume', { whileSuspended: { ...whileSuspended, pcm: undefined }, after: { ...preview.diagnostics(), pcm: undefined } }, [
        ['suspended preview sources release immediately', whileSuspended.activeSources === 0],
        ['resuming the shared context cannot reopen the stopped preview', preview.diagnostics().activeSources === 0],
        ['live held note remains independent', engine.getVoices().some(value => value.id === 'live-forge-test' && value.gateOpen)],
      ])

      let resolveStopped, resolveDisposed
      const deferredStop = new SamplePreview(() => new Promise(resolve => { resolveStopped = resolve }))
      const deferredDispose = new SamplePreview(() => new Promise(resolve => { resolveDisposed = resolve }))
      const sourcesBeforeDeferred = tracked.length
      const stoppedPromise = deferredStop.play(bank.base.render); deferredStop.stop(); resolveStopped(bus)
      const disposedPromise = deferredDispose.play(bank.base.render); deferredDispose.dispose(); resolveDisposed(bus)
      const deferredResults = await Promise.all([stoppedPromise, disposedPromise])
      check('Deferred context preparation cannot revive cancelled preview requests', { deferredResults }, [
        ['Stop and dispose invalidate pending play tokens', deferredResults.every(value => value === false)],
        ['no native AudioBufferSource is created by obsolete provider completion', tracked.length === sourcesBeforeDeferred],
      ])
      deferredStop.dispose()

      await preview.play(bank.base.render)
      preview.dispose(); preview.dispose()
      await sleep(25)
      const disposed = preview.diagnostics(), refused = await preview.play(bank.base.render)
      check('Preview dispose is idempotent and frees all buffers and gain nodes', { disposed: { ...disposed, pcm: undefined }, nativeLiveSources: liveBufferSources.size }, [
        ['dispose completes the short tail and releases source PCM references', disposed.disposed && disposed.activeSources === 0 && disposed.pcm === null && disposed.started === disposed.ended],
        ['disposed preview cannot start again', !refused && liveBufferSources.size === 0],
        ['preview lifecycle uses only one real-time AudioContext', nativeContexts.length === 1],
      ])
    } finally {
      recorder?.close(); pair?.disconnect(); player?.dispose(); preview.dispose(); await engine.dispose(); window.AudioContext = NativeAudioContext
    }
    const final = offlineDiagnostics()
    check('Combined offline and preview work leaves no permanent extra audio engine', { offline: final, contextStates: nativeContexts.map(value => value.state) }, [
      ['all native offline graphs and completed contexts are released', final.active === 0 && final.connectedNodes === 0 && final.failed === 0 && final.closedContexts === final.contextsCreated],
      ['the single shared musical context closes cleanly', nativeContexts.length === 1 && nativeContexts.every(value => value.state === 'closed')],
    ])
    window.OfflineAudioContext = NativeOfflineAudioContext
    return { browser: navigator.userAgent, scenarios: results.length, results, diagnostics: final }
  })
  await mkdir('test-results', { recursive: true })
  await writeFile(`test-results/sample-forge-batch-${browserName}.json`, JSON.stringify(report, null, 2))
  for (const result of report.results) {
    for (const check of result.checks) assert.ok(check.passed, `${result.name}: ${check.description}\n${JSON.stringify(result.metrics, null, 2)}`)
    console.log(`PASS ${result.name}`)
  }
  console.log(`PASS Sample Forge batch/preview: ${report.scenarios} scenarios / ${report.results.reduce((sum, value) => sum + value.checks.length, 0)} assertions (${browserName})`)
} finally { await session.close() }
