import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'
import { runPcmSuite } from './pcm-harness.mjs'

let session, page
const results = [], errors = []
const browserName = testBrowserName(), runId = Date.now().toString(36)
const captureAttempts = [], invalidCaptures = []
let lastMetrics = null, deferredResumeCancellation = false
async function setupSession() {
  session = await startTestBrowser(); page = session.page
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.addInitScript(() => {
    class Port extends EventTarget {
      constructor() { super(); this.id = 'declick-controller'; this.name = 'Declick Test MIDI'; this.manufacturer = 'Simulated'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
    window.__sendMidi = raw => { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
  })
  await page.evaluate(() => localStorage.clear()); await page.reload()
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').findLast(item => item.name.includes('/src/audio/SynthEngine.ts'))?.name ?? '/src/audio/SynthEngine.ts'
    const { SynthEngine } = await import(moduleUrl)
    const trace = window.__declick = { engine: null, inputs: [], created: new Map(), retriggers: 0 }
    const NativeAudioWorkletNode = window.AudioWorkletNode
    window.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(context, name, options) {
        super(context, name, options)
        if (name !== 'sound-lab-envelope-v1') return
        this.port.addEventListener('message', event => {
          const record = trace.created.get(event.data.instanceId)
          if (record && event.data.type === 'state' && event.data.slot === record.controlAtAllocation.slot && event.data.generation === record.controlAtAllocation.generation) record.nativeControlStates.push(structuredClone(event.data))
        })
      }
    }
    const oscillatorStarts = new WeakMap()
    const oscillatorCreatedWall = new WeakMap()
    const createOscillator = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function (...args) {
      const createdWall = performance.now(), oscillator = createOscillator.apply(this, args), starts = []
      oscillatorStarts.set(oscillator, starts)
      oscillatorCreatedWall.set(oscillator, createdWall)
      const start = oscillator.start.bind(oscillator)
      oscillator.start = (...startArgs) => { starts.push({ calledAt: this.currentTime, calledWall: performance.now(), scheduledAt: startArgs[0] ?? this.currentTime }); return start(...startArgs) }
      return oscillator
    }
    const getAnalysis = SynthEngine.prototype.getAnalysis
    SynthEngine.prototype.getAnalysis = function (...args) { trace.engine = this; return getAnalysis.apply(this, args) }
    const noteOn = SynthEngine.prototype.noteOnVoice
    SynthEngine.prototype.noteOnVoice = function (note) {
      trace.engine = this
      const input = { id: note.id, sourceId: note.sourceId, wall: performance.now(), time: this.getAnalysis()?.time.context.currentTime ?? 0, instanceId: null }
      trace.inputs.push(input)
      return noteOn.call(this, note).then(() => {
        input.resolvedAt = this.getAnalysis()?.time.context.currentTime ?? null
        const record = trace.created.get(input.instanceId)
        if (record) record.completion = { at: input.resolvedAt, wall: performance.now(), startsAt: record.voice.startsAt, gateOpen: record.voice.gateOpen, control: record.voice.getEnvelopeControlState() }
      })
    }
    const managerUrl = performance.getEntriesByType('resource').findLast(item => item.name.includes('/src/audio/VoiceManager.ts'))?.name ?? '/src/audio/VoiceManager.ts'
    const { VoiceManager } = await import(managerUrl), add = VoiceManager.prototype.add
    VoiceManager.prototype.add = function (voice) {
      const result = add.call(this, voice)
      const input = trace.inputs.findLast(input => input.instanceId === null && input.id === voice.note.id && input.sourceId === voice.note.sourceId)
      if (!input) throw new Error(`Native voice allocation has no matching input: ${voice.note.id}`)
      input.instanceId = voice.instanceId
      const context = voice.envelope.context
      const starts = oscillatorStarts.get(voice.carrier.oscillator)
      if (!starts) throw new Error('Native carrier was constructed before the start-event instrumentation')
      const record = { id: voice.note.id, instanceId: voice.instanceId, createdAt: voice.createdAt, carrierCreatedWall: oscillatorCreatedWall.get(voice.carrier.oscillator), allocationWall: performance.now(), allocationAt: context.currentTime, latency: voice.createdAt - input.time, frequency: voice.note.frequency, sourceId: voice.note.sourceId, controlAtAllocation: voice.getEnvelopeControlState(), starts, stops: [], plans: [], controlStates: [], nativeControlStates: [], completion: null, destruction: null }
      Object.defineProperty(record, 'voice', { value: voice })
      trace.created.set(voice.instanceId, record)
      voice.envelopeControl.port.addEventListener('message', event => record.controlStates.push(structuredClone(event.data)))
      const postMessage = voice.envelopeControl.port.postMessage.bind(voice.envelopeControl.port)
      voice.envelopeControl.port.postMessage = (...args) => { if (args[0]?.type === 'plan') record.plans.push({ at: context.currentTime, wall: performance.now(), plan: structuredClone(args[0]) }); return postMessage(...args) }
      const destroy = voice.destroy.bind(voice)
      voice.destroy = (...args) => {
        record.destruction ??= { at: context.currentTime, wall: performance.now(), startsAt: voice.startsAt, gateOpen: voice.gateOpen, control: voice.getEnvelopeControlState() }
        return destroy(...args)
      }
      return result
    }
    const noteOff = SynthEngine.prototype.noteOffVoice
    SynthEngine.prototype.noteOffVoice = function (id, ...args) {
      const voice = this.voices.findHeld(id), record = voice && trace.created.get(voice.instanceId)
      if (record) record.stops.push({ at: voice.envelope.context.currentTime, wall: performance.now(), startsAt: voice.startsAt, gateOpen: voice.gateOpen, control: voice.getEnvelopeControlState() })
      return noteOff.call(this, id, ...args)
    }
    const voiceUrl = performance.getEntriesByType('resource').findLast(item => item.name.includes('/src/audio/SynthVoice.ts'))?.name ?? '/src/audio/SynthVoice.ts'
    const { SynthVoice } = await import(voiceUrl), retrigger = SynthVoice.prototype.retrigger
    SynthVoice.prototype.retrigger = function (...args) { trace.retriggers++; return retrigger.apply(this, args) }
  })
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  for (const [name, value] of [['Нарастание', 0.005], ['Спад', 0.01], ['Удержание', 100], ['Затухание', 0.01]]) {
    const input = page.getByRole('spinbutton', { name: `${name}, значение`, exact: true }); await input.fill(String(value)); await input.press('Enter')
  }
  await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: /^Sine/ }).click()
  await page.evaluate(async () => {
    const trace = window.__declick, before = performance.now()
    // Report cold context/module preparation separately. The musical input
    // patterns below exercise a genuinely running, pre-ready native context.
    await trace.engine.prepare()
    trace.preparation = { wallMilliseconds: performance.now() - before, state: trace.engine.getState(), diagnostics: trace.engine.getDiagnostics() }
  })
  await page.evaluate(() => {
    for (const key of document.querySelectorAll('.piano-key')) { key.setPointerCapture = () => {}; key.hasPointerCapture = () => false }
  })
}

