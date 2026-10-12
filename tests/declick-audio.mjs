import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'
import { runPcmSuite } from './pcm-harness.mjs'

const browserName = /msedge/i.test(process.env.SOUND_LAB_BROWSER || '') ? 'edge' : 'chrome'
const leadOverride = process.env.SOUND_LAB_CONTROL_LEAD_FRAMES
const explicitHold = process.env.SOUND_LAB_EXPLICIT_HOLD === '1'
if (leadOverride !== undefined && !['0', '128', '256'].includes(leadOverride)) throw new Error('Test-only lead override must be 0, 128 or 256')
let session = await startTestBrowser()
const configureRoute = async () => {
  if (leadOverride !== undefined || explicitHold) {
    await session.page.route('**/src/audio/SynthVoice.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      let body = source
      if (leadOverride !== undefined) { assert.match(body, /CONTROL_LEAD_FRAMES\s*=\s*(128|256)\b/); body = body.replace(/CONTROL_LEAD_FRAMES\s*=\s*(128|256)\b/, `CONTROL_LEAD_FRAMES = ${leadOverride}`) }
      if (explicitHold && /if\s*\(typeof param\.cancelAndHoldAtTime\s*===\s*["']function["']\)/.test(body)) body = body.replace(/if\s*\(typeof param\.cancelAndHoldAtTime\s*===\s*["']function["']\)/, 'if (false)')
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
              const record = { at: voice.startsAt, createdAt: voice.createdAt, allocatedAt: voice.allocatedAt ?? voice.startsAt - nativeControlLead, frequency: voice.note.frequency, id: voice.note.id, slot: records.length + 1, releases: [], firstAudible: null, automation: [] }
              records.push(record)
              for (const method of ['cancelAndHoldAtTime', 'cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']) {
                const native = voice.envelope.gain[method].bind(voice.envelope.gain)
                voice.envelope.gain[method] = (...args) => { const before = patternContext.currentTime; const result = native(...args); record.automation.push({ method, args, before, after: patternContext.currentTime }); return result }
              }
              voice.envelope.connect(pair, 0, 0)
              voice.envelope.connect(pair, 0, record.slot + 10)
              voice.carrier.gain.connect(pair, 0, record.slot)
              const release = voice.release.bind(voice)
              voice.release = (seconds, force = false) => {
                const wasGated = voice.gateOpen
                release(seconds, force)
                if (!wasGated && !force) return
                const releaseRamp = voice.envelopeRamps.find(ramp => ramp.phase === 'release')
                const at = releaseRamp.start
                const from = envelopeAt(record, at)
                const end = releaseRamp.end
                record.releases.push({ at, from, duration: end - at })
              }
              add(voice)
            }
            const on = async (id, midi) => patternEngine.noteOnVoice({ id, midi, frequency: 440 * 2 ** ((midi - 69) / 12), velocity: 127, sourceId: 'probe', sourceName: 'PCM note pattern', channel: 1, origin: 'midi' })
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
              if (Math.abs(residual) > maximumResidual) { maximumResidual = Math.abs(residual); worst = { time, actual, expected, components: records.map(record => ({ id: record.id, at: record.at, releases: record.releases, raw: pcm.channels[record.slot][index], actual: pcm.channels[record.slot + 10][index], envelope: envelopeAt(record, time) })) } }
              residualPower += residual * residual
              actualPower += actual * actual
              if (index) for (const record of records) {
                const raw = pcm.channels[record.slot][index]
                const previousRaw = pcm.channels[record.slot][index - 1]
                if (record.firstAudible === null && Math.abs(raw) > 0.2 && Math.abs(pcm.channels[record.slot + 10][index] / raw) > 0.001) record.firstAudible = time
                if (Math.abs(raw) < 0.2 || Math.abs(previousRaw) < 0.2) continue
                const step = pcm.channels[record.slot + 10][index] / raw - pcm.channels[record.slot + 10][index - 1] / previousRaw
                if (Math.abs(step) > maximumEnvelopeStep) { maximumEnvelopeStep = Math.abs(step); worstStep = { time, id: record.id, at: record.at, releases: record.releases, automation: record.automation, step } }
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
            const voiceOnsets = records.map(({ id, createdAt, allocatedAt, at, firstAudible }) => ({ id, createdAt, allocatedAt, startsAt: at, firstAudible }))
            const metrics = { maximumResidual, residualRms: Math.sqrt(residualPower / testedFrames), actualRms: Math.sqrt(actualPower / testedFrames), frames: testedFrames, missingFrames: pcm.missingFrames, gaps: pcm.gaps, createdVoices: records.length, maximumEnvelopeStep, maximumMusicalStep, maximumAttackLatency, maximumAllocationTime, maximumScheduledOnsetDelay, onsetDeliveryLimit, voiceOnsets, worstStep, worst, diagnostics: patternEngine.getDiagnostics() }
            check(`${mode.name}: ${timing.name} staccato legato repeats and chord releases`, metrics, [
              ['native PCM contains the complete uninterrupted audible pattern', testedFrames > patternContext.sampleRate * 0.4 && metrics.actualRms > 0.01 && pcm.missingFrames === 0],
              ['ordinary carrier edges cancel and actual envelope has no nonmusical single-sample jump', maximumEnvelopeStep <= maximumMusicalStep + 0.000002],
              ['scheduled Attack onset follows within one delivery quantum plus measurement threshold', maximumScheduledOnsetDelay >= 0 && maximumScheduledOnsetDelay <= onsetDeliveryLimit],
              ['duplicate events create no extra voice', records.length === 10],
              ['all independent releases finish with no surviving node', patternEngine.getState().voiceCount === 0 && patternEngine.getDiagnostics().totalCarrierCount === 0 && patternEngine.getDiagnostics().createdVoiceCount === patternEngine.getDiagnostics().destroyedVoiceCount],
            ])
          } finally {
            patternRecorder?.close()
            await patternEngine.dispose()
          }
        }
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
        let gainAtDestroy = null
        const destroy = victim.destroy.bind(victim)
        victim.destroy = () => { gainAtDestroy = victim.envelope.gain.value; destroy() }
        await sleep(60)
        const burst = Promise.all(Array.from({ length: 32 }, (_, index) => on(`burst:${index}`, 60 + index % 12)))
        let maximumManaged = 0; let maximumRetiring = 0; let maximumCarriers = 0
        for (let index = 0; index < 25; index++) {
          const diagnostics = stressEngine.getDiagnostics()
          maximumManaged = Math.max(maximumManaged, diagnostics.managedCount)
          maximumRetiring = Math.max(maximumRetiring, diagnostics.retiringCount)
          maximumCarriers = Math.max(maximumCarriers, diagnostics.totalCarrierCount)
          await sleep(5)
        }
        await burst
        const pcm = await stressRecorder.stop()
        const metrics = ratioError(pcm, victim.releasingAt, elapsed => 0.7 * Math.max(0, 1 - elapsed / 0.012))
        check('A saturated synchronous burst retires the oldest audible voice through a real fade', { ...metrics, gainAtDestroy, maximumManaged, maximumRetiring, maximumCarriers }, [
          ['retiring tail has a continuous twelve-millisecond envelope', metrics.count > 100 && metrics.maximumError < 0.003 && metrics.maximumStep < 0.7 / (0.012 * pcm.sampleRate) + 0.000002 && metrics.missingFrames === 0],
          ['the native gain is zero before its oscillator is destroyed', gainAtDestroy === 0],
          ['queued admissions preserve managed retiring and carrier bounds', maximumManaged <= 16 && maximumRetiring <= 4 && maximumCarriers <= 40],
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
          ['Panic removes pending admissions voices and every carrier', stressEngine.getState().pendingCount === 0 && stressEngine.getState().voiceCount === 0 && stressEngine.getDiagnostics().totalCarrierCount === 0 && stressEngine.getDiagnostics().createdVoiceCount === stressEngine.getDiagnostics().destroyedVoiceCount],
        ])
      } finally { stressRecorder?.close(); await stressEngine.dispose() }
      return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
    } finally {
      recorder?.close()
      await engine.dispose()
    }
  })
  const reportUrl = new URL(`../test-results/declick-audio-${browserName}${leadOverride === undefined ? '' : `-lead${leadOverride}`}${explicitHold ? '-explicitHold' : ''}.json`, import.meta.url)
  const report = await runPcmSuite(run, reportUrl, { beforeRetry: async () => {
    await session.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    session = await startTestBrowser()
    await configureRoute()
  } })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(reportUrl, JSON.stringify({ browser: browserName, controlLeadOverride: leadOverride === undefined ? null : Number(leadOverride), explicitHold, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Native PCM transition tests failed')
  console.log(`PASS: ${report.results.length} PCM scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally { await session.close() }
