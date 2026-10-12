import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chooseWorkspace, startTestBrowser, testBrowserName, WORKSPACE_KEY } from './helpers.mjs'
import { connectStudioMidi, installStudioProbe, setStudioNumber, studioMeasure, studioMidi, studioTelemetry, waitStudioSound } from './studio-harness.mjs'

const session = await startTestBrowser({ workspace: 'studio' })
const url = session.page.url()
await session.page.close()
// This fresh context deliberately has no workspace init script. It verifies
// the real product default, rather than seeding Studio through the test helper.
const context = await session.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await context.newPage(), browser = testBrowserName(), results = [], errors = []
page.setDefaultTimeout(7000)
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
const pass = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }
const button = name => page.getByRole('button', { name, exact: true })
const dial = name => page.getByRole('slider', { name, exact: true })
const number = name => page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
const value = async name => Number(await number(name).inputValue())
const status = expected => page.waitForFunction(expected => document.querySelector('.phrase-status')?.textContent === expected, expected)
const notes = () => page.locator('.phrase-roll-note').evaluateAll(elements => elements.map(element => ({ midi: Number(element.dataset.midi), velocity: Number(element.dataset.velocity), start: Number(element.dataset.start), end: Number(element.dataset.end) })))
const key = (code, down) => page.evaluate(({ code, down }) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.slice(-1).toLowerCase(), bubbles: true })), { code, down })
const mapping = {
  version: 1, selectedInput: { id: 'studio-controller', name: 'Studio Test Controller' },
  bindings: [{ id: 'legacy-cutoff', target: 'filter.cutoff', sourceId: 'studio-controller', sourceName: 'Studio Test Controller', channel: 1, kind: 'cc', number: 74, mode: 'absolute' }],
}

async function drag(name, dy, precise = false) {
  const box = await dial(name).boundingBox(); assert.ok(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  if (precise) await page.keyboard.down('Shift')
  try {
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 10 })
    await page.mouse.up()
  } finally { if (precise) await page.keyboard.up('Shift') }
}

async function verifyLayout(name, viewport, requireAllAboveFold) {
  await page.setViewportSize(viewport); await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(150)
  const geometry = await page.evaluate(() => {
    const elements = ['.studio-upper', '.studio-synth-controls', '.compact-harmonics', '.phrase-roll-graph', '.piano'].map(selector => {
      const element = document.querySelector(selector), box = element?.getBoundingClientRect()
      return { selector, exists: Boolean(element), visible: Boolean(box && box.width > 0 && box.height > 0), box: box?.toJSON() }
    })
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, elements }
  })
  assert.ok(geometry.scrollWidth <= viewport.width + 2, `${name} horizontal overflow: ${JSON.stringify(geometry)}`)
  for (const item of geometry.elements) {
    assert.equal(item.exists, true, `${name} missing ${item.selector}`); assert.equal(item.visible, true, `${name} hidden ${item.selector}`)
    assert.ok(item.box.left >= -1 && item.box.right <= viewport.width + 2, `${name} clipped ${item.selector}`)
    if (requireAllAboveFold) assert.ok(item.box.top >= -1 && item.box.bottom <= viewport.height + 2, `${name} requires scrolling to ${item.selector}: ${JSON.stringify(item.box)}`)
  }
  for (const label of ['Record phrase', 'Stop phrase', 'Play phrase', 'Save phrase']) {
    const box = await button(label).boundingBox(); assert.ok(box && box.width >= 24 && box.height >= 24, `${label} needs an operable hit target`)
    if (requireAllAboveFold) assert.ok(box.y + box.height <= viewport.height + 2, `${label} must be above the fold`)
  }
  assert.equal(await dial('Гармоника H16').isVisible(), true)
  const transportStatus = page.locator('.studio-transport-options > [role="status"]')
  assert.equal(await transportStatus.isVisible(), true, `${name} must show the current transport state`)
  assert.equal(await transportStatus.innerText(), 'Остановлено', `${name} must label a stopped recorder explicitly`)
  await page.screenshot({ path: `test-results/studio-${name}-${browser}.png`, fullPage: true })
  return geometry
}

