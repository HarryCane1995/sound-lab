import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const session = await startTestBrowser({ workspace: 'learn' })
const { page } = session
const browserName = testBrowserName()
try {
  const report = await page.evaluate(async () => {
    const { GpuScene } = await import('/src/visuals/gpu/GpuScene.ts')
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const checks = []
    const check = (name, passed, data) => checks.push({ name, passed: Boolean(passed), data })
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '70vh', zIndex: '20000' })
    document.body.append(canvas)
    const params = { ...copyParams(DEFAULT_PARAMS), amplitude: 0.25, adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.1 } }
    const engine = new SynthEngine(params)
    const statuses = []
    const scene = new GpuScene(canvas, () => engine.getAnalysis(), value => statuses.push(value))
    scene.configure({ quality: 'high', history: 96 })
    let disposed = false
    try {
      await engine.noteOn(220)
      await sleep(750)
      const sine = scene.diagnostics()
      check('WebGL2 renderer uses a real context', sine.webgl2 && sine.drawCalls > 0, sine)
      check('Actual PCM reaches waveform ring and GPU geometry', sine.rms > 0.001 && sine.newestWavePeak > 0.001 && sine.ringCount > 3, sine)
      check('Actual FFT resolves sine fundamental and quiet H2', Math.abs(sine.peakFrequency - 220) < 10 && sine.fft220 > sine.fft440 + 30, sine)
      scene.configure({ mode: 'spectrum' })
      params.waveform = 'sawtooth'
      engine.setParams(params)
      await sleep(600)
      const saw = scene.diagnostics()
      check('Sawtooth FFT harmonics reach spectral ring', saw.mode === 'spectrum' && saw.fft440 > sine.fft440 + 25 && saw.newestSpectrumPeak > -70, saw)
      const highBefore = scene.provider.spectrumAt(1760, 12)
      params.filter = { cutoff: 400, q: 0.707, bypass: false }
      engine.setParams(params)
      await sleep(600)
      const highAfter = scene.provider.spectrumAt(1760, 12)
      check('Cutoff changes measured spectrum', highBefore - highAfter > 15, { highBefore, highAfter })
      params.waveform = 'sine'; params.filter.bypass = true; engine.setParams(params)
      engine.noteOff()
      await sleep(180)
      scene.configure({ minFrequency: 20, maxFrequency: 2000 })
      const nativeAnalysis = engine.getAnalysis()
      const width = nativeAnalysis.sampleRate / nativeAnalysis.frequency.fftSize
      const bins = new Float32Array(nativeAnalysis.frequency.frequencyBinCount)
      const belowBin = Math.ceil(20 / width) - 1
      await engine.noteOn(belowBin * width)
      await sleep(600)
      nativeAnalysis.frequency.getFloatFrequencyData(bins)
      const lowerRange = scene.diagnostics()
      check('Log range excludes FFT-bin centers below the selected lower boundary', Math.abs(lowerRange.firstSpectrumDb - bins[belowBin + 1]) < 1 && lowerRange.firstSpectrumDb < bins[belowBin] - 3, { lowerRange, belowDb: bins[belowBin], firstAllowedDb: bins[belowBin + 1], binWidth: width })
      engine.noteOff(); await sleep(180)
      const aboveBin = Math.floor(2000 / width) + 1
      await engine.noteOn(aboveBin * width)
      await sleep(600)
      nativeAnalysis.frequency.getFloatFrequencyData(bins)
      const upperRange = scene.diagnostics()
      check('Log range excludes FFT-bin centers above the selected upper boundary', Math.abs(upperRange.lastSpectrumDb - bins[aboveBin - 1]) < 1 && upperRange.lastSpectrumDb < bins[aboveBin] - 3, { upperRange, aboveDb: bins[aboveBin], lastAllowedDb: bins[aboveBin - 1], binWidth: width })
      engine.noteOff(); await sleep(180)
      scene.configure({ maxFrequency: 20000 })
      await Promise.all([220, 330, 440].map((hz, i) => engine.noteOnVoice({ id: `gpu-chord-${i}`, frequency: hz, midi: 57 + i, velocity: 127, sourceId: 'gpu-test', sourceName: 'GPU test', channel: 1, origin: 'midi' })))
      await sleep(600)
      const chord = [220, 330, 440].map(hz => scene.provider.spectrumAt(hz))
      check('A chord retains multiple real peaks', chord.every(db => db > -75), chord)
      scene.configure({ frozen: true })
      const frozen = scene.diagnostics()
      await sleep(300)
      const stillFrozen = scene.diagnostics()
      const analysis = engine.getAnalysis()
      const pcm = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(pcm)
      const liveRms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length)
      check('Freeze stops data ingestion while native audio continues', frozen.analysisReads === stillFrozen.analysisReads && liveRms > 0.001, { frozen, stillFrozen, liveRms })
      scene.configure({ frozen: false })
      await sleep(200)
      check('Resume restarts data ingestion', scene.diagnostics().analysisReads > stillFrozen.analysisReads, scene.diagnostics())
      scene.setView('front')
      const camera = scene.diagnostics().cameraPosition
      params.amplitude = 0.2; engine.setParams(params); scene.configure({ frequency: 330 })
      check('Sound parameter changes preserve camera', JSON.stringify(camera) === JSON.stringify(scene.diagnostics().cameraPosition), scene.diagnostics())
      await sleep(120)
      check('Pitch changes retain the same calibrated PCM time window', scene.diagnostics().pcmWindowMs === sine.pcmWindowMs, { before: sine.pcmWindowMs, after: scene.diagnostics().pcmWindowMs })
      scene.configure({ projection: 'orthographic' })
      check('Orthographic camera is available', scene.diagnostics().projection === 'orthographic', scene.diagnostics())
      canvas.style.width = '800px'; canvas.style.height = '400px'
      await sleep(150)
      check('Resize retains renderer and data', canvas.width === 800 * scene.diagnostics().dpr && scene.diagnostics().ringCount > 0, scene.diagnostics())
      await sleep(3800)
      const bounded = scene.diagnostics()
      check('Longer playback has a bounded ring and GPU resources', bounded.ringCount === bounded.capacity && bounded.geometries <= 3 && bounded.textures === 0, bounded)
      const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context')
      if (extension) {
        extension.loseContext()
        await sleep(150)
        check('Context loss safely pauses only GPU', scene.diagnostics().contextLost && engine.getAudioClock()?.state === 'running', scene.diagnostics())
        extension.restoreContext()
        await sleep(700)
        check('Native WebGL context restores and resumes', !scene.diagnostics().contextLost && scene.diagnostics().running, scene.diagnostics())
      } else check('Context-loss extension available for native test', false, {})
      scene.dispose(); disposed = true
      const after = scene.diagnostics()
      check('Dispose releases scene resources and render loop', after.disposed && !after.running && after.liveScenes === 0, after)
      for (let i = 0; i < 5; i++) {
        const extra = document.createElement('canvas')
        Object.assign(extra.style, { position: 'fixed', inset: '0', width: '500px', height: '300px' })
        document.body.append(extra)
        const probe = new GpuScene(extra, () => engine.getAnalysis())
        await sleep(60)
        probe.dispose()
        check(`Repeated scene ${i + 1} is fully released`, probe.diagnostics().liveScenes === 0, probe.diagnostics())
        extra.remove()
      }
      return { browser: navigator.userAgent, checks, performance: bounded, statuses }
    } finally { if (!disposed) scene.dispose(); await engine.dispose(); canvas.remove() }
  })
  await writeFile(`test-results/gpu-prototype-${browserName}.json`, JSON.stringify(report, null, 2))
  for (const check of report.checks) assert.equal(check.passed, true, `${check.name}: ${JSON.stringify(check.data)}`)
  console.log(`GPU prototype ${browserName}: ${report.checks.length} checks passed; ${report.performance.fps.toFixed(1)} measured FPS; ${report.performance.meanFrameMs.toFixed(2)} ms mean frame; ${report.performance.drawCalls} draw calls; renderer ${report.performance.renderer}`)
} finally { await session.close() }
