import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const browserName = /msedge/i.test(process.env.SOUND_LAB_BROWSER || '') ? 'edge' : 'chrome'
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { PhraseCapture, quantizeNotes, playbackDuration, copyPhrase, phraseId } = await import('/src/phrases/model.ts')
    const { validatePhrase, exportPhraseJson, importPhraseJson, listPhrases, savePhrase, deletePhrase, saveDraft, loadDraft, PHRASE_DB, MAX_IMPORT_BYTES } = await import('/src/phrases/storage.ts')
    const { exportMidi } = await import('/src/phrases/midiExport.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const rejects = operation => { try { operation(); return false } catch { return true } }
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
    const note = (id, midi = 60, overrides = {}) => ({ id, midi, velocity: 100, sourceId: 'A', sourceName: 'Simulated MIDI A', channel: 1, ...overrides })
    let clock = 1000
    const capture = new PhraseCapture(() => clock)
    const sound = copyParams(DEFAULT_PARAMS)
    capture.start(120, 'free', sound)
    capture.noteOn(note('A:1:60'))
    clock = 1100
    capture.noteOn(note('B:1:60', 60, { sourceId: 'B', sourceName: 'Simulated MIDI B', velocity: 65 }))
    capture.noteOn(note('A:1:60', 60, { velocity: 30 }))
    clock = 1200
    capture.noteOn(note('pc:64', 64, { sourceId: 'local', sourceName: 'PC keyboard', channel: null, velocity: 127 }))
    capture.noteOn(note('zero', 67, { velocity: 0 }))
    clock = 1350
    capture.noteOff('A:1:60')
    capture.noteOff('unknown')
    clock = 1500
    capture.releaseSource('B')
    clock = 1600
    const heldSnapshot = capture.snapshot()
    sound.adsr.sustain = 0
    heldSnapshot.notes[0].velocity = 1
    heldSnapshot.sound.additive.levels[0] = 0
    clock = 1700
    const recorded = capture.stop()
    check('Capture preserves polyphony source identity velocity and exact intervals', { phrase: recorded }, [
      ['duplicate and velocity-zero Note On create no duplicate interval', recorded.notes.length === 3],
      ['each source has its independent note duration', recorded.notes[0].start === 0 && recorded.notes[0].end === 0.35 && recorded.notes[1].start === 0.1 && recorded.notes[1].end === 0.5 && recorded.notes[2].start === 0.2 && recorded.notes[2].end === 0.7],
      ['source cleanup leaves the local keyboard held until Stop', recorded.notes[2].end === 0.7],
      ['snapshot and caller edits cannot mutate captured notes or sound', recorded.notes[0].velocity === 100 && recorded.sound.adsr.sustain === DEFAULT_PARAMS.adsr.sustain && recorded.sound.additive.levels[0] === 100],
      ['Stop closes recording and produces a validated phrase', !capture.recording && validatePhrase(recorded).duration === 0.7],
    ])
    capture.start(90, 'tempo')
    clock += 100
    const empty = capture.stop()
    check('Empty recording has a defined harmless result', { empty }, [['empty Stop returns null and resets recording', empty === null && !capture.recording && capture.stop() === null]])

    capture.start(120, 'free')
    capture.noteOn(note('A:1:60'))
    capture.noteOn(note('A:2:64', 64, { channel: 2 }))
    clock += 200
    capture.releaseSource('A', 1)
    clock += 300
    const scoped = capture.stop()
    check('Scoped recording cleanup isolates MIDI channels', { notes: scoped.notes }, [['only matching channel closes at cleanup time', scoped.notes[0].end === 0.2 && scoped.notes[1].end === 0.5]])

    capture.start(120, 'free')
    capture.noteOn(note('limit-note'))
    clock += 600_000
    capture.noteOn(note('too-late', 64))
    clock += 10_000
    const boundedTime = capture.stop()
    check('Recording duration is bounded at ten minutes', { duration: boundedTime.duration, notes: boundedTime.notes }, [['late notes are ignored and held note closes at the limit', boundedTime.duration === 600 && boundedTime.notes.length === 1 && boundedTime.notes[0].end === 600]])
    capture.start(120, 'free')
    for (let index = 0; index < 10_010; index++) { capture.noteOn(note(`capacity:${index}`)); capture.noteOff(`capacity:${index}`) }
    const boundedNotes = capture.stop()
    check('Recording note capacity cannot grow without a bound', { notes: boundedNotes.notes.length }, [['only ten thousand note intervals are retained', boundedNotes.notes.length === 10_000 && validatePhrase(boundedNotes).notes.length === 10_000]])
    const maximumJson = exportPhraseJson(boundedNotes)
    const maximumImported = importPhraseJson(maximumJson)
    check('A full ten-thousand-note recording can import its own JSON export', { bytes: new TextEncoder().encode(maximumJson).length, importLimit: MAX_IMPORT_BYTES, notes: maximumImported.notes.length }, [
      ['largest ordinary recording fits the bounded import size', new TextEncoder().encode(maximumJson).length < MAX_IMPORT_BYTES],
      ['full note capacity round-trips without losing any interval', maximumImported.notes.length === 10_000 && same(maximumImported.notes, boundedNotes.notes)],
    ])

    const take = copyPhrase(recorded)
    take.duration = 1
    take.notes = take.notes.map((entry, index) => ({ ...entry, start: [0.12, 0.12, 0.31][index], end: [0.38, 0.7, 0.91][index] }))
    const originalIntervals = JSON.stringify(take.notes)
    const grids = ['off', '1/4', '1/8', '1/16', '1/32']
    const quantized = grids.map(grid => ({ grid, notes: quantizeNotes(take.notes, 120, grid) }))
    check('Quantization is a reversible view that preserves chords and overlaps', { grids: quantized }, [
      ['off retains exact timestamps in independent note objects', JSON.stringify(quantized[0].notes) === originalIntervals && quantized[0].notes[0] !== take.notes[0]],
      ['every musical grid keeps a strictly positive note length', quantized.every(result => result.notes.every(entry => entry.end > entry.start && entry.start >= 0))],
      ['simultaneous notes remain simultaneous across all grids', quantized.every(result => result.notes[0].start === result.notes[1].start)],
      ['overlaps are not shortened to fit another note', quantized.every(result => result.notes[1].end > result.notes[2].start)],
      ['nearest-grid onsets are monotone and all grid points are exact', quantized.slice(1).every(({ grid, notes }) => { const cell = 0.5 * 4 / Number(grid.slice(2)); return notes.every((entry, index) => (!index || entry.start >= notes[index - 1].start) && Math.abs(entry.start / cell - Math.round(entry.start / cell)) < 1e-8 && Math.abs(entry.end / cell - Math.round(entry.end / cell)) < 1e-8) })],
      ['original take remains byte-for-byte unchanged', JSON.stringify(take.notes) === originalIntervals],
      ['playback duration expands for notes rounded beyond the original end', playbackDuration({ ...take, duration: 0.91 }, quantized[1].notes) === 1],
    ])

    const json = exportPhraseJson(recorded)
    const imported = importPhraseJson(json)
    check('Phrase JSON round-trip preserves music and generates a fresh library identity', { originalId: recorded.id, importedId: imported.id, bytes: new TextEncoder().encode(json).length }, [
      ['import creates an independent identity with exact note data', imported.id !== recorded.id && same(imported.notes, recorded.notes)],
      ['sound snapshot survives the JSON round-trip', same(imported.sound, recorded.sound)],
    ])
    const invalid = [
      { ...recorded, version: 2 }, { ...recorded, duration: Infinity }, { ...recorded, bpm: 29 }, { ...recorded, bpm: 301 },
      { ...recorded, notes: [{ ...recorded.notes[0], velocity: 0 }] }, { ...recorded, notes: [{ ...recorded.notes[0], midi: 128 }] },
      { ...recorded, notes: [{ ...recorded.notes[0], channel: 0 }] }, { ...recorded, notes: [{ ...recorded.notes[0], end: 0 }] },
      { ...recorded, notes: [{ ...recorded.notes[0], end: 2 }] }, { ...recorded, notes: [recorded.notes[0], recorded.notes[0]] },
      { ...recorded, sound: { ...recorded.sound, additive: { ...recorded.sound.additive, levels: [100] } } },
    ]
    let oversizedError = ''
    try { importPhraseJson('я'.repeat(MAX_IMPORT_BYTES / 2 + 1)) } catch (error) { oversizedError = error.message }
    check('Import and validation reject malformed unsafe or oversized data', { invalidCases: invalid.length, oversizedError }, [
      ['all invalid range version identity and sound cases are rejected', invalid.every(value => rejects(() => validatePhrase(value)))],
      ['unknown file version and invalid JSON are rejected', rejects(() => importPhraseJson('{')) && rejects(() => importPhraseJson(JSON.stringify({ format: 'sound-lab.phrase', version: 2, phrase: recorded })))],
      ['size limit counts UTF-8 bytes and rejects before parsing', oversizedError.includes('32 MiB')],
    ])

    // Independent SMF reader. It does not import or reuse any exporter helper;
    // every byte, VLQ, status and note pair is read back from the binary file.
    const readSmf = bytes => {
      let offset = 0
      const read = () => { if (offset >= bytes.length) throw new Error('Truncated SMF'); return bytes[offset++] }
      const u16 = () => read() * 256 + read()
      const u32 = () => read() * 16_777_216 + read() * 65_536 + read() * 256 + read()
      const text = size => String.fromCharCode(...Array.from({ length: size }, read))
      const vlq = () => { let value = 0; for (let length = 0; length < 4; length++) { const byte = read(); value = value * 128 + (byte & 127); if (!(byte & 128)) return value } throw new Error('Invalid VLQ') }
      if (text(4) !== 'MThd' || u32() !== 6) throw new Error('Invalid MIDI header')
      const format = u16(), tracks = u16(), ppq = u16()
      const events = [], notes = [], active = new Map()
      for (let track = 0; track < tracks; track++) {
        if (text(4) !== 'MTrk') throw new Error('Missing track')
        const end = offset + 4 + new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
        u32()
        let tick = 0, running = null
        while (offset < end) {
          tick += vlq()
          let status = read(), first = null
          if (status < 128) { first = status; status = running; if (status === null) throw new Error('Invalid running status') }
          if (status === 255) {
            const type = read(), length = vlq(), data = Array.from({ length }, read)
            events.push({ tick, meta: type, data })
            continue
          }
          running = status
          const kind = status & 240, channel = status & 15
          if (![128, 144].includes(kind)) throw new Error('Unexpected channel event')
          const midi = first ?? read(), velocity = read(), key = `${channel}:${midi}`
          if (midi > 127 || velocity > 127) throw new Error('Invalid channel data')
          events.push({ tick, kind, channel, midi, velocity })
          if (kind === 144 && velocity > 0) {
            if (active.has(key)) throw new Error('Overlapping identical channel pitch')
            active.set(key, { channel, midi, velocity, start: tick })
          } else {
            const entry = active.get(key)
            if (!entry) throw new Error('Orphan Note Off')
            notes.push({ ...entry, end: tick }); active.delete(key)
          }
        }
        if (offset !== end) throw new Error('Track size mismatch')
      }
      if (offset !== bytes.length || active.size) throw new Error('Trailing bytes or hanging note')
      return { format, tracks, ppq, events, notes }
    }
    const smf = readSmf(exportMidi(recorded))
    const tempo = smf.events.find(event => event.meta === 81)?.data
    check('Independent MIDI parser verifies header tempo timestamps velocity and note pairs', { format: smf.format, tracks: smf.tracks, ppq: smf.ppq, events: smf.events, notes: smf.notes }, [
      ['file is a complete format-zero single-track PPQ480 SMF', smf.format === 0 && smf.tracks === 1 && smf.ppq === 480],
      ['tempo and four-four signature are explicit MIDI metadata', tempo.join(',') === '7,161,32' && smf.events.some(event => event.meta === 88 && event.data.join(',') === '4,2,24,8')],
      ['all exported notes retain pitch velocity start and end ticks', recorded.notes.every(entry => smf.notes.some(read => read.midi === entry.midi && read.velocity === entry.velocity && read.start === Math.round(entry.start * 960) && read.end === Math.round(entry.end * 960)))],
      ['overlapping identical pitches use different channels', new Set(smf.notes.filter(entry => entry.midi === 60).map(entry => entry.channel)).size === 2],
      ['one final End of Track event terminates at phrase duration', smf.events.at(-1).meta === 47 && smf.events.at(-1).tick === Math.round(recorded.duration * 960)],
    ])
    const polyPhrase = { ...copyPhrase(recorded), id: phraseId(), duration: 0.5, notes: Array.from({ length: 16 }, (_, index) => ({ ...recorded.notes[0], id: `poly:${index}`, eventId: `poly:${index}`, start: 0, end: 0.5, velocity: 1 + index })) }
    const polySmf = readSmf(exportMidi(polyPhrase))
    const overflowPhrase = { ...polyPhrase, notes: [...polyPhrase.notes, { ...polyPhrase.notes[0], id: 'overflow', eventId: 'overflow' }] }
    check('MIDI export preserves sixteen overlapping equal notes and rejects impossible channel overflow', { notes: polySmf.notes }, [
      ['sixteen simultaneous copies remain independently paired', polySmf.notes.length === 16 && new Set(polySmf.notes.map(entry => entry.channel)).size === 16],
      ['seventeenth same-pitch overlap reports an explicit export error', rejects(() => exportMidi(overflowPhrase))],
    ])
    const boundaryPhrase = { ...copyPhrase(recorded), duration: 600, bpm: 300, notes: [
      { ...recorded.notes[0], id: 'left', start: 0, end: 0.5 }, { ...recorded.notes[0], id: 'right', start: 0.5, end: 600 },
    ] }
    const boundarySmf = readSmf(exportMidi(boundaryPhrase))
    const boundaryEvents = boundarySmf.events.filter(event => event.tick === 1200 && event.kind)
    check('MIDI boundaries and long VLQ intervals round-trip correctly', { notes: boundarySmf.notes, boundaryEvents }, [
      ['Note Off precedes Note On at a shared pitch boundary', boundaryEvents.length === 2 && boundaryEvents[0].kind === 128 && boundaryEvents[1].kind === 144],
      ['long phrase preserves its exact final multi-byte delta timestamp', boundarySmf.notes[1].end === 1_440_000 && boundarySmf.events.at(-1).tick === 1_440_000],
    ])

    // Let unrelated application preference debounces finish before observing
    // that the phrase database itself never uses localStorage.
    await new Promise(resolve => setTimeout(resolve, 250))
    const beforeLocalStorage = JSON.stringify(Object.entries(localStorage))
    await savePhrase(recorded)
    const saved = await listPhrases()
    const renamed = { ...copyPhrase(recorded), name: 'Renamed phrase', updatedAt: recorded.updatedAt + 1 }
    await savePhrase(renamed)
    const duplicate = { ...copyPhrase(renamed), id: phraseId(), name: 'Duplicate phrase' }
    await savePhrase(duplicate)
    await deletePhrase(duplicate.id)
    await saveDraft(renamed)
    const draft = await loadDraft()
    await saveDraft(null)
    check('Actual IndexedDB stores independent phrases edits copies deletes and draft recovery', { initialCount: saved.phrases.length, library: await listPhrases(), draft }, [
      ['first phrase is read back with exact saved notes and sound', saved.phrases.some(value => value.id === recorded.id && same(value.notes, recorded.notes) && same(value.sound, recorded.sound))],
      ['rename and delete leave exactly the intended library entry', (await listPhrases()).phrases.length === 1 && (await listPhrases()).phrases[0].name === 'Renamed phrase'],
      ['draft sound and notes survive and can then be removed', same(draft.notes, renamed.notes) && same(draft.sound, renamed.sound) && await loadDraft() === null],
      ['phrase library never writes into localStorage', JSON.stringify(Object.entries(localStorage)) === beforeLocalStorage],
    ])
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(PHRASE_DB, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise((resolve, reject) => { const tx = db.transaction('phrases', 'readwrite'); tx.objectStore('phrases').put({ id: 'corrupt-entry', version: -1 }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    const corruptRead = await listPhrases()
    await deletePhrase('corrupt-entry')
    check('One corrupted IndexedDB entry cannot hide valid library phrases', { skipped: corruptRead.skipped, valid: corruptRead.phrases.length }, [['invalid entry is counted and valid phrase remains readable', corruptRead.skipped === 1 && corruptRead.phrases.length === 1]])
    for (let index = 1; index < 200; index++) await savePhrase({ ...copyPhrase(recorded), id: `capacity:${index}`, name: `Phrase ${index}` })
    let capacityError = ''
    try { await savePhrase({ ...copyPhrase(recorded), id: 'one-too-many' }) } catch (error) { capacityError = error.message }
    await savePhrase({ ...renamed, name: 'Edit at capacity' })
    await deletePhrase('capacity:1')
    await savePhrase({ ...copyPhrase(recorded), id: 'replacement' })
    const fullLibrary = await listPhrases()
    check('IndexedDB library cap remains transactional while edits and replacement stay possible', { libraryCount: fullLibrary.phrases.length, capacityError }, [
      ['the two-hundred-first phrase is rejected with a useful limit error', capacityError.includes('200')],
      ['existing entry can be edited even at capacity', fullLibrary.phrases.some(value => value.id === recorded.id && value.name === 'Edit at capacity')],
      ['deleting one entry permits a replacement without exceeding two hundred', fullLibrary.phrases.length === 200 && fullLibrary.phrases.some(value => value.id === 'replacement')],
    ])
    db.close()
    return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../test-results/phrase-core-${browserName}.json`, import.meta.url), JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Phrase recording storage quantization and independent MIDI tests failed')
  console.log(`PASS: ${report.results.length} phrase core scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally { await session.close() }
