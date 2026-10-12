import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const session = await startTestBrowser(), { page } = session
const results = [], errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(6000)
const pass = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }

try {
  await page.addInitScript(() => {
    class Port extends EventTarget {
      constructor() { super(); this.id = 'phrase-controller'; this.name = 'Phrase Test MIDI'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed'; this.manufacturer = 'Simulated' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
    window.__phraseMidi = raw => { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) }
    window.__phraseConnected = connected => { port.state = connected ? 'connected' : 'disconnected'; connected ? access.inputs.set(port.id, port) : access.inputs.delete(port.id); access.dispatchEvent(new Event('statechange')) }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
    if (sessionStorage.getItem('phrase-test-storage-denied')) Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('Test IndexedDB unavailable', 'SecurityError') } } })
  })
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() }); await page.reload()
  const recorder = page.getByRole('region', { name: 'Phrase Recorder', exact: true })
  const button = name => recorder.getByRole('button', { name, exact: true })
  const status = expected => page.waitForFunction(expected => document.querySelector('.phrase-status')?.textContent === expected, expected)
  const notes = () => recorder.locator('.phrase-roll-note').evaluateAll(elements => elements.map(element => ({ midi: +element.dataset.midi, velocity: +element.dataset.velocity, start: +element.dataset.start, end: +element.dataset.end })))
  const readStore = store => page.evaluate(store => new Promise((resolve, reject) => {
    const open = indexedDB.open('sound-lab.phrases.v1', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(store, 'readonly'), request = store === 'draft' ? tx.objectStore(store).get('current') : tx.objectStore(store).getAll()
      tx.oncomplete = () => { resolve(request.result ?? null); db.close() }; tx.onerror = () => { reject(tx.error); db.close() }
    }
  }), store)
  const draft = () => readStore('draft')
  const midi = async raw => { await page.evaluate(raw => window.__phraseMidi(raw), raw); await page.waitForTimeout(30) }
  const pc = (code, down) => page.evaluate(({ code, down }) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })), { code, down })
  const pointer = (offset, id, down) => page.evaluate(({ offset, id, down }) => document.querySelectorAll('.piano-key')[offset].dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', { pointerId: id, pointerType: 'touch', button: 0, buttons: down ? 1 : 0, bubbles: true })), { offset, id, down })
  const installProbe = () => page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').findLast(entry => entry.name.includes('/src/audio/SynthEngine.ts'))?.name ?? '/src/audio/SynthEngine.ts'
    const { SynthEngine } = await import(url), native = SynthEngine.prototype.getAnalysis
    SynthEngine.prototype.getAnalysis = function (...args) { window.__phraseEngine = this; return native.apply(this, args) }
    for (const key of document.querySelectorAll('.piano-key')) { key.setPointerCapture = () => {}; key.hasPointerCapture = () => false }
  })
  const voices = () => page.evaluate(() => window.__phraseEngine?.getVoices().map(voice => ({ id: voice.id, instanceId: voice.instanceId, origin: voice.origin, gateOpen: voice.gateOpen, frequency: voice.frequency })) ?? [])
  const dialogClick = async (locator, accept) => {
    const pending = page.waitForEvent('dialog'); const click = locator.click(); const dialog = await pending
    accept ? await dialog.accept() : await dialog.dismiss(); await click; return dialog.message()
  }
  const importJson = async raw => {
    const accept = dialog => dialog.accept()
    page.on('dialog', accept)
    try {
      await recorder.getByLabel('Import phrase JSON', { exact: true }).setInputFiles({ name: 'phrase.json', mimeType: 'application/json', buffer: Buffer.from(raw) })
      await page.waitForFunction(() => document.querySelector('input[aria-label="Import phrase JSON"]').value === '')
    }
    finally { page.off('dialog', accept) }
  }
  const download = async name => {
    const pending = page.waitForEvent('download'); await button(name).click(); const result = await pending
    return { name: result.suggestedFilename(), data: await readFile(await result.path()) }
  }
  const delayLibraryCommit = () => page.evaluate(() => {
    const prototype = IDBTransaction.prototype, complete = Object.getOwnPropertyDescriptor(prototype, 'oncomplete'), put = IDBObjectStore.prototype.put
    window.__delayedPhraseCommit = null; window.__draftWritesDuringRace = []; window.__delayPhraseCommitOnce = true
    Object.defineProperty(prototype, 'oncomplete', { configurable: true, get: complete.get, set(handler) {
      if (this.mode === 'readwrite' && this.objectStoreNames.contains('phrases') && window.__delayPhraseCommitOnce) {
        window.__delayPhraseCommitOnce = false
        complete.set.call(this, function (event) { window.__delayedPhraseCommit = () => handler.call(this, event) })
      } else complete.set.call(this, handler)
    } })
    IDBObjectStore.prototype.put = function (value, ...args) { if (this.name === 'draft') window.__draftWritesDuringRace.push({ id: value.id, name: value.name }); return put.call(this, value, ...args) }
    window.__restoreIdbRaceProbe = () => { Object.defineProperty(prototype, 'oncomplete', complete); IDBObjectStore.prototype.put = put }
  })
  const recordBeforeCommitDelivery = async () => {
    await page.waitForFunction(() => typeof window.__delayedPhraseCommit === 'function')
    page.once('dialog', dialog => dialog.accept())
    // Deliver completion in the same JS task as Record, before the hook's next
    // 25ms snapshot. The native transaction itself has already committed.
    await page.evaluate(() => { document.querySelector('button[aria-label="Record phrase"]').click(); window.__delayedPhraseCommit() })
    await status('Запись')
  }
  await recorder.waitFor(); await installProbe()
  assert.equal(await recorder.locator('.phrase-section').count(), 3)
  assert.equal(await button('Play phrase').isDisabled(), true)
  assert.equal(await recorder.getByRole('button', { name: 'Free', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await recorder.getByLabel('Phrase BPM', { exact: true }).inputValue(), '120')
  assert.equal(await recorder.getByLabel('Квантизация фразы', { exact: true }).inputValue(), 'off')
  assert.equal(await recorder.getByLabel('Метроном', { exact: true }).isDisabled(), true)
  assert.equal(await recorder.getByLabel('Отсчёт 1 такт', { exact: true }).isDisabled(), true)
  assert.match(await recorder.innerText(), /аудио, CC, Pitch Bend/)
  pass('Empty state, three collapsible sections, Free 120 BPM and non-audio scope')

  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await button('Record phrase').click(); await status('Запись')
  await midi([0x90, 60, 50]); await midi([0x90, 64, 110]); await pc('KeyA', true); await pointer(0, 81, true); await pointer(4, 82, true)
  await page.waitForTimeout(130); await midi([0x80, 60, 0]); await midi([0x90, 67, 90]); await midi([0xb0, 74, 87]); await midi([0xe0, 0, 80])
  await page.waitForTimeout(160); await midi([0x80, 64, 0]); await midi([0x80, 67, 0]); await pc('KeyA', false); await pointer(0, 81, false); await pointer(4, 82, false)
  await button('Stop phrase').click(); await status('Остановлено'); await page.waitForTimeout(120)
  const take = await draft(), originalNotes = await notes()
  assert.equal(take.notes.length, 6); assert.equal(originalNotes.length, 6)
  assert.ok(take.duration > .3 && take.duration < 3)
  assert.ok(take.notes.every(note => note.end > note.start))
  assert.ok(take.notes.some(note => note.midi === 60 && note.velocity === 50 && note.channel === 1))
  assert.ok(take.notes.some(note => note.midi === 64 && note.velocity === 110))
  assert.ok(new Set(take.notes.map(note => note.sourceId)).size >= 3)
  assert.ok(originalNotes.some((note, index) => originalNotes.some((other, otherIndex) => index !== otherIndex && note.start < other.end && other.start < note.end)))
  pass('Native MIDI, PC and two virtual pointers record polyphonic notes, actual durations and velocity; CC/bend omitted', { notes: take.notes.length, duration: take.duration, sources: [...new Set(take.notes.map(note => note.sourceName))] })

  await recorder.getByLabel('Квантизация фразы', { exact: true }).selectOption('1/4')
  await recorder.getByRole('button', { name: 'Quantized', exact: true }).click()
  const quantized = await notes()
  assert.ok(quantized.every(note => Math.abs(note.start / .5 - Math.round(note.start / .5)) < 1e-6 && Math.abs(note.end / .5 - Math.round(note.end / .5)) < 1e-6))
  assert.notDeepEqual(quantized, originalNotes)
  await recorder.getByRole('button', { name: 'Original', exact: true }).click(); assert.deepEqual(await notes(), originalNotes)
  assert.deepEqual((await draft()).notes, take.notes)
  const rollHeight = await recorder.locator('.phrase-roll-graph').evaluate(element => element.getBoundingClientRect().height)
  await recorder.getByLabel('Масштаб Piano Roll', { exact: true }).selectOption('4')
  assert.equal(await recorder.locator('.phrase-roll-graph').evaluate(element => element.style.width), '400%')
  assert.equal(await recorder.locator('.phrase-roll-graph').evaluate(element => element.getBoundingClientRect().height), rollHeight)
  assert.equal(await recorder.getByRole('img', { name: /Piano Roll — записанные ноты/ }).count(), 1)
  pass('Quantization is reversible; Piano Roll includes velocity, chords, accessible model and horizontal zoom')

  await recorder.getByLabel('Название фразы', { exact: true }).fill('Идея 0.5')
  await button('Save phrase').click(); await recorder.getByRole('button', { name: 'Открыть фразу: Идея 0.5', exact: true }).waitFor()
  const stored = await readStore('phrases'); assert.equal(stored.length, 1); assert.equal(stored[0].notes.length, 6); assert.ok(stored[0].sound)
  const json = await download('Export phrase JSON'), midiFile = await download('Export phrase MIDI')
  const envelope = JSON.parse(json.data.toString('utf8'))
  assert.equal(envelope.format, 'sound-lab.phrase'); assert.equal(envelope.version, 1); assert.equal(envelope.phrase.notes.length, 6)
  assert.match(json.name, /\.json$/); assert.match(midiFile.name, /\.mid$/)
  assert.equal(midiFile.data.subarray(0, 4).toString(), 'MThd'); assert.ok(midiFile.data.includes(Buffer.from('MTrk')))
  pass('Save writes IndexedDB with sound snapshot; native JSON and MIDI downloads contain expected formats', { midiBytes: midiFile.data.length })

  await midi([0x90, 84, 85]); const live = (await voices()).find(voice => voice.gateOpen && voice.origin !== 'sequence')
  assert.ok(live)
  await recorder.getByLabel('Loop', { exact: true }).check(); await button('Play phrase').click(); await status('Воспроизведение')
  assert.equal(await button('Record phrase').isDisabled(), true)
  await page.waitForFunction(() => window.__phraseEngine?.getVoices().some(voice => voice.origin === 'sequence' && voice.gateOpen))
  await button('Pause phrase').click(); await status('Пауза'); await page.waitForTimeout(70)
  assert.ok((await voices()).some(voice => voice.instanceId === live.instanceId && voice.gateOpen))
  assert.equal((await voices()).filter(voice => voice.origin === 'sequence' && voice.gateOpen).length, 0)
  const paused = await recorder.getByLabel('Время фразы', { exact: true }).innerText(); await page.waitForTimeout(100)
  assert.equal(await recorder.getByLabel('Время фразы', { exact: true }).innerText(), paused)
  await button('Resume phrase').click(); await status('Воспроизведение'); await page.waitForTimeout(take.duration * 1000 + 160)
  await status('Воспроизведение'); await midi([0x90, 86, 80]); await midi([0x80, 86, 0])
  await button('Stop phrase').click(); await status('Остановлено'); await page.waitForTimeout(100)
  assert.equal((await voices()).filter(voice => voice.origin === 'sequence' && voice.gateOpen).length, 0)
  assert.ok((await voices()).some(voice => voice.instanceId === live.instanceId && voice.gateOpen))
  assert.deepEqual((await draft()).notes, take.notes)
  await midi([0x80, 84, 0]); await recorder.getByLabel('Loop', { exact: true }).uncheck()
  pass('Play/Pause/Resume/Loop/Stop isolate sequence voices and never overdub live notes into the take')

  await recorder.getByLabel('Звук воспроизведения фразы', { exact: true }).selectOption('original'); await midi([0x90, 81, 90])
  const warning = await dialogClick(button('Play phrase'), false); assert.match(warning, /Original Sound/); await status('Остановлено')
  await dialogClick(button('Play phrase'), true); await status('Воспроизведение'); await button('Stop phrase').click(); await midi([0x80, 81, 0])
  await recorder.getByLabel('Звук воспроизведения фразы', { exact: true }).selectOption('current')
  const cancelMessage = await dialogClick(button('Record phrase'), false); assert.match(cancelMessage, /черновик/); assert.equal((await notes()).length, 6)
  await dialogClick(button('Clear phrase'), false); assert.equal((await notes()).length, 6)
  pass('Original Sound warns before changing live timbre; cancelling replacement and clear preserves the take')

  await page.reload(); await recorder.waitFor(); await installProbe(); await recorder.locator('.phrase-notice').filter({ hasText: /восстановлен.*IndexedDB/ }).waitFor()
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  assert.equal((await notes()).length, 6); assert.equal(await recorder.getByRole('button', { name: 'Открыть фразу: Идея 0.5', exact: true }).count(), 1)
  await button('Rename phrase: Идея 0.5').click(); await recorder.getByLabel('Новое название: Идея 0.5', { exact: true }).fill('Мелодия'); await recorder.getByRole('button', { name: 'Сохранить имя', exact: true }).click()
  await button('Duplicate phrase: Мелодия').waitFor(); assert.equal(await recorder.getByLabel('Название фразы', { exact: true }).inputValue(), 'Мелодия'); await button('Duplicate phrase: Мелодия').click(); await button('Открыть фразу: Мелодия · копия').waitFor()
  assert.equal(await recorder.locator('.phrase-list>li').count(), 2)
  await dialogClick(button('Delete phrase: Мелодия · копия'), false); assert.equal(await recorder.locator('.phrase-list>li').count(), 2)
  await dialogClick(button('Delete phrase: Мелодия · копия'), true); await page.waitForFunction(() => document.querySelectorAll('.phrase-list>li').length === 1)
  pass('Draft and library restore after reload; rename, copy and confirmed delete persist independently')

  await importJson(JSON.stringify(envelope)); await recorder.locator('.phrase-notice').filter({ hasText: /JSON проверен/ }).waitFor()
  assert.equal((await notes()).length, 6); assert.notEqual((await draft()).id, envelope.phrase.id)
  const beforeBad = await notes()
  for (const raw of ['{broken', JSON.stringify({ ...envelope, version: 42 }), JSON.stringify({ ...envelope, phrase: { ...envelope.phrase, notes: [{ ...envelope.phrase.notes[0], midi: 999 }] } })]) {
    await importJson(raw); await recorder.getByRole('alert').waitFor(); assert.deepEqual(await notes(), beforeBad)
  }
  const importLimit = await page.evaluate(async () => (await import('/src/phrases/storage.ts')).MAX_IMPORT_BYTES)
  await recorder.getByLabel('Import phrase JSON', { exact: true }).setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(importLimit + 1, 32) })
  assert.match(await recorder.getByRole('alert').innerText(), /32 MiB/); assert.deepEqual(await notes(), beforeBad)
  await importJson(JSON.stringify({ ...envelope, phrase: { ...envelope.phrase, sound: null } })); await recorder.locator('.phrase-notice').filter({ hasText: /JSON проверен/ }).waitFor()
  await page.waitForFunction(() => document.querySelector('.phrase-recorder option[value=original]').disabled)
  assert.equal(await recorder.locator('option[value=original]').evaluate(element => element.disabled), true)
  await recorder.getByLabel('Сохранить настройки звука', { exact: true }).uncheck(); await recorder.getByLabel('Название фразы', { exact: true }).fill('Без снимка'); await button('Save phrase').click(); await button('Открыть фразу: Без снимка').waitFor()
  assert.equal((await readStore('phrases')).find(phrase => phrase.name === 'Без снимка').sound, null)
  await recorder.getByLabel('Сохранить настройки звука', { exact: true }).check()
  pass('JSON import restores notes; malformed, obsolete, invalid and oversized imports preserve current draft; no-snapshot Original Sound disabled')

  await button('Открыть фразу: Мелодия').click()
  await recorder.getByLabel('Звук воспроизведения фразы', { exact: true }).selectOption('original')
  await button('Play saved phrase: Без снимка').click(); await status('Воспроизведение')
  assert.equal(await recorder.getByLabel('Звук воспроизведения фразы', { exact: true }).inputValue(), 'current')
  await page.waitForFunction(() => window.__phraseEngine?.getVoices().some(voice => voice.origin === 'sequence' && voice.gateOpen))
  assert.equal(await recorder.locator('.phrase-error').count(), 0)
  await button('Stop phrase').click(); await status('Остановлено')
  pass('Saved-row Play without snapshot falls back to Current Sound in one click after Original Sound was selected')

  await recorder.getByRole('button', { name: 'Tempo', exact: true }).click()
  const bpm = recorder.getByLabel('Phrase BPM', { exact: true }); await bpm.fill('300'); await bpm.press('Enter')
  assert.equal(await bpm.inputValue(), '300')
  await recorder.getByLabel('Метроном', { exact: true }).check(); await recorder.getByLabel('Отсчёт 1 такт', { exact: true }).check()
  await dialogClick(button('Record phrase'), true); await status('Отсчёт · 1 такт')
  await midi([0x90, 72, 75]); await midi([0x80, 72, 0]); await status('Запись')
  await midi([0x90, 74, 99]); await page.waitForTimeout(90); await button('Stop phrase').click(); await midi([0x80, 74, 0]); await status('Остановлено'); await page.waitForTimeout(100)
  const tempoTake = await draft(); assert.equal(tempoTake.bpm, 300); assert.equal(tempoTake.recordingMode, 'tempo'); assert.equal(tempoTake.notes.length, 1); assert.equal(tempoTake.notes[0].midi, 74); assert.ok(tempoTake.notes[0].end > tempoTake.notes[0].start)
  await recorder.getByLabel('Метроном', { exact: true }).uncheck()
  await page.evaluate(() => {
    const engine = window.__phraseEngine, schedule = engine.scheduleMetronome.bind(engine)
    window.__countInOnlyClicks = []
    engine.scheduleMetronome = (...args) => { window.__countInOnlyClicks.push({ when: args[0], accent: args[1], source: args[2] }); return schedule(...args) }
    window.__restoreMetronome = () => { engine.scheduleMetronome = schedule }
  })
  await dialogClick(button('Record phrase'), true); await status('Отсчёт · 1 такт'); await status('Запись'); await page.waitForTimeout(100)
  await midi([0x90, 75, 88]); await page.waitForTimeout(40); await midi([0x80, 75, 0]); await button('Stop phrase').click(); await status('Остановлено')
  const countInOnlyClicks = await page.evaluate(() => window.__countInOnlyClicks)
  assert.equal(countInOnlyClicks.length, 4, JSON.stringify(countInOnlyClicks)); assert.equal(countInOnlyClicks[0].accent, true)
  await page.evaluate(() => window.__restoreMetronome())
  pass('Tempo count-in excludes pre-roll notes; Stop closes held note and stores a valid take', { duration: tempoTake.duration })

  const beforeReplace = await notes()
  await dialogClick(button('Открыть фразу: Мелодия'), false); assert.deepEqual(await notes(), beforeReplace)
  const cancelImport = dialog => dialog.dismiss(); page.once('dialog', cancelImport)
  await recorder.getByLabel('Import phrase JSON', { exact: true }).setInputFiles({ name: 'cancel.json', mimeType: 'application/json', buffer: json.data })
  await page.waitForFunction(() => document.querySelector('input[aria-label="Import phrase JSON"]').value === '')
  assert.deepEqual(await notes(), beforeReplace)
  await page.evaluate(async () => {
    const context = window.__phraseEngine.getAnalysis().time.context
    await context.suspend()
    const resume = context.resume.bind(context)
    context.resume = () => new Promise(resolve => { window.__phraseResume = async () => { await resume(); context.resume = resume; resolve() } })
  })
  await dialogClick(button('Record phrase'), true); await status('Отсчёт · 1 такт'); await button('Stop phrase').click()
  await page.evaluate(() => window.__phraseResume()); await page.waitForTimeout(1000); await status('Остановлено')
  assert.deepEqual(await notes(), beforeReplace)
  pass('Unsaved Open/Import cancellation preserves take; cancelled Record cannot restart after deferred native audio resume')

  await recorder.getByLabel('Отсчёт 1 такт', { exact: true }).uncheck()
  await recorder.getByLabel('Метроном', { exact: true }).uncheck()
  for (const [index, mode] of ['Free', 'Tempo'].entries()) {
    await recorder.getByRole('button', { name: mode, exact: true }).click()
    await page.evaluate(async () => {
      const context = window.__phraseEngine.getAnalysis().time.context
      await context.suspend()
      const resume = context.resume.bind(context)
      context.resume = () => new Promise(resolve => { window.__phraseResume = async () => { await resume(); context.resume = resume; resolve() } })
    })
    await dialogClick(button('Record phrase'), true); await status('Запись')
    await page.evaluate(async midi => {
      window.__phraseMidi([0x90, midi, 43])
      await new Promise(resolve => setTimeout(resolve, 12))
      window.__phraseMidi([0x80, midi, 0])
    }, 79 + index)
    await button('Stop phrase').click(); await status('Остановлено')
    await page.waitForFunction(midi => document.querySelectorAll('.phrase-roll-note').length === 1 && Number(document.querySelector('.phrase-roll-note').dataset.midi) === midi, 79 + index)
    const pendingTake = await notes()
    assert.equal(pendingTake[0].velocity, 43); assert.ok(pendingTake[0].end > pendingTake[0].start)
    assert.ok(pendingTake[0].end - pendingTake[0].start < .15)
    await page.evaluate(() => window.__phraseResume()); await page.waitForTimeout(150); await status('Остановлено')
    assert.deepEqual(await notes(), pendingTake)
    assert.equal((await voices()).filter(voice => voice.gateOpen).length, 0)
    assert.equal((await draft()).notes[0].midi, 79 + index)
  }
  pass('Free and Tempo retain short MIDI notes recorded before native resume; Stop prevents audio or capture resurrection')

  await recorder.getByRole('button', { name: 'Free', exact: true }).click()
  await page.evaluate(async () => {
    const engine = window.__phraseEngine, context = engine.getAnalysis().time.context
    await context.suspend()
    const resume = context.resume.bind(context), schedule = engine.scheduleNote.bind(engine)
    window.__phraseScheduledDuringRecord = []
    engine.scheduleNote = (...args) => { window.__phraseScheduledDuringRecord.push({ id: args[0].id, origin: args[0].origin }); return schedule(...args) }
    window.__phraseRestoreSchedule = () => { engine.scheduleNote = schedule }
    context.resume = () => new Promise(resolve => { window.__phraseResume = async () => { await resume(); context.resume = resume; resolve() } })
  })
  await button('Play phrase').click(); await status('Подготовка аудио')
  await dialogClick(button('Record phrase'), true); await status('Запись')
  await page.evaluate(async () => { window.__phraseMidi([0x90, 82, 76]); await new Promise(resolve => setTimeout(resolve, 12)); window.__phraseMidi([0x80, 82, 0]) })
  await page.evaluate(() => window.__phraseResume()); await page.waitForTimeout(180); await status('Запись')
  assert.deepEqual(await page.evaluate(() => window.__phraseScheduledDuringRecord), [])
  assert.equal((await voices()).filter(voice => voice.origin === 'sequence').length, 0)
  await midi([0x90, 83, 91]); await page.waitForTimeout(40); await midi([0x80, 83, 0]); await button('Stop phrase').click(); await status('Остановлено')
  assert.deepEqual((await notes()).map(note => note.midi), [82, 83])
  assert.ok((await draft()).notes.every(note => !note.sourceId.startsWith('phrase-playback:')))
  await page.evaluate(() => window.__phraseRestoreSchedule())
  pass('Record cancels a pending Play before audio unlock; capture continues without late sequence audio or overdub')

  const beforePendingStop = await notes()
  await page.evaluate(async () => {
    const engine = window.__phraseEngine, context = engine.getAnalysis().time.context
    await context.suspend()
    const resume = context.resume.bind(context), schedule = engine.scheduleNote.bind(engine)
    window.__phraseScheduledDuringStop = []
    engine.scheduleNote = (...args) => { window.__phraseScheduledDuringStop.push({ id: args[0].id, origin: args[0].origin }); return schedule(...args) }
    window.__phraseRestoreSchedule = () => { engine.scheduleNote = schedule }
    context.resume = () => new Promise(resolve => { window.__phraseResume = async () => { await resume(); context.resume = resume; resolve() } })
  })
  await button('Play phrase').click(); await status('Подготовка аудио')
  assert.equal(await button('Stop phrase').isEnabled(), true)
  assert.equal(await button('Play phrase').isDisabled(), true)
  assert.equal(await button('Record phrase').isEnabled(), true)
  await button('Stop phrase').click(); await status('Остановлено')
  await page.evaluate(() => window.__phraseResume()); await page.waitForTimeout(180); await status('Остановлено')
  assert.deepEqual(await page.evaluate(() => window.__phraseScheduledDuringStop), [])
  assert.equal((await voices()).filter(voice => voice.origin === 'sequence').length, 0)
  assert.deepEqual(await notes(), beforePendingStop)
  await page.evaluate(() => window.__phraseRestoreSchedule())
  pass('Pending Play has explicit preparing state and an enabled Stop; cancellation prevents late sequence admission')

  for (const action of ['rename', 'delete']) {
    await importJson(JSON.stringify(envelope)); await recorder.getByLabel('Название фразы', { exact: true }).fill(`Race ${action}`); await button('Save phrase').click(); await button(`Открыть фразу: Race ${action}`).waitFor()
    const fixture = (await readStore('phrases')).find(phrase => phrase.name === `Race ${action}`)
    assert.equal((await draft()).id, fixture.id)
    await delayLibraryCommit()
    if (action === 'rename') {
      await button('Rename phrase: Race rename').click(); await recorder.getByLabel('Новое название: Race rename', { exact: true }).fill('Late rename')
      await recorder.getByRole('button', { name: 'Сохранить имя', exact: true }).click()
    } else await dialogClick(button('Delete phrase: Race delete'), true)
    await recordBeforeCommitDelivery()
    await midi([0x90, 85, 66]); await page.waitForTimeout(60); await midi([0x80, 85, 0])
    await status('Запись')
    const writes = await page.evaluate(() => window.__draftWritesDuringRace)
    assert.equal(writes.some(write => write.id === fixture.id), false, `${action}: stale library callback wrote old draft ${JSON.stringify(writes)}`)
    await button('Stop phrase').click(); await status('Остановлено'); await page.waitForTimeout(70)
    assert.equal((await notes()).length, 1); assert.equal((await notes())[0].midi, 85); assert.notEqual((await draft()).id, fixture.id)
    await page.evaluate(() => window.__restoreIdbRaceProbe())
    if (action === 'rename') await button('Открыть фразу: Late rename').waitFor()
    else assert.equal(await button('Открыть фразу: Race delete').count(), 0)
    pass(`Delayed native IndexedDB ${action} completion cannot stop or overwrite a new take before its first UI snapshot`)
  }

  await recorder.getByRole('button', { name: 'Free', exact: true }).click(); await dialogClick(button('Record phrase'), true); await status('Запись')
  await midi([0x90, 77, 95]); await page.waitForTimeout(70); await page.evaluate(() => window.__phraseConnected(false)); await status('Остановлено'); await page.waitForTimeout(120)
  assert.equal((await notes()).length, 1); assert.equal((await notes())[0].midi, 77); assert.ok((await notes())[0].end > (await notes())[0].start)
  assert.match(await recorder.locator('.phrase-notice').innerText(), /MIDI отключён/)
  await page.evaluate(() => window.__phraseConnected(true)); await page.waitForFunction(() => document.querySelector('.midi-status-ready'))
  await button('Play phrase').click(); await status('Воспроизведение'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await status('Остановлено'); await page.waitForTimeout(50)
  assert.equal((await voices()).filter(voice => voice.origin === 'sequence' && voice.gateOpen).length, 0)
  await dialogClick(button('Record phrase'), true); await status('Запись'); await pc('KeyA', true); await page.waitForTimeout(80); await page.getByRole('button', { name: /^Panic/ }).click(); await status('Остановлено')
  assert.equal((await notes()).length, 1); assert.equal((await voices()).filter(voice => voice.gateOpen).length, 0)
  pass('MIDI statechange, blur and Panic close held recording notes and cancel sequence transport without hanging voices')

  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.ok(await recorder.locator('.phrase-roll-scroll').evaluate(element => element.scrollWidth > element.clientWidth))
  await recorder.screenshot({ path: 'test-results/phrase-recorder-mobile.png' })
  for (const section of await recorder.locator('.phrase-section').all()) { await section.locator('summary').click(); assert.equal(await section.getAttribute('open'), null); await section.locator('summary').click() }
  await page.setViewportSize({ width: 1440, height: 1100 }); await recorder.screenshot({ path: 'test-results/phrase-recorder-desktop.png' })
  pass('390px responsive panel has internal Piano Roll scrolling, no page overflow, and keyboard-native disclosure panels')

  await page.evaluate(() => sessionStorage.setItem('phrase-test-storage-denied', '1')); await page.reload(); await recorder.waitFor()
  await recorder.getByRole('alert').waitFor(); assert.match(await recorder.getByRole('alert').innerText(), /IndexedDB unavailable/)
  assert.equal(await button('Record phrase').isEnabled(), true)
  await button('Record phrase').click(); await status('Запись'); await pc('KeyA', true); await page.waitForTimeout(90); await pc('KeyA', false); await button('Stop phrase').click(); await status('Остановлено')
  assert.equal((await notes()).length, 1)
  await button('Play phrase').click(); await status('Воспроизведение'); await button('Stop phrase').click()
  pass('Denied IndexedDB reports a visible error while in-memory recording and playback remain usable')
  assert.deepEqual(errors, [])
  const browser = testBrowserName()
  await writeFile(`test-results/phrase-ui-${browser}.json`, JSON.stringify({ browser, results, errors }, null, 2))
  console.log(`PASS Phrase UI — ${results.length} groups`)
} finally { await session.close() }
