import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const browserName = testBrowserName()
const session = await startTestBrowser()
const consoleErrors = []
session.page.on('pageerror', error => consoleErrors.push(error.message))
try {
  const report = await session.page.evaluate(async () => {
    const { DEFAULT_KICK_PATCH, kickPatchFingerprint, canonicalKickPatch } = await import('/src/sample-forge/kickPatch.ts')
    const { renderKick } = await import('/src/sample-forge/audio/KickRenderer.ts')
    const { generateSampleBank, createForgeSample } = await import('/src/sample-forge/VariationGenerator.ts')
    const { copyBank } = await import('/src/sample-forge/model.ts')
    const { SAMPLE_FORGE_DB, MAX_BANK_BYTES, MAX_SAMPLE_BANKS, listSampleBanks, loadSampleBank, saveSampleBank, deleteSampleBank, saveWorkingBase, loadWorkingBase, validateSampleBank, validateRenderedKick } = await import('/src/sample-forge/library.ts')
    const { normalizeTags, portableKickPatch, exportPatchJson, importPatchJson, MAX_PATCH_JSON_BYTES } = await import('/src/sample-forge/patchJson.ts')
    const { exportSamplePack, createStoredZip, safePackFilename } = await import('/src/sample-forge/pack.ts')
    const { listPhrases, savePhrase, saveDraft, loadDraft } = await import('/src/phrases/storage.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const rejects = operation => { try { operation(); return false } catch { return true } }
    const rejection = async operation => { try { await operation(); return '' } catch (error) { return `${error.name}: ${error.message}` } }
    const same = (first, second) => JSON.stringify(first) === JSON.stringify(second)
    const sameBytes = (first, second) => first.length === second.length && first.every((value, index) => value === second[index])
    const base64 = bytes => {
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
      return btoa(binary)
    }
    const at = 1_792_000_000_000
    const legacy = { version: 1, id: 'forge-legacy-sentinel', name: 'Existing Phrase Sound Snapshot', createdAt: at, updatedAt: at, duration: 0.5, bpm: 120, recordingMode: 'free',
      notes: [{ id: 'legacy-note', eventId: 'legacy-event', sourceId: 'legacy-source', sourceName: 'Simulated MIDI', channel: 1, midi: 60, velocity: 87, start: 0, end: 0.5 }], sound: copyParams(DEFAULT_PARAMS) }
    await savePhrase(legacy); await saveDraft(legacy)
    const localSentinels = ['sound-lab.midi.v1', 'sound-lab.harmonics.v1', 'sound-lab.harmonic-patch.v1', 'sound-lab.display.v1']
    const originalLocal = localSentinels.map(key => localStorage.getItem(key))
    localSentinels.forEach((key, index) => localStorage.setItem(key, `Existing ${index}`))
    const beforeLocal = localSentinels.map(key => localStorage.getItem(key))
    const beforeLegacy = await listPhrases(), beforeDraft = await loadDraft()
    const bank = await generateSampleBank({ ...DEFAULT_KICK_PATCH }, 20260813)
    // A clean, usable pilot deliverable, distinct from subsequent malicious-name
    // and metadata mutation fixtures. It keeps default generated Kick_01…16.
    const pilotBank = copyBank(bank); pilotBank.name = 'SOUND LAB KICK PACK 001'
    const pilotPack = await exportSamplePack(pilotBank)
    check('Clean pilot pack contains sixteen original named WAV and editable patches', { filename: pilotPack.filename, seed: pilotPack.manifest.batchSeed, bytes: pilotPack.bytes.length }, [
      ['clean bank title produces the requested canonical archive name', pilotPack.filename === 'SOUND_LAB_KICK_PACK_001.zip' && pilotPack.manifest.name === 'SOUND LAB KICK PACK 001'],
      ['all original generated variations retain their clean Kick_01 to Kick_16 names', pilotPack.manifest.samples.every((sample, index) => sample.name === `Kick_${String(index + 1).padStart(2, '0')}`)],
      ['pilot uses the fixed default base and reproducible seed', pilotPack.manifest.batchSeed === 20260813 && same(pilotPack.manifest.basePatch, DEFAULT_KICK_PATCH)],
    ])
    bank.name = 'Kick Pack / .. / тест'; bank.tags = ['Kick', '  Custom  Texture ', 'kick']
    const valid = validateSampleBank(bank)
    check('Bank has sixteen committed variations and an independent base render', { generated: valid.samples.length, copies: valid.copies.length, duration: valid.samples[6].render.metrics.duration }, [
      ['exactly sixteen variants plus a separate base', valid.samples.length === 16 && valid.copies.length === 0 && valid.base.id !== valid.samples[0].id],
      ['every WAV and render patch fingerprint matches its committed patch', valid.samples.every(sample => sample.render.fingerprint === kickPatchFingerprint(sample.patch) && canonicalKickPatch(sample.patch) === canonicalKickPatch(sample.render.patch))],
      ['all native PCM and WAV buffers survive strict validation', valid.samples.every(sample => validateRenderedKick(sample.render, sample.patch).pcm.length === sample.render.pcm.length)],
    ])
    const initiallySavedBase = await loadWorkingBase()
    await saveWorkingBase(valid.base)
    const loadedBase = await loadWorkingBase()
    check('A standalone Base can be explicitly saved before any bank exists', { database: SAMPLE_FORGE_DB, frames: loadedBase.render.pcm.length }, [
      ['new standalone Base storage starts empty', initiallySavedBase === null],
      ['saved Base preserves its editable patch and exact audio', same(loadedBase.patch, valid.base.patch) && sameBytes(loadedBase.render.pcm, valid.base.render.pcm) && sameBytes(loadedBase.render.wav, valid.base.render.wav)],
      ['standalone Base creates no implicit sixteen-variation bank', (await listSampleBanks()).banks.length === 0],
      ['standalone Base does not replace the musical Phrase Recorder draft', same(await loadDraft(), beforeDraft)],
    ])
    const normalized = normalizeTags(['Kick', ' kick ', '  Punchy   ', 'PUNCHY', 'My   Custom Tag', 'my custom tag', 'Мой тег', 'МОЙ ТЕГ'])
    check('Tags normalize whitespace case Unicode and preserve user display spelling', { tags: normalized }, [
      ['duplicates with different case or spaces collapse', same(normalized, ['Kick', 'Punchy', 'My Custom Tag', 'Мой тег'])],
      ['oversized tag arrays text and non-text values are rejected', rejects(() => normalizeTags(Array.from({ length: 25 }, () => 'Kick'))) && rejects(() => normalizeTags(['a'.repeat(49)])) && rejects(() => normalizeTags([1]))],
    ])
    const portable = portableKickPatch(valid.samples[6], valid.generatorVersion), rawPatch = exportPatchJson(portable), restoredPatch = importPatchJson(rawPatch)
    const invalidPatches = [
      { ...portable, version: 2 }, { ...portable, format: 'javascript' }, { ...portable, generatorVersion: '../../bad' },
      { ...portable, patch: { ...portable.patch, startFrequency: 2 } }, { ...portable, patch: { ...portable.patch, endFrequency: 100, startFrequency: 70 } },
      { ...portable, patch: { ...portable.patch, bodyDecay: -1 } }, { ...portable, patch: { ...portable.patch, seed: 1.2 } },
      { ...portable, patch: { ...portable.patch, noiseColor: 'script' } }, { ...portable, tags: [false] }, { ...portable, name: '' },
    ]
    check('Portable Patch JSON round-trips real parameters and immutable generated originals', { bytes: new TextEncoder().encode(rawPatch).length, invalidCases: invalidPatches.length }, [
      ['each actual variation imports its exported current and original patches', valid.samples.every(sample => { const restored = importPatchJson(exportPatchJson(sample, valid.generatorVersion)); return same(restored.patch, sample.patch) && same(restored.generatedPatch, sample.generatedPatch) })],
      ['portable metadata and selected patch match after the round trip', same(restoredPatch, portable)],
      ['unsupported versions invalid ranges types and JSON are rejected', invalidPatches.every(value => rejects(() => importPatchJson(JSON.stringify(value)))) && rejects(() => importPatchJson('{'))],
      ['UTF-8 byte and character limits apply before JSON parsing', rejects(() => importPatchJson(' '.repeat(MAX_PATCH_JSON_BYTES + 1))) && rejects(() => importPatchJson('я'.repeat(MAX_PATCH_JSON_BYTES / 2 + 1)))],
      ['unknown executable-looking properties do not survive the allowlist', !('script' in importPatchJson(JSON.stringify({ ...portable, script: 'window.bad = true', __proto__: { bad: true } }))) && window.bad === undefined],
    ])
    const importedRender = await renderKick(importPatchJson(rawPatch).patch)
    check('Imported patch reconstructs its actual exported one-shot within the same browser engine', { fingerprint: importedRender.fingerprint }, [
      ['current parameters and saved seed reproduce every PCM sample exactly', sameBytes(importedRender.pcm, valid.samples[6].render.pcm)],
      ['the regenerated PCM24 WAV is byte-identical', sameBytes(importedRender.wav, valid.samples[6].render.wav)],
    ])
    restoredPatch.patch.bodyDecay += 1
    check('Imported and validated data are independent copies', {}, [
      ['editing imported parameters does not mutate the source patch', restoredPatch.patch.bodyDecay !== portable.patch.bodyDecay],
      ['validation creates new PCM and WAV arrays', valid.samples[0].render.pcm !== bank.samples[0].render.pcm && valid.samples[0].render.wav !== bank.samples[0].render.wav],
    ])
    const corruptions = [
      value => { value.schemaVersion = 2 }, value => { value.samples.pop() }, value => { value.samples[1].id = value.samples[0].id },
      value => { value.samples[0].patch.bodyDecay += 1 }, value => { value.samples[0].render.fingerprint = 'wrong' },
      value => { value.samples[0].render.pcm[4] = NaN }, value => { value.samples[0].render.wav[22] = 2 },
      value => { value.samples[0].render.wav[50] ^= 1 }, value => { value.samples[0].render.metrics.rms = 0.8 },
      value => { value.samples[0].render.metrics.duration += 0.2 }, value => { value.samples[0].render.metrics.frames += 1 },
      value => { value.copies = Array.from({ length: 33 }, (_, index) => ({ ...value.samples[0], id: `bad-copy-${index}` })) },
    ]
    check('Strict bank validation rejects stale PCM WAV metadata and schema corruption', { cases: corruptions.length }, [
      ['every malformed bank fails without silent clamping', corruptions.every(mutate => { const value = copyBank(valid); mutate(value); return rejects(() => validateSampleBank(value)) })],
      ['a valid committed bank remains unchanged after rejected copies', validateSampleBank(valid).samples.length === 16],
    ])
    await saveSampleBank(valid)
    const restored = await loadSampleBank(valid.id), summaries = await listSampleBanks()
    check('Atomic IndexedDB save restores exact PCM WAV patches and light metadata summaries', { database: SAMPLE_FORGE_DB, count: summaries.banks.length, bytes: summaries.banks.find(item => item.id === valid.id)?.bytes }, [
      ['bank reload retains all sixteen renderable editable variants', restored.samples.length === 16 && restored.generatorVersion === valid.generatorVersion && restored.batchSeed === valid.batchSeed],
      ['restored PCM and WAV bytes are exact, rather than a fresh offline render', restored.samples.every((sample, index) => sameBytes(sample.render.pcm, valid.samples[index].render.pcm) && sameBytes(sample.render.wav, valid.samples[index].render.wav))],
      ['summary records avoid reading audio into the bank list', summaries.banks.length === 1 && summaries.banks[0].sampleCount === 16 && !('samples' in summaries.banks[0]) && !('base' in summaries.banks[0])],
      ['retrieved bank mutation cannot change stored audio', (() => { restored.samples[0].render.pcm[5] = 0.5; return restored.samples[0].render.pcm[5] !== valid.samples[0].render.pcm[5] })()],
    ])
    const unchanged = await loadSampleBank(valid.id)
    check('Readback is isolated from caller edits', {}, [['the persisted buffer is still exact after editing a loaded copy', sameBytes(unchanged.samples[0].render.pcm, valid.samples[0].render.pcm)]])
    const edited = copyBank(valid), changedPatch = { ...edited.samples[6].patch, pitchDecay: edited.samples[6].patch.pitchDecay * 0.8, clickAmount: 0.2, drive: 0.3 }
    const changedRender = await renderKick(changedPatch)
    edited.samples[6] = { ...edited.samples[6], name: 'Punchy / Hard / Short', tags: ['Punchy', 'Hard', 'Short'], favorite: true, patch: changedPatch, render: changedRender, updatedAt: edited.samples[6].updatedAt + 1 }
    edited.updatedAt += 1
    const custom = createForgeSample(changedPatch, changedRender, { name: '../../CON:Copy?', character: 'custom', tags: ['Kick', 'My Copy'] })
    edited.copies.push(custom)
    await saveSampleBank(edited)
    const savedEdit = await loadSampleBank(edited.id)
    check('Saved refinement updates one committed pair while preserving generated originals and copies', { copies: savedEdit.copies.length, changedFingerprint: savedEdit.samples[6].render.fingerprint }, [
      ['selected current patch and WAV both change together', same(savedEdit.samples[6].patch, changedPatch) && sameBytes(savedEdit.samples[6].render.wav, changedRender.wav)],
      ['Reset to Generated source remains available after saving edits', same(savedEdit.samples[6].generatedPatch, valid.samples[6].generatedPatch)],
      ['metadata favorites tags and duplicated patches survive reload', savedEdit.samples[6].favorite && same(savedEdit.samples[6].tags, ['Punchy', 'Hard', 'Short']) && savedEdit.copies.length === 1],
      ['the remaining fifteen committed WAV files remain exact', savedEdit.samples.every((sample, index) => index === 6 || sameBytes(sample.render.wav, valid.samples[index].render.wav))],
    ])
    const second = copyBank(valid); second.id = crypto.randomUUID(); second.name = 'A second separate bank'; second.createdAt += 100; second.updatedAt += 100
    await saveSampleBank(second)
    const separate = await listSampleBanks()
    check('New banks retain previous banks and sort newest first', { ids: separate.banks.map(item => item.id) }, [
      ['both independent bank records remain available', separate.banks.length === 2 && (await loadSampleBank(valid.id)).samples[6].favorite],
      ['the newest bank is listed first', separate.banks[0].id === second.id],
    ])
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(SAMPLE_FORGE_DB, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const direct = (stores, operation) => new Promise((resolve, reject) => { const tx = db.transaction(stores, 'readwrite'); operation(tx); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    await direct(['banks', 'metadata'], tx => {
      tx.objectStore('banks').put({ id: 'corrupt-entry', schemaVersion: -1 })
      tx.objectStore('metadata').put({ id: 'corrupt-entry', schemaVersion: -1 })
    })
    const corruptList = await listSampleBanks(), corruptLoad = await rejection(() => loadSampleBank('corrupt-entry'))
    await deleteSampleBank('corrupt-entry')
    check('Corrupt Sample Forge records are isolated and never hide valid banks', { skipped: corruptList.skipped, loadError: corruptLoad }, [
      ['invalid metadata is counted while both valid banks remain readable', corruptList.skipped === 1 && corruptList.banks.length === 2],
      ['loading corrupted audio reports an error instead of returning a damaged bank', Boolean(corruptLoad)],
      ['corruption handling does not delete or rewrite valid records', same((await loadSampleBank(second.id)).samples[0].patch, valid.samples[0].patch)],
    ])
    const nativePut = IDBObjectStore.prototype.put
    let quotaError = ''
    try {
      IDBObjectStore.prototype.put = function (...args) { if (this.name === 'metadata') throw new DOMException('Test quota', 'QuotaExceededError'); return nativePut.apply(this, args) }
      const unsaved = copyBank(edited); unsaved.name = 'Must not commit half a transaction'
      quotaError = await rejection(() => saveSampleBank(unsaved))
    } finally { IDBObjectStore.prototype.put = nativePut }
    check('Quota failure rolls back both audio and metadata atomically', { error: quotaError }, [
      ['quota failure produces actionable storage guidance', quotaError.includes('Недостаточно места')],
      ['queued bank replacement is rolled back when metadata cannot commit', (await loadSampleBank(edited.id)).name === edited.name && (await listSampleBanks()).banks.find(item => item.id === edited.id).name === edited.name],
    ])
    const summaryTemplate = (await listSampleBanks()).banks[0], budgetIds = Array.from({ length: 8 }, (_, index) => `budget-${index}`)
    await direct(['metadata'], tx => { for (const id of budgetIds) tx.objectStore('metadata').put({ ...summaryTemplate, id, bytes: MAX_BANK_BYTES }) })
    const budgetError = await rejection(() => saveSampleBank(second))
    await direct(['metadata'], tx => { for (const id of budgetIds) tx.objectStore('metadata').delete(id) })
    const capIds = Array.from({ length: MAX_SAMPLE_BANKS - 2 }, (_, index) => `capacity-${index}`)
    await direct(['metadata'], tx => { for (const id of capIds) tx.objectStore('metadata').put({ ...summaryTemplate, id, bytes: 1 }) })
    const overCapacity = copyBank(valid); overCapacity.id = 'one-too-many'
    const capError = await rejection(() => saveSampleBank(overCapacity))
    await saveSampleBank(second)
    await direct(['metadata'], tx => { for (const id of capIds) tx.objectStore('metadata').delete(id) })
    check('Transactional library capacity and byte budgets cannot silently overgrow', { budgetError, capError }, [
      ['byte budget rejects a whole bank with a useful 256 MiB message', budgetError.includes('256 MiB')],
      ['bank count rejects an additional bank at one hundred', capError.includes('100') && await loadSampleBank('one-too-many') === null],
      ['existing banks can still update at the count limit', (await loadSampleBank(second.id)).name === second.name],
      ['rejected writes retain both real banks', (await listSampleBanks()).banks.length === 2],
    ])
    const progress = [], packSource = copyBank(savedEdit)
    const pack = await exportSamplePack(packSource, { onProgress: item => { progress.push(item); if (item.percent > 0) packSource.samples[0].name = 'Changed during export' } })
    const subset = await exportSamplePack(savedEdit, { sampleIds: [savedEdit.samples[6].id, savedEdit.copies[0].id] })
    check('Complete ZIP links sixteen committed WAV and JSON files and preserves names safely', { bytes: pack.bytes.length, files: pack.manifest.files.length, filename: pack.filename }, [
      ['default pack contains exactly sixteen WAV sixteen JSON manifest and README', pack.manifest.exportedSampleCount === 16 && pack.manifest.files.filter(file => file.endsWith('.wav')).length === 16 && pack.manifest.files.filter(file => file.startsWith('PATCHES/')).length === 16 && pack.manifest.files.length === 34],
      ['all paths are unique safe relative ordinal names independent of sample titles', new Set(pack.manifest.files).size === 34 && pack.manifest.files.every(file => !file.includes('..') && !file.includes('\\')) && !pack.filename.includes('/')],
      ['metadata identifies WAV format app generator base patch and reproducible seeds', pack.manifest.wavFormat.bitsPerSample === 24 && pack.manifest.wavFormat.sampleRate === 48000 && pack.manifest.wavFormat.channels === 1 && pack.manifest.generatorVersion === savedEdit.generatorVersion && pack.manifest.batchSeed === savedEdit.batchSeed && same(pack.manifest.basePatch, savedEdit.base.patch)],
      ['async UI edits cannot alter the already frozen export snapshot', pack.manifest.samples[0].name === savedEdit.samples[0].name && packSource.samples[0].name === 'Changed during export'],
      ['progress is monotonic and reaches completion', progress[0].percent === 0 && progress.at(-1).percent === 100 && progress.every((item, index) => index === 0 || item.percent >= progress[index - 1].percent)],
    ])
    check('Selected subset can export generated kicks and user copies without including the base', { files: subset.manifest.files, ids: subset.manifest.samples.map(item => item.id) }, [
      ['subset includes exactly its two selected WAV patch pairs', subset.manifest.exportedSampleCount === 2 && subset.manifest.files.length === 6],
      ['generated ordinal and separate copy naming retain unambiguous paths', subset.manifest.files.includes('WAV/Kick_07.wav') && subset.manifest.files.includes('WAV/Kick_Copy_01.wav')],
      ['invalid empty duplicate and unknown selections are rejected', Boolean(await rejection(() => exportSamplePack(savedEdit, { sampleIds: [] }))) && Boolean(await rejection(() => exportSamplePack(savedEdit, { sampleIds: [savedEdit.samples[0].id, savedEdit.samples[0].id] }))) && Boolean(await rejection(() => exportSamplePack(savedEdit, { sampleIds: ['missing'] })))],
    ])
    const cancel = new AbortController(), cancelProgress = []
    const cancelled = await rejection(() => exportSamplePack(savedEdit, { signal: cancel.signal, onProgress: value => { cancelProgress.push(value.percent); if (value.percent > 0) cancel.abort() } }))
    const preCancelled = await rejection(() => exportSamplePack(savedEdit, { signal: cancel.signal }))
    const invalidPaths = ['../escape.txt', '/root.txt', 'C:/absolute.txt', 'a\\b.txt', 'a//b.txt']
    const unsafe = []
    for (const path of invalidPaths) unsafe.push(await rejection(() => createStoredZip([{ path, data: new Uint8Array([1]) }])))
    const duplicate = await rejection(() => createStoredZip([{ path: 'A.txt', data: new Uint8Array([1]) }, { path: 'a.txt', data: new Uint8Array([2]) }]))
    check('Cancellation and unsafe ZIP paths cannot publish incomplete or conflicting archives', { cancelled, preCancelled, progress: cancelProgress }, [
      ['mid-export and pre-export cancellation reject with AbortError', cancelled.startsWith('AbortError') && preCancelled.startsWith('AbortError') && cancelProgress.at(-1) < 100],
      ['path traversal absolute Windows and duplicate paths are rejected', unsafe.every(Boolean) && Boolean(duplicate)],
      ['filename sanitization never turns a title into an executable path', safePackFilename('../../CON:?.zip').startsWith('SOUND_LAB_KICK_PACK_') && !/[\\/:?]/u.test(safePackFilename('../../CON:?.zip'))],
      ['cancelled export never removes or replaces its source bank', same((await loadSampleBank(savedEdit.id)).samples[6].patch, savedEdit.samples[6].patch)],
    ])
    const unicodeZip = await createStoredZip([{ path: 'Тест/имя.txt', data: new TextEncoder().encode('Unicode content'), modifiedAt: at }])
    await deleteSampleBank(second.id)
    check('Sample Forge storage operations preserve all legacy libraries and settings', { remainingBanks: (await listSampleBanks()).banks.length }, [
      ['deleting one bank removes only that bank and its metadata', await loadSampleBank(second.id) === null && (await listSampleBanks()).banks.length === 1],
      ['Phrase Recorder library and Sound Snapshot are byte-equivalent data', same(await listPhrases(), beforeLegacy) && same(await loadDraft(), beforeDraft)],
      ['MIDI Learn harmonic patches and unrelated local settings are untouched', same(localSentinels.map(key => localStorage.getItem(key)), beforeLocal)],
    ])
    localSentinels.forEach((key, index) => { if (originalLocal[index] === null) localStorage.removeItem(key); else localStorage.setItem(key, originalLocal[index]) })
    db.close()
    const sample = savedEdit.samples[6]
    return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)), artifacts: {
      zipBase64: base64(pack.bytes), pilotZipBase64: base64(pilotPack.bytes), subsetZipBase64: base64(subset.bytes), unicodeZipBase64: base64(unicodeZip), wavBase64: base64(sample.render.wav),
      pcmBase64: base64(new Uint8Array(sample.render.pcm.buffer, sample.render.pcm.byteOffset, sample.render.pcm.byteLength)), patch: sample.patch,
      expectedFrames: sample.render.pcm.length, expectedDuration: sample.render.metrics.duration, expectedFingerprint: sample.render.fingerprint, packManifest: pack.manifest, subsetManifest: subset.manifest,
    } }
  })
  const { artifacts, ...summary } = report
  assert.deepEqual(summary.failures, [], 'Sample Forge data scenarios failed')
  assert.deepEqual(consoleErrors, [], 'Sample Forge data scenarios produced uncaught browser errors')
  await mkdir('test-results', { recursive: true })
  const zipFile = path.resolve(`test-results/sample-forge-pack-${browserName}.zip`), subsetFile = path.resolve(`test-results/sample-forge-subset-${browserName}.zip`), unicodeFile = path.resolve(`test-results/sample-forge-unicode-${browserName}.zip`)
  const pilotFile = path.resolve(`test-results/SOUND_LAB_KICK_PACK_001-${browserName}.zip`)
  await writeFile(zipFile, Buffer.from(artifacts.zipBase64, 'base64')); await writeFile(subsetFile, Buffer.from(artifacts.subsetZipBase64, 'base64')); await writeFile(unicodeFile, Buffer.from(artifacts.unicodeZipBase64, 'base64'))
  await writeFile(pilotFile, Buffer.from(artifacts.pilotZipBase64, 'base64'))
  const wav = Buffer.from(artifacts.wavBase64, 'base64'), pcm = Buffer.from(artifacts.pcmBase64, 'base64')
  // Independent RIFF reader: chunk walking, signed PCM24 decoding, and exact
  // per-sample comparison with actual OfflineAudioContext Float32 output.
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE'); assert.equal(wav.readUInt32LE(4), wav.length - 8)
  let cursor = 12, format = null, data = null
  while (cursor + 8 <= wav.length) {
    const name = wav.toString('ascii', cursor, cursor + 4), bytes = wav.readUInt32LE(cursor + 4), start = cursor + 8
    assert.ok(start + bytes <= wav.length)
    if (name === 'fmt ') format = { pcm: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4), byteRate: wav.readUInt32LE(start + 8), blockAlign: wav.readUInt16LE(start + 12), bits: wav.readUInt16LE(start + 14) }
    if (name === 'data') data = wav.subarray(start, start + bytes)
    cursor = start + bytes + (bytes & 1)
  }
  assert.deepEqual(format, { pcm: 1, channels: 1, sampleRate: 48000, byteRate: 144000, blockAlign: 3, bits: 24 })
  assert.equal(data.length, artifacts.expectedFrames * 3); assert.equal(pcm.length, artifacts.expectedFrames * 4); assert.equal(data.length / 3 / 48000, artifacts.expectedDuration)
  let maximumQuantizationError = 0, peak = 0, sum = 0
  for (let index = 0; index < artifacts.expectedFrames; ++index) {
    const encoded = data.readIntLE(index * 3, 3), source = pcm.readFloatLE(index * 4), scale = source < 0 ? 0x800000 : 0x7fffff
    // Signed integer PCM has one zero representation; Math.round can return -0.
    assert.equal(encoded, Math.round(source * scale) || 0); const decoded = encoded / scale
    maximumQuantizationError = Math.max(maximumQuantizationError, Math.abs(decoded - source)); peak = Math.max(peak, Math.abs(decoded)); sum += decoded
  }
  assert.ok(maximumQuantizationError < 1 / 0x7fffff); assert.ok(peak <= 10 ** (-1 / 20) + 1e-6); assert.ok(Math.abs(sum / artifacts.expectedFrames) < 1e-4)
  assert.equal(data.readIntLE(0, 3), 0); assert.equal(data.readIntLE(data.length - 3, 3), 0)
  const python = String.raw`
import sys, json, zipfile, io, wave
reports = []
for filename, expected in [(sys.argv[1], 16), (sys.argv[2], 2), (sys.argv[4], 16)]:
    with zipfile.ZipFile(filename) as z:
        assert z.testzip() is None, 'CRC32 verification failed'
        names = z.namelist()
        assert len(names) == expected * 2 + 2
        assert len(set(n.lower() for n in names)) == len(names)
        assert all(not n.startswith('/') and '..' not in n.split('/') and '\\' not in n for n in names)
        root = names[0].split('/')[0] + '/'
        manifest = json.loads(z.read(root + 'manifest.json'))
        assert manifest['format'] == 'sound-lab.sample-pack' and manifest['version'] == 1
        assert manifest['exportedSampleCount'] == expected and manifest['variationCount'] == 16
        assert set(root + n for n in manifest['files']) == set(names)
        assert manifest['wavFormat'] == {'container': 'RIFF/WAVE', 'encoding': 'signed PCM', 'bitsPerSample': 24, 'channels': 1, 'sampleRate': 48000}
        assert len(manifest['samples']) == expected
        if filename == sys.argv[4]:
            assert manifest['name'] == 'SOUND LAB KICK PACK 001' and root == 'SOUND_LAB_KICK_PACK_001/'
            assert manifest['batchSeed'] == 20260813
            assert [s['name'] for s in manifest['samples']] == ['Kick_%02d' % n for n in range(1, 17)]
        assert 'ready-to-use audio samples' in z.read(root + 'README.txt').decode('utf8')
        for sample in manifest['samples']:
            with wave.open(io.BytesIO(z.read(root + sample['wav'])), 'rb') as w:
                assert w.getnchannels() == 1 and w.getsampwidth() == 3 and w.getframerate() == 48000 and w.getcomptype() == 'NONE'
                assert w.getnframes() == sample['frames']
                assert abs(w.getnframes() / w.getframerate() - sample['duration']) < 1e-12
                raw = w.readframes(w.getnframes())
                assert len(raw) == w.getnframes() * 3
                assert int.from_bytes(raw[:3], 'little', signed=True) == 0 and int.from_bytes(raw[-3:], 'little', signed=True) == 0
                assert max(abs(int.from_bytes(raw[i:i+3], 'little', signed=True)) for i in range(0, len(raw), 3)) <= 7476360
            patch = json.loads(z.read(root + sample['patch']))
            assert patch['format'] == 'sound-lab.kick-patch' and patch['version'] == 1
            assert patch['name'] == sample['name'] and patch['tags'] == sample['tags']
            assert patch['generatorVersion'] == manifest['generatorVersion']
            assert patch['patch']['version'] == 1 and patch['generatedPatch']['version'] == 1
            assert patch['patch']['seed'] == sample['seed'] and patch['generatedPatch']['seed'] == sample['generatedSeed']
        reports.append({'files': len(names), 'samples': expected, 'crcVerified': True, 'wavParsed': expected, 'patchParsed': expected})
with zipfile.ZipFile(sys.argv[3]) as z:
    assert z.namelist() == ['Тест/имя.txt'] and z.read('Тест/имя.txt').decode('utf8') == 'Unicode content'
    assert z.infolist()[0].flag_bits & 0x800 and z.testzip() is None
print(json.dumps({'archives': reports, 'unicodeVerified': True}))
`
  const independent = spawnSync(process.env.SOUND_LAB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', python, zipFile, subsetFile, unicodeFile, pilotFile], { encoding: 'utf8', timeout: 30000 })
  assert.equal(independent.status, 0, `Independent Python zipfile/wave parser failed: ${independent.stderr || independent.error}`)
  const independentZip = JSON.parse(independent.stdout)
  const independentResults = { independentWav: { frames: artifacts.expectedFrames, format, maximumQuantizationError, peak }, independentZip }
  await writeFile(`test-results/sample-forge-data-${browserName}.json`, JSON.stringify({ browser: browserName, ...summary, ...independentResults, consoleErrors }, null, 2))
  console.log(JSON.stringify({ ...summary, ...independentResults }, null, 2))
  console.log(`PASS: ${summary.results.length} Sample Forge data scenarios, ${summary.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions, independent PCM24 + Python ZIP/WAVE validation (${browserName})`)
} finally { await session.close() }
