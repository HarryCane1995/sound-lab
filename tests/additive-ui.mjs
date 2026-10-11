import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser(), { page } = session
const results = [], errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(4500)
const passed = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }
const ACTIVE = 'sound-lab.harmonics.v1', PATCH = 'sound-lab.harmonic-patch.v1', MIDI = 'sound-lab.midi.v1'

try {
  await page.addInitScript(() => {
    const badActive = sessionStorage.getItem('sound-lab.test-bad-active')
    if (badActive !== null) localStorage.setItem('sound-lab.harmonics.v1', badActive)
    const unavailable = sessionStorage.getItem('sound-lab.test-storage-unavailable') === 'true'
    if (unavailable) for (const method of ['getItem', 'setItem']) {
      const native = Storage.prototype[method]
      Storage.prototype[method] = function (key, ...args) {
        if (key === 'sound-lab.harmonics.v1' || key === 'sound-lab.harmonic-patch.v1') throw new DOMException('Test storage unavailable', 'SecurityError')
        return native.call(this, key, ...args)
      }
    }
    class Port extends EventTarget {
      constructor() { super(); this.id = 'harmonic-controller'; this.name = 'Harmonic Test Keyboard'; this.manufacturer = 'Test'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
    window.__harmonicMidi = { requests: [], send(raw) { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) } }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async options => { window.__harmonicMidi.requests.push(options); return access } })
    window.__harmonicAudio = { contexts: [], analysers: [], oscillators: [], voices: [] }
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args)
      window.__harmonicAudio.contexts.push(context)
      const createAnalyser = context.createAnalyser.bind(context)
      context.createAnalyser = (...args) => { const node = createAnalyser(...args); window.__harmonicAudio.analysers.push(node); return node }
      const createOscillator = context.createOscillator.bind(context)
      context.createOscillator = (...args) => { const node = createOscillator(...args); node.__ended = false; node.addEventListener('ended', () => { node.__ended = true }); window.__harmonicAudio.oscillators.push(node); return node }
      return context
    } })
  })
  const midiInitial = JSON.stringify({ version: 1, selectedInput: { id: 'harmonic-controller', name: 'Harmonic Test Keyboard' }, bindings: [{ id: 'keep-cutoff', target: 'filter.cutoff', sourceId: 'harmonic-controller', sourceName: 'Harmonic Test Keyboard', channel: 1, kind: 'cc', number: 74, mode: 'absolute' }] })
  await page.evaluate(({ MIDI, midiInitial }) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(MIDI, midiInitial) }, { MIDI, midiInitial })
  await page.reload()
  const builder = page.getByRole('region', { name: 'Harmonic Builder', exact: true })
  const mode = name => builder.getByRole('button', { name, exact: true })
  const slider = n => builder.getByRole('slider', { name: `Гармоника H${n}`, exact: true })
  const number = name => page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
  const template = name => builder.locator('.harmonic-template-grid').getByRole('button', { name: new RegExp(`^${name}`) })
  const send = async raw => { await page.evaluate(raw => window.__harmonicMidi.send(raw), raw); await page.waitForTimeout(45) }
  const waitVoices = value => page.waitForFunction(value => Number(document.querySelector('output[aria-label="Звучащие голоса"]')?.textContent) === value, value, { polling: 20 })
  const waitHeld = value => page.waitForFunction(value => Number(document.querySelector('output[aria-label="Удерживаемые ноты"]')?.textContent) === value, value, { polling: 20 })
  const panic = async () => { await page.getByRole('button', { name: /^Panic/ }).click(); await waitHeld(0); await waitVoices(0) }
  const state = async (key = ACTIVE) => { await page.waitForTimeout(180); return page.evaluate(key => JSON.parse(localStorage.getItem(key)), key) }
  const setNumber = async (name, value) => { await number(name).fill(String(value)); await number(name).press('Enter') }
  const instrumentVoices = () => page.evaluate(async () => {
    // Vite may append a transform timestamp. Import the exact module already
    // used by React so the observer wraps the running class, not another copy.
    const moduleUrl = performance.getEntriesByType('resource').findLast(item => item.name.includes('/src/audio/SynthEngine.ts'))?.name ?? '/src/audio/SynthEngine.ts'
    const { SynthEngine } = await import(moduleUrl)
    const native = SynthEngine.prototype.getVoices
    SynthEngine.prototype.getVoices = function (...args) { const result = native.apply(this, args); window.__harmonicAudio.voices = result; return result }
  })
  const voices = () => page.evaluate(() => window.__harmonicAudio.voices.map(voice => ({ id: voice.id, instanceId: voice.instanceId, createdAt: voice.createdAt, gateOpen: voice.gateOpen, phase: voice.phase })))
  const rms = () => page.evaluate(() => {
    const context = window.__harmonicAudio.contexts.findLast(item => item.state !== 'closed'), analyser = window.__harmonicAudio.analysers.find(item => item.context === context)
    if (!analyser) return 0
    const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data)
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length)
  })
  const spectrum = async frequencies => {
    await page.evaluate(() => {
      const context = window.__harmonicAudio.contexts.findLast(item => item.state !== 'closed')
      window.__harmonicAudio.analysers.find(item => item.context === context).fftSize = 32768
    })
    await page.waitForTimeout(750)
    return page.evaluate(frequencies => {
      const context = window.__harmonicAudio.contexts.findLast(item => item.state !== 'closed'), analyser = window.__harmonicAudio.analysers.find(item => item.context === context)
      const data = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(data)
      return frequencies.map(frequency => { const bin = Math.round(frequency * analyser.fftSize / context.sampleRate); return { frequency, db: Math.max(...data.slice(bin - 2, bin + 3)) } })
    }, frequencies)
  }
  const assertMode = async name => assert.equal(await mode(name).getAttribute('aria-pressed'), 'true')
  const assertApprox = (actual, expected, epsilon = 0.00001) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`)

  await builder.waitFor(); await instrumentVoices()
  assert.equal(await page.evaluate(() => window.__harmonicAudio.contexts.length), 0)
  await assertMode('Classic Oscillator')
  assert.equal(await builder.getByRole('slider', { includeHidden: true }).count(), 16)
  assert.equal(await slider(8).isVisible(), true); assert.equal(await slider(9).isVisible(), false)
  assert.equal(await builder.locator('.harmonic-template-grid button').count(), 6)
  assert.equal(await builder.locator('.harmonic-experiment-grid details').count(), 3)
  assert.match(await builder.locator('.harmonic-mode-hint').innerText(), /автоматически/)
  await slider(2).fill('50'); await assertMode('Additive Synthesis')
  await slider(2).focus(); await page.keyboard.press('ArrowUp'); assert.equal(await slider(2).inputValue(), '51')
  await page.keyboard.press('ArrowDown'); assert.equal(await slider(2).inputValue(), '50')
  assert.equal(await slider(2).getAttribute('aria-orientation'), 'vertical')
  passed('Lazy audio, sixteen accessible harmonic controls, six templates, three experiments and vertical keyboard slider editing')

  await slider(3).fill('30'); await slider(4).fill('20')
  await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitVoices(1)
  const peaks = await spectrum([220, 440, 660, 880])
  assert.ok(peaks.every(item => item.db > -85), JSON.stringify(peaks))
  const identity = await voices()
  const sumBefore = await builder.locator('.harmonic-theory-graph path').last().getAttribute('d')
  await builder.getByRole('switch', { name: 'Включить H2', exact: true }).click()
  assert.equal(await slider(2).inputValue(), '50')
  const muted = await spectrum([440])
  assert.ok(muted[0].db < peaks[1].db - 30, `Mute must remove the real harmonic: ${JSON.stringify(muted)}`)
  await builder.getByRole('switch', { name: 'Включить H2', exact: true }).click()
  await builder.getByRole('button', { name: 'Solo H3', exact: true }).click()
  const solo = await spectrum([220, 660])
  assert.ok(solo[1].db > -85 && solo[0].db < solo[1].db - 30, JSON.stringify(solo))
  await builder.getByRole('button', { name: 'Solo H3', exact: true }).click()
  assert.equal(await slider(2).inputValue(), '50')
  assert.deepEqual(await voices(), identity, 'Mute/Solo must preserve the held voice and ADSR')
  passed('Native 220/440/660/880 Hz peaks, independent mute and reversible Solo without voice restart', { peaks, muted, solo })

  await builder.locator('.harmonic-phase summary').click()
  await builder.getByRole('button', { name: 'Инвертировать фазу H3', exact: true }).click()
  assert.equal(await builder.getByRole('button', { name: 'Инвертировать фазу H3', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.notEqual(await builder.locator('.harmonic-theory-graph path').last().getAttribute('d'), sumBefore)
  assert.match(await builder.locator('.harmonic-model-note').innerText(), /Модель, не аудиозапись/)
  await builder.getByRole('combobox', { name: 'Гармоника на расчётном графике', exact: true }).selectOption('3')
  assert.equal(await builder.getByRole('img', { name: /^Первая гармоника, H3 и сумма гармоник/ }).count(), 1)
  await builder.locator('.harmonic-higher summary').click(); await slider(16).fill('12')
  assert.equal((await state()).additive.levels[15], 12)
  for (let n = 1; n <= 16; n++) await slider(n).fill('0')
  await page.waitForTimeout(800); assert.ok(await rms() < 0.00001)
  await waitVoices(1)
  await slider(1).fill('100'); await page.waitForTimeout(800); assert.ok(await rms() > 0.001)
  assert.equal((await voices())[0].instanceId, identity[0].instanceId)
  passed('Phase inversion, truthful calculated traces, all sixteen levels and silent all-zero composition preserve the voice')

  const templateCases = [
    ['Pure Sine', n => n === 1 ? 100 : 0, () => 0],
    ['Two Harmonics', n => n === 1 ? 100 : n === 2 ? 50 : 0, () => 0],
    ['Square Approximation', n => n % 2 ? 100 / n : 0, () => 0],
    ['Sawtooth Approximation', n => 100 / n, n => n % 2 ? 0 : 180],
    ['Triangle Approximation', n => n % 2 ? 100 / (n * n) : 0, n => n % 4 === 3 ? 180 : 0],
    ['Organ-like Tone', n => [100, 15, 45, 30, 0, 12, 0, 8][n - 1] ?? 0, () => 0],
  ]
  for (const [name, level, phase] of templateCases) {
    await template(name).click()
    const saved = await state()
    assert.equal(saved.mode, 'additive')
    saved.additive.levels.forEach((actual, index) => assertApprox(actual, level(index + 1)))
    saved.additive.phases.forEach((actual, index) => assert.equal(actual, phase(index + 1)))
    assert.equal(Number(await number('Нарастание').inputValue()), 0.01)
    assert.equal(Number(await number('Удержание').inputValue()), 100)
    assert.equal(Number(await number('Амплитуда').inputValue()), 20)
    assert.equal(await page.getByRole('switch', { name: 'Bypass', exact: true }).getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByRole('switch', { name: 'LFO', exact: true }).getAttribute('aria-checked'), 'false')
    assert.match(await builder.locator('.harmonic-patch').innerText(), /ADSR:[\s\S]*Частота и удерживаемые ноты сохранены/)
    assert.equal((await voices())[0].instanceId, identity[0].instanceId)
  }
  passed('All six templates have exact levels/phases, disclosed neutral settings and preserve existing notes')

  const comparisonMetrics = []
  for (const wave of ['square', 'sawtooth', 'triangle']) {
    await builder.getByRole('combobox', { name: 'Волна для сравнения', exact: true }).selectOption(wave)
    await builder.getByRole('button', { name: 'Сравнить: Additive', exact: true }).click(); await page.waitForTimeout(800)
    const additiveRms = await rms(), before = await voices()
    await builder.getByRole('button', { name: 'Сравнить: Classic', exact: true }).click(); await page.waitForTimeout(800)
    const classicRms = await rms()
    assert.deepEqual(await voices(), before, 'A/B comparison must not restart ADSR or replace the voice identity')
    assert.ok(classicRms / additiveRms > 0.8 && classicRms / additiveRms < 1.2, `${wave}: ${additiveRms} / ${classicRms}`)
    await assertMode('Classic Oscillator')
    await builder.getByRole('button', { name: 'Сравнить: Additive', exact: true }).click(); await assertMode('Additive Synthesis')
    comparisonMetrics.push({ wave, additiveRms, classicRms, ratio: classicRms / additiveRms })
  }
  await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: /^Sine/ }).click(); await assertMode('Classic Oscillator')
  await mode('Additive Synthesis').click()
  assert.equal((await voices())[0].instanceId, identity[0].instanceId)
  passed('Square/saw/triangle pairs load matching approximations, preserve held ADSR and match native RMS; classic buttons restore Classic', { comparisonMetrics })

  for (let n = 1; n <= 3; n++) {
    await builder.locator('.harmonic-experiment-grid details').nth(n - 1).locator('summary').click()
    await builder.getByRole('button', { name: `Начать эксперимент ${n}`, exact: true }).click()
    const text = await builder.locator('.harmonic-experiment-grid details').nth(n - 1).innerText()
    for (const instruction of ['Измените', 'Услышьте', 'Увидьте', 'Почему']) assert.ok(text.toLowerCase().includes(instruction.toLowerCase()))
  }
  passed('All three guided experiments load their sound and explain change, listening, observation and cause')

  await slider(1).fill('85'); await slider(2).fill('40')
  await builder.getByRole('switch', { name: 'Включить H3', exact: true }).click()
  await builder.getByRole('button', { name: 'Инвертировать фазу H2', exact: true }).click()
  await builder.getByRole('button', { name: 'Solo H2', exact: true }).click()
  await builder.getByRole('button', { name: 'Сохранить патч', exact: true }).click()
  const savedPatch = await state(PATCH)
  assert.equal(savedPatch.additive.solo, null); assert.equal(savedPatch.additive.compare, false)
  assert.equal(savedPatch.additive.phases[1], 180); assert.equal(savedPatch.additive.enabled[2], false)
  await builder.getByRole('button', { name: 'Сбросить гармоники', exact: true }).click()
  assert.equal(await slider(1).inputValue(), '100'); assert.equal(await slider(2).inputValue(), '0')
  await builder.getByRole('button', { name: 'Загрузить патч', exact: true }).click()
  assert.deepEqual(await state(), savedPatch)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), MIDI), midiInitial)
  await panic(); await page.reload(); await builder.waitFor(); await instrumentVoices()
  await assertMode('Additive Synthesis'); assert.equal(await slider(1).inputValue(), '85'); assert.equal(await slider(2).inputValue(), '40')
  assert.equal(await builder.getByRole('button', { name: 'Solo H2', exact: true }).getAttribute('aria-pressed'), 'false')
  assert.equal(await page.evaluate(() => window.__harmonicAudio.contexts.length), 0, 'Restoring state must not create an AudioContext')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), MIDI), midiInitial)
  passed('Debounced persistence and Save/Load retain levels, phase and mute, exclude transient Solo/Compare and preserve MIDI settings')

  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await page.getByRole('button', { name: 'MIDI Learn: Classic / Additive · Режим синтеза', exact: true }).click()
  await send([0x99, 36, 100]); await waitVoices(0); await waitHeld(0); await assertMode('Additive Synthesis')
  await send([0x89, 36, 0]); await send([0x99, 36, 100]); await assertMode('Classic Oscillator')
  await send([0x99, 36, 100]); await assertMode('Classic Oscillator')
  await send([0x89, 36, 0]); await send([0x99, 36, 100]); await assertMode('Additive Synthesis'); await send([0x89, 36, 0])
  const midiWithMode = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), MIDI)
  assert.equal(midiWithMode.bindings.filter(binding => binding.target === 'synthesis.mode').length, 1)
  assert.ok(midiWithMode.bindings.some(binding => binding.id === 'keep-cutoff'))
  await page.waitForTimeout(180); await page.reload(); await builder.waitFor(); await instrumentVoices()
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await send([0x99, 36, 100]); await assertMode('Classic Oscillator'); await waitVoices(0)
  await send([0x89, 36, 0])
  await page.getByRole('button', { name: 'MIDI Learn: Classic / Additive · Режим синтеза', exact: true }).click()
  await send([0xb0, 25, 127]); await assertMode('Classic Oscillator')
  await send([0xb0, 25, 0]); await send([0xb0, 25, 127]); await assertMode('Additive Synthesis')
  await send([0xb0, 25, 127]); await assertMode('Additive Synthesis')
  await send([0xb0, 25, 0]); await send([0xb0, 25, 127]); await assertMode('Classic Oscillator')
  await send([0xb0, 25, 0]); await mode('Additive Synthesis').click()
  passed('Mode MIDI Learn consumes pads, persists, preserves existing bindings and handles Note/CC rising edges without phantom voices')

  await template('Two Harmonics').click()
  await page.evaluate(() => { for (let note = 48; note < 64; note++) window.__harmonicMidi.send([0x90, note, 90]) })
  await waitHeld(16); await waitVoices(16)
  await page.waitForTimeout(120)
  const chordBefore = await voices()
  await slider(3).fill('25'); await page.waitForTimeout(120)
  assert.deepEqual(await voices(), chordBefore, 'Editing the shared additive composition must preserve every voice envelope')
  const nativeCarriers = await page.evaluate(() => {
    const context = window.__harmonicAudio.contexts.findLast(item => item.state !== 'closed')
    return window.__harmonicAudio.oscillators.filter(node => node.context === context && !node.__ended && node.frequency.value > 20).map(node => node.type)
  })
  assert.equal(nativeCarriers.length, 16); assert.ok(nativeCarriers.every(type => type === 'custom'))
  assert.ok(await rms() > 0.001)
  await panic()
  passed('Sixteen simultaneous MIDI keys use sixteen native additive carriers and keep independent envelopes while harmonics change', { nativeCarriers: nativeCarriers.length })

  await builder.locator('.harmonic-higher summary').click(); await slider(16).fill('10')
  await setNumber('Частота', 20000)
  assert.match(await builder.locator('.harmonic-nyquist').innerText(), /H16[\s\S]*Найквиста/)
  await setNumber('Частота', 220)
  await builder.locator('.harmonic-phase summary').click()
  for (const [name, viewport] of [['additive-desktop', { width: 1440, height: 1100 }], ['additive-mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport); await builder.scrollIntoViewIfNeeded(); await page.waitForTimeout(70)
    const sizes = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth }))
    assert.ok(sizes.document <= viewport.width + 1 && sizes.body <= viewport.width + 1, `${name}: ${JSON.stringify(sizes)}`)
    const dimensions = await slider(1).evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, direction: getComputedStyle(element).writingMode }))
    assert.ok(dimensions.height > dimensions.width * 4 && dimensions.direction === 'vertical-lr')
    await builder.screenshot({ path: `test-results/${name}.png` })
  }
  passed('Reference-aware Nyquist warning, sixteen expanded controls and responsive desktop/mobile layouts have no horizontal overflow')

  const midiBeforeFailures = await page.evaluate(key => localStorage.getItem(key), MIDI)
  for (const raw of ['{broken', JSON.stringify({ version: 99, mode: 'additive', additive: savedPatch.additive })]) {
    // Inject immediately before the next React mount. The current page's
    // legitimate debounced save must not race our corruption simulation.
    await page.evaluate(raw => sessionStorage.setItem('sound-lab.test-bad-active', raw), raw)
    await page.reload(); await builder.waitFor(); await assertMode('Classic Oscillator')
    assert.equal(await slider(1).inputValue(), '100'); assert.equal(await slider(2).inputValue(), '0')
    assert.match(await builder.locator('.harmonic-patch').innerText(), /повреждены|неподдерживаемую/)
    assert.equal(await page.evaluate(() => window.__harmonicAudio.contexts.length), 0)
  }
  await page.evaluate(() => sessionStorage.removeItem('sound-lab.test-bad-active'))
  await slider(2).fill('25')
  await page.evaluate(key => localStorage.setItem(key, '{broken'), PATCH)
  await builder.getByRole('button', { name: 'Загрузить патч', exact: true }).click()
  assert.equal(await slider(2).inputValue(), '25', 'Invalid patch must preserve the current composition')
  await page.evaluate(() => sessionStorage.setItem('sound-lab.test-storage-unavailable', 'true'))
  await page.reload(); await builder.waitFor(); await assertMode('Classic Oscillator')
  await slider(2).fill('30'); await page.waitForTimeout(180)
  assert.match(await builder.locator('.harmonic-patch').innerText(), /localStorage недоступен/)
  await builder.getByRole('button', { name: 'Сохранить патч', exact: true }).click()
  await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitVoices(1); await page.waitForTimeout(400)
  assert.ok(await rms() > 0.001)
  await panic()
  assert.equal(await page.evaluate(key => localStorage.getItem(key), MIDI), midiBeforeFailures)
  passed('Corrupt, obsolete and inaccessible harmonic storage falls back safely, never overwrites MIDI settings and keeps audio usable')

  assert.deepEqual(errors, [])
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await writeFile(`test-results/additive-ui-${userAgent.includes('Edg/') ? 'edge' : 'chrome'}.json`, JSON.stringify({ results, errors, userAgent }, null, 2))
  console.log(`All ${results.length} SOUND LAB additive UI scenarios passed.`)
} finally {
  await session.close()
}
