import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chooseWorkspace, startTestBrowser, testBrowserName } from './helpers.mjs'
import { connectStudioMidi, installStudioProbe, setStudioNumber, studioMeasure, studioMidi, studioTelemetry, waitStudioSound } from './studio-harness.mjs'

const session = await startTestBrowser({ workspace: 'studio' }), { page } = session
const browser = testBrowserName(), results = [], errors = []
let fallbackContext
const pass = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }
const observe = target => {
  target.on('pageerror', error => errors.push(error.message))
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  target.setDefaultTimeout(7000)
}
const canvas = () => page.locator('.gpu-canvas')
const diagnostics = () => canvas().evaluate(element => element.gpuDiagnostics())
const waitGpu = condition => page.waitForFunction(condition => {
  const canvas = document.querySelector('.gpu-canvas')
  const value = canvas?.gpuDiagnostics?.()
  if (!value) return false
  switch (condition) {
    case 'ready': return value.webgl2 && value.drawCalls > 0 && value.running
    case 'sine': return value.rms > .001 && Math.abs(value.peakFrequency - 220) < 10 && value.fft220 > value.fft440 + 30
    // Wait until the native analyser's window/smoothing has settled from the
    // preceding sine; a first nonzero H3 is not a valid filter baseline.
    case 'saw': return value.fft440 > -75 && value.fft660 > -80 && value.fft440 > value.fft220 - 9 && value.fft660 > value.fft220 - 13
    case 'chord': return value.fft220 > -75 && value.fft440 > -75 && value.fft660 > -75
    case 'lost': return value.contextLost && !value.running
    case 'restored': return !value.contextLost && value.running && value.drawCalls > 0
    default: return false
  }
}, condition, { polling: 30, timeout: 7000 })
const button = name => page.getByRole('button', { name, exact: true })
const play = () => button('Включить тон Play').click()
const stop = () => button('Остановить тон Play').click()
const waveform = name => page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: new RegExp(`^${name}`) }).click()