try {
  await setupSession()
  for (const [name, expected] of [['midi-staccato', 16], ['pc-legato', 8], ['virtual-staccato', 8], ['midi-repeated', 24], ['mixed-chord', 9]]) {
    let attempt = 0
    const reportUrl = new URL(`../test-results/declick-ui-${browserName}-${name}-${runId}.json`, import.meta.url)
    const report = await runPcmSuite(async () => {
      attempt++
      const metrics = await page.evaluate(async name => {
      const { createPcmRecorder } = await import('/tests/pcm-recorder.mjs')
      const trace = window.__declick, engine = trace.engine, analysis = engine.getAnalysis(), context = analysis.time.context
      engine.panic(); await new Promise(resolve => setTimeout(resolve, 60))
      trace.inputs = []; trace.created = new Map(); trace.retriggers = 0
      const recorder = await createPcmRecorder(context, analysis.time), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const midiOn = note => window.__sendMidi([0x90, note, 100]), midiOff = note => window.__sendMidi([0x80, note, 0])
      const pc = (code, down, repeat = false) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), repeat, bubbles: true }))
      const pointer = (offset, id, down) => document.querySelectorAll('.piano-key')[offset].dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', { pointerId: id, pointerType: 'touch', button: 0, buttons: down ? 1 : 0, bubbles: true }))
      await wait(50)
      if (name === 'midi-staccato') for (const note of [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60]) {
        midiOn(note); midiOn(note); await wait(28); midiOff(note); midiOff(note); await wait(20)
      }
      if (name === 'pc-legato') {
        let previous = null
        for (const code of ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG']) {
          pc(code, true); pc(code, true, true); await wait(10); if (previous) pc(previous, false); previous = code; await wait(20)
        }
        pc(previous, false)
      }
      if (name === 'virtual-staccato') for (const offset of [0, 2, 4, 7, 7, 4, 2, 0]) {
        pointer(offset, 31, true); pointer(offset, 31, true); await wait(28); pointer(offset, 31, false)
        document.querySelectorAll('.piano-key')[offset].dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 31, bubbles: true })); await wait(20)
      }
      if (name === 'midi-repeated') for (let i = 0; i < 24; i++) { midiOn(60); await wait(18); midiOff(60); await wait(2) }
      if (name === 'mixed-chord') {
        for (const note of [60, 64, 67]) midiOn(note)
        pc('KeyA', true); pc('KeyD', true); pointer(0, 41, true); await wait(45)
        const before = engine.getVoices().filter(voice => voice.gateOpen).map(voice => voice.instanceId)
        midiOff(64); await wait(8)
        const after = engine.getVoices().filter(voice => voice.gateOpen).map(voice => voice.instanceId)
        if (before.length !== 6 || after.length !== 5 || after.some(id => !before.includes(id))) throw new Error('Releasing one chord note restarted or stopped another source')
        midiOn(65); pc('KeyW', true); pointer(2, 42, true); await wait(45)
        for (const note of [60, 65, 67]) midiOff(note)
        for (const code of ['KeyA', 'KeyD', 'KeyW']) pc(code, false)
        pointer(0, 41, false); pointer(2, 42, false)
      }
      await wait(90)
      const recording = await recorder.stop(); recorder.close()
      const samples = recording.samples, differences = Array.from(samples.slice(1), (sample, index) => Math.abs(sample - samples[index]))
      const sorted = [...differences].sort((a, b) => a - b), maxJump = sorted.at(-1) ?? 0, p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
      const edgeIndex = differences.indexOf(maxJump) + 1
      const edge = { index: edgeIndex, frame: recording.firstFrame + edgeIndex, time: (recording.firstFrame + edgeIndex) / recording.sampleRate, before: Array.from(samples.slice(Math.max(0, edgeIndex - 18), edgeIndex)), after: Array.from(samples.slice(edgeIndex, edgeIndex + 18)), blockOffset: (recording.firstFrame + edgeIndex) % 128 }
      const peak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
      return { name, sampleRate: recording.sampleRate, firstFrame: recording.firstFrame, lastFrame: recording.lastFrame, missingFrames: recording.missingFrames, gaps: recording.gaps, samples: samples.length, peak, maxJump, p99, edge, jumpRatio: maxJump / Math.max(p99, 1e-8), preparation: trace.preparation, requests: trace.inputs.length, inputs: trace.inputs, created: [...trace.created.values()], retriggers: trace.retriggers, remaining: engine.getVoices().length, held: Number(document.querySelector('output[aria-label="Удерживаемые ноты"]')?.textContent) }
      }, name)
      lastMetrics = metrics
      const checks = [
        { description: 'duplicate input creates no additional request', passed: metrics.requests === expected },
        { description: 'actual voice count matches inputs', passed: metrics.created.length === expected },
        { description: 'physical notes never retrigger another envelope', passed: metrics.retriggers === 0 },
        { description: 'all voices finish', passed: metrics.remaining === 0 },
        { description: 'all held keys release', passed: metrics.held === 0 },
        { description: 'every input-to-voice latency remains below 32 ms', passed: metrics.created.every(voice => voice.latency >= 0 && voice.latency < 0.032) },
        { description: 'every warm musical input starts its actual native carrier exactly once', passed: metrics.created.length === expected && metrics.created.every(voice => voice.starts.length === 1) },
        { description: 'every warm input schedules its actual carrier onset below 32 ms', passed: metrics.created.every(voice => { const input = metrics.inputs.find(input => input.instanceId === voice.instanceId), start = voice.starts[0]; return start && start.scheduledAt >= input.time && start.scheduledAt - input.time < 0.032 }) },
        { description: 'short musical inputs schedule Release after onset and retire only after latest native rendered zero', passed: metrics.created.every(voice => {
          const start = voice.starts[0], state = voice.destruction?.control
          const releases = voice.plans.flatMap(({ plan }) => plan.ramps.filter(ramp => ramp.phase === 'release').map(ramp => ({ revision: plan.revision, ...ramp })))
          return start && voice.destruction && voice.destruction.at >= start.scheduledAt && voice.stops.length > 0 && releases.length > 0 && releases.every(release => release.start >= start.scheduledAt)
            && state?.zero && state.connected && !state.destroyed && state.acknowledgedRevision === state.revision
            && Number.isSafeInteger(state.appliedFrame) && Number.isSafeInteger(state.endFrame) && Number.isSafeInteger(state.zeroFrame) && state.zeroFrame >= Math.max(state.appliedFrame, state.endFrame)
            && Number.isSafeInteger(state.renderedThroughFrame) && state.renderedThroughFrame >= state.zeroFrame + 127
            && voice.nativeControlStates.some(packet => packet.slot === state.slot && packet.generation === state.generation && packet.instanceId === state.instanceId && packet.revision === state.revision && packet.appliedFrame === state.appliedFrame && packet.endFrame === state.endFrame && packet.zeroFrame === state.zeroFrame && packet.renderedThroughFrame === state.renderedThroughFrame)
        }) },
        { description: 'native PCM contains enough samples and audible signal', passed: metrics.samples > 2000 && metrics.peak > 0.001 },
        { description: 'browser has no console or page errors', passed: errors.length === 0 },
      ]
      const structuralFailures = checks.filter(check => !check.passed)
      if (!process.env.SOUND_LAB_DECLICK_BASELINE) checks.push(
        { description: 'native PCM capture contains no missing frames', passed: metrics.missingFrames === 0 },
        { description: 'PCM edge remains below 0.01 and eight times p99', passed: metrics.maxJump < 0.01 && metrics.jumpRatio < 8 },
      )
      const userAgent = await page.evaluate(() => navigator.userAgent)
      const attemptUrl = new URL(reportUrl.href.replace(/\.json$/, `-attempt${attempt}.json`))
      const value = { results: [{ name, metrics, checks }], errors: [...errors], userAgent }
      // Persist before assertions too: structural errors are fatal even if the
      // native PCM capture has a gap. Only the unusable capture may be retried.
      await writeFile(attemptUrl, JSON.stringify(value, null, 2))
      captureAttempts.push({ name, attempt, report: attemptUrl.pathname.split('/').at(-1), missingFrames: metrics.missingFrames })
      if (metrics.missingFrames > 0) invalidCaptures.push({ name, attempt, missingFrames: metrics.missingFrames, gaps: metrics.gaps })
      assert.deepEqual(structuralFailures, [], `${name}: input, cleanup or browser assertion failed`)
      return value
    }, reportUrl, {
      beforeRetry: async () => {
        await session.close(); session = null
        await setupSession()
      },
    })
    await writeFile(reportUrl, JSON.stringify(report, null, 2))
    assert.deepEqual(report.failures, [], `${name}: failed native PCM assertions; see ${reportUrl.pathname}`)
    const selected = report.results[0]
    const metrics = { ...selected.metrics, captureAttempt: selected.captureAttempt }
    results.push(metrics); console.log(`PASS ${name}`, JSON.stringify({ requests: metrics.requests, voices: metrics.created.length, peak: metrics.peak, maxJump: metrics.maxJump, jumpRatio: metrics.jumpRatio, maxLatencyMs: Math.max(...metrics.created.map(voice => voice.latency)) * 1000, captureAttempt: metrics.captureAttempt }))
  }

  await page.evaluate(async () => {
    const trace = window.__declick, context = trace.engine.getAnalysis().time.context
    await context.suspend()
    const resume = context.resume.bind(context)
    let release
    context.resume = () => new Promise(resolve => { release = () => resume().then(resolve) })
    window.__sendMidi([0x90, 60, 100]); window.__sendMidi([0x80, 60, 0])
    if (!release) throw new Error('Deferred resume was not exercised')
    await release(); context.resume = resume
    await new Promise(resolve => setTimeout(resolve, 60))
    if (trace.engine.getVoices().length || trace.engine.getState().pendingCount) throw new Error('Cancelled input resurrected after deferred resume')
  })
  deferredResumeCancellation = true
  console.log('PASS deferred native AudioContext resume cannot resurrect an already released MIDI note')
  assert.deepEqual(errors, [])
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await writeFile(`test-results/declick-ui-${browserName}${process.env.SOUND_LAB_DECLICK_BASELINE ? '-baseline' : ''}.json`, JSON.stringify({ results, errors, userAgent, deferredResumeCancellation, captureAttempts, invalidCaptures }, null, 2))
  console.log(`All ${results.length + 1} SOUND LAB declick input scenarios passed.`)
} catch (error) {
  // Never overwrite evidence from an earlier failed run.
  await writeFile(`test-results/declick-ui-${browserName}-failure-${runId}.json`, JSON.stringify({ results, metrics: lastMetrics, errors, error: String(error), deferredResumeCancellation, captureAttempts, invalidCaptures }, null, 2))
  throw error
} finally { await session?.close() }