try {
  await installStudioProbe(page)
  await page.goto(url); await page.locator('.studio-shell').waitFor()
  assert.equal(await button('Studio').getAttribute('aria-pressed'), 'true')
  assert.equal(await button('Learn').getAttribute('aria-pressed'), 'false')
  assert.equal((await studioTelemetry(page)).contexts, 0)
  const layouts = []
  layouts.push(await verifyLayout('1920', { width: 1920, height: 1080 }, true))
  layouts.push(await verifyLayout('1440', { width: 1440, height: 900 }, false))
  layouts.push(await verifyLayout('1366', { width: 1366, height: 768 }, false))
  // Browser zoom 125% reduces the logical area of a 1920x1080 viewport to
  // 1536x864. This checks that layout; native OS/browser UI zoom is manual QA.
  layouts.push(await verifyLayout('125-percent-effective', { width: 1536, height: 864 }, false))
  await page.setViewportSize({ width: 700, height: 900 })
  assert.equal(await button('MIDI Monitor и привязки').isVisible(), true, 'Compact PWA windows need a visible MIDI entry point')
  const midiEntry = await button('MIDI Monitor и привязки').boundingBox()
  assert.ok(midiEntry && midiEntry.width >= 24 && midiEntry.height >= 24)
  await button('MIDI Monitor и привязки').click()
  assert.equal(await button('Подключить MIDI').isVisible(), true)
  await button('Закрыть MIDI Monitor').click()
  await button('2D').click()
  await page.locator('.gpu-compatible canvas').first().waitFor()
  const mobileFallback = await page.evaluate(() => {
    const region = document.querySelector('.gpu-visual-lab').getBoundingClientRect()
    const controls = document.querySelector('.studio-synth-controls').getBoundingClientRect()
    const canvases = [...document.querySelectorAll('.gpu-compatible canvas')].map(canvas => ({ box: canvas.getBoundingClientRect().toJSON(), native2d: Boolean(canvas.getContext('2d')) }))
    return { region: region.toJSON(), controls: controls.toJSON(), canvases, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth }
  })
  assert.equal(mobileFallback.canvases.length, 2)
  assert.ok(mobileFallback.scrollWidth <= mobileFallback.viewport + 2, 'Compact 2D fallback must not overflow horizontally')
  for (const canvas of mobileFallback.canvases) {
    assert.equal(canvas.native2d, true)
    assert.ok(canvas.box.width > 0 && canvas.box.height > 0)
    assert.ok(canvas.box.top >= mobileFallback.region.top && canvas.box.bottom <= mobileFallback.region.bottom + 2, 'Both stacked 2D graphs must fit their GPU fallback panel')
    assert.ok(canvas.box.left >= -1 && canvas.box.right <= mobileFallback.viewport + 2)
  }
  assert.ok(mobileFallback.controls.top >= mobileFallback.region.bottom - 2, 'Synth controls must not overlap the stacked 2D fallback')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await button('MIDI Monitor и привязки').isVisible(), true)
  await page.waitForTimeout(100)
  const stackedFallback = await page.evaluate(() => {
    const region = document.querySelector('.gpu-visual-lab').getBoundingClientRect()
    const controls = document.querySelector('.studio-synth-controls').getBoundingClientRect()
    return { bottom: region.bottom, controlsTop: controls.top, canvases: [...document.querySelectorAll('.gpu-compatible canvas')].map(canvas => canvas.getBoundingClientRect().toJSON()), width: document.documentElement.scrollWidth, viewport: innerWidth }
  })
  assert.equal(stackedFallback.canvases.length, 2)
  assert.ok(stackedFallback.width <= stackedFallback.viewport + 2)
  assert.ok(stackedFallback.canvases.every(canvas => canvas.bottom <= stackedFallback.bottom + 2))
  assert.ok(stackedFallback.controlsTop >= stackedFallback.bottom - 2)
  await page.screenshot({ path: `test-results/studio-mobile-2d-${browser}.png`, fullPage: true })
  await button('Waveform 3D').click()
  await page.setViewportSize({ width: 1920, height: 1080 })
  pass('Fresh profiles open Studio; desktop, compact windows and the effective 125% viewport keep all controls reachable', { layouts, mobileFallback, browserZoomEmulatedByLogicalViewport: true })

  assert.equal(await page.locator('.studio-synth-controls .knob').count(), 10)
  await setStudioNumber(page, 'Амплитуда', 25); await drag('Амплитуда', -30)
  const normalDelta = (await value('Амплитуда')) - 25
  assert.ok(normalDelta > 10)
  await setStudioNumber(page, 'Амплитуда', 25); await drag('Амплитуда', -30, true)
  const fineDelta = (await value('Амплитуда')) - 25
  assert.ok(fineDelta > 0 && fineDelta < normalDelta / 4, 'Shift drag must retain precise control')
  await dial('Амплитуда').dblclick()
  assert.equal(await number('Амплитуда').evaluate(element => document.activeElement === element), true)
  await number('Амплитуда').fill('37'); await number('Амплитуда').press('Enter'); assert.equal(await value('Амплитуда'), 37)
  await dial('Амплитуда').dblclick(); await number('Амплитуда').fill('64'); await number('Амплитуда').press('Escape'); assert.equal(await value('Амплитуда'), 37)
  await button('По умолчанию: Амплитуда').click(); assert.equal(await value('Амплитуда'), 25)
  await dial('Амплитуда').focus(); await page.keyboard.press('Home'); assert.equal(await value('Амплитуда'), 0)
  await page.keyboard.press('End'); assert.equal(await value('Амплитуда'), 100)
  await page.keyboard.press('ArrowLeft'); assert.ok(await value('Амплитуда') < 100)
  await setStudioNumber(page, 'Амплитуда', 25)
  const beforeWheel = await value('Амплитуда'), ampBox = await dial('Амплитуда').boundingBox()
  await page.mouse.move(ampBox.x + ampBox.width / 2, ampBox.y + ampBox.height / 2); await page.mouse.wheel(0, 100)
  assert.equal(await value('Амплитуда'), beforeWheel, 'Knobs must not hijack the scrolling wheel')
  await page.evaluate(() => scrollTo(0, 0))
  pass('Linear Knobs support vertical/fine drag, exact entry, Escape, explicit reset, keyboard and ordinary scrolling', { normalDelta, fineDelta })

  await dial('Частота').fill('500')
  assert.ok(Math.abs((await value('Частота')) - Math.sqrt(20 * 20000)) < .1)
  assert.match(await dial('Частота').getAttribute('aria-valuetext'), /Hz/)
  await setStudioNumber(page, 'Частота', 440)
  await chooseWorkspace(page, 'learn')
  assert.equal(await value('Частота'), 440)
  assert.equal(await page.getByRole('navigation', { name: 'Выбор урока', exact: true }).getByRole('button').count(), 7)
  assert.equal(await page.locator('.harmonic-experiment-grid details').count(), 3)
  await setStudioNumber(page, 'Частота', 330)
  await chooseWorkspace(page, 'studio'); assert.equal(await value('Частота'), 330)
  await page.reload(); await page.locator('.studio-shell').waitFor()
  await chooseWorkspace(page, 'learn'); await page.reload()
  assert.equal(await button('Learn').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), WORKSPACE_KEY), 'learn')
  await chooseWorkspace(page, 'studio')
  pass('Logarithmic math and accessible units remain unchanged; Studio/Learn share values and persist the selected workspace')

  await page.getByText('Settings', { exact: true }).click()
  await page.getByLabel('Плотность интерфейса', { exact: true }).selectOption('comfortable')
  await page.getByLabel('Масштаб интерфейса', { exact: true }).fill('110')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
  await page.getByLabel('Масштаб интерфейса', { exact: true }).fill('80')
  const target = await dial('Амплитуда').boundingBox()
  assert.ok(target && target.width >= 24 && target.height >= 24, 'Minimum UI scale must retain an operable Knob hit target')
  await page.getByLabel('Плотность интерфейса', { exact: true }).selectOption('compact')
  await page.getByLabel('Масштаб интерфейса', { exact: true }).fill('100')
  await page.getByText('Settings', { exact: true }).click()
  pass('Comfortable/Compact density and UI scale preserve reachable controls without page overflow')

  await page.evaluate(mapping => localStorage.setItem('sound-lab.midi.v1', JSON.stringify(mapping)), mapping)
  await page.reload(); await page.locator('.studio-shell').waitFor()
  await connectStudioMidi(page)
  await button('MIDI Monitor и привязки').click()
  assert.deepEqual(await page.evaluate(() => window.__studioProbe.midiRequests), [{ sysex: false }])
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  await studioMidi(page, [0xb0, 74, 64])
  const expectedCutoff = 20 * (20000 / 20) ** (64 / 127)
  await page.waitForFunction(expected => {
    const field = document.querySelector('input[aria-label="Частота среза, значение"]')
    return field && Math.abs(Number(field.value) - expected) < 2
  }, expectedCutoff)
  const cutoffKnob = page.locator('.knob').filter({ has: dial('Частота среза') })
  // Parameter application precedes the controller's throttled state publish.
  // Wait for that real notification instead of assuming it shares a render.
  await page.waitForFunction(() => document.querySelector('.knob[data-parameter="filter.cutoff"]')?.classList.contains('is-midi-controlled'), null, { timeout: 1500 })
  assert.equal(await cutoffKnob.evaluate(element => element.classList.contains('is-midi-controlled')), true)
  await page.waitForFunction(() => !document.querySelector('.knob[data-parameter="filter.cutoff"]')?.classList.contains('is-midi-controlled'), null, { timeout: 1500 })
  assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('sound-lab.midi.v1')).bindings)).some(binding => binding.id === 'legacy-cutoff'))
  await button('MIDI Learn: Amplitude · Громкость').click()
  await studioMidi(page, [0xb0, 74, 90])
  await page.locator('.studio-midi-drawer').waitFor({ state: 'visible' })
  assert.equal(await page.getByText('Этот сигнал уже назначен', { exact: true }).isVisible(), true, 'A compact Learn conflict must expose the replacement prompt')
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sound-lab.midi.v1')).bindings), mapping.bindings, 'Learning a conflicting encoder must preserve the previous mapping until resolved')
  await button('Отменить замену').click()
  assert.equal(await button('MIDI Learn: Amplitude · Громкость').getAttribute('aria-pressed'), 'false')
  await button('Закрыть MIDI Monitor').click()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sound-lab.midi.v1')).bindings), mapping.bindings)
  await button('MIDI Learn: Amplitude · Громкость').click()
  await studioMidi(page, [0xb0, 71, 100]); await studioMidi(page, [0xb0, 71, 64])
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Амплитуда, значение"]')?.value) === 50)
  await dial('Частота среза').click({ button: 'right' })
  assert.equal(await button('MIDI Learn: Cutoff · Частота среза').getAttribute('aria-pressed'), 'true')
  // Cancel this pending learn through its keyboard-accessible button.
  await button('MIDI Learn: Cutoff · Частота среза').click()
  await setStudioNumber(page, 'Амплитуда', 25)
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  pass('Existing MIDI mapping IDs work in Knobs; CC highlights, explicit Learn and context-menu Learn share the original system', { expectedCutoff, cutoff: await value('Частота среза') })

  for (const [name, value] of [['Частота', 880], ['Амплитуда', 18], ['Нарастание', .12], ['Спад', .34], ['Удержание', 65], ['Затухание', .56]]) await setStudioNumber(page, name, value)
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  await setStudioNumber(page, 'Частота среза', 1300); await setStudioNumber(page, 'Резонанс', 1.7)
  await page.getByRole('switch', { name: 'LFO', exact: true }).click()
  await setStudioNumber(page, 'Скорость', 3.2); await setStudioNumber(page, 'Глубина', 24)
  await button('Срез Filter Cutoff').click(); await dial('Гармоника H4').fill('7')
  await button('Сбросить параметры осциллятора').click()
  assert.equal(await value('Частота'), 220); assert.equal(await value('Амплитуда'), 25)
  assert.equal(await button('Classic Oscillator').getAttribute('aria-pressed'), 'true')
  for (const [name, expected] of [['Нарастание', .12], ['Спад', .34], ['Удержание', 65], ['Затухание', .56], ['Частота среза', 1300], ['Резонанс', 1.7], ['Скорость', 3.2], ['Глубина', 24]]) assert.equal(await value(name), expected)
  assert.equal(await dial('Гармоника H4').inputValue(), '7')
  assert.equal(await page.getByRole('switch', { name: 'Bypass', exact: true }).getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByRole('switch', { name: 'LFO', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await button('Срез Filter Cutoff').getAttribute('aria-pressed'), 'true')
  await page.getByRole('switch', { name: 'LFO', exact: true }).click(); await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  pass('Oscillator Reset is scoped: ADSR, Filter, LFO and stored harmonic levels remain intact')

  for (const [name, value] of [['Частота', 220], ['Нарастание', .005], ['Спад', .01], ['Удержание', 100], ['Затухание', .05]]) await setStudioNumber(page, name, value)
  await button('Включить тон Play').click(); await waitStudioSound(page, true)
  const beforeMode = await studioTelemetry(page)
  await chooseWorkspace(page, 'learn'); assert.ok((await studioMeasure(page)).rms > .001)
  await chooseWorkspace(page, 'studio'); assert.ok((await studioMeasure(page)).rms > .001)
  const afterMode = await studioTelemetry(page)
  assert.equal(afterMode.contexts, beforeMode.contexts); assert.equal(afterMode.starts, beforeMode.starts)
  for (const wave of ['Square', 'Sawtooth', 'Triangle', 'Sine']) {
    await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: new RegExp(`^${wave}`) }).click()
    await waitStudioSound(page, true)
  }
  await button('Остановить тон Play').click(); await waitStudioSound(page, false)
  pass('Studio/Learn keeps the original AudioContext and oscillator starts; all four Classic waves remain audible', { beforeMode, afterMode })

  assert.equal(await page.locator('.compact-harmonics input[type="range"]').count(), 16)
  await dial('Гармоника H2').fill('50'); await dial('Гармоника H16').fill('12')
  assert.equal(await dial('Гармоника H2').inputValue(), '50'); assert.equal(await dial('Гармоника H16').inputValue(), '12')
  await chooseWorkspace(page, 'learn')
  const builder = page.getByRole('region', { name: 'Harmonic Builder', exact: true })
  assert.equal(await builder.getByRole('slider', { name: 'Гармоника H2', exact: true }).inputValue(), '50')
  await builder.locator('.harmonic-higher summary').click()
  assert.equal(await builder.getByRole('slider', { name: 'Гармоника H16', exact: true }).inputValue(), '12')
  await chooseWorkspace(page, 'studio')
  await page.evaluate(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    // Sixteen real input events in one JS task exercise state coalescing. Each
    // event must retain the earlier changes made before React's next render.
    for (let harmonic = 1; harmonic <= 16; harmonic++) {
      const input = document.querySelector(`#studio-harmonic-${harmonic}`)
      setValue.call(input, String(harmonic * 3))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  for (let harmonic = 1; harmonic <= 16; harmonic++) assert.equal(await dial(`Гармоника H${harmonic}`).inputValue(), String(harmonic * 3))
  await chooseWorkspace(page, 'learn')
  for (let harmonic = 1; harmonic <= 16; harmonic++) assert.equal(await builder.getByRole('slider', { name: `Гармоника H${harmonic}`, exact: true, includeHidden: true }).inputValue(), String(harmonic * 3))
  await page.evaluate(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    for (const [harmonic, level] of [[2, 50], [3, 25]]) {
      const input = document.querySelector(`#harmonic-level-${harmonic}`)
      setValue.call(input, String(level)); input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  assert.equal(await dial('Гармоника H2').inputValue(), '50')
  assert.equal(await dial('Гармоника H3').inputValue(), '25')
  await chooseWorkspace(page, 'studio')
  await page.locator('.compact-harmonics').screenshot({ path: `test-results/studio-harmonics-${browser}.png` })
  pass('All sixteen compact harmonic controls share Learn state and retain every change in a same-task input burst')

  await page.getByLabel('Harmonic Template', { exact: true }).selectOption('two-harmonics')
  assert.equal(await button('Additive Synthesis').getAttribute('aria-pressed'), 'true')
  await button('Включить тон Play').click(); await waitStudioSound(page, true)
  await page.waitForTimeout(350)
  const combined = await studioMeasure(page)
  assert.ok(combined.bands[1].db > -70)
  await button('Действия H2').click(); await button('Solo H2').click()
  await page.waitForFunction(before => window.__studioProbe.measure().bands[0].db < before - 25, combined.bands[0].db)
  assert.equal(await dial('Гармоника H1').inputValue(), '100'); assert.equal(await dial('Гармоника H2').inputValue(), '50')
  await button('Solo H2').click(); await button('Включить H2').click()
  await page.waitForFunction(before => window.__studioProbe.measure().bands[1].db < before - 25, combined.bands[1].db)
  await button('Включить H2').click(); await button('Инвертировать фазу H2').click()
  assert.equal(await button('Инвертировать фазу H2').getAttribute('aria-pressed'), 'true')
  await button('Закрыть действия H2').click()
  await page.getByRole('spinbutton', { name: 'Уровень H2, значение', exact: true }).fill('33')
  await page.getByRole('spinbutton', { name: 'Уровень H2, значение', exact: true }).press('Enter')
  assert.equal(await dial('Гармоника H2').inputValue(), '33')
  await page.getByLabel('Harmonic Template', { exact: true }).selectOption('square-approx')
  await page.getByText('Дополнительно: гармоники', { exact: true }).click()
  await button('Сравнить: Classic').click(); assert.equal(await button('Classic Oscillator').getAttribute('aria-pressed'), 'true')
  await waitStudioSound(page, true)
  await button('Сравнить: Additive').click(); assert.equal(await button('Additive Synthesis').getAttribute('aria-pressed'), 'true')
  await waitStudioSound(page, true)
  await page.getByText('Дополнительно: гармоники', { exact: true }).click()
  await button('Остановить тон Play').click(); await waitStudioSound(page, false)
  pass('Compact templates, nondestructive Solo/Mute, phase, precise harmonic entry and Classic comparison control real native sound', { combined })

  await Promise.all(Array.from({ length: 16 }, (_, index) => studioMidi(page, [0x90, 48 + index, 70 + index])))
  await waitStudioSound(page, true)
  await page.waitForFunction(() => document.querySelector('output[aria-label="Звучащие голоса"]')?.textContent === '16')
  assert.equal(await page.locator('.piano-key[aria-pressed="true"]').count() > 0, true)
  const voices = await studioTelemetry(page)
  assert.equal(voices.contexts, 1)
  await Promise.all(Array.from({ length: 16 }, (_, index) => studioMidi(page, [0x80, 48 + index, 0])))
  await waitStudioSound(page, false)
  pass('Studio accepts a sixteen-note live MIDI chord through the existing single audio context', voices)

  await button('Record phrase').click(); await status('Запись')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport)
    const visibleRecording = page.locator('.studio-transport-options > [role="status"]')
    assert.equal(await visibleRecording.isVisible(), true)
    assert.equal(await visibleRecording.innerText(), 'Запись')
    assert.equal(await visibleRecording.evaluate(element => element.classList.contains('studio-recording-indicator')), true)
  }
  await page.setViewportSize({ width: 1920, height: 1080 })
  await key('KeyA', true); await page.waitForTimeout(90); await key('KeyA', false)
  await Promise.all([60, 64, 67].map(midi => studioMidi(page, [0x90, midi, 100])))
  await page.waitForTimeout(120)
  await chooseWorkspace(page, 'learn'); await status('Запись')
  assert.equal(await page.getByLabel('Удерживаемые ноты', { exact: true }).innerText(), '3')
  await chooseWorkspace(page, 'studio'); await status('Запись')
  assert.equal(await page.getByLabel('Удерживаемые ноты', { exact: true }).innerText(), '3')
  await Promise.all([60, 64, 67].map(midi => studioMidi(page, [0x80, midi, 0])))
  await button('Stop phrase').click(); await status('Остановлено')
  const captured = await notes()
  assert.equal(captured.length, 4); assert.ok(captured.every(note => note.end > note.start && note.velocity >= 1 && note.velocity <= 127))
  await page.getByLabel('Название фразы', { exact: true }).fill('Studio persistence')
  await button('Save phrase').click()
  await page.locator('.phrase-section').filter({ has: page.locator('summary', { hasText: 'MY PHRASES' }) }).locator('summary').click()
  await button('Открыть фразу: Studio persistence').waitFor()
  await page.getByLabel('Studio Loop', { exact: true }).check(); await button('Play phrase').click(); await status('Воспроизведение'); await waitStudioSound(page, true)
  const playing = await studioTelemetry(page)
  await chooseWorkspace(page, 'learn'); await status('Воспроизведение')
  await chooseWorkspace(page, 'studio'); await status('Воспроизведение')
  assert.equal((await studioTelemetry(page)).contexts, playing.contexts)
  await button('Pause phrase').click(); await status('Пауза')
  await chooseWorkspace(page, 'learn'); await status('Пауза'); await chooseWorkspace(page, 'studio'); await status('Пауза')
  await button('Stop phrase').click(); await status('Остановлено'); await page.getByLabel('Studio Loop', { exact: true }).uncheck()
  await page.getByRole('region', { name: 'Phrase Recorder', exact: true }).screenshot({ path: `test-results/studio-recorder-${browser}.png` })
  await page.reload(); await page.locator('.studio-shell').waitFor()
  const library = page.locator('.phrase-section').filter({ has: page.locator('summary', { hasText: 'MY PHRASES' }) })
  if (!await library.evaluate(element => element.open)) await library.locator('summary').click()
  await button('Открыть фразу: Studio persistence').click()
  assert.equal((await notes()).length, 4)
  await chooseWorkspace(page, 'learn')
  assert.equal(await page.getByRole('navigation', { name: 'Выбор урока', exact: true }).getByRole('button').count(), 7)
  await page.screenshot({ path: `test-results/studio-learn-${browser}.png`, fullPage: true })
  pass('Recorder transport, real MIDI/PC capture, Piano Roll, Loop/Pause and saved phrases survive workspace changes and reload', { captured })

  assert.deepEqual(errors, [])
  await writeFile(`test-results/studio-ui-${browser}.json`, JSON.stringify({ browser, results, errors, physicalMidiTested: false, nativeBrowserZoomTested: false }, null, 2))
  console.log(`Studio UI: ${results.length} scenarios passed (${browser})`)
} catch (reason) {
  await writeFile(`test-results/studio-ui-${browser}.json`, JSON.stringify({ browser, results, errors, failure: reason instanceof Error ? reason.stack : String(reason) }, null, 2))
  throw reason
} finally { await context.close(); await session.close() }