try {
  observe(page)
  await installStudioProbe(page)
  await page.reload(); await chooseWorkspace(page, 'studio')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await canvas().scrollIntoViewIfNeeded()
  await waitGpu('ready')
  assert.equal((await studioTelemetry(page)).contexts, 0, 'GPU must not create an AudioContext')
  await page.getByLabel('Качество GPU', { exact: true }).selectOption('high')
  await page.getByLabel('Глубина истории', { exact: true }).selectOption('16')
  pass('Studio initializes a real WebGL2 renderer without constructing audio', await diagnostics())

  for (const [name, value] of [['Частота', 220], ['Амплитуда', 25], ['Нарастание', .005], ['Спад', .01], ['Удержание', 100], ['Затухание', .05]]) await setStudioNumber(page, name, value)
  await waveform('Sine'); await play(); await waitStudioSound(page, true); await waitGpu('sine')
  const sine = await diagnostics(), nativeSine = await studioMeasure(page)
  assert.ok(sine.analysisReads > 0 && sine.ringCount > 0 && sine.newestWavePeak > .001)
  assert.ok(nativeSine.bands[0].db > nativeSine.bands[1].db + 30)
  assert.ok(Math.abs(sine.rms - nativeSine.rms) < .02, 'GPU provider must observe the native application output')
  await page.screenshot({ path: `test-results/gpu-waveform-${browser}.png` })
  pass('Real application PCM and a measured sine fundamental reach Waveform 3D', { gpu: sine, native: nativeSine })

  await button('Spectral Landscape').click(); await waveform('Sawtooth'); await waitGpu('saw')
  const saw = await diagnostics()
  assert.equal(saw.mode, 'spectrum'); assert.ok(saw.fft440 > sine.fft440 + 25 && saw.newestSpectrumPeak > -75)
  await page.screenshot({ path: `test-results/gpu-landscape-${browser}.png` })
  pass('Sawtooth harmonics populate the real spectral landscape', saw)

  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  await setStudioNumber(page, 'Частота среза', 250)
  await page.waitForFunction(before => document.querySelector('.gpu-canvas')?.gpuDiagnostics?.().fft660 < before - 12, saw.fft660, { timeout: 6000 })
  const filtered = await diagnostics()
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  pass('Low-pass Cutoff attenuates measured high harmonics in the GPU landscape', { before: saw.fft660, after: filtered.fft660 })

  await stop(); await waitStudioSound(page, false); await waveform('Sine')
  await connectStudioMidi(page)
  // Closing diagnostics changes only the layout, preserving the MIDI input.
  if (await page.locator('.studio-midi-drawer').isVisible()) await button('MIDI Monitor и привязки').click()
  await studioMidi(page, [0x90, 57, 127]); await waitStudioSound(page, true); await waitGpu('sine')
  const centered = await diagnostics()
  await studioMidi(page, [0xe0, 127, 127])
  await page.waitForFunction(() => {
    const value = document.querySelector('.gpu-canvas')?.gpuDiagnostics?.()
    return value && Math.abs(value.peakFrequency - 246.94) < 10
  }, null, { timeout: 6000 })
  const bent = await diagnostics()
  assert.ok(bent.peakFrequency > centered.peakFrequency + 15)
  await studioMidi(page, [0xe0, 0, 64]); await studioMidi(page, [0x80, 57, 0]); await waitStudioSound(page, false)
  await Promise.all([57, 69, 76].map(midi => studioMidi(page, [0x90, midi, 110])))
  await waitGpu('chord')
  const chord = await diagnostics(), nativeChord = await studioMeasure(page, [220, 440, 659.255])
  assert.ok(nativeChord.bands.every(band => band.db > -75))
  pass('Live MIDI Pitch Bend moves FFT peaks and a chord shows three independent measured components', { centered, bent, chord, nativeChord })

  await button('Freeze').click()
  const frozen = await diagnostics(); assert.equal(frozen.frozen, true)
  await page.waitForTimeout(250)
  const stillFrozen = await diagnostics()
  assert.equal(stillFrozen.historyWrites, frozen.historyWrites)
  assert.equal(stillFrozen.ringCount, frozen.ringCount)
  assert.equal(stillFrozen.historySeconds, frozen.historySeconds)
  assert.equal(stillFrozen.newestWavePeak, frozen.newestWavePeak)
  assert.equal(stillFrozen.newestSpectrumPeak, frozen.newestSpectrumPeak)
  assert.ok((await studioMeasure(page)).rms > .001, 'Freeze must preserve real native audio')
  await button('Resume').click()
  await page.waitForFunction(writes => document.querySelector('.gpu-canvas')?.gpuDiagnostics?.().historyWrites > writes, frozen.historyWrites)
  pass('Freeze holds real history without stopping audio; Resume restarts ingestion', { frozen, resumed: await diagnostics() })

  await page.getByLabel('Ракурс камеры', { exact: true }).selectOption('front')
  const front = (await diagnostics()).cameraPosition
  await setStudioNumber(page, 'Амплитуда', 22)
  assert.deepEqual((await diagnostics()).cameraPosition, front, 'Sound controls must not reset the camera')
  const box = await canvas().boundingBox(); assert.ok(box)
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5)
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .58, { steps: 10 }); await page.mouse.up()
  await page.waitForTimeout(250)
  assert.notDeepEqual((await diagnostics()).cameraPosition, front, 'Actual pointer drag must rotate the camera')
  const beforeWheel = (await diagnostics()).cameraPosition
  await page.mouse.wheel(0, -180); await page.waitForTimeout(250)
  assert.notDeepEqual((await diagnostics()).cameraPosition, beforeWheel)
  await button('Reset Camera').dblclick()
  await page.getByLabel('Проекция камеры', { exact: true }).selectOption('orthographic')
  assert.equal((await diagnostics()).projection, 'orthographic')
  await page.getByLabel('Цвет амплитуды', { exact: true }).selectOption('heat')
  await page.getByLabel('Частотный диапазон', { exact: true }).selectOption('bass')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(100)
    const size = await canvas().evaluate(element => ({ width: element.width, height: element.height, rect: element.getBoundingClientRect().toJSON(), diagnostics: element.gpuDiagnostics() }))
    assert.ok(size.width > 0 && size.height > 0 && size.rect.width <= viewport.width)
    assert.equal(size.diagnostics.liveScenes, 1)
  }
  pass('Pointer camera controls, zoom, reset, presets, projection and resize retain a single scene', await diagnostics())

  for (const quality of ['low', 'medium', 'high', 'auto']) {
    await page.getByLabel('Качество GPU', { exact: true }).selectOption(quality)
    await page.waitForTimeout(120)
    const value = await diagnostics()
    assert.equal(value.quality, quality); assert.ok(value.dpr <= 2 && value.pointCount <= 256 && value.capacity === 96 && value.geometries <= 3 && value.textures === 0)
  }
  await page.waitForTimeout(800)
  const bounded = await diagnostics()
  assert.ok(bounded.ringCount <= bounded.capacity && bounded.visibleHistory <= 96)
  pass('Quality settings retain bounded reusable GPU buffers and history', bounded)

  const beforeLost = await diagnostics()
  await canvas().evaluate(element => {
    const extension = element.getContext('webgl2').getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('Native context-loss extension unavailable')
    element.__testContextExtension = extension; extension.loseContext()
  })
  await waitGpu('lost')
  assert.ok((await studioMeasure(page)).rms > .001)
  await canvas().evaluate(element => element.__testContextExtension.restoreContext())
  await waitGpu('restored')
  assert.ok((await diagnostics()).analysisReads >= beforeLost.analysisReads)
  pass('Native WebGL context loss and restoration preserve live audio and recover rendering', await diagnostics())

  for (let index = 0; index < 4; index++) {
    const old = await canvas().elementHandle()
    await button('2D').click(); await page.locator('.scope-canvas').waitFor()
    assert.equal((await old.evaluate(element => element.gpuDiagnostics())).disposed, true)
    assert.equal((await old.evaluate(element => element.gpuDiagnostics())).liveScenes, 0)
    await button('Waveform 3D').click(); await waitGpu('ready')
    const value = await diagnostics()
    assert.equal(value.liveScenes, 1); assert.equal(value.createdScenes - value.disposedScenes, 1)
    await old.dispose()
  }
  pass('Repeated 2D/3D changes release old scenes, buffers and animation loops', await diagnostics())

  const beforeMode = await studioTelemetry(page), oldScene = await canvas().elementHandle()
  await chooseWorkspace(page, 'learn'); await page.locator('.scope-canvas').waitFor()
  assert.equal((await oldScene.evaluate(element => element.gpuDiagnostics())).disposed, true)
  assert.ok((await studioMeasure(page)).rms > .001)
  await chooseWorkspace(page, 'studio'); await waitGpu('ready')
  const afterMode = await studioTelemetry(page)
  assert.equal(afterMode.contexts, beforeMode.contexts); assert.equal(afterMode.starts, beforeMode.starts)
  await oldScene.dispose()
  await Promise.all([57, 69, 76].map(midi => studioMidi(page, [0x80, midi, 0])))
  await waitStudioSound(page, false)
  pass('Learn/Studio changes dispose only visual resources and preserve native voice identity', { beforeMode, afterMode })

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hidden = await diagnostics()
  await page.waitForTimeout(180)
  const stillHidden = await diagnostics()
  assert.equal(stillHidden.running, false)
  assert.equal(stillHidden.renderedFrames, hidden.renderedFrames)
  assert.equal(stillHidden.historyWrites, hidden.historyWrites)
  assert.equal(stillHidden.analysisReads, hidden.analysisReads)
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await waitGpu('ready')
  pass('Hidden-document safety stops GPU rendering and audio reads; visibility resumes the existing scene', { hidden, resumed: await diagnostics() })

  // Deliberately deny only WebGL2 in a separate, fresh test profile. Canvas 2D
  // and the application's native Web Audio graph remain real and operational.
  fallbackContext = await session.browser.newContext({ viewport: { width: 1366, height: 768 } })
  const fallback = await fallbackContext.newPage(); observe(fallback); await installStudioProbe(fallback)
  await fallback.addInitScript(() => {
    const native = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : native.call(this, type, ...args) }
  })
  await fallback.goto(page.url()); await fallback.locator('.scope-canvas').waitFor()
  assert.equal(await fallback.getByRole('button', { name: '2D', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.match(await fallback.getByRole('region', { name: 'GPU Visual Lab', exact: true }).innerText(), /WebGL2 недоступен|совместимый режим 2D/i)
  await fallback.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitStudioSound(fallback, true)
  assert.equal((await studioTelemetry(fallback)).contexts, 1)
  await fallback.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitStudioSound(fallback, false)
  pass('A browser without WebGL2 falls back to actual Canvas 2D and remains a functioning synthesizer')

  assert.deepEqual(errors, [])
  await writeFile(`test-results/gpu-${browser}.json`, JSON.stringify({ browser, results, errors, performance: bounded, physicalGpuBenchmark: false }, null, 2))
  console.log(`GPU integration: ${results.length} scenarios passed (${browser})`)
} catch (reason) {
  await writeFile(`test-results/gpu-${browser}.json`, JSON.stringify({ browser, results, errors, failure: reason instanceof Error ? reason.stack : String(reason) }, null, 2))
  throw reason
} finally { if (fallbackContext) await fallbackContext.close(); await session.close() }
