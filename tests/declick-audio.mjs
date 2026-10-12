import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'
import { runPcmSuite } from './pcm-harness.mjs'

const browserName = testBrowserName()
const leadOverride = process.env.SOUND_LAB_CONTROL_LEAD_FRAMES
if (leadOverride !== undefined && !['0', '128', '256', '512', '640'].includes(leadOverride)) throw new Error('Test-only lead override must be 0, 128, 256, 512 or 640')
let session = await startTestBrowser()
const configureRoute = async () => {
  if (leadOverride !== undefined) {
    await session.page.route('**/src/audio/SynthVoice.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      let body = source
      if (leadOverride !== undefined) { assert.match(body, /CONTROL_LEAD_FRAMES\s*=\s*(128|256|512|640)\b/); body = body.replace(/CONTROL_LEAD_FRAMES\s*=\s*(128|256|512|640)\b/, `CONTROL_LEAD_FRAMES = ${leadOverride}`) }
      await route.fulfill({ response, body })
    })
    await session.page.reload()
    await session.page.locator('h1').waitFor()
  }
}
try {
  await configureRoute()
  const run = async () => session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams, defaultAdditive } = await import('/src/types.ts')
    const { createPcmRecorder } = await import('/tests/pcm-recorder.mjs')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const NativeAudioWorkletNode = window.AudioWorkletNode
    const physicalControls = []
    window.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(context, name, options) {
        super(context, name, options)
        if (name !== 'sound-lab-envelope-v1') return
        const record = { context, packets: [] }
        physicalControls.push(record)
        this.port.addEventListener('message', event => record.packets.push(structuredClone(event.data)))
      }
    }
    const matchingState = (message, state) => message.type === 'state'
      && message.slot === state.slot && message.generation === state.generation
      && message.instanceId === state.instanceId && message.revision === state.revision
      && message.appliedFrame === state.appliedFrame && message.endFrame === state.endFrame
      && message.zeroFrame === state.zeroFrame && message.renderedThroughFrame === state.renderedThroughFrame
    const renderedZero = (state, acknowledgements, context) => Boolean(state?.zero
      && Number.isInteger(state.slot) && state.slot >= 0 && state.slot < 20
      && Number.isSafeInteger(state.generation) && state.generation > 0
      && Number.isSafeInteger(state.revision) && state.revision > 0
      && state.acknowledgedRevision === state.revision
      && Number.isSafeInteger(state.appliedFrame) && state.appliedFrame >= 0
      && Number.isSafeInteger(state.endFrame) && state.endFrame >= 0
      && Number.isSafeInteger(state.zeroFrame) && state.zeroFrame >= Math.max(state.endFrame, state.appliedFrame)
      && Number.isSafeInteger(state.renderedThroughFrame) && state.renderedThroughFrame >= state.zeroFrame + 127
      && acknowledgements.some(message => matchingState(message, state))
      && physicalControls.some(record => record.context === context && record.packets.some(message => matchingState(message, state))))
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const params = { ...copyParams(DEFAULT_PARAMS), waveform: 'sine', frequency: 220, amplitude: 0.2, adsr: { attack: 0.02, decay: 0.02, sustain: 0.7, release: 0.1 }, filter: { cutoff: 8000, q: 0.707, bypass: true }, lfo: { enabled: false, rate: 3, depth: 0, target: 'pitch' } }
    const engine = new SynthEngine(params)
    let recorder
    try {
      await engine.prepare()
      await sleep(400)
      await engine.noteOnVoice({ id: 'probe', midi: 57, frequency: 220, velocity: 127, sourceId: 'probe', sourceName: 'PCM probe', channel: 1, origin: 'midi' })
      const context = engine.getAnalysis().time.context
      const voice = engine.voices.all[0]
      const pair = context.createChannelMerger(2)
      voice.envelope.connect(pair, 0, 0)
      voice.carrier.gain.connect(pair, 0, 1)
      recorder = await createPcmRecorder(context, pair, { channels: 2 })
      await sleep(280)
      const requestedAt = context.currentTime
      engine.noteOffVoice('probe')
      const releasedAt = voice.releasingAt
      await sleep(140)
      const pcm = await recorder.stop()
      const observed = []
      for (let index = 0; index < pcm.samples.length; index++) {
        const time = (pcm.firstFrame + index) / pcm.sampleRate
        const elapsed = time - releasedAt
        const carrier = pcm.channels[1][index]
        if (elapsed >= 0 && elapsed < 0.008 && Math.abs(carrier) > 0.25) observed.push({ elapsed, envelope: pcm.channels[0][index] / carrier, expected: 0.7 * (1 - elapsed / 0.1) })
      }
      const maximumError = Math.max(...observed.map(value => Math.abs(value.envelope - value.expected)))
      check('Sustain to Release starts from the actual held envelope without a gain jump', { requestedAt, releasedAt, maximumError, firstSamples: observed.slice(0, 8), sampleCount: observed.length, missingFrames: pcm.missingFrames, gaps: pcm.gaps }, [
        ['PCM includes uninterrupted first eight milliseconds after Note Off', observed.length > 100 && pcm.missingFrames === 0],
        ['actual envelope follows its continuous release ramp', maximumError < 0.025],
      ])
      const modes = ['sine', 'square', 'sawtooth', 'triangle'].map(waveform => ({ name: `Classic ${waveform}`, mode: 'classic', waveform })).concat([{ name: 'Additive', mode: 'additive', waveform: 'sine' }])
      const ratioError = (pcm, start, expected, duration = 0.008) => {
        let maximumError = 0
        let count = 0
        let first = null
        let maximumStep = 0
        let previous = null
        for (let index = 0; index < pcm.samples.length; index++) {
          const elapsed = (pcm.firstFrame + index) / pcm.sampleRate - start
          const raw = pcm.channels[1][index]
          if (Math.abs(raw) < 0.15) continue
          const gain = pcm.channels[0][index] / raw
          if (elapsed >= 0 && elapsed < duration && previous && index === previous.index + 1) maximumStep = Math.max(maximumStep, Math.abs(gain - previous.gain))
          previous = { index, gain }
          if (elapsed < 0 || elapsed >= duration) continue
          first ??= { elapsed, gain, expected: expected(elapsed) }
          maximumError = Math.max(maximumError, Math.abs(gain - expected(elapsed)))
          ++count
        }
        return { maximumError, maximumStep, count, first, missingFrames: pcm.missingFrames, gaps: pcm.gaps }
      }
      // A deliberate native gain discontinuity must fail the same detector.
      // This prevents a passing test caused by an inaudible or unconnected graph.
      const negativeContext = new AudioContext({ sampleRate: 48000 })
      const negativeOscillator = negativeContext.createOscillator()
      negativeOscillator.frequency.value = 220
      const negativeGain = negativeContext.createGain()
      negativeGain.gain.value = 0.7
      const negativePair = negativeContext.createChannelMerger(2)
      negativeOscillator.connect(negativeGain)
      negativeGain.connect(negativePair, 0, 0)
      negativeOscillator.connect(negativePair, 0, 1)
      negativeOscillator.start()
      await negativeContext.resume()
      const negativeRecorder = await createPcmRecorder(negativeContext, negativePair, { channels: 2 })
      await sleep(100)
      const steppedAt = (Math.ceil((negativeContext.currentTime + 0.02) * 220) + 0.25) / 220
      negativeGain.gain.setValueAtTime(0.1, steppedAt)
      await sleep(50)
      const negativePcm = await negativeRecorder.stop()
      const negativeMetrics = ratioError(negativePcm, steppedAt, () => 0.7)
      check('PCM detector identifies an intentionally injected gain jump', negativeMetrics, [
        ['recorded native carrier has enough uninterrupted transition samples', negativeMetrics.count > 100 && negativeMetrics.missingFrames === 0],
        ['known discontinuity is detected with a large envelope residual', negativeMetrics.maximumError > 0.5],
        ['the same per-sample envelope continuity detector rejects the intentional jump', negativeMetrics.maximumStep > 0.5],
      ])
      negativeOscillator.stop()
      negativeOscillator.disconnect()
      negativeGain.disconnect()
      negativePair.disconnect()
      await negativeContext.close()

      for (const mode of modes) {
        const additive = defaultAdditive()
        additive.levels[1] = 35
        additive.levels[2] = 15
        const toneParams = { ...copyParams(params), ...mode, additive }
        const toneEngine = new SynthEngine(toneParams)
        let toneRecorder
        try {
          await toneEngine.noteOnVoice({ id: 'fade', midi: 57, frequency: 220, velocity: 127, sourceId: 'probe', sourceName: 'Crossfade PCM', channel: 1, origin: 'midi' })
          await sleep(250)
          const toneContext = toneEngine.getAnalysis().time.context
          const toneVoice = toneEngine.voices.all[0]
          const outgoing = toneVoice.carrier
          const pair = toneContext.createChannelMerger(2)
          outgoing.gain.connect(pair, 0, 0)
          outgoing.oscillator.connect(pair, 0, 1)
          toneRecorder = await createPcmRecorder(toneContext, pair, { channels: 2 })
          await sleep(80)
          toneEngine.setParams({ ...toneParams, mode: mode.mode === 'classic' ? 'additive' : 'classic', waveform: 'triangle' })
          const fadedAt = toneVoice.waveformFadeEnds - 0.030
          await sleep(70)
          const fadePcm = await toneRecorder.stop()
          const fadeMetrics = ratioError(fadePcm, fadedAt, elapsed => 1 - elapsed / 0.025)
          check(`${mode.name}: late carrier replacement starts its fade continuously`, fadeMetrics, [
            ['first eight milliseconds of outgoing carrier are captured uninterrupted', fadeMetrics.count > 80 && fadeMetrics.missingFrames === 0],
            ['outgoing gain follows the anchored twenty-five millisecond ramp', fadeMetrics.maximumError < 0.003],
            ['crossfade preserves gated voice and cleans up its outgoing carrier', toneEngine.getVoices()[0]?.gateOpen && toneEngine.getDiagnostics().totalCarrierCount === 1],
          ])
        } finally {
          toneRecorder?.close()
          await toneEngine.dispose()
        }

        for (const timing of [{ name: 'fast attack short release', attack: 0.004, release: 0.015 }, { name: 'slow attack overlapping release', attack: 0.09, release: 0.12 }]) {
          const patternParams = { ...toneParams, adsr: { attack: timing.attack, decay: 0.035, sustain: 0.7, release: timing.release } }
          const patternEngine = new SynthEngine(patternParams)
          let patternRecorder
          try {
            await patternEngine.prepare()
            const patternContext = patternEngine.getAnalysis().time.context
            const pair = patternContext.createChannelMerger(21)
            patternRecorder = await createPcmRecorder(patternContext, pair, { channels: 21 })
            const nativeControlLead = patternEngine.getDiagnostics().controlLeadSeconds
            const records = []
            const envelopeAt = (record, time) => {
              const release = [...record.releases].reverse().find(event => time >= event.at)
              if (release) return release.from * Math.max(0, 1 - (time - release.at) / release.duration)
              const elapsed = time - record.at
              if (elapsed <= 0) return 0
              if (elapsed < timing.attack) return elapsed / timing.attack
              if (elapsed < timing.attack + 0.035) return 1 - (1 - 0.7) * (elapsed - timing.attack) / 0.035
              return 0.7
            }
            const add = patternEngine.voices.add.bind(patternEngine.voices)
            patternEngine.voices.add = voice => {
              let initialPlan = null
              const captureInitialPlan = () => {
                if (initialPlan === null && Number.isFinite(voice.startsAt) && voice.envelopeRamps.length) initialPlan = { revision: voice.getEnvelopeControlState().revision, at: voice.startsAt, ramps: structuredClone(voice.envelopeRamps) }
              }
              const record = { get at() { return voice.startsAt }, createdAt: voice.createdAt, get allocatedAt() { return voice.allocatedAt ?? voice.startsAt - nativeControlLead }, frequency: voice.note.frequency, id: voice.note.id, slot: records.length + 1, releases: [], firstAudible: null, automation: [], get initialPlan() { return initialPlan }, captureInitialPlan, processorStates: [] }
              captureInitialPlan()
              records.push(record)
              voice.envelopeControl.port.addEventListener('message', event => record.processorStates.push(structuredClone(event.data)))
              const postMessage = voice.envelopeControl.port.postMessage.bind(voice.envelopeControl.port)
              voice.envelopeControl.port.postMessage = (...args) => { const before = patternContext.currentTime; const result = postMessage(...args); record.automation.push({ method: 'processor.plan', plan: args[0], before, after: patternContext.currentTime }); return result }
              voice.envelope.connect(pair, 0, 0)
              voice.envelope.connect(pair, 0, record.slot + 10)
              voice.carrier.gain.connect(pair, 0, record.slot)
              const release = voice.release.bind(voice)
              voice.release = (seconds, force = false) => {
                const wasGated = voice.gateOpen
                const controlBeforeRelease = voice.getEnvelopeControlState()
                release(seconds, force)
                if (!wasGated && !force) return
                const releaseRamp = voice.envelopeRamps.find(ramp => ramp.phase === 'release')
                if (!releaseRamp) {
                  const controlAfterRelease = voice.getEnvelopeControlState()
                  // Cancelling a safely distant scheduled carrier destroys
                  // its silent graph directly and clears all ramps.
                  // A second forced release on that graph is also a no-op.
                  if (controlAfterRelease.destroyed && !controlAfterRelease.connected
                    && (controlBeforeRelease.cancelSafeBeforeStart || controlBeforeRelease.destroyed)) return
                  throw new Error(`Missing Release ramp for an audible voice: ${JSON.stringify({ id: voice.note.id, controlBeforeRelease, controlAfterRelease })}`)
                }
                const at = releaseRamp.start
                const from = envelopeAt(record, at)
                const end = releaseRamp.end
                record.releases.push({ at, from, duration: end - at })
              }
              add(voice)
            }
            const on = async (id, midi) => {
              await patternEngine.noteOnVoice({ id, midi, frequency: 440 * 2 ** ((midi - 69) / 12), velocity: 127, sourceId: 'probe', sourceName: 'PCM note pattern', channel: 1, origin: 'midi' })
              for (const record of records) record.captureInitialPlan()
            }
            for (let repeat = 0; repeat < 4; repeat++) {
              await on('repeat', 60)
              await on('repeat', 60) // A physical duplicate must not retrigger.
              await sleep(26)
              patternEngine.noteOffVoice('repeat')
              patternEngine.noteOffVoice('repeat')
              await sleep(24)
            }
            await on('legato-1', 60)
            await sleep(35)
            await on('legato-2', 62)
            await sleep(20)
            patternEngine.noteOffVoice('legato-1')
            await on('legato-3', 64)
            await sleep(35)
            patternEngine.noteOffVoice('legato-2')
            patternEngine.noteOffVoice('legato-3')
            await Promise.all([60, 64, 67].map(midi => on(`chord-${midi}`, midi)))
            await sleep(65)
            patternEngine.noteOffVoice('chord-64')
            await sleep(35)
            patternEngine.noteOffVoice('chord-60')
            patternEngine.noteOffVoice('chord-67')
            await sleep(timing.release * 1000 + 65)
            const pcm = await patternRecorder.stop()
            let maximumResidual = 0
            let residualPower = 0
            let actualPower = 0
            let testedFrames = 0
            let worst = null
            let maximumEnvelopeStep = 0
            let worstStep = null
            for (let index = 0; index < pcm.samples.length; index++) {
              const time = (pcm.firstFrame + index) / pcm.sampleRate
              let expected = 0
              for (const record of records) expected += pcm.channels[record.slot][index] * envelopeAt(record, time)
              const actual = pcm.channels[0][index]
              const residual = actual - expected
              if (Math.abs(residual) > maximumResidual) { maximumResidual = Math.abs(residual); worst = { time, actual, expected, components: records.map(record => ({ id: record.id, at: record.at, releases: record.releases, initialPlan: record.initialPlan, processorStates: record.processorStates, raw: pcm.channels[record.slot][index], actual: pcm.channels[record.slot + 10][index], envelope: envelopeAt(record, time) })) } }
              residualPower += residual * residual
              actualPower += actual * actual
              if (index) for (const record of records) {
                const raw = pcm.channels[record.slot][index]
                const previousRaw = pcm.channels[record.slot][index - 1]
                if (record.firstAudible === null && Math.abs(raw) > 0.2 && Math.abs(pcm.channels[record.slot + 10][index] / raw) > 0.001) record.firstAudible = time
                if (Math.abs(raw) < 0.2 || Math.abs(previousRaw) < 0.2) continue
                const step = pcm.channels[record.slot + 10][index] / raw - pcm.channels[record.slot + 10][index - 1] / previousRaw
                if (Math.abs(step) > maximumEnvelopeStep) { maximumEnvelopeStep = Math.abs(step); worstStep = { time, id: record.id, at: record.at, releases: record.releases, initialPlan: record.initialPlan, processorStates: record.processorStates, automation: record.automation, step } }
              }
              ++testedFrames
            }
            const maximumMusicalStep = Math.max(1 / timing.attack, 0.3 / 0.035, 1 / timing.release) / pcm.sampleRate
            const maximumAttackLatency = Math.max(...records.map(record => record.firstAudible === null ? Infinity : record.firstAudible - record.createdAt))
            const maximumAllocationTime = Math.max(...records.map(record => record.allocatedAt - record.createdAt))
            const maximumScheduledOnsetDelay = Math.max(...records.map(record => record.firstAudible === null ? Infinity : record.firstAudible - record.at))
            // Native delivery can span one render quantum. Cold node/PeriodicWave
            // allocation is reported separately from the musical start schedule.
            const onsetDeliveryLimit = 128 / pcm.sampleRate + 0.1 / Math.min(...records.map(record => record.frequency)) + timing.attack * 0.001
            const voiceOnsets = records.map(({ id, createdAt, allocatedAt, at, firstAudible, initialPlan, processorStates }) => ({ id, createdAt, allocatedAt, startsAt: at, firstAudible, initialPlan, processorStates }))
            const metrics = { maximumResidual, residualRms: Math.sqrt(residualPower / testedFrames), actualRms: Math.sqrt(actualPower / testedFrames), frames: testedFrames, missingFrames: pcm.missingFrames, gaps: pcm.gaps, createdVoices: records.length, maximumEnvelopeStep, maximumMusicalStep, maximumAttackLatency, maximumAllocationTime, maximumScheduledOnsetDelay, onsetDeliveryLimit, voiceOnsets, worstStep, worst, diagnostics: patternEngine.getDiagnostics() }
            check(`${mode.name}: ${timing.name} staccato legato repeats and chord releases`, metrics, [
              ['native PCM contains the complete uninterrupted audible pattern', testedFrames > patternContext.sampleRate * 0.4 && metrics.actualRms > 0.01 && pcm.missingFrames === 0],
              ['ordinary carrier edges cancel and actual envelope has no nonmusical single-sample jump', maximumEnvelopeStep <= maximumMusicalStep + 0.000002],
              ['scheduled Attack onset follows within one delivery quantum plus measurement threshold', maximumScheduledOnsetDelay >= 0 && maximumScheduledOnsetDelay <= onsetDeliveryLimit],
              ['every warm native PCM Attack becomes audible within 32 ms of its input', maximumAttackLatency >= 0 && maximumAttackLatency < 0.032],
              ['duplicate events create no extra voice', records.length === 10],
              ['all independent releases finish with no surviving node', patternEngine.getState().voiceCount === 0 && patternEngine.getDiagnostics().totalCarrierCount === 0 && patternEngine.getDiagnostics().envelopeControlCount === 0 && patternEngine.getDiagnostics().createdVoiceCount === patternEngine.getDiagnostics().destroyedVoiceCount],
            ])
          } finally {
            patternRecorder?.close()
            await patternEngine.dispose()
          }
        }
      }
      for (const boundary of [{ name: 'same-frame floating-point boundary', offsetFrames: 0 }, { name: 'one quantum before onset', offsetFrames: -128 }]) {
        const boundaryEngine = new SynthEngine({ ...copyParams(params), adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.015 } })
        let boundaryRecorder
        try {
          await boundaryEngine.prepare()
          const boundaryContext = boundaryEngine.getAnalysis().time.context
          const pair = boundaryContext.createChannelMerger(3)
          boundaryEngine.getAnalysis().time.connect(pair, 0, 2)
          boundaryRecorder = await createPcmRecorder(boundaryContext, pair, { channels: 3 })
          await boundaryEngine.noteOnVoice({ id: 'boundary', midi: 57, frequency: 220, velocity: 127, sourceId: 'probe', sourceName: 'Simulated clock observation / native PCM boundary', channel: 1, origin: 'midi' })
          const voice = boundaryEngine.voices.all[0]
          voice.envelope.connect(pair, 0, 0); voice.carrier.gain.connect(pair, 0, 1)
          const acknowledgements = []
          voice.envelopeControl.port.addEventListener('message', event => acknowledgements.push(structuredClone(event.data)))
          let controlAtDestroy = null, destroyedAt = null
          const destroy = voice.destroy.bind(voice)
          voice.destroy = () => { if (!voice.getEnvelopeControlState().destroyed) { controlAtDestroy = voice.getEnvelopeControlState(); destroyedAt = boundaryContext.currentTime }; destroy() }
          const nativeClockBeforeObservation = boundaryContext.currentTime
          const observedClock = boundary.offsetFrames === 0
            ? voice.startsAt - Number.EPSILON * Math.max(1, Math.abs(voice.startsAt))
            : voice.startsAt + boundary.offsetFrames / boundaryContext.sampleRate
          const previousClockDescriptor = Object.getOwnPropertyDescriptor(boundaryContext, 'currentTime')
          let immediatelyAfterOff, releaseRamp
          // Only the main-thread clock observation is simulated. Carrier,
          // envelope processor, downstream bus and every recorded sample are
          // native Web Audio objects running on their actual render clock.
          Object.defineProperty(boundaryContext, 'currentTime', { configurable: true, get: () => observedClock })
          try {
            boundaryEngine.noteOffVoice('boundary')
            immediatelyAfterOff = voice.getEnvelopeControlState()
            releaseRamp = structuredClone(voice.envelopeRamps.find(ramp => ramp.phase === 'release'))
          } finally {
            if (previousClockDescriptor) Object.defineProperty(boundaryContext, 'currentTime', previousClockDescriptor)
            else delete boundaryContext.currentTime
          }
          await sleep(140)
          const pcm = await boundaryRecorder.stop()
          const fade = releaseRamp ? ratioError(pcm, releaseRamp.start, elapsed => releaseRamp.from * Math.max(0, 1 - elapsed / (releaseRamp.end - releaseRamp.start))) : { count: 0, maximumError: Infinity, maximumStep: Infinity }
          let firstAudible = null
          for (let index = 0; index < pcm.samples.length; index++) if (Math.abs(pcm.channels[1][index]) > 0.2 && Math.abs(pcm.channels[0][index] / pcm.channels[1][index]) > 0.001) { firstAudible = (pcm.firstFrame + index) / pcm.sampleRate; break }
          const differences = Array.from(pcm.channels[2].slice(1), (sample, index) => Math.abs(sample - pcm.channels[2][index])).sort((a, b) => a - b)
          const maxJump = differences.at(-1) ?? 0, p99 = differences[Math.floor(differences.length * 0.99)] ?? 0
          const onsetLatency = firstAudible === null ? Infinity : firstAudible - voice.createdAt
          const metrics = { simulatedMainThreadClockObservation: true, nativeClockBeforeObservation, observedClock, observedFrame: Math.round(observedClock * pcm.sampleRate), startsAt: voice.startsAt, startFrame: Math.round(voice.startsAt * pcm.sampleRate), immediatelyAfterOff, releaseRamp, fade, firstAudible, onsetLatency, maxJump, p99, jumpRatio: maxJump / Math.max(p99, 1e-8), missingFrames: pcm.missingFrames, gaps: pcm.gaps, samples: pcm.samples.length, controlAtDestroy, destroyedAt, acknowledgements, diagnostics: boundaryEngine.getDiagnostics() }
          check(`Live Note Off at ${boundary.name} preserves a real attack and continuous native Release`, metrics, [
            ['the deliberate clock boundary is exact and native PCM contains the audible carrier without gaps', metrics.observedFrame === metrics.startFrame + boundary.offsetFrames && pcm.missingFrames === 0 && fade.count > 100 && firstAudible !== null],
            ['ordinary Release is scheduled after onset without disconnecting the near-start voice', immediatelyAfterOff.connected && !immediatelyAfterOff.destroyed && immediatelyAfterOff.revision > 1 && releaseRamp?.start >= voice.startsAt && releaseRamp.from > 0],
            ['native Release and processed PCM preserve the unchanged continuity thresholds', releaseRamp && fade.maximumError < 0.003 && fade.maximumStep <= releaseRamp.from / ((releaseRamp.end - releaseRamp.start) * pcm.sampleRate) + 0.000002 && maxJump < 0.01 && metrics.jumpRatio < 8],
            ['only a latest-plan native zero quantum authorizes final resource cleanup', releaseRamp && renderedZero(controlAtDestroy, acknowledgements, boundaryContext) && destroyedAt >= releaseRamp.end && boundaryEngine.getState().voiceCount === 0 && boundaryEngine.getDiagnostics().envelopeControlCount === 0 && boundaryEngine.getDiagnostics().createdVoiceCount === boundaryEngine.getDiagnostics().destroyedVoiceCount],
            ['the real warm carrier becomes audible within the unchanged 32 ms input budget', onsetLatency >= 0 && onsetLatency < 0.032],
          ])
        } finally { boundaryRecorder?.close(); await boundaryEngine.dispose() }
      }

      const stressEngine = new SynthEngine({ ...copyParams(params), adsr: { attack: 0.02, decay: 0.02, sustain: 0.7, release: 0.3 } })
      let stressRecorder
      try {
        const on = (id, midi) => stressEngine.noteOnVoice({ id, midi, frequency: 440 * 2 ** ((midi - 69) / 12), velocity: 127, sourceId: 'stress', sourceName: 'Retirement PCM', channel: 1, origin: 'midi' })
        await Promise.all(Array.from({ length: 16 }, (_, index) => on(`initial:${index}`, 48 + index)))
        await sleep(180)
        const context = stressEngine.getAnalysis().time.context
        const victim = stressEngine.voices.all[0]
        const pair = context.createChannelMerger(2)
        victim.envelope.connect(pair, 0, 0); victim.carrier.gain.connect(pair, 0, 1)
        stressRecorder = await createPcmRecorder(context, pair, { channels: 2 })
        let controlAtDestroy = null
        const acknowledgements = []
        victim.envelopeControl.port.addEventListener('message', event => acknowledgements.push(event.data))
        const destroy = victim.destroy.bind(victim)
        victim.destroy = () => { controlAtDestroy = victim.getEnvelopeControlState(); destroy() }
        await sleep(60)
        const burst = Promise.all(Array.from({ length: 32 }, (_, index) => on(`burst:${index}`, 60 + index % 12)))
        let maximumManaged = 0; let maximumRetiring = 0; let maximumCarriers = 0; let maximumControls = 0
        for (let index = 0; index < 25; index++) {
          const diagnostics = stressEngine.getDiagnostics()
          maximumManaged = Math.max(maximumManaged, diagnostics.managedCount)
          maximumRetiring = Math.max(maximumRetiring, diagnostics.retiringCount)
          maximumCarriers = Math.max(maximumCarriers, diagnostics.totalCarrierCount)
          maximumControls = Math.max(maximumControls, diagnostics.envelopeControlCount)
          await sleep(5)
        }
        await burst
        const pcm = await stressRecorder.stop()
        const metrics = ratioError(pcm, victim.releasingAt, elapsed => 0.7 * Math.max(0, 1 - elapsed / 0.012))
        check('A saturated synchronous burst retires the oldest audible voice through a real fade', { ...metrics, controlAtDestroy, acknowledgements, maximumManaged, maximumRetiring, maximumCarriers, maximumControls }, [
          ['retiring tail has a continuous twelve-millisecond envelope', metrics.count > 100 && metrics.maximumError < 0.003 && metrics.maximumStep < 0.7 / (0.012 * pcm.sampleRate) + 0.000002 && metrics.missingFrames === 0],
          ['a latest-plan native shared-port ACK proves a fully rendered zero block before destruction', controlAtDestroy?.connected === true && controlAtDestroy.contextState === 'running' && !controlAtDestroy.notStarted && renderedZero(controlAtDestroy, acknowledgements, context)],
          ['queued admissions preserve managed retiring carrier and lane bounds on one physical processor', maximumManaged <= 16 && maximumRetiring <= 4 && maximumCarriers <= 40 && maximumControls > 0 && maximumControls <= 20 && physicalControls.filter(record => record.context === context).length === 1],
        ])
        const panicVoice = stressEngine.voices.all.find(voice => voice.gateOpen)
        const panicPair = context.createChannelMerger(2)
        panicVoice.envelope.connect(panicPair, 0, 0); panicVoice.carrier.gain.connect(panicPair, 0, 1)
        const panicRecorder = await createPcmRecorder(context, panicPair, { channels: 2 })
        await sleep(70)
        stressEngine.panic()
        const panicAt = panicVoice.releasingAt
        await sleep(45)
        const panicPcm = await panicRecorder.stop()
        const panicMetrics = ratioError(panicPcm, panicAt, elapsed => 0.7 * Math.max(0, 1 - elapsed / 0.025))
        check('Panic fades actual held PCM and cleans the entire saturated graph', { ...panicMetrics, diagnostics: stressEngine.getDiagnostics() }, [
          ['Panic has no envelope discontinuity', panicMetrics.count > 100 && panicMetrics.maximumError < 0.003 && panicMetrics.maximumStep < 0.7 / (0.025 * panicPcm.sampleRate) + 0.000002 && panicMetrics.missingFrames === 0],
          ['Panic removes pending admissions voices and every carrier and control node', stressEngine.getState().pendingCount === 0 && stressEngine.getState().voiceCount === 0 && stressEngine.getDiagnostics().totalCarrierCount === 0 && stressEngine.getDiagnostics().envelopeControlCount === 0 && stressEngine.getDiagnostics().createdVoiceCount === stressEngine.getDiagnostics().destroyedVoiceCount],
        ])
      } finally { stressRecorder?.close(); await stressEngine.dispose() }
      return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
    } finally {
      recorder?.close()
      await engine.dispose()
      window.AudioWorkletNode = NativeAudioWorkletNode
    }
  })
  const reportUrl = new URL(`../test-results/declick-audio-${browserName}${leadOverride === undefined ? '' : `-lead${leadOverride}`}.json`, import.meta.url)
  const report = await runPcmSuite(run, reportUrl, { beforeRetry: async () => {
    await session.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    session = await startTestBrowser()
    await configureRoute()
  } })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(reportUrl, JSON.stringify({ browser: browserName, controlLeadOverride: leadOverride === undefined ? null : Number(leadOverride), ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Native PCM transition tests failed')
  console.log(`PASS: ${report.results.length} PCM scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally { await session.close() }
