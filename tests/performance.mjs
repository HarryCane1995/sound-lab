import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

// Isolated native browser profile. Only the MIDI port is simulated; rendering,
// all audio nodes, FFT, scheduling, recording and React controls remain real.
await mkdir('test-results', { recursive: true })
const browserName = testBrowserName()
const session = await startTestBrowser({ workspace: 'studio' })
const { page } = session
await page.setViewportSize({ width: 1920, height: 1080 })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
const checks = [], phases = []
const check = (name, passed, metrics = {}) => { checks.push({ name, passed: Boolean(passed), metrics }); assert.ok(passed, `${name}: ${JSON.stringify(metrics)}`) }
await page.addInitScript(() => {
  localStorage.setItem('sound-lab.workspace.v1', 'studio')
  localStorage.setItem('sound-lab.midi.v1', JSON.stringify({ version: 1, selectedInput: null, bindings: [{ id: 'perf-cutoff', target: 'filter.cutoff', sourceId: 'performance-midi', sourceName: 'Performance MIDI', channel: 1, kind: 'cc', number: 74, mode: 'absolute' }] }))
  class Port extends EventTarget {
    constructor() { super(); this.id = 'performance-midi'; this.name = 'Performance MIDI'; this.manufacturer = 'Simulated test'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed' }
    async open() { this.connection = 'open'; return this }
    async close() { this.connection = 'closed'; return this }
  }
  const port = new Port(), access = new EventTarget()
  access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
  window.__performanceMidi = raw => { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) }
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
  const NativeContext = window.AudioContext
  window.__performanceContexts = []
  window.AudioContext = new Proxy(NativeContext, { construct(Target, args) { const context = Reflect.construct(Target, args); window.__performanceContexts.push(context); return context } })
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
const metrics = async () => {
  const data = await cdp.send('Performance.getMetrics')
  const selected = Object.fromEntries(data.metrics.filter(item => ['JSHeapUsedSize', 'JSHeapTotalSize', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'Frames', 'Nodes'].includes(item.name)).map(item => [item.name, item.value]))
  return { ...selected, dom: await cdp.send('Memory.getDOMCounters') }
}
const diagnostic = () => page.evaluate(() => document.querySelector('.gpu-canvas')?.gpuDiagnostics?.())
const samplePhase = async (name, milliseconds) => {
  const before = await metrics()
  const gpuBefore = await diagnostic()
  const samples = await page.evaluate(async milliseconds => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const start = performance.now(), samples = []
    while (performance.now() - start < milliseconds) {
      await sleep(Math.min(2000, milliseconds - (performance.now() - start)))
      const gpu = document.querySelector('.gpu-canvas')?.gpuDiagnostics?.()
      samples.push({ atMs: performance.now() - start, gpu, voices: window.__performanceEngine?.getVoices().filter(voice => !voice.retiring).length ?? 0, contexts: window.__performanceContexts.length, contextState: window.__performanceEngine?.getAudioClock()?.state })
    }
    return samples
  }, milliseconds)
  const after = await metrics()
  const gpuAfter = samples.at(-1)?.gpu
  const rendered = (gpuAfter?.renderedFrames ?? 0) - (gpuBefore?.renderedFrames ?? 0)
  const renderCpu = (gpuAfter?.meanFrameMs ?? 0) * (gpuAfter?.renderedFrames ?? 0) - (gpuBefore?.meanFrameMs ?? 0) * (gpuBefore?.renderedFrames ?? 0)
  const summary = { measuredDurationMs: samples.at(-1)?.atMs, renderedFrames: rendered, fps: rendered * 1000 / (samples.at(-1)?.atMs || milliseconds), meanFrameCPUms: rendered ? renderCpu / rendered : 0, p95RecentFrameCPUms: gpuAfter?.p95FrameMs, drawCalls: gpuAfter?.drawCalls, effectiveQuality: gpuAfter?.effectiveQuality, historyWrites: (gpuAfter?.historyWrites ?? 0) - (gpuBefore?.historyWrites ?? 0), ringTurnovers: ((gpuAfter?.historyWrites ?? 0) - (gpuBefore?.historyWrites ?? 0)) / (gpuAfter?.capacity || 96), heapDeltaBytes: after.JSHeapUsedSize - before.JSHeapUsedSize, mainThreadTaskMs: (after.TaskDuration - before.TaskDuration) * 1000 }
  const phase = { name, durationMs: milliseconds, before, after, samples, summary }
  phases.push(phase)
  check(`${name}: native renderer and sound stay active`, samples.every(sample => sample.gpu?.webgl2 && sample.gpu.running && sample.gpu.drawCalls > 0 && sample.gpu.rms > 0.00001 && sample.contextState === 'running'), phase)
  check(`${name}: sampled GPU resources and AudioContext stay bounded`, samples.every(sample => sample.contexts === 1 && sample.gpu.ringCount <= sample.gpu.capacity && sample.gpu.capacity === 96 && sample.gpu.geometries <= 3 && sample.gpu.textures === 0 && sample.gpu.drawCalls <= 3 && sample.gpu.liveScenes === 1), phase)
  if (milliseconds >= 120000) check(`${name}: repeated ring reuse without extreme JS heap growth`, summary.ringTurnovers >= 5 && summary.heapDeltaBytes < 128 * 1024 * 1024, summary)
  console.log(`PERF ${name}`, JSON.stringify(summary))
  return phase
}

try {
  await page.reload()
  await page.getByRole('button', { name: 'Studio', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.gpu-canvas')?.gpuDiagnostics?.().webgl2)
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').findLast(item => item.name.includes('/src/audio/SynthEngine.ts'))?.name ?? '/src/audio/SynthEngine.ts'
    const { SynthEngine } = await import(moduleUrl), original = SynthEngine.prototype.getAnalysis
    SynthEngine.prototype.getAnalysis = function (...args) { window.__performanceEngine = this; return original.apply(this, args) }
    const setParams = SynthEngine.prototype.setParams
    window.__performanceParamCommits = 0
    window.__performanceParamCommitDurations = []
    SynthEngine.prototype.setParams = function (params) {
      window.__performanceParamCommits++
      window.__performanceParams = structuredClone(params)
      // Time the actual engine call separately from the test-only readback copy.
      const begin = performance.now()
      try { return setParams.call(this, params) }
      finally { window.__performanceParamCommitDurations.push(performance.now() - begin) }
    }
    window.__performanceLongTasks = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      window.__performanceObserver = new PerformanceObserver(list => window.__performanceLongTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))))
      window.__performanceObserver.observe({ type: 'longtask', buffered: true })
    }
  })
  await page.getByRole('button', { name: 'MIDI Monitor и привязки', exact: true }).click()
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await page.getByRole('button', { name: 'Закрыть MIDI Monitor', exact: true }).click()
  await page.waitForFunction(() => window.__performanceEngine?.getAudioClock()?.state === 'running')
  await page.evaluate(() => { for (let midi = 48; midi < 64; midi++) window.__performanceMidi([0x90, midi, 100]) })
  await page.waitForFunction(() => window.__performanceEngine.getVoices().filter(voice => !voice.retiring).length === 16)
  check('16 MIDI voices share the single existing AudioContext', await page.evaluate(() => window.__performanceContexts.length === 1), await page.evaluate(() => ({ contexts: window.__performanceContexts.map(context => context.state), engine: window.__performanceEngine.getDiagnostics() })))
  await samplePhase('16 voices + Waveform 3D', 4000)
  await page.getByRole('button', { name: 'Spectral Landscape', exact: true }).click()
  await samplePhase('16 voices + Spectral Landscape', 4000)
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  const ccLatency = await page.evaluate(async () => {
    const values = []
    for (let i = 0; i < 96; i++) {
      const begin = performance.now()
      window.__performanceMidi([0xb0, 74, i % 128])
      const dispatched = performance.now()
      await new Promise(resolve => requestAnimationFrame(resolve))
      values.push({ dispatchMs: dispatched - begin, nextFrameMs: performance.now() - begin })
    }
    return { samples: values, cutoff: window.__performanceParams.filter.cutoff, bypass: window.__performanceParams.filter.bypass, displayed: document.querySelector('.knob[data-parameter="filter.cutoff"] input[type="number"]')?.value, engine: window.__performanceEngine.getDiagnostics(), gpu: document.querySelector('.gpu-canvas').gpuDiagnostics() }
  })
  const expectedCutoff = 20 * 1000 ** (95 / 127)
  check('Saved MIDI CC Cutoff mapping responds while GPU and 16 voices run', !ccLatency.bypass && Math.abs(ccLatency.cutoff - expectedCutoff) < 1 && Math.abs(Number(ccLatency.displayed) - expectedCutoff) < 1 && ccLatency.gpu.running, ccLatency)
  const harmonicStress = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('.compact-harmonic-slider')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const dispatchTimingsMs = [], nextFrameTimingsMs = [], batchCommits = []
    const commitsBefore = window.__performanceParamCommits
    const commitDurationsBefore = window.__performanceParamCommitDurations.length
    for (let pass = 0; pass < 24; pass++) {
      const begin = performance.now()
      const batchBefore = window.__performanceParamCommits
      inputs.forEach((input, index) => { setter.call(input, String((pass + index) % 3 === 0 ? 100 : (pass * 7 + index * 3) % 70)); input.dispatchEvent(new Event('input', { bubbles: true })) })
      dispatchTimingsMs.push(performance.now() - begin)
      // Includes deferred audio/React commits before the next rendering opportunity.
      await new Promise(resolve => requestAnimationFrame(resolve))
      nextFrameTimingsMs.push(performance.now() - begin)
      await new Promise(resolve => setTimeout(resolve, 32))
      batchCommits.push(window.__performanceParamCommits - batchBefore)
    }
    return { inputs: inputs.length, dispatchTimingsMs, nextFrameTimingsMs, paramCommitTimingsMs: window.__performanceParamCommitDurations.slice(commitDurationsBefore), batchCommits, paramCommits: window.__performanceParamCommits - commitsBefore, mode: window.__performanceParams.mode, levels: window.__performanceParams.additive.levels, gpu: document.querySelector('.gpu-canvas').gpuDiagnostics(), engine: window.__performanceEngine.getDiagnostics() }
  })
  check('Rapid changes across all16 actual harmonic controls coalesce and stay bounded', harmonicStress.inputs === 16 && harmonicStress.paramCommits > 0 && harmonicStress.paramCommits <= 24 && harmonicStress.batchCommits.every(commits => commits <= 1) && harmonicStress.mode === 'additive' && harmonicStress.levels.every((level, index) => level === ((23 + index) % 3 === 0 ? 100 : (23 * 7 + index * 3) % 70)) && harmonicStress.gpu.running && harmonicStress.gpu.geometries <= 3, harmonicStress)
  await samplePhase('Long run:16 voices + additive + GPU', 120000)
  const beforeCycles = await page.evaluate(() => ({ ids: window.__performanceEngine.getVoices().map(voice => voice.instanceId), contexts: window.__performanceContexts.length, gpu: document.querySelector('.gpu-canvas').gpuDiagnostics() }))
  const cycles = []
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.gpu-canvas'))
    await page.getByRole('button', { name: 'Studio', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.gpu-canvas')?.gpuDiagnostics?.().running)
    cycles.push(await diagnostic())
  }
  const afterCycles = await page.evaluate(() => ({ ids: window.__performanceEngine.getVoices().map(voice => voice.instanceId), contexts: window.__performanceContexts.length, gpu: document.querySelector('.gpu-canvas').gpuDiagnostics() }))
  check('Studio/Learn cycles dispose GPU resources without restarting voices or context', afterCycles.contexts === beforeCycles.contexts && JSON.stringify(afterCycles.ids) === JSON.stringify(beforeCycles.ids) && cycles.every(gpu => gpu.liveScenes === 1 && gpu.createdScenes - gpu.disposedScenes === 1 && gpu.geometries <= 3), { beforeCycles, cycles, afterCycles })
  await page.evaluate(() => { for (let midi = 48; midi < 64; midi++) window.__performanceMidi([0x80, midi, 0]) })
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Record phrase', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes('Запись')))
  await page.evaluate(async () => {
    for (let chord = 0; chord < 2; chord++) {
      for (const midi of [60, 64, 67]) window.__performanceMidi([0x90, midi + chord, 90 + chord * 10])
      await new Promise(resolve => setTimeout(resolve, 200))
      for (const midi of [60, 64, 67]) window.__performanceMidi([0x80, midi + chord, 0])
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  })
  await page.getByRole('button', { name: 'Stop phrase', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Studio Loop', exact: true }).check()
  await page.getByRole('button', { name: 'Play phrase', exact: true }).click()
  await samplePhase('Phrase Recorder loop + GPU', 4000)
  await page.getByRole('button', { name: 'Stop phrase', exact: true }).click()
  await page.waitForTimeout(700)
  check('Playback stop leaves no stuck sequencer voices', await page.evaluate(() => window.__performanceEngine.getVoices().every(voice => voice.origin !== 'sequence')), await page.evaluate(() => window.__performanceEngine.getDiagnostics()))
  check('No browser errors', errors.length === 0, errors)
  const report = {
    browser: browserName, userAgent: await page.evaluate(() => navigator.userAgent), viewport: page.viewportSize(), checks, phases, ccLatency, harmonicStress, cycles,
    longTasks: await page.evaluate(() => window.__performanceLongTasks), final: await metrics(),
    unavailableMetrics: ['Dedicated GPU memory', 'Audio driver / physical SMK-25 latency', 'GPU execution time (CPU frame timings reported separately)'],
    physicalMidiTested: false,
  }
  await writeFile(`test-results/performance-${browserName}.json`, JSON.stringify(report, null, 2))
  console.log(`Performance ${browserName}: ${checks.length} checks passed; ${phases.length} measured workloads. Full native metrics in test-results/performance-${browserName}.json`)
} catch (error) {
  await writeFile(`test-results/performance-${browserName}-failure.json`, JSON.stringify({ checks, phases, errors, error: String(error), gpu: await diagnostic().catch(() => null) }, null, 2))
  throw error
} finally { await session.close() }
