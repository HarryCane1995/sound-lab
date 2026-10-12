import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser()
const { page } = session
const errors = []
const results = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(4000)
const passed = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }

try {
  // Inject ports before React mounts. Only MIDI is simulated: all analyser
  // samples below come from the application's native Web Audio graph.
  await page.addInitScript(() => {
    const scenario = sessionStorage.getItem('sound-lab.test-midi-scenario') ?? 'ready'
    class Port extends EventTarget {
      constructor(id, name) { super(); this.id = id; this.name = name; this.manufacturer = 'Test Instruments'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const access = new EventTarget()
    const primary = new Port('test-primary', 'Generic USB Keyboard')
    const secondary = new Port('test-secondary', 'Alternate MIDI Port')
    access.inputs = new Map(scenario === 'empty' ? [] : [[primary.id, primary], [secondary.id, secondary]])
    access.outputs = new Map()
    access.sysexEnabled = false
    const ports = new Map([[primary.id, primary], [secondary.id, secondary]])
    window.__mockMidi = {
      requests: [], access, ports,
      send(id, raw) {
        const input = ports.get(id)
        const event = new Event('midimessage')
        Object.defineProperty(event, 'data', { value: new Uint8Array(raw) })
        input.dispatchEvent(event)
      },
      setConnected(id, connected) {
        const input = ports.get(id)
        input.state = connected ? 'connected' : 'disconnected'
        access.dispatchEvent(new Event('statechange'))
      },
    }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: scenario === 'unsupported' ? undefined : async options => {
      window.__mockMidi.requests.push(options)
      if (scenario === 'denied') throw new DOMException('Test MIDI permission refused', 'NotAllowedError')
      return access
    } })
    window.__midiAudio = { contexts: [], analysers: [], oscillators: [] }
    window.__midiAudio.activeAnalyser = () => {
      const context = window.__midiAudio.contexts.findLast(item => item.state !== 'closed')
      return window.__midiAudio.analysers.find(item => item.context === context) ?? null
    }
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args)
      window.__midiAudio.contexts.push(context)
      const createAnalyser = context.createAnalyser.bind(context)
      context.createAnalyser = (...parameters) => { const node = createAnalyser(...parameters); window.__midiAudio.analysers.push(node); return node }
      const createOscillator = context.createOscillator.bind(context)
      context.createOscillator = (...parameters) => { const node = createOscillator(...parameters); window.__midiAudio.oscillators.push(node); return node }
      return context
    } })
  })
  await page.evaluate(() => { localStorage.removeItem('sound-lab.midi.v1'); sessionStorage.removeItem('sound-lab.test-midi-scenario') })
  await page.reload()
  await page.getByRole('heading', { name: 'Физический контроллер', exact: false }).waitFor()
  const panel = page.getByRole('region', { name: 'MIDI Controller', exact: true })
  const num = name => page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
  const value = async name => Number(await num(name).inputValue())
  const send = async (bytes, id = 'test-primary') => { await page.evaluate(({ id, bytes }) => window.__mockMidi.send(id, bytes), { id, bytes }); await page.waitForTimeout(45) }
  const setNumber = async (name, number) => { await num(name).fill(String(number)); await num(name).press('Enter') }
  const waitValue = async (name, expected, epsilon = 0.02) => {
    await page.waitForFunction(({ name, expected, epsilon }) => {
      const field = [...document.querySelectorAll('input[type="number"]')].find(item => item.getAttribute('aria-label') === `${name}, значение`)
      return field && Math.abs(Number(field.value) - expected) <= epsilon
    }, { name, expected, epsilon })
  }
  const rms = () => page.evaluate(() => {
    const analyser = window.__midiAudio.activeAnalyser()
    if (!analyser) return 0
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length)
  })
  const waitSilent = (timeout = 2000) => page.waitForFunction(() => {
    const analyser = window.__midiAudio.activeAnalyser()
    if (!analyser) return true
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length) < 0.00001
  }, null, { polling: 25, timeout })
  const waitAudible = () => page.waitForFunction(() => {
    const analyser = window.__midiAudio.activeAnalyser()
    if (!analyser) return false
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length) > 0.001
  }, null, { polling: 25, timeout: 2000 })
  const learnButton = target => page.getByRole('button', { name: `MIDI Learn: ${target}`, exact: true })
  const bindingRow = target => page.locator('.midi-binding-list li').filter({ has: page.locator('.midi-binding-description b', { hasText: target }) })
  const mappings = panel.locator('details.midi-bindings')
  const openMappings = async () => { if (!await mappings.evaluate(element => element.open)) await mappings.locator('summary').click() }
  const learnAction = async target => {
    await openMappings()
    await page.getByRole('combobox', { name: 'Параметр для MIDI Learn', exact: true }).selectOption(target)
    await page.getByRole('button', { name: 'Начать MIDI Learn', exact: true }).click()
  }

  assert.equal(await page.evaluate(() => window.__mockMidi.requests.length), 0)
  assert.equal(await page.evaluate(() => window.__midiAudio.contexts.length), 0)
  assert.equal(await panel.locator('details[open]').count(), 0)
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  assert.deepEqual(await page.evaluate(() => window.__mockMidi.requests), [{ sysex: false }])
  assert.equal(await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).inputValue(), 'test-primary')
  await waitSilent()
  passed('User-triggered permission, arbitrary device names, collapsed diagnostics and silent audio unlock')

  await setNumber('Нарастание', 0.005)
  await setNumber('Спад', 0.01)
  await setNumber('Удержание', 100)
  await setNumber('Затухание', 0.05)
  await page.evaluate(() => { window.__midiAudio.activeAnalyser().fftSize = 2048 })
  await send([0x90, 60, 64])
  await waitAudible()
  assert.equal(await page.getByRole('button', { name: 'Нота C4', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.match(await panel.locator('.midi-note').innerText(), /C4[\s\S]*MIDI 60[\s\S]*261\.63 Hz[\s\S]*Generic USB Keyboard[\s\S]*канал 1/)
  await send([0x90, 64, 100])
  await waitValue('Частота', 220)
  assert.equal(await panel.locator('.midi-note-list li').count(), 2, 'Both MIDI notes must remain held')
  const chordOscillators = await page.evaluate(() => window.__midiAudio.oscillators.length)
  await send([0x80, 64, 0])
  await waitValue('Частота', 220)
  assert.equal(await panel.locator('.midi-note-list li').count(), 1)
  assert.equal(await page.evaluate(() => window.__midiAudio.oscillators.length), chordOscillators, 'Note Off must not retrigger the remaining MIDI voice')
  await send([0x90, 60, 0])
  await waitSilent()
  assert.equal(await page.locator('.piano-key[aria-pressed="true"]').count(), 0)
  passed('Independent MIDI notes, velocity-zero release, stable manual Frequency, note name/frequency/source and virtual-key highlight')

  await send([0x90, 69, 32])
  await page.waitForTimeout(150)
  const soft = await rms()
  await send([0x80, 69, 0])
  await waitSilent()
  await send([0x90, 69, 127])
  await page.waitForTimeout(150)
  const strong = await rms()
  assert.ok(soft > 0.0005 && strong > soft * 3.6 && strong < soft * 4.4, `Velocity should scale native output: ${soft} → ${strong}`)
  assert.equal(await panel.getByLabel('Текущая Velocity', { exact: true }).innerText(), '127 / 127')
  assert.equal(await value('Амплитуда'), 25, 'Velocity must not overwrite Amplitude')
  const oscillatorCount = await page.evaluate(() => window.__midiAudio.oscillators.length)
  await send([0xe0, 127, 127])
  await page.waitForTimeout(120)
  assert.match(await panel.getByLabel('Текущий Pitch Bend', { exact: true }).innerText(), /\+2\.00/)
  const bentHz = await page.evaluate(() => {
    const analyser = window.__midiAudio.activeAnalyser()
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    const crossings = []
    for (let i = 1; i < data.length; i++) if (data[i - 1] <= 0 && data[i] > 0) crossings.push(i - 1 - data[i - 1] / (data[i] - data[i - 1]))
    return analyser.context.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0])
  })
  assert.ok(Math.abs(bentHz - 493.883) < 2, `14-bit bend changes actual signal frequency: ${bentHz}`)
  assert.equal(await page.evaluate(() => window.__midiAudio.oscillators.length), oscillatorCount, 'Pitch Bend must reuse the oscillator')
  await send([0xe0, 0, 64])
  await send([0xb0, 1, 127])
  assert.match(await panel.getByLabel('Текущая Modulation', { exact: true }).innerText(), /127.*100%/)
  await page.getByRole('switch', { name: 'LFO', exact: true }).click()
  await waitValue('Глубина', 100)
  await page.getByRole('switch', { name: 'LFO', exact: true }).click()
  await send([0x80, 69, 0])
  await waitSilent()
  passed('Native output amplitude follows velocity; continuous ±2-semitone bend and standard modulation', { softRms: soft, strongRms: strong, ratio: strong / soft, bentHz })

  await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  await learnButton('Cutoff · Частота среза').click()
  assert.equal(await learnButton('Cutoff · Частота среза').getAttribute('aria-pressed'), 'true')
  await send([0xb0, 74, 64])
  assert.equal(await value('Частота среза'), 8000, 'Learn capture must be inert')
  await openMappings()
  assert.match(await bindingRow('Cutoff · Частота среза').innerText(), /CC 74.*канал 1[\s\S]*Generic USB Keyboard/)
  await send([0xb0, 74, 0])
  await waitValue('Частота среза', 20)
  await page.getByLabel('Cutoff · Частота среза: управление MIDI', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.getByLabel('Cutoff · Частота среза: управление MIDI', { exact: true }).isVisible(), true)
  await send([0xb0, 74, 127])
  await waitValue('Частота среза', 20000, 1)
  await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: /^Sawtooth/ }).click()
  await send([0x90, 69, 100])
  await page.waitForTimeout(220)
  const openFilter = await rms()
  await send([0xb0, 74, 0])
  await page.waitForTimeout(220)
  const closedFilter = await rms()
  assert.ok(openFilter > 0.001 && closedFilter < openFilter / 15, `MIDI Cutoff must change the real output: ${openFilter} → ${closedFilter}`)
  await send([0x80, 69, 0])
  await waitSilent()
  await page.getByRole('combobox', { name: 'Режим энкодера: Cutoff · Частота среза', exact: true }).selectOption('relative-twos-complement')
  await setNumber('Частота среза', 1000)
  await send([0xb0, 74, 1])
  const relativeUp = await value('Частота среза')
  assert.ok(relativeUp > 1000 && relativeUp < 1100)
  await send([0xb0, 74, 127])
  await waitValue('Частота среза', 1000, 1)
  await page.getByRole('combobox', { name: 'Режим энкодера: Cutoff · Частота среза', exact: true }).selectOption('absolute')
  passed('CC Learn captures actual source/channel, logarithmic mapping, MIDI activity, native filter effect and explicit relative encoder mode', { openRms: openFilter, closedRms: closedFilter, relativeUp })

  await learnButton('Amplitude · Громкость').click()
  await send([0xb0, 74, 90])
  assert.equal(await page.getByRole('button', { name: 'Заменить привязку', exact: true }).isVisible(), true)
  await page.getByRole('button', { name: 'Отменить замену', exact: true }).click()
  assert.equal(await bindingRow('Cutoff · Частота среза').count(), 1)
  await learnButton('Amplitude · Громкость').click()
  await send([0xb0, 74, 90])
  await page.getByRole('button', { name: 'Заменить привязку', exact: true }).click()
  assert.equal(await bindingRow('Cutoff · Частота среза').count(), 0)
  assert.equal(await bindingRow('Amplitude · Громкость').count(), 1)
  await page.getByRole('button', { name: 'Удалить MIDI-привязку: Amplitude · Громкость', exact: true }).click()
  await learnButton('Cutoff · Частота среза').click()
  await send([0xb0, 74, 64])
  await learnButton('Frequency · Частота').click()
  await page.keyboard.press('Escape')
  assert.equal(await learnButton('Frequency · Частота').getAttribute('aria-pressed'), 'false')
  passed('Learn conflict cancel/replace, individual removal and Escape cancellation')

  await learnAction('preset.soft-bass')
  await send([0x99, 36, 110])
  await waitSilent()
  assert.equal(await page.locator('#preset-select').inputValue(), '', 'Learning a pad must not execute its action')
  await send([0x89, 36, 0])
  await send([0x99, 36, 110])
  assert.equal(await page.locator('#preset-select').inputValue(), 'soft-bass')
  await waitSilent()
  assert.equal(await page.locator('.piano-key[aria-pressed="true"]').count(), 0, 'Mapped pads must not also play notes')
  await setNumber('Амплитуда', 17)
  await send([0x99, 36, 110])
  assert.equal(await value('Амплитуда'), 17, 'Repeated held Note On must not retrigger its action')
  await send([0x89, 36, 0])
  await send([0x99, 36, 110])
  await waitValue('Амплитуда', 28)
  await send([0x89, 36, 0])
  await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).selectOption('test-secondary')
  await page.reload()
  await panel.waitFor()
  assert.equal(await page.evaluate(() => window.__mockMidi.requests.length), 0, 'Reload must not request MIDI without a user gesture')
  await openMappings()
  assert.equal(await bindingRow('Cutoff · Частота среза').count(), 1)
  assert.equal(await bindingRow('Пресет · Мягкий бас').count(), 1)
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  assert.equal(await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).inputValue(), 'test-secondary', 'Device selection must restore')
  await send([0x90, 60, 100], 'test-primary')
  await waitSilent()
  await send([0x90, 60, 100], 'test-secondary')
  await waitAudible()
  await send([0x80, 60, 0], 'test-primary')
  await waitAudible()
  await page.evaluate(() => window.__mockMidi.setConnected('test-secondary', false))
  await waitSilent()
  await page.waitForFunction(() => document.querySelector('.midi-status-disconnected'))
  await page.evaluate(() => window.__mockMidi.setConnected('test-secondary', true))
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await send([0x90, 60, 100], 'test-secondary')
  await waitAudible()
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await waitValue('Частота', 220)
  await send([0x90, 64, 100], 'test-secondary')
  await waitValue('Частота', 220)
  assert.equal(await panel.locator('.midi-note-list li').count(), 2)
  await send([0x80, 64, 0], 'test-secondary')
  await waitValue('Частота', 220)
  await page.keyboard.up('a')
  await waitValue('Частота', 220)
  await send([0x91, 60, 80], 'test-secondary')
  await send([0x80, 60, 0], 'test-secondary')
  await waitAudible()
  assert.match(await panel.locator('.midi-note').innerText(), /канал 2/)
  await send([0x81, 60, 0], 'test-secondary')
  await waitSilent()
  await send([0x90, 60, 100], 'test-secondary')
  await waitAudible()
  await page.getByRole('button', { name: 'Panic / All Notes Off', exact: true }).click()
  await waitSilent()
  await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).selectOption('test-primary')
  await send([0x99, 36, 110])
  assert.equal(await page.locator('#preset-select').inputValue(), 'soft-bass', 'Reloaded pad assignment must execute')
  await send([0x89, 36, 0])
  passed('Pad preset action/release latch, persistence, preferred device restore, source isolation, disconnect/reconnect and Panic')
  passed('Independent simultaneous PC/MIDI voices, stable manual Frequency and same-note MIDI channel isolation')

  await setNumber('Нарастание', 0.005)
  await setNumber('Спад', 0.01)
  await setNumber('Удержание', 100)
  await setNumber('Затухание', 5)
  await page.evaluate(() => { window.__midiAudio.activeAnalyser().fftSize = 2048 })
  await send([0x90, 60, 100])
  await waitAudible()
  await send([0x80, 60, 0])
  await page.waitForTimeout(100)
  assert.ok(await rms() > 0.001, 'Five-second release must still be audible before All Sound Off')
  await send([0xb0, 120, 0])
  await waitSilent(500)
  await send([0x90, 60, 100])
  await waitAudible()
  await page.evaluate(() => window.__mockMidi.setConnected('test-primary', false))
  await waitSilent(500)
  await page.evaluate(() => window.__mockMidi.setConnected('test-primary', true))
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await send([0x90, 60, 100])
  await waitAudible()
  await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).selectOption('test-secondary')
  await waitSilent(500)
  await page.getByRole('combobox', { name: 'MIDI-вход', exact: true }).selectOption('test-primary')
  await setNumber('Затухание', 0.05)
  passed('CC120 during a five-second release, unplug and input switch each reach native silence within 500 ms')

  const monitor = panel.locator('details.midi-monitor')
  await monitor.locator('summary').click()
  await send([0xd2, 55])
  await send([0xa2, 64, 77])
  await send([0x92, 60, 0])
  assert.equal(await monitor.getByText('Aftertouch', { exact: true }).isVisible(), true)
  assert.equal(await monitor.getByText('Poly Aftertouch', { exact: true }).isVisible(), true)
  assert.equal(await monitor.locator('.midi-event-list li').first().getByText('Note Off', { exact: true }).isVisible(), true)
  assert.match(await monitor.innerText(), /канал 3/)
  assert.match(await monitor.innerText(), /92 3C 00/)
  for (let index = 0; index < 35; index++) await page.evaluate(index => window.__mockMidi.send('test-primary', [0xb0, 25, index]), index)
  await page.waitForTimeout(60)
  assert.equal(await monitor.locator('.midi-event-list li').count(), 30)
  await page.getByRole('button', { name: 'Очистить MIDI Monitor', exact: true }).click()
  assert.equal(await monitor.locator('.midi-event-list li').count(), 0)
  await openMappings()
  await page.getByRole('button', { name: 'Удалить все MIDI-привязки', exact: true }).click()
  assert.equal(await page.locator('.midi-binding-list li').count(), 0)
  await page.locator('h1').click()
  await page.keyboard.down('a')
  await waitAudible()
  await page.keyboard.up('a')
  await waitSilent()
  passed('Monitor event types/channel/RAW/newest-first/30-event bound, clear controls and independent PC keyboard')

  await openMappings()
  await learnAction('waveform.next')
  await send([0xb0, 25, 127])
  await send([0xb0, 25, 0])
  await send([0xb0, 25, 127])
  for (const [name, viewport] of [['midi-desktop', { width: 1440, height: 1100 }], ['midi-mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(80)
    const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth }))
    assert.ok(overflow.document <= viewport.width + 1 && overflow.body <= viewport.width + 1, `${name} overflow: ${JSON.stringify(overflow)}`)
    await page.screenshot({ path: `test-results/${name}.png`, fullPage: true })
  }
  passed('Expanded mapping/monitor responsive desktop/mobile layouts')

  for (const scenario of ['empty', 'denied', 'unsupported']) {
    await page.evaluate(scenario => { localStorage.removeItem('sound-lab.midi.v1'); sessionStorage.setItem('sound-lab.test-midi-scenario', scenario) }, scenario)
    await page.reload()
    await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
    const status = scenario === 'empty' ? 'no-devices' : scenario
    await page.waitForFunction(status => document.querySelector(`.midi-status-${status}`), status)
    await waitSilent()
    await page.locator('h1').click()
    await page.keyboard.down('a')
    await waitAudible()
    await page.keyboard.up('a')
    try { await waitSilent() } catch (error) {
      console.log('Permission-case release diagnostics', scenario, await page.evaluate(() => ({
        hidden: document.hidden, focused: document.hasFocus(), active: document.querySelectorAll('.piano-key[aria-pressed="true"]').length,
        status: document.querySelector('.audio-status')?.textContent, context: window.__midiAudio.contexts.map(item => ({ state: item.state, time: item.currentTime })),
      })), 'RMS', await rms())
      throw error
    }
    assert.equal(await page.getByRole('alert').count(), 0)
  }
  passed('No MIDI devices, denied permission and unsupported API remain silent and preserve the PC keyboard')
  assert.deepEqual(errors, [], 'No console errors or uncaught exceptions')
  const userAgent = await page.evaluate(() => navigator.userAgent)
  const report = JSON.stringify({ results, errors, browser: process.env.SOUND_LAB_BROWSER ?? 'auto', userAgent }, null, 2)
  await writeFile(`test-results/midi-ui-${userAgent.includes('Edg/') ? 'edge' : 'chrome'}.json`, report)
  await writeFile('test-results/midi-ui.json', report)
  console.log(`All ${results.length} SOUND LAB MIDI UI scenarios passed.`)
} finally {
  await session.close()
}
