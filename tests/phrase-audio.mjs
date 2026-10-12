import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'
import { runPcmSuite } from './pcm-harness.mjs'

const browserName = testBrowserName()
let session = await startTestBrowser()
try {
  const run = async () => session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { PhrasePlayer } = await import('/src/phrases/PhrasePlayer.ts')
    const { DEFAULT_PARAMS, copyParams, defaultAdditive } = await import('/src/types.ts')
    const { createPcmRecorder } = await import('/tests/pcm-recorder.mjs')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const waitForReleasedVoices = async engine => {
      const released = engine.voices.all.filter(voice => !voice.gateOpen)
      const instances = new Set(released.map(voice => voice.instanceId))
      const cleanupAt = Math.max(0, ...released.map(voice => voice.nextMaintenanceAt()).filter(Number.isFinite))
      const wallDeadline = performance.now() + 250
      const remaining = () => engine.voices.all.filter(voice => instances.has(voice.instanceId)).length
      while (((engine.getAudioClock()?.time ?? 0) < cleanupAt || remaining() > 0) && performance.now() < wallDeadline) await sleep(2)
      return { cleanupAt, nativeTime: engine.getAudioClock()?.time ?? 0, remaining: remaining() }
    }
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const params = { ...copyParams(DEFAULT_PARAMS), waveform: 'sine', amplitude: 0.2, adsr: { attack: 0.02, decay: 0.05, sustain: 0.7, release: 0.09 }, filter: { cutoff: 8000, q: 0.707, bypass: true }, lfo: { enabled: false, rate: 3, depth: 0, target: 'pitch' } }
    const live = (id, midi = 60, sourceId = 'test-live') => ({ id, midi, frequency: 440 * 2 ** ((midi - 69) / 12), velocity: 127, sourceId, sourceName: 'Native test', channel: 1, origin: 'midi' })
    const phraseNote = (id, midi, start, end) => ({ id, eventId: id, sourceId: 'recorded', sourceName: 'Recorded MIDI', channel: 1, midi, velocity: 100, start, end })
    const heldEnvelope = (elapsed, adsr) => elapsed <= 0 ? 0 : elapsed < adsr.attack ? elapsed / adsr.attack : elapsed < adsr.attack + adsr.decay ? 1 - (1 - adsr.sustain) * (elapsed - adsr.attack) / adsr.decay : adsr.sustain
    const expectedEnvelope = (time, start, end, adsr) => time < end ? heldEnvelope(time - start, adsr) : heldEnvelope(end - start, adsr) * Math.max(0, 1 - (time - end) / adsr.release)
    for (const heldFor of [0.009, 0.04, 0.18]) {
      const engine = new SynthEngine(params)
      let recorder
      try {
        await engine.prepare()
        const context = engine.getAnalysis().time.context
        const pair = context.createChannelMerger(2)
        recorder = await createPcmRecorder(context, pair, { channels: 2 })
        const start = context.currentTime + 0.045
        const end = start + heldFor
        const admitted = engine.scheduleNote({ ...live('native-gate'), origin: 'sequence' }, start, end)
        const voice = engine.voices.all[0]
        voice.envelope.connect(pair, 0, 0)
        voice.carrier.gain.connect(pair, 0, 1)
        // Native ON and Off must still happen while the JavaScript scheduler stalls.
        const stallUntil = performance.now() + (heldFor + 0.16) * 1000
        while (performance.now() < stallUntil) { /* Deliberate main-thread stall. */ }
        await sleep(60)
        const pcm = await recorder.stop()
        let maximumError = 0
        let preStartPeak = 0
        let count = 0
        let releaseCount = 0
        for (let index = 0; index < pcm.samples.length; index++) {
          const time = (pcm.firstFrame + index) / pcm.sampleRate
          const raw = pcm.channels[1][index]
          if (time < start) preStartPeak = Math.max(preStartPeak, Math.abs(pcm.samples[index]))
          if (Math.abs(raw) < 0.2 || time < start) continue
          maximumError = Math.max(maximumError, Math.abs(pcm.samples[index] / raw - expectedEnvelope(time, start, end, params.adsr)))
          ++count
          if (time >= end && time < end + params.adsr.release) ++releaseCount
        }
        check(`Native scheduled gate during ${heldFor < 0.02 ? 'Attack' : heldFor < 0.07 ? 'Decay' : 'Sustain'}`, { admitted, start, end, maximumError, preStartPeak, count, releaseCount, missingFrames: pcm.missingFrames, diagnostics: engine.getDiagnostics() }, [
          ['future ON is sample-scheduled and silent beforehand', admitted && voice.startsAt === start && preStartPeak === 0 && pcm.missingFrames === 0],
          ['native Off retains its planned envelope under a blocked main thread', count > 200 && releaseCount > 200 && maximumError < 0.0002],
          ['expired native gates and oscillators are cleaned up', engine.getState().voiceCount === 0 && engine.getDiagnostics().scheduledNoteCount === 0],
        ])
      } finally { recorder?.close(); await engine.dispose() }
    }

    const modes = ['sine', 'square', 'sawtooth', 'triangle'].map(waveform => ({ name: `Classic ${waveform}`, mode: 'classic', waveform })).concat([{ name: 'Additive', mode: 'additive', waveform: 'sine' }])
    for (const mode of modes) {
      const additive = defaultAdditive()
      additive.levels[1] = 35; additive.levels[2] = 15
      const patternParams = { ...copyParams(params), ...mode, additive, adsr: { attack: 0.004, decay: 0.012, sustain: 0.7, release: 0.025 } }
      const engine = new SynthEngine(patternParams)
      const player = new PhrasePlayer(engine, () => {})
      let recorder
      const references = []
      try {
        await engine.prepare()
        const context = engine.getAnalysis().time.context
        const pair = context.createChannelMerger(2)
        recorder = await createPcmRecorder(context, pair, { channels: 2 })
        const admitted = []
        const add = engine.voices.add.bind(engine.voices)
        engine.voices.add = voice => {
          add(voice)
          if (voice.note.origin !== 'sequence') return
          admitted.push({ start: voice.startsAt, end: voice.plannedEndAt, midi: voice.note.midi })
          voice.envelope.connect(pair, 0, 0)
          // Branch the actual native carrier through an independent test
          // envelope. Its ordinary square/saw edges cancel exactly.
          const gain = context.createGain()
          const start = voice.startsAt
          const end = voice.plannedEndAt
          const adsr = patternParams.adsr
          gain.gain.value = 0
          gain.gain.setValueAtTime(0, start)
          const attackEnd = Math.min(end, start + adsr.attack)
          gain.gain.linearRampToValueAtTime(heldEnvelope(attackEnd - start, adsr), attackEnd)
          if (end > attackEnd) {
            const decayEnd = Math.min(end, start + adsr.attack + adsr.decay)
            gain.gain.linearRampToValueAtTime(heldEnvelope(decayEnd - start, adsr), decayEnd)
            if (end > decayEnd) gain.gain.setValueAtTime(adsr.sustain, end)
          }
          gain.gain.linearRampToValueAtTime(0, end + adsr.release)
          voice.carrier.gain.connect(gain); gain.connect(pair, 0, 1)
          references.push({ gain })
        }
        const notes = [phraseNote('a', 60, 0, 0.028), phraseNote('b', 60, 0.028, 0.056), phraseNote('c', 64, 0.045, 0.105), ...[60, 64, 67].map((midi, index) => phraseNote(`chord${midi}`, midi, 0.105, 0.135 + index * 0.012))]
        player.configure(notes, 0.18, true)
        await player.play()
        const anchor = player.anchor
        await sleep(780)
        player.setLoop(false)
        await sleep(260)
        const pcm = await recorder.stop()
        let maximumResidual = 0; let residualPower = 0; let actualPower = 0
        for (let index = 0; index < pcm.samples.length; index++) {
          const residual = pcm.samples[index] - pcm.channels[1][index]
          maximumResidual = Math.max(maximumResidual, Math.abs(residual))
          residualPower += residual * residual; actualPower += pcm.samples[index] ** 2
        }
        const cycleStarts = admitted.filter(note => note.midi === 60 && Math.abs((note.start - anchor) / 0.18 - Math.round((note.start - anchor) / 0.18)) < 1e-7).map(note => note.start)
        const metrics = { maximumResidual, residualRms: Math.sqrt(residualPower / pcm.samples.length), actualRms: Math.sqrt(actualPower / pcm.samples.length), admitted: admitted.length, cycleStarts, missingFrames: pcm.missingFrames, gaps: pcm.gaps, firstFrame: pcm.firstFrame, lastFrame: pcm.lastFrame, player: player.getDiagnostics(), diagnostics: engine.getDiagnostics() }
        check(`${mode.name}: quick repeated melody overlapping chord and loop boundaries`, metrics, [
          ['at least four cycles render real uninterrupted nonzero PCM', cycleStarts.length >= 4 && metrics.actualRms > 0.03 && pcm.missingFrames === 0],
          ['native oscillator edges cancel against independent phase-matched reference', maximumResidual < 0.003 && metrics.residualRms < 0.0003],
          ['cycle boundaries use the native audio clock without accumulated drift', cycleStarts.every((time, index) => Math.abs(time - cycleStarts[0] - index * 0.18) < 1e-6)],
          ['normal lookahead playback skips no notes', metrics.player.skippedNotes === 0],
          ['disabling Loop completes the current cycle and releases all nodes', player.getState().status === 'stopped' && engine.getState().voiceCount === 0 && metrics.diagnostics.scheduledNoteCount === 0 && metrics.diagnostics.createdVoiceCount === metrics.diagnostics.destroyedVoiceCount],
        ])
      } finally {
        recorder?.close(); player.dispose()
        for (const reference of references) reference.gain.disconnect()
        await engine.dispose()
      }
    }

    const denseEngine = new SynthEngine(params)
    const densePlayer = new PhrasePlayer(denseEngine, () => {})
    try {
      const denseNotes = [0, 0.25].flatMap((start, chord) => Array.from({ length: 16 }, (_, index) => phraseNote(`dense:${chord}:${index}`, 48 + index, start, start + 0.2)))
      densePlayer.configure(denseNotes, 0.6, true)
      await densePlayer.play()
      let maximumManaged = 0; let maximumRetiring = 0; let maximumCarriers = 0; let maximumHeld = 0
      for (let index = 0; index < 180; index++) {
        const diagnostics = denseEngine.getDiagnostics()
        maximumManaged = Math.max(maximumManaged, diagnostics.managedCount)
        maximumRetiring = Math.max(maximumRetiring, diagnostics.retiringCount)
        maximumCarriers = Math.max(maximumCarriers, diagnostics.totalCarrierCount)
        maximumHeld = Math.max(maximumHeld, denseEngine.getState().heldCount)
        await sleep(8)
      }
      densePlayer.stop(); await waitForReleasedVoices(denseEngine)
      check('Repeated sixteen-note playback chords share bounded polyphony and clean up', { maximumManaged, maximumRetiring, maximumCarriers, maximumHeld, player: densePlayer.getDiagnostics(), diagnostics: denseEngine.getDiagnostics() }, [
        ['a complete sixteen-note chord is actually gated', maximumHeld === 16],
        ['managed and retiring native resources stay within engine limits', maximumManaged <= 16 && maximumRetiring <= 4 && maximumCarriers <= 40],
        ['multiple loop cycles allocate and retire real voices', denseEngine.getDiagnostics().createdVoiceCount >= 64],
        ['Stop clears native queued gates and every retiring carrier', denseEngine.getState().voiceCount === 0 && denseEngine.getDiagnostics().totalCarrierCount === 0 && denseEngine.getDiagnostics().scheduledNoteCount === 0 && denseEngine.getDiagnostics().createdVoiceCount === denseEngine.getDiagnostics().destroyedVoiceCount],
      ])
    } finally { densePlayer.dispose(); await denseEngine.dispose() }

    const engine = new SynthEngine(params)
    const player = new PhrasePlayer(engine, () => {})
    try {
      await engine.prepare()
      await engine.noteOnVoice(live('live', 72))
      player.configure([phraseNote('long', 60, 0, 0.8), phraseNote('future', 64, 0.25, 0.6)], 0.9, false)
      await player.play(); await sleep(120)
      player.pause()
      const paused = player.getState()
      await waitForReleasedVoices(engine)
      const pausePosition = player.getState().position
      const surviving = engine.getVoices()
      await player.play(); await sleep(55)
      const resumed = engine.getVoices().filter(voice => voice.origin === 'sequence' && voice.gateOpen)
      player.stop(); await waitForReleasedVoices(engine)
      check('Pause resume and Stop isolate playback from live input', { paused, pausePosition, resumed, surviving, afterStop: engine.getVoices() }, [
        ['Pause freezes the native-clock cursor', paused.status === 'paused' && paused.position > 0.07 && paused.position < 0.3 && pausePosition === paused.position],
        ['Pause removes sequence nodes while preserving the live note', surviving.length === 1 && surviving[0].id === 'live' && surviving[0].gateOpen],
        ['resume reopens the note containing the cursor once', resumed.length === 1 && resumed[0].midi === 60],
        ['Stop resets position and cancels all queued playback starts', player.getState().position === 0 && engine.getVoices().length === 1 && engine.getVoices()[0].id === 'live' && engine.getDiagnostics().scheduledFutureCount === 0],
      ])
      player.configure([phraseNote('cancel', 60, 0.08, 0.3)], 0.35, true)
      await player.play(); player.stop(); await sleep(150)
      check('Stop before a future native ON leaves no late sequence note', { diagnostics: engine.getDiagnostics() }, [['queued starts are cancelled rather than heard later', engine.getVoices().every(voice => voice.id === 'live') && engine.getDiagnostics().scheduledNoteCount === 0]])
      player.configure([phraseNote('suspend', 60, 0, 0.8)], 0.9, true)
      await player.play(); await sleep(70)
      const context = engine.getAnalysis().time.context
      await context.suspend(); await sleep(30)
      const suspended = player.getState()
      await context.resume(); await sleep(60)
      check('AudioContext suspension pauses playback without replaying a frozen tail', { suspended, afterResume: player.getState(), voices: engine.getVoices() }, [
        ['suspension sets a paused cursor', suspended.status === 'paused' && suspended.position > 0],
        ['resuming the context does not resume the sequence automatically', player.getState().status === 'paused' && engine.getVoices().every(voice => voice.origin !== 'sequence')],
      ])
      await player.play(); await sleep(40); engine.panic()
      const panicCleanup = await waitForReleasedVoices(engine)
      check('Direct Panic cancels transport timers and native schedules', { state: player.getState(), panicCleanup, diagnostics: engine.getDiagnostics() }, [['Panic stops transport and clears every audio node', panicCleanup.nativeTime >= panicCleanup.cleanupAt && player.getState().status === 'stopped' && engine.getState().voiceCount === 0 && engine.getDiagnostics().scheduledNoteCount === 0]])
      for (let index = 0; index < 30; index++) engine.scheduleMetronome(context.currentTime + 0.06 + index * 0.005, index === 0, 'count-in')
      const boundedTicks = engine.getDiagnostics().metronomeCount
      engine.cancelMetronome('count-in'); await sleep(100)
      check('Metronome count-in nodes are bounded and cancellable', { boundedTicks, afterCancel: engine.getDiagnostics().metronomeCount }, [['tick pool never exceeds eight and cancellation clears future ticks', boundedTicks <= 8 && boundedTicks > 0 && engine.getDiagnostics().metronomeCount === 0]])
    } finally { player.dispose(); await engine.dispose() }
    check('Player and engine disposal clears transport caches and native resources', { state: player.getState(), diagnostics: engine.getDiagnostics() }, [['disposed engine retains no voice schedule metronome or wave cache', engine.getDiagnostics().disposed && engine.getDiagnostics().totalCarrierCount === 0 && engine.getDiagnostics().scheduledNoteCount === 0 && engine.getDiagnostics().metronomeCount === 0 && engine.getDiagnostics().periodicWaveCacheSize === 0]])

    const suspendedEngine = new SynthEngine(params)
    let suspendedRecorder
    try {
      await suspendedEngine.prepare()
      const context = suspendedEngine.getAnalysis().time.context
      const pair = context.createChannelMerger(2)
      suspendedEngine.getAnalysis().time.connect(pair, 0, 0)
      suspendedRecorder = await createPcmRecorder(context, pair, { channels: 2 })
      await suspendedEngine.noteOnVoice(live('suspended-live', 60))
      suspendedEngine.voices.all[0].envelope.connect(pair, 0, 1)
      await sleep(90)
      await context.suspend()
      const resumedAt = context.currentTime
      suspendedEngine.panic()
      const immediate = suspendedEngine.getDiagnostics()
      const resumedAnalysis = suspendedEngine.getAnalysis().time
      resumedAnalysis.connect(pair, 0, 0)
      await context.resume()
      await sleep(90)
      await suspendedEngine.noteOnVoice(live('after-suspended-panic', 64))
      const freshStart = suspendedEngine.voices.all[0].startsAt
      await sleep(70)
      const pcm = await suspendedRecorder.stop()
      let beforePeak = 0; let afterPeak = 0; let afterSamples = 0; let afterVoicePeak = 0; let outputTailSeconds = 0; let freshPeak = 0
      for (let index = 0; index < pcm.samples.length; index++) {
        const time = (pcm.firstFrame + index) / pcm.sampleRate
        if (time < resumedAt) beforePeak = Math.max(beforePeak, Math.abs(pcm.samples[index]))
        else if (time < freshStart) {
          afterPeak = Math.max(afterPeak, Math.abs(pcm.samples[index]))
          afterVoicePeak = Math.max(afterVoicePeak, Math.abs(pcm.channels[1][index]))
          if (Math.abs(pcm.samples[index]) > 1e-7) outputTailSeconds = time - resumedAt
          ++afterSamples
        } else freshPeak = Math.max(freshPeak, Math.abs(pcm.samples[index]))
      }
      check('Panic during a suspended live note cannot replay its frozen tail', { resumedAt, freshStart, beforePeak, afterPeak, afterVoicePeak, outputTailSeconds, afterSamples, freshPeak, missingFrames: pcm.missingFrames, gaps: pcm.gaps, immediate }, [
        ['suspended Panic immediately clears held native voices and pending work', immediate.managedCount === 0 && immediate.retiringCount === 0 && immediate.totalCarrierCount === 0 && immediate.pendingCount === 0],
        ['the previously audible live note remains actual PCM silence after resume', beforePeak > 0.001 && afterSamples > pcm.sampleRate * 0.06 && afterPeak === 0 && pcm.missingFrames === 0],
        ['the current audible output remains connected for a new note', resumedAnalysis.context === context && freshPeak > 0.001],
      ])
    } finally { suspendedRecorder?.close(); await suspendedEngine.dispose() }

    const deferred = new SynthEngine(params)
    const deferredPlayer = new PhrasePlayer(deferred, () => {})
    const originalPrepare = deferred.prepare.bind(deferred)
    let releasePrepare
    const gate = new Promise(resolve => { releasePrepare = resolve })
    deferred.prepare = async () => { await originalPrepare(); await gate }
    deferredPlayer.configure([phraseNote('late', 60, 0, 0.2)], 0.25, true)
    const playing = deferredPlayer.play()
    await sleep(30); deferred.panic(); releasePrepare(); await playing; await sleep(40)
    check('Panic during asynchronous prepare invalidates the pending Play intent', { state: deferredPlayer.getState(), diagnostics: deferred.getDiagnostics() }, [['a delayed prepare cannot resurrect playback after Panic', deferredPlayer.getState().status === 'stopped' && deferred.getState().voiceCount === 0 && deferred.getDiagnostics().scheduledNoteCount === 0]])
    deferredPlayer.dispose(); await deferred.dispose()
    return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
  })
  const reportUrl = new URL(`../test-results/phrase-audio-${browserName}.json`, import.meta.url)
  const report = await runPcmSuite(run, reportUrl, { beforeRetry: async () => {
    await session.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    session = await startTestBrowser()
  } })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(reportUrl, JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Native phrase playback tests failed')
  console.log(`PASS: ${report.results.length} phrase audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally { await session.close() }
