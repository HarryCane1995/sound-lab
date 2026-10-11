import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const { page, close } = await startTestBrowser()
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(3500)

try {
  // Test-only native Web Audio probes: production code exposes no UI debug state.
  await page.addInitScript(() => {
    window.__audioProbe = { contexts: [], analysers: [], oscillators: [] }
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, {
      construct(Target, argumentsList) {
        const context = Reflect.construct(Target, argumentsList)
        window.__audioProbe.contexts.push(context)
        const createAnalyser = context.createAnalyser.bind(context)
        context.createAnalyser = (...args) => {
          const analyser = createAnalyser(...args)
          window.__audioProbe.analysers.push(analyser)
          return analyser
        }
        const createOscillator = context.createOscillator.bind(context)
        context.createOscillator = (...args) => {
          const oscillator = createOscillator(...args)
          window.__audioProbe.oscillators.push(oscillator)
          return oscillator
        }
        return context
      },
    })
  })
  await page.reload()
  await page.getByRole('heading', { name: 'Из чего состоит звук?' }).waitFor()
  const number = name => page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
  const play = () => page.getByRole('button', { name: 'Включить тон Play', exact: true }).click()
  const stop = () => page.getByRole('button', { name: 'Остановить тон Play', exact: true }).click()
  const reset = () => page.getByRole('button', { name: 'Сбросить все параметры', exact: true }).click()
  const isPlaying = () => page.getByRole('button', { name: 'Остановить тон Play', exact: true }).isVisible()
  const activeCount = () => page.locator('.piano-key[aria-pressed="true"]').count()
  const valueIs = async (name, value, epsilon = 0.015) => {
    assert.ok(Math.abs(Number(await number(name).inputValue()) - value) <= epsilon, `${name}: expected ${value}, got ${await number(name).inputValue()}`)
  }
  const audible = async () => {
    await page.waitForFunction(() => {
      const analyser = window.__audioProbe.analysers[0]
      if (!analyser) return false
      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length) > 0.001
    }, null, { polling: 20, timeout: 2000 })
  }
  const silent = async () => {
    await page.waitForFunction(() => {
      const analyser = window.__audioProbe.analysers[0]
      if (!analyser) return true
      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length) < 0.00001
    }, null, { polling: 20, timeout: 2000 })
  }
  const allParams = async expected => {
    for (const [name, value] of Object.entries(expected)) await valueIs(name, value)
  }

  assert.equal(await page.evaluate(() => window.__audioProbe.contexts.length), 0, 'AudioContext must be lazy')
  await valueIs('Частота', 220)
  await valueIs('Амплитуда', 25)
  assert.equal(await page.getByRole('slider', { name: 'Частота', exact: true }).getAttribute('aria-valuetext'), '220 Hz', 'Logarithmic sliders must announce the actual frequency, not their normalized position')
  const scopeScale = page.getByRole('combobox', { name: 'Шкала амплитуды', exact: true })
  assert.equal(await scopeScale.inputValue(), '0.25')
  await scopeScale.selectOption('1')
  assert.ok((await page.locator('.scope-canvas').getAttribute('aria-label')).includes('от −1 до 1'))
  await scopeScale.selectOption('0.1')
  assert.ok((await page.locator('.scope-canvas').getAttribute('aria-label')).includes('от −0.1 до 0.1'))
  await scopeScale.selectOption('0.25')
  await page.getByRole('slider', { name: 'Частота', exact: true }).fill('500')
  await valueIs('Частота', 632.46)
  await number('Частота').fill('330')
  await valueIs('Частота', 330)
  await page.getByRole('slider', { name: 'Амплитуда', exact: true }).fill('30')
  await valueIs('Амплитуда', 30)
  assert.equal(await page.evaluate(() => window.__audioProbe.contexts.length), 0, 'Controls must not initialize audio')
  await reset()

  await play()
  await audible()
  assert.equal(await page.evaluate(() => window.__audioProbe.contexts.length), 1)
  await number('Частота').focus()
  await page.keyboard.press('ControlOrMeta+A')
  await number('Частота').pressSequentially('440', { delay: 15 })
  await valueIs('Частота', 440)
  await page.waitForFunction(expected => {
    const carrier = window.__audioProbe.oscillators.at(-1)
    return carrier && Math.abs(carrier.frequency.value - expected) < 0.1
  }, 440, { polling: 20, timeout: 1000 })
  await number('Частота').press('Enter')
  await number('Нарастание').focus()
  await page.keyboard.press('ControlOrMeta+A')
  await number('Нарастание').pressSequentially('2.4', { delay: 15 })
  await valueIs('Нарастание', 2.4)
  await number('Нарастание').press('Enter')
  await number('Частота').fill('')
  assert.equal(await number('Частота').inputValue(), '', 'An empty draft must remain editable')
  await page.keyboard.press('Tab')
  await valueIs('Частота', 440)
  await number('Частота').focus()
  await page.keyboard.press('ControlOrMeta+A')
  await number('Частота').pressSequentially('660', { delay: 15 })
  await valueIs('Частота', 660)
  await page.keyboard.press('Escape')
  await valueIs('Частота', 440)
  await silent()
  assert.equal(await isPlaying(), false, 'Escape must both cancel the numeric draft and stop playback')
  console.log('PASS sequential integer/decimal typing, real carrier frequency, empty draft and Escape cancellation')
  await reset()
  await play()
  await audible()
  for (const wave of ['Sine', 'Square', 'Sawtooth', 'Triangle']) {
    const button = page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: new RegExp(`^${wave}`) })
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await audible()
  }
  await stop()
  await silent()
  assert.equal(await isPlaying(), false)
  await number('Частота').fill('0')
  assert.equal(await number('Частота').inputValue(), '0', 'Out-of-range draft must remain editable until commit')
  await number('Частота').press('Enter')
  await valueIs('Частота', 20)
  assert.ok(await page.evaluate(() => {
    const analyser = window.__audioProbe.analysers[0]
    return analyser.fftSize / analyser.context.sampleRate >= 0.15
  }), 'Time analysis must contain at least three periods at 20 Hz')
  await number('Частота').fill('25000')
  await number('Частота').press('Tab')
  await valueIs('Частота', 20000)
  await number('Частота').fill('220')
  await number('Частота').press('Enter')
  console.log('PASS lazy context, live Play/Stop, four waveforms, numeric and range controls')

  const presets = [
    ['pure-sine', 'Sine', { Частота: 220, Амплитуда: 22, Нарастание: 0.02, Спад: 0.2, Удержание: 75, Затухание: 0.35 }],
    ['8-bit-lead', 'Square', { Частота: 440, Амплитуда: 12, Нарастание: 0.005, Спад: 0.12, Удержание: 55, Затухание: 0.1, 'Частота среза': 6500 }],
    ['soft-bass', 'Triangle', { Частота: 110, Амплитуда: 28, Нарастание: 0.04, Спад: 0.3, Удержание: 65, Затухание: 0.3, 'Частота среза': 600 }],
    ['sharp-saw-lead', 'Sawtooth', { Частота: 220, Амплитуда: 15, Нарастание: 0.008, Спад: 0.15, Удержание: 65, Затухание: 0.16, 'Частота среза': 9000 }],
    ['evolving-pad', 'Sawtooth', { Частота: 220, Амплитуда: 14, Нарастание: 2.4, Спад: 1.2, Удержание: 65, Затухание: 2.8, 'Частота среза': 1100, Скорость: 0.35, Глубина: 20 }],
  ]
  for (const [id, waveform, expected] of presets) {
    await page.locator('#preset-select').selectOption(id)
    await allParams(expected)
    assert.equal(await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: new RegExp(`^${waveform}`) }).getAttribute('aria-pressed'), 'true')
    assert.equal(await isPlaying(), false, `Preset ${id} must not start audio`)
  }
  assert.equal(await page.getByRole('switch', { name: 'LFO', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Срез Filter Cutoff', exact: true }).getAttribute('aria-pressed'), 'true')
  for (const [name, expected] of [
    ['Короткий удар', { Нарастание: 0.005, Спад: 0.15, Удержание: 0, Затухание: 0.12 }],
    ['Мягкий пэд', { Нарастание: 2, Спад: 1, Удержание: 70, Затухание: 2.5 }],
    ['Орган', { Нарастание: 0.01, Спад: 0.02, Удержание: 100, Затухание: 0.07 }],
  ]) {
    await page.getByRole('button', { name, exact: true }).click()
    await allParams(expected)
  }
  console.log('PASS five presets with actual values and all three ADSR examples')

  await reset()
  const bypass = page.getByRole('switch', { name: 'Bypass', exact: true })
  assert.equal(await bypass.getAttribute('aria-checked'), 'true')
  assert.equal(await number('Частота среза').isDisabled(), true)
  await bypass.click()
  await number('Частота среза').fill('750')
  await number('Резонанс').fill('2')
  await allParams({ 'Частота среза': 750, Резонанс: 2 })
  const lfo = page.getByRole('switch', { name: 'LFO', exact: true })
  assert.equal(await number('Скорость').isDisabled(), true)
  await lfo.click()
  await number('Скорость').fill('2')
  await number('Глубина').fill('35')
  await page.getByRole('button', { name: 'Срез Filter Cutoff', exact: true }).click()
  await allParams({ Скорость: 2, Глубина: 35 })
  await bypass.click()
  assert.equal(await page.getByText('Выключите Bypass фильтра, чтобы услышать модуляцию среза.', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: 'Высота Pitch', exact: true }).click()
  await lfo.click()
  assert.equal(await number('Скорость').isDisabled(), true)
  console.log('PASS filter bypass, cutoff/Q, LFO switch, rate/depth and both targets')

  const lessonExpected = [
    { Частота: 220, Амплитуда: 20 }, { Частота: 220, Амплитуда: 20 },
    { Частота: 220, Амплитуда: 15 }, { Частота: 220, Амплитуда: 15 },
    { Частота: 220, Амплитуда: 16, Нарастание: 0.9, Спад: 0.6, Удержание: 35, Затухание: 1.2 },
    { Частота: 220, Амплитуда: 15, 'Частота среза': 8000 },
    { Частота: 220, Амплитуда: 15, 'Частота среза': 1400, Скорость: 4, Глубина: 12 },
  ]
  const lessons = page.getByRole('navigation', { name: 'Выбор урока', exact: true }).getByRole('button')
  assert.equal(await lessons.count(), 7)
  for (let index = 0; index < 7; index += 1) {
    await reset()
    await play()
    await audible()
    await lessons.nth(index).click()
    await page.getByRole('button', { name: /Загрузить демо/ }).click()
    assert.equal(await isPlaying(), false, `Lesson ${index + 1} must release playback`)
    assert.equal(await activeCount(), 0)
    await silent()
    await allParams(lessonExpected[index])
    const mark = page.getByRole('button', { name: 'Я это попробовал', exact: false })
    await mark.click()
  }
  assert.equal(await page.getByText('7 из 7', { exact: true }).isVisible(), true)
  console.log('PASS seven independent lesson demos, real silence after loading and session progress')

  await reset()
  // Physical key events use KeyboardEvent.code; no dependence on input language.
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await valueIs('Частота', 220)
  await page.keyboard.down('s')
  await valueIs('Частота', 220)
  assert.equal(await activeCount(), 2, 'Physical keys must form a chord without changing manual Frequency')
  const chordOscillators = await page.evaluate(() => window.__audioProbe.oscillators.length)
  await page.keyboard.up('s')
  await valueIs('Частота', 220)
  assert.equal(await activeCount(), 1)
  assert.equal(await page.evaluate(() => window.__audioProbe.oscillators.length), chordOscillators, 'Releasing a note must not restart another held voice')
  await page.keyboard.down('s')
  await page.keyboard.up('a')
  await valueIs('Частота', 220)
  assert.equal(await activeCount(), 1)
  await page.keyboard.up('s')
  await silent()
  assert.equal(await activeCount(), 0)

  await page.keyboard.down('a')
  const oscillatorCount = await page.evaluate(() => window.__audioProbe.oscillators.length)
  await page.keyboard.down('a') // Browser emits repeat:true for an already held key.
  assert.equal(await activeCount(), 1)
  assert.equal(await page.evaluate(() => window.__audioProbe.oscillators.length), oscillatorCount)
  await page.keyboard.up('a')
  await silent()
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'ф', bubbles: true })))
  await valueIs('Частота', 220)
  assert.equal(await activeCount(), 1, 'Russian key text must retain the physical KeyA position')
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'ф', bubbles: true })))
  await silent()
  console.log('PASS independent physical-key voices, stable manual Frequency, key repeat and Russian-layout physical code')

  const pianoC = page.getByRole('button', { name: 'Нота C3', exact: true })
  await pianoC.evaluate(element => element.click())
  await audible()
  assert.equal(await activeCount(), 1, 'Click-only assistive activation must play the piano key')
  await pianoC.evaluate(element => element.click())
  await silent()
  assert.equal(await activeCount(), 0, 'Repeated click-only activation must release its held note')
  await pianoC.focus()
  await page.keyboard.down('Space')
  await audible()
  await page.keyboard.press('Tab')
  await page.keyboard.up('Space')
  await silent()
  assert.equal(await activeCount(), 0, 'A focused piano key must release when Tab moves focus during Space')
  await pianoC.scrollIntoViewIfNeeded()
  let box = await pianoC.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7)
  await page.mouse.down()
  await audible()
  await page.mouse.move(4, 4)
  await page.mouse.up()
  await silent()
  assert.equal(await activeCount(), 0, 'Pointer capture must release outside the keyboard')
  await pianoC.scrollIntoViewIfNeeded()
  box = await pianoC.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7)
  await page.mouse.down()
  await audible()
  await pianoC.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', button: 0 })
  await page.mouse.up()
  await silent()
  assert.equal(await activeCount(), 0)

  await page.locator('h1').click()
  await page.keyboard.down('a')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.keyboard.up('a')
  await silent()
  assert.equal(await activeCount(), 0)
  await play()
  await audible()
  // Deterministically exercise the hidden-document handler in headless Chromium.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await silent()
  assert.equal(await isPlaying(), false)
  console.log('PASS pointer release outside, pointercancel, window blur and hidden-document safety')

  await page.locator('h1').click()
  await page.keyboard.down('a')
  await reset()
  await page.keyboard.up('a')
  await valueIs('Частота', 220)
  await silent()
  assert.equal(await activeCount(), 0)
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await page.getByRole('button', { name: 'Октава выше', exact: true }).click()
  await page.keyboard.up('a')
  await silent()
  assert.equal(await activeCount(), 0)
  await page.getByRole('button', { name: 'Октава ниже', exact: true }).click()

  await number('Частота').focus()
  await page.keyboard.press('a')
  assert.equal(await activeCount(), 0, 'Typing in number inputs must not play a note')
  assert.equal(await isPlaying(), false)
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await audible()
  await number('Частота').fill('330')
  assert.equal(await activeCount(), 1, 'Manual tuning must preserve a held keyboard note')
  await audible()
  await page.keyboard.up('a')
  await valueIs('Частота', 330)
  assert.equal(await activeCount(), 0)
  assert.equal(await isPlaying(), false, 'Manual tuning must not create an audition voice')
  await silent()
  await play()
  await audible()
  await page.keyboard.press('Escape')
  await silent()
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await valueIs('Частота', 330)
  await page.keyboard.up('a')
  await silent()
  console.log('PASS reset/octave clear local held notes, input focus, independent manual frequency and Esc')

  await reset()
  await mkdir('test-results', { recursive: true })
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1100 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(60)
    const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: window.innerWidth }))
    assert.ok(overflow.document <= overflow.viewport + 1 && overflow.body <= overflow.viewport + 1, `${name} horizontal overflow: ${JSON.stringify(overflow)}`)
    for (const canvas of await page.locator('canvas').all()) {
      const dimensions = await canvas.evaluate(element => ({ width: element.width, height: element.height, cssWidth: element.getBoundingClientRect().width }))
      assert.ok(dimensions.width > 0 && dimensions.height > 0 && dimensions.cssWidth <= viewport.width)
    }
    await page.screenshot({ path: `test-results/${name}.png`, fullPage: true })
  }
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.deepEqual(errors, [], 'Browser must have no console errors or uncaught exceptions')
  assert.equal(await page.evaluate(() => window.__audioProbe.contexts.length), 1, 'All interaction must reuse the same AudioContext')
  console.log('PASS responsive desktop/mobile, screenshots, no console errors, one reused AudioContext')
  console.log('All SOUND LAB UI smoke checks passed.')
} finally {
  await close()
}
