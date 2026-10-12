import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser(), { page } = session
const results = [], errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
try {
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
    const getAnalysis = SynthEngine.prototype.getAnalysis
    SynthEngine.prototype.getAnalysis = function (...args) { trace.engine = this; return getAnalysis.apply(this, args) }
    const noteOn = SynthEngine.prototype.noteOnVoice
    SynthEngine.prototype.noteOnVoice = function (note) {
      trace.engine = this
      const input = { id: note.id, sourceId: note.sourceId, time: this.getAnalysis()?.time.context.currentTime ?? 0 }
      trace.inputs.push(input)
      return noteOn.call(this, note).then(() => {
        const voice = this.getVoices().find(voice => voice.id === note.id && voice.gateOpen)
        if (voice) trace.created.set(voice.instanceId, { id: voice.id, instanceId: voice.instanceId, createdAt: voice.createdAt, latency: voice.createdAt - input.time, frequency: voice.frequency, sourceId: voice.sourceId })
      })
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
  await page.evaluate(() => {
    for (const key of document.querySelectorAll('.piano-key')) { key.setPointerCapture = () => {}; key.hasPointerCapture = () => false }
  })

  for (const [name, expected] of [['midi-staccato', 16], ['pc-legato', 8], ['virtual-staccato', 8], ['midi-repeated', 24], ['mixed-chord', 9]]) {
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
      return { name, sampleRate: recording.sampleRate, firstFrame: recording.firstFrame, lastFrame: recording.lastFrame, missingFrames: recording.missingFrames, gaps: recording.gaps, samples: samples.length, peak, maxJump, p99, edge, jumpRatio: maxJump / Math.max(p99, 1e-8), requests: trace.inputs.length, created: [...trace.created.values()], retriggers: trace.retriggers, remaining: engine.getVoices().length, held: Number(document.querySelector('output[aria-label="Удерживаемые ноты"]')?.textContent) }
    }, name)
    assert.equal(metrics.requests, expected, `${name}: duplicate input generated another request`)
    assert.equal(metrics.created.length, expected, `${name}: wrong number of actual voices`)
    assert.equal(metrics.retriggers, 0, `${name}: a physical note unexpectedly retriggered an existing envelope`)
    assert.equal(metrics.remaining, 0); assert.equal(metrics.held, 0)
    assert.ok(metrics.created.every(voice => voice.latency >= 0 && voice.latency < 0.032), `${name}: input-to-voice latency ${JSON.stringify(metrics.created)}`)
    assert.ok(metrics.samples > 2000 && metrics.peak > 0.001)
    if (!process.env.SOUND_LAB_DECLICK_BASELINE) {
      if (metrics.missingFrames || !(metrics.maxJump < 0.01 && metrics.jumpRatio < 8)) {
        const userAgent = await page.evaluate(() => navigator.userAgent)
        await writeFile(`test-results/declick-ui-${userAgent.includes('Edg/') ? 'edge' : 'chrome'}-failure.json`, JSON.stringify({ metrics, errors, userAgent }, null, 2))
      }
      assert.equal(metrics.missingFrames, 0, `${name}: native PCM capture skipped frames ${JSON.stringify(metrics.gaps)}`)
      assert.ok(metrics.maxJump < 0.01 && metrics.jumpRatio < 8, `${name}: anomalous PCM edge ${JSON.stringify(metrics)}`)
    }
    results.push(metrics); console.log(`PASS ${name}`, JSON.stringify({ requests: metrics.requests, voices: metrics.created.length, peak: metrics.peak, maxJump: metrics.maxJump, jumpRatio: metrics.jumpRatio, maxLatencyMs: Math.max(...metrics.created.map(voice => voice.latency)) * 1000 }))
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
  console.log('PASS deferred native AudioContext resume cannot resurrect an already released MIDI note')
  assert.deepEqual(errors, [])
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await writeFile(`test-results/declick-ui-${userAgent.includes('Edg/') ? 'edge' : 'chrome'}${process.env.SOUND_LAB_DECLICK_BASELINE ? '-baseline' : ''}.json`, JSON.stringify({ results, errors, userAgent, deferredResumeCancellation: true }, null, 2))
  console.log(`All ${results.length + 1} SOUND LAB declick input scenarios passed.`)
} finally { await session.close() }
