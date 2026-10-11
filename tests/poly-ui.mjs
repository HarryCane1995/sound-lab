import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser()
const { page } = session
const results = [], errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(4000)
const passed = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }

try {
  await page.addInitScript(() => {
    class Port extends EventTarget {
      constructor() { super(); this.id = 'poly-controller'; this.name = 'Polyphony Test Keyboard'; this.manufacturer = 'Simulated MIDI'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
    window.__polyMidi = { send(raw) { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) }, connect(connected) { port.state = connected ? 'connected' : 'disconnected'; access.dispatchEvent(new Event('statechange')) } }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
    window.__polyAudio = { contexts: [], analysers: [], oscillators: [] }
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args)
      window.__polyAudio.contexts.push(context)
      const createAnalyser = context.createAnalyser.bind(context)
      context.createAnalyser = (...args) => { const node = createAnalyser(...args); window.__polyAudio.analysers.push(node); return node }
      const createOscillator = context.createOscillator.bind(context)
      context.createOscillator = (...args) => { const node = createOscillator(...args); node.__ended = false; node.addEventListener('ended', () => { node.__ended = true }); window.__polyAudio.oscillators.push(node); return node }
      return context
    } })
  })
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  const number = name => page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
  const setNumber = async (name, value) => { await number(name).fill(String(value)); await number(name).press('Enter') }
  const send = async raw => { await page.evaluate(raw => window.__polyMidi.send(raw), raw); await page.waitForTimeout(40) }
  const waitCount = (label, value) => page.waitForFunction(({ label, value }) => Number(document.querySelector(`output[aria-label="${label}"]`)?.textContent) === value, { label, value }, { polling: 20 })
  const waitHeld = value => waitCount('Удерживаемые ноты', value)
  const waitVoices = value => waitCount('Звучащие голоса', value)
  const highlighted = () => page.locator('.piano-key[aria-pressed="true"]').count()
  const panic = async () => { await page.getByRole('button', { name: 'Panic / All Notes Off', exact: true }).click(); await waitHeld(0); await waitVoices(0) }
  const rms = () => page.evaluate(() => {
    const context = window.__polyAudio.contexts.findLast(item => item.state !== 'closed')
    const analyser = window.__polyAudio.analysers.find(item => item.context === context)
    if (!analyser) return 0
    const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data)
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length)
  })
  const carriers = () => page.evaluate(() => {
    const context = window.__polyAudio.contexts.findLast(item => item.state !== 'closed')
    return window.__polyAudio.oscillators.filter(node => node.context === context && !node.__ended && node.frequency.value > 20).map(node => ({ frequency: node.frequency.value, detune: node.detune.value, type: node.type }))
  })
  const key = midi => page.getByRole('button', { name: `Нота ${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`, exact: true })
  await setNumber('Нарастание', 0.005); await setNumber('Спад', 0.01); await setNumber('Удержание', 100); await setNumber('Затухание', 0.15)
  await page.getByRole('button', { name: 'Октава выше', exact: true }).click()

  for (const [note, velocity] of [[60, 120], [64, 70], [67, 35]]) await send([0x90, note, velocity])
  await waitHeld(3); await waitVoices(3)
  assert.equal(await highlighted(), 3)
  assert.match(await page.getByLabel('Активные ноты', { exact: true }).innerText(), /C4[\s\S]*E4[\s\S]*G4/)
  assert.equal(Number(await number('Частота').inputValue()), 220)
  await page.evaluate(() => {
    const context = window.__polyAudio.contexts.findLast(item => item.state !== 'closed')
    window.__polyAudio.analysers.find(item => item.context === context).fftSize = 32768
  })
  await page.waitForTimeout(700)
  const peaks = await page.evaluate(() => {
    const context = window.__polyAudio.contexts.findLast(item => item.state !== 'closed')
    const analyser = window.__polyAudio.analysers.find(item => item.context === context)
    const data = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(data)
    return [261.6256, 329.6276, 391.9954].map(frequency => {
      const bin = Math.round(frequency * analyser.fftSize / context.sampleRate)
      return { frequency, db: Math.max(...data.slice(bin - 2, bin + 3)) }
    })
  })
  assert.ok(peaks.every(item => item.db > -80), `All chord frequencies must exist in native output: ${JSON.stringify(peaks)}`)
  passed('C4/E4/G4 are simultaneously highlighted and present in the native mixed spectrum', { peaks })

  const allocations = await page.evaluate(() => window.__polyAudio.oscillators.length)
  await send([0x80, 64, 0]); await waitHeld(2)
  assert.equal(await highlighted(), 2)
  assert.equal(await key(60).getAttribute('aria-pressed'), 'true')
  assert.equal(await key(67).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(() => window.__polyAudio.oscillators.length), allocations)
  await waitVoices(2)
  await send([0x90, 64, 30]); await waitVoices(3)
  await send([0x90, 64, 100]); await waitHeld(3); await waitVoices(3)
  assert.equal(await page.evaluate(() => window.__polyAudio.oscillators.length), allocations + 1, 'Duplicate Note On must not allocate another voice')
  passed('Release leaves other keys held without restarting them; re-press and duplicate Note On remain independent')

  await page.locator('h1').click(); await page.keyboard.down('a'); await key(72).evaluate(element => element.click())
  await waitHeld(5); await waitVoices(5)
  assert.equal(await highlighted(), 4, 'Two sources playing C4 share one key highlight but keep independent voices')
  await send([0x80, 60, 0]); await waitHeld(4)
  assert.equal(await key(60).getAttribute('aria-pressed'), 'true', 'PC C4 must survive MIDI C4 Note Off')
  await key(72).evaluate(element => element.click()); await page.keyboard.up('a'); await waitHeld(2); await waitVoices(2)
  passed('PC, virtual click-only activation and MIDI coexist; same-note sources release separately')

  await key(60).evaluate(element => element.click()); await key(61).evaluate(element => element.click()); await waitHeld(4)
  await key(60).evaluate(element => element.click()); await waitHeld(3)
  assert.equal(await key(61).getAttribute('aria-pressed'), 'true')
  await key(61).evaluate(element => element.click()); await waitHeld(2)
  await key(60).focus(); await page.keyboard.down('Space'); await waitHeld(3)
  await page.keyboard.press('Tab'); await page.keyboard.up('Space'); await waitHeld(2)
  await key(60).focus(); await page.keyboard.down('Enter'); await waitHeld(3)
  await page.keyboard.up('Enter'); await waitHeld(2)
  passed('Independent assistive toggles, Space/Enter and release when Tab changes focus')

  // Synthetic pointer IDs exercise simultaneous touch identities. Real browser
  // pointer capture is covered by smoke.mjs; these events do not fabricate audio.
  for (const [midi, id] of [[60, 31], [61, 32]]) await key(midi).evaluate(element => { element.setPointerCapture = () => {}; element.hasPointerCapture = () => false })
  await key(60).dispatchEvent('pointerdown', { pointerId: 31, pointerType: 'touch', button: 0, buttons: 1 })
  await key(61).dispatchEvent('pointerdown', { pointerId: 32, pointerType: 'touch', button: 0, buttons: 1 })
  await waitHeld(4)
  await key(60).dispatchEvent('pointerup', { pointerId: 31, pointerType: 'touch', button: 0 })
  await waitHeld(3); assert.equal(await key(61).getAttribute('aria-pressed'), 'true')
  await key(61).dispatchEvent('pointercancel', { pointerId: 32, pointerType: 'touch', button: 0 })
  await waitHeld(2)
  passed('Multiple pointer identities form a chord and cancel/release only their own note')

  await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitVoices(3)
  await setNumber('Частота', 440)
  assert.ok((await carriers()).some(node => Math.abs(node.frequency - 440) < 0.1))
  assert.ok((await carriers()).some(node => Math.abs(node.frequency - 329.6276) < 0.1), 'Manual frequency must not retune held E4')
  await page.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitVoices(2); await waitHeld(2)
  assert.ok(await rms() > 0.0005)
  passed('Play has its own audition voice; manual tuning and Stop preserve held MIDI voices')

  await page.locator('h1').click(); await page.keyboard.down('a'); await send([0x91, 72, 90]); await waitHeld(4); await waitVoices(4)
  await send([0xe0, 127, 127]); await page.waitForTimeout(120)
  const bent = await carriers()
  for (const hz of [329.6276, 391.9954]) assert.ok(bent.some(node => Math.abs(node.frequency - hz) < 0.1 && Math.abs(node.detune - 200) < 1), `Channel 1 chord should bend: ${JSON.stringify(bent)}`)
  for (const hz of [261.6256, 523.2511]) assert.ok(bent.some(node => Math.abs(node.frequency - hz) < 0.1 && Math.abs(node.detune) < 1), `PC/channel 2 should stay centered: ${JSON.stringify(bent)}`)
  await page.getByRole('combobox', { name: 'Диапазон Pitch Bend', exact: true }).selectOption('12'); await page.waitForTimeout(120)
  assert.ok((await carriers()).filter(node => Math.abs(node.detune - 1200) < 1).length === 2)
  await send([0xe0, 0, 64]); await page.waitForTimeout(120)
  assert.ok((await carriers()).every(node => Math.abs(node.detune) < 1))
  passed('Source/channel Pitch Bend affects the full chord, preserves foreign voices and changes range without retrigger')

  await page.getByRole('button', { name: 'Октава выше', exact: true }).click(); await page.keyboard.up('a'); await waitHeld(3)
  assert.equal(await page.locator('.midi-note-list li').count(), 3, 'Changing octave must preserve MIDI notes outside the visible range')
  await send([0xb0, 123, 0]); await waitHeld(1)
  assert.equal(await page.locator('.midi-note-list li').count(), 1)
  assert.match(await page.locator('.midi-note-list').innerText(), /канал 2/)
  await waitVoices(1)
  passed('Octave change releases local held keys while MIDI continues; CC123 releases only its channel')

  await setNumber('Затухание', 5)
  await send([0x90, 60, 100]); await send([0x80, 60, 0]); await waitHeld(1); await waitVoices(2)
  await send([0xb0, 120, 0]); await waitVoices(1)
  assert.match(await page.locator('.midi-note-list').innerText(), /канал 2/)
  await page.locator('h1').click(); await page.keyboard.down('a'); await waitHeld(2)
  await page.evaluate(() => window.__polyMidi.connect(false)); await waitHeld(1); await waitVoices(1)
  assert.ok(await rms() > 0.0005)
  await page.keyboard.up('a'); await panic()
  await page.evaluate(() => window.__polyMidi.connect(true)); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  passed('Scoped CC120 stops release tails, and disconnect removes only device voices while PC audio survives')

  await setNumber('Затухание', 0.3)
  for (let midi = 48; midi < 65; midi++) await send([0x90, midi, 90])
  await waitHeld(17); await waitVoices(16)
  const liveAtLimit = (await carriers()).length
  assert.equal(liveAtLimit, 16)
  await send([0x80, 48, 0]); await waitHeld(16); await waitVoices(16)
  assert.equal((await carriers()).length, 16, 'Note Off of a stolen note must not release another voice')
  for (let midi = 49; midi < 65; midi++) await send([0x80, midi, 0])
  await waitHeld(0); await waitVoices(0)
  passed('Seventeen held notes stay bounded to sixteen sounding voices; stolen Note Off cannot stop another voice', { liveAtLimit })

  for (const note of [60, 64, 67]) await send([0x90, note, 100])
  await waitVoices(3)
  await page.getByRole('group', { name: 'Форма волны', exact: true }).getByRole('button', { name: /^Sawtooth/ }).click()
  await page.waitForTimeout(100); await waitVoices(3)
  assert.ok((await carriers()).every(node => node.type === 'sawtooth'))
  await page.getByRole('switch', { name: 'Bypass', exact: true }).click(); await setNumber('Частота среза', 1500)
  await page.getByRole('switch', { name: 'LFO', exact: true }).click(); await setNumber('Глубина', 15)
  await waitHeld(3); await waitVoices(3)
  assert.ok(await rms() > 0.0005)
  await panic()
  await page.waitForTimeout(750)
  assert.ok(await rms() < 0.00001)
  passed('Waveform crossfade, Filter and LFO preserve the chord; Panic removes all voices and reaches native silence')

  await page.locator('h1').click()
  for (const code of ['a', 'w', 'd']) await page.keyboard.down(code)
  await waitHeld(3); await waitVoices(3)
  assert.equal(await highlighted(), 3, 'White and black PC keys must play together')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  for (const code of ['a', 'w', 'd']) await page.keyboard.up(code)
  await waitHeld(0); await waitVoices(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  for (const note of [60, 64, 67]) await send([0x90, note, 100])
  await waitVoices(3)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await waitHeld(0); await waitVoices(0)
  passed('White/black PC chords, window blur and hidden-tab safety clear every held voice')

  for (const note of [60, 64, 67]) await send([0x90, note, 100])
  await waitVoices(3)
  await page.locator('#preset-select').selectOption('soft-bass'); await waitHeld(0); await waitVoices(0)
  for (const note of [60, 64, 67]) await send([0x90, note, 100])
  await waitVoices(3)
  await page.getByRole('button', { name: 'Сбросить все параметры', exact: true }).click(); await waitHeld(0); await waitVoices(0)
  assert.equal(Number(await number('Частота').inputValue()), 220)
  passed('Preset loading and parameter reset stop the whole chord without hanging notes')

  assert.equal(await page.evaluate(() => window.__polyAudio.contexts.filter(item => item.state !== 'closed').length), 1)
  assert.deepEqual(errors, [])
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await writeFile(`test-results/poly-ui-${userAgent.includes('Edg/') ? 'edge' : 'chrome'}.json`, JSON.stringify({ results, errors, userAgent }, null, 2))
  console.log(`All ${results.length} SOUND LAB polyphonic UI scenarios passed.`)
} finally {
  await session.close()
}
