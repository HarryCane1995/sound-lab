import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { startTestBrowser, testBrowserName } from './helpers.mjs'
import { connectStudioMidi, installStudioProbe, setStudioNumber, studioMidi, studioTelemetry } from './studio-harness.mjs'

const session = await startTestBrowser({ workspace: 'studio' })
const url = session.page.url(), browserName = testBrowserName()
await session.page.close()
const context = await session.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await context.newPage(), results = [], errors = [], dialogs = []
page.setDefaultTimeout(10000)
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
let acceptDialog = true
page.on('dialog', async dialog => { dialogs.push(dialog.message()); if (acceptDialog) await dialog.accept(); else await dialog.dismiss() })
const pass = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }
const button = name => page.getByRole('button', { name, exact: true })
const forge = () => page.locator('.sample-forge')
const pads = () => page.locator('.forge-sample-grid').first().locator('.forge-sample-pad')
const selectedId = () => page.locator('.forge-sample-pad.is-selected').first().getAttribute('data-sample-id')
const previewGraph = () => page.locator('.forge-preview > .forge-waveform')
const ready = () => page.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.renderStatus === 'ready')
const settled = () => page.waitForFunction(() => !document.querySelector('.forge-progress'))
const starts = () => page.evaluate(() => window.__forgeUiProbe.starts.length)
const stop = async () => { await button('■ Stop Preview').click(); await page.waitForTimeout(25) }
const currentValue = async name => Number(await page.getByRole('spinbutton', { name: `Kick ${name}, значение`, exact: true }).inputValue())
const setKick = async (name, value) => setStudioNumber(page, `Kick ${name}`, value)
const generated = async () => { await settled(); await ready(); await page.waitForFunction(() => document.querySelectorAll('.forge-grid-panel > .forge-sample-grid > .forge-sample-pad').length === 16) }
const choose = async label => { await button(label).click(); await page.waitForFunction(label => [...document.querySelectorAll('.workspace-mode button')].some(button => button.textContent === label && button.getAttribute('aria-pressed') === 'true'), label) }
const selectPad = async index => { await pads().nth(index).locator('.forge-pad-select').click(); await ready() }
const saveChanges = async () => { await ready(); await button('Save Changes').click(); await settled(); await page.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.dirty === 'false') }
const saveBank = async () => { await page.getByRole('button', { name: /^Save Bank/ }).click(); await settled(); await page.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.bankDirty === 'false') }
const holdOffline = async () => page.evaluate(() => { window.__forgeUiProbe.holdOffline = true })
const waitHeld = () => page.waitForFunction(() => window.__forgeUiProbe.heldRenders.length > 0)
const releaseOffline = async () => page.evaluate(() => { const probe = window.__forgeUiProbe; probe.holdOffline = false; for (const resolve of probe.heldRenders.splice(0)) resolve() })
const storageSnapshot = () => page.evaluate(async () => {
  const { listSampleBanks, loadSampleBank, loadWorkingBase } = await import('/src/sample-forge/library.ts')
  const hash = bytes => { let value = 0x811c9dc5; for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193); return (value >>> 0).toString(16) }
  const sample = value => ({ id: value.id, name: value.name, tags: value.tags, favorite: value.favorite, patch: value.patch,
    generatedPatch: value.generatedPatch, fingerprint: value.render.fingerprint, frames: value.render.pcm.length,
    pcmHash: hash(new Uint8Array(value.render.pcm.buffer, value.render.pcm.byteOffset, value.render.pcm.byteLength)), wavHash: hash(value.render.wav) })
  const summary = await listSampleBanks(), banks = []
  for (const entry of summary.banks) { const value = await loadSampleBank(entry.id); banks.push({ id: value.id, name: value.name, batchSeed: value.batchSeed, base: sample(value.base), samples: value.samples.map(sample), copies: value.copies.map(sample) }) }
  const base = await loadWorkingBase()
  return { banks, base: base ? sample(base) : null }
})

async function verifyLayout(name, viewport, aboveFold = false) {
  await page.setViewportSize(viewport); await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(100)
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    blocks: ['.forge-topbar', '.forge-editor', '.forge-preview', '.forge-metadata', '.forge-grid-panel', '.forge-library'].map(selector => ({ selector, box: document.querySelector(selector)?.getBoundingClientRect().toJSON() })) }))
  assert.ok(geometry.scrollWidth <= viewport.width + 2, `${name}: horizontal overflow ${JSON.stringify(geometry)}`)
  for (const { selector, box } of geometry.blocks) {
    assert.ok(box && box.width > 0 && box.height > 0, `${name}: missing ${selector}`)
    assert.ok(box.left >= -1 && box.right <= viewport.width + 2, `${name}: ${selector} is clipped horizontally`)
    if (aboveFold) assert.ok(box.bottom <= viewport.height + 2, `${name}: ${selector} requires a long scroll: ${JSON.stringify(box)}`)
  }
  for (const name of ['GENERATE 16 VARIATIONS', 'Save Changes', '■ Stop Preview']) {
    const box = await button(name).boundingBox(); assert.ok(box && box.width >= 24 && box.height >= 20)
    if (aboveFold) assert.ok(box.y + box.height <= viewport.height + 2, `${name}: action must be above fold`)
  }
  await page.screenshot({ path: `test-results/sample-forge-${name}-${browserName}.png`, fullPage: true })
  return geometry
}

try {
  await installStudioProbe(page)
  await page.addInitScript(() => {
    const probe = window.__forgeUiProbe = { starts: [], holdOffline: false, heldRenders: [], nativeRenders: 0 }
    const CurrentAudioContext = window.AudioContext
    window.AudioContext = new Proxy(CurrentAudioContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args), createSource = context.createBufferSource.bind(context)
      context.createBufferSource = (...values) => {
        const source = createSource(...values), nativeStart = source.start.bind(source)
        source.start = (...times) => {
          const pcm = source.buffer?.getChannelData(0).slice() ?? new Float32Array()
          probe.starts.push({ source, pcm, sampleRate: source.buffer?.sampleRate, at: times[0] ?? context.currentTime, ended: false })
          const record = probe.starts.at(-1); source.addEventListener('ended', () => { record.ended = true }, { once: true })
          return nativeStart(...times)
        }
        return source
      }
      return context
    } })
    // Fault injection holds only Promise delivery of a completed native render;
    // synthesis, scheduling, audio samples and the returned buffer stay native.
    const NativeOfflineAudioContext = window.OfflineAudioContext
    window.OfflineAudioContext = new Proxy(NativeOfflineAudioContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args), nativeRender = context.startRendering.bind(context)
      context.startRendering = async () => {
        const buffer = await nativeRender(); ++probe.nativeRenders
        if (probe.holdOffline) await new Promise(resolve => probe.heldRenders.push(resolve))
        return buffer
      }
      return context
    } })
  })
  await page.goto(url); await button('Sample Forge').waitFor()
  assert.equal(await button('Studio').getAttribute('aria-pressed'), 'true')
  await choose('Sample Forge'); await ready()
  assert.equal(await forge().getAttribute('data-dirty'), 'false')
  assert.equal(await pads().count(), 0)
  assert.ok(Number(await previewGraph().getAttribute('data-pcm-frames')) > 14000)
  assert.equal((await studioTelemetry(page)).contexts, 0)
  assert.equal(await starts(), 0)
  pass('Fresh Studio opens Sample Forge with a real silent Base render and no extra AudioContext')

  await page.getByRole('checkbox', { name: 'Прослушивать изменения Kick', exact: true }).uncheck()
  await setKick('Body Decay', 360); await ready(); await saveChanges()
  const standalone = await storageSnapshot()
  assert.equal(standalone.base.patch.bodyDecay, 360)
  assert.equal(standalone.banks.length, 0)
  assert.ok(standalone.base.frames > 14000)
  pass('Base Patch is editable and explicitly saved independently of sixteen-variation banks', { base: standalone.base })

  await page.getByRole('spinbutton', { name: 'Generation Seed', exact: true }).fill('20260808')
  const beforeGenerationStarts = await starts()
  await button('GENERATE 16 VARIATIONS').click(); await generated()
  assert.equal(await pads().count(), 16)
  assert.equal(await starts(), beforeGenerationStarts)
  assert.equal((await studioTelemetry(page)).contexts, 0)
  const originalIds = await pads().evaluateAll(items => items.map(item => item.dataset.sampleId))
  assert.equal(new Set(originalIds).size, 16)
  await button('Выбрать Base Patch').click(); assert.equal(await currentValue('Body Decay'), 360); await selectPad(0)
  pass('Generate creates exactly sixteen new pads from a snapshotted separate Base without autoplay', { ids: originalIds })

  const waveforms = await pads().locator('svg').evaluateAll(elements => elements.map(svg => ({ fingerprint: svg.dataset.pcmFingerprint, frames: Number(svg.dataset.pcmFrames), path: svg.querySelector('.forge-wave-peaks')?.getAttribute('d'), description: svg.querySelector('desc')?.textContent })))
  assert.equal(waveforms.length, 16)
  assert.equal(new Set(waveforms.map(value => value.fingerprint)).size, 16)
  assert.equal(new Set(waveforms.map(value => value.path)).size, 16)
  assert.ok(waveforms.every(value => value.frames > 3000 && value.path?.startsWith('M') && value.description.includes('Реальный PCM')))
  assert.ok(await page.locator('.forge-metrics').innerText().then(value => value.includes('dBFS') && value.includes('Mono · 24-bit')))
  pass('Every pad and large waveform displays actual distinct PCM with duration Peak RMS and format', { frames: waveforms.map(value => value.frames) })

  const defaultBody = await currentValue('Body Decay'), firstFingerprint = await previewGraph().getAttribute('data-pcm-fingerprint')
  await setKick('Body Decay', 400)
  assert.equal(await forge().getAttribute('data-dirty'), 'true')
  assert.equal(await forge().getAttribute('data-render-status'), 'rendering')
  await ready()
  assert.notEqual(await previewGraph().getAttribute('data-pcm-fingerprint'), firstFingerprint)
  assert.equal(await pads().first().locator('svg').getAttribute('data-pcm-fingerprint'), firstFingerprint)
  assert.ok((await page.locator('.forge-render-badge').innerText()).includes('SAVE PATCH'))
  await page.getByRole('button', { name: /^Export ZIP/ }).click()
  assert.match(await page.locator('.forge-error').innerText(), /Save Changes/)
  pass('Knob edits debounce real preview while committed pad/WAV remain unchanged; stale ZIP export is blocked')

  await button('Undo').click(); await ready(); assert.equal(await currentValue('Body Decay'), defaultBody)
  await setKick('Body Decay', 410); await ready()
  await button('Reset to Generated').click(); await ready(); assert.equal(await currentValue('Body Decay'), defaultBody)
  await setKick('Body Decay', 420); await ready(); await button('Re-render').click(); await ready()
  await saveChanges()
  const savedAfterEdit = await storageSnapshot(), storedFirst = savedAfterEdit.banks[0].samples[0]
  assert.equal(storedFirst.patch.bodyDecay, 420)
  assert.ok(Math.abs(storedFirst.generatedPatch.bodyDecay - defaultBody) <= 0.051)
  assert.equal(storedFirst.fingerprint, await previewGraph().getAttribute('data-pcm-fingerprint'))
  pass('Undo Reset Re-render and Save Changes preserve generated provenance and commit matching patch/PCM/WAV', { storedFirst })

  await page.getByRole('checkbox', { name: 'Прослушивать изменения Kick', exact: true }).check()
  const startsBeforeEdit = await starts()
  await setKick('Body Decay', 430)
  await page.waitForFunction(count => window.__forgeUiProbe.starts.length > count, startsBeforeEdit)
  await ready()
  const matched = await page.evaluate(async () => {
    const { loadSampleBank, listSampleBanks } = await import('/src/sample-forge/library.ts')
    const { renderKick } = await import('/src/sample-forge/audio/KickRenderer.ts')
    const current = await loadSampleBank((await listSampleBanks()).banks[0].id)
    const expected = await renderKick({ ...current.samples[0].patch, bodyDecay: 430 })
    const actual = window.__forgeUiProbe.starts.at(-1).pcm
    return { equal: actual.length === expected.pcm.length && actual.every((value, index) => value === expected.pcm[index]), frames: actual.length }
  })
  assert.equal(matched.equal, true)
  assert.equal((await studioTelemetry(page)).contexts, 1)
  await stop(); await saveChanges()
  pass('Auto Preview uses the latest debounced patch and the exact native render on the shared context', matched)

  const plays = async action => { const count = await starts(); await action(); await page.waitForFunction(count => window.__forgeUiProbe.starts.length > count, count) }
  await plays(() => button('▶ Base Kick · A').click())
  assert.equal(await button('▶ Base Kick · A').getAttribute('aria-pressed'), 'true')
  await plays(() => button('A/B Compare').click())
  assert.equal(await button('▶ Selected Kick · B').getAttribute('aria-pressed'), 'true')
  await plays(() => button('↻ Replay').click())
  const idBeforeNext = await selectedId(); await plays(() => button('Next ▶').click()); assert.notEqual(await selectedId(), idBeforeNext)
  await plays(() => pads().nth(3).getByRole('button', { name: /^Play / }).click())
  await stop()
  assert.equal(await button('▶ Selected Kick · B').getAttribute('aria-pressed'), 'false')
  assert.ok(await page.evaluate(() => window.__forgeUiProbe.starts.filter(value => !value.ended).length <= 1))
  pass('Pad Play Stop Replay Next and A/B comparison operate one bounded preview without restarting the synth')

  await selectPad(0)
  const name = page.getByRole('textbox', { name: 'Название Kick', exact: true })
  await name.fill('Моя бочка'); await name.press('Enter')
  const tag = page.getByLabel('Новый тег Kick', { exact: true })
  await tag.fill('  My   Tone  '); await tag.press('Enter')
  await tag.fill('my tone'); await tag.press('Enter')
  assert.equal(await button('Удалить тег My Tone').count(), 1)
  await button('Избранное выбранного Kick').click()
  assert.equal(await button('Избранное выбранного Kick').getAttribute('aria-pressed'), 'true')
  const search = page.getByRole('searchbox', { name: 'Поиск Kick по названию и тегам', exact: true })
  await search.fill('MY TONE'); assert.equal(await pads().count(), 1)
  await page.getByRole('checkbox', { name: '★ Избранное', exact: true }).check(); assert.equal(await pads().count(), 1)
  await search.fill('missing-nonexistent-tag'); assert.equal(await pads().count(), 0)
  await page.getByRole('checkbox', { name: '★ Избранное', exact: true }).uncheck(); await search.clear(); assert.equal(await pads().count(), 16)
  await button('Удалить тег My Tone').click(); assert.equal(await button('Удалить тег My Tone').count(), 0)
  await saveBank()
  pass('Names tags Unicode whitespace case-insensitive deduplication favorites and filters work on real metadata')

  const patchDownloadPromise = page.waitForEvent('download')
  await button('Export Patch JSON').click()
  const patchDownload = await patchDownloadPromise, patchText = await readFile(await patchDownload.path(), 'utf8'), portable = JSON.parse(patchText)
  assert.equal(portable.format, 'sound-lab.kick-patch'); assert.equal(portable.patch.bodyDecay, 430); assert.equal(portable.name, 'Моя бочка')
  assert.notEqual(portable.generatedPatch.bodyDecay, portable.patch.bodyDecay)
  pass('Export Patch JSON downloads actual editable values and original generated parameters', { name: portable.name, bodyDecay: portable.patch.bodyDecay })

  await button('Duplicate Patch').click(); await settled(); await ready()
  await page.locator('.forge-copies > summary').click()
  assert.equal(await page.locator('.forge-copies .forge-sample-pad').count(), 1)
  assert.equal(await pads().count(), 16)
  assert.match(await name.inputValue(), /copy$/)
  await saveChanges()
  pass('Duplicate creates an editable user copy while keeping the sixteen generated variants intact')

  const importFile = page.getByLabel('Файл Kick Patch JSON', { exact: true })
  await importFile.setInputFiles({ name: 'Kick_Patch.json', mimeType: 'application/json', buffer: Buffer.from(patchText) })
  await settled(); await ready()
  assert.equal(await page.locator('.forge-copies .forge-sample-pad').count(), 2)
  assert.equal(await currentValue('Body Decay'), 430)
  assert.equal(await name.inputValue(), 'Моя бочка')
  await saveChanges()
  pass('Import of exported Patch validates and natively re-renders a separate editable copy')

  await importFile.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...portable, patch: { ...portable.patch, tone: null } })) })
  await settled(); await page.locator('.forge-error').waitFor()
  assert.equal(await page.locator('.forge-copies .forge-sample-pad').count(), 2)
  await importFile.setInputFiles({ name: 'huge.json', mimeType: 'application/json', buffer: Buffer.from(' '.repeat(65537)) })
  await settled(); assert.match(await page.locator('.forge-error').innerText(), /64 KiB/)
  assert.equal(await currentValue('Body Decay'), 430)
  pass('Malformed and oversized Patch imports show errors without replacing the current sound or copies')

  await selectPad(0); await button('Выбрать все для ZIP').click()
  await pads().nth(15).getByRole('checkbox').uncheck()
  assert.match(await page.getByRole('button', { name: /^Export ZIP/ }).innerText(), /15/)
  await button('Выбрать все для ZIP').click()
  const zipDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Export ZIP/ }).click()
  const zipDownload = await zipDownloadPromise
  const zipPath = `test-results/sample-forge-ui-${browserName}.zip`; await zipDownload.saveAs(zipPath)
  await settled()
  const parsedZip = spawnSync('python', ['-c', `import json,sys,zipfile,struct
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist(); wav=[n for n in names if n.endswith('.wav')]; patches=[n for n in names if n.endswith('.json') and '/PATCHES/' in n]
 checks=[]
 for n in wav:
  b=z.read(n); checks.append(b[:4]==b'RIFF' and b[8:12]==b'WAVE' and struct.unpack_from('<H',b,22)[0]==1 and struct.unpack_from('<I',b,24)[0]==48000 and struct.unpack_from('<H',b,34)[0]==24 and struct.unpack_from('<I',b,40)[0]%3==0)
 print(json.dumps({'wav':len(wav),'patches':len(patches),'unique':len(names)==len(set(names)),'validWav':all(checks),'badMember':z.testzip()}))`, zipPath], { encoding: 'utf8' })
  assert.equal(parsedZip.status, 0, parsedZip.stderr)
  const zipReport = JSON.parse(parsedZip.stdout)
  assert.equal(zipReport.wav, 16); assert.equal(zipReport.patches, 16); assert.equal(zipReport.unique, true); assert.equal(zipReport.validWav, true); assert.equal(zipReport.badMember, null)
  pass('Multi-selection exports sixteen actual PCM24 WAV and sixteen Patch files in a standard-parser-valid ZIP', zipReport)

  await page.getByRole('textbox', { name: 'Название Sample Bank', exact: true }).fill('Мой Kick Bank 01')
  await page.getByRole('textbox', { name: 'Название Sample Bank', exact: true }).press('Enter')
  await saveBank()
  const beforeReload = await storageSnapshot(), originalBankId = beforeReload.banks[0].id
  await page.reload(); await forge().waitFor({ state: 'visible' }); await generated()
  const afterReload = await storageSnapshot()
  assert.deepEqual(afterReload, beforeReload)
  assert.equal(await page.getByRole('textbox', { name: 'Название Sample Bank', exact: true }).inputValue(), 'Мой Kick Bank 01')
  assert.equal(await pads().count(), 16)
  assert.equal(await starts(), 0)
  pass('Save Bank and reload retain exact IndexedDB patch PCM WAV name metadata and copies without autoplay', { id: originalBankId, sampleCount: beforeReload.banks[0].samples.length })

  await page.getByRole('spinbutton', { name: 'Generation Seed', exact: true }).fill('20260809')
  await button('GENERATE 16 VARIATIONS').click(); await generated(); await saveBank()
  const twoBanks = await storageSnapshot()
  assert.equal(twoBanks.banks.length, 2)
  assert.deepEqual(twoBanks.banks.find(value => value.id === originalBankId), beforeReload.banks[0])
  await page.getByRole('combobox', { name: 'Открыть Sample Bank', exact: true }).selectOption(originalBankId); await generated()
  assert.equal(await page.getByRole('textbox', { name: 'Название Sample Bank', exact: true }).inputValue(), 'Мой Kick Bank 01')
  pass('New batches create separate banks and preserve previously saved banks byte-for-byte', { bankIds: twoBanks.banks.map(value => value.id) })

  const idsBeforeCancel = await pads().evaluateAll(items => items.map(item => item.dataset.sampleId))
  await holdOffline(); await button('Regenerate Batch').click(); await waitHeld()
  await button('Cancel Generation').click(); await releaseOffline(); await settled(); await ready()
  assert.deepEqual(await pads().evaluateAll(items => items.map(item => item.dataset.sampleId)), idsBeforeCancel)
  assert.deepEqual(await storageSnapshot(), twoBanks)
  pass('Cancel Generation discards a pending native batch and preserves the current bank and saved library')

  const desktopLayout = await verifyLayout('1920', { width: 1920, height: 1080 }, true)
  const compactLayout = await verifyLayout('1366', { width: 1366, height: 768 })
  const mobileLayout = await verifyLayout('mobile', { width: 390, height: 844 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  pass('Sample Forge keeps primary controls above fold at1920 and has no horizontal clipping at1366 or mobile', { desktopLayout, compactLayout, mobileLayout })

  await choose('Studio'); await connectStudioMidi(page)
  if (await button('Закрыть MIDI Monitor').isVisible()) await button('Закрыть MIDI Monitor').click()
  await button('Record phrase').click()
  await page.waitForFunction(() => document.querySelector('.phrase-status')?.textContent === 'Запись')
  await studioMidi(page, [0x90, 57, 90]); await studioMidi(page, [0x90, 60, 100]); await page.waitForTimeout(55)
  await studioMidi(page, [0x80, 57, 0]); await studioMidi(page, [0x80, 60, 0]); await page.waitForTimeout(30)
  await button('Stop phrase').click()
  await page.getByRole('checkbox', { name: 'Studio Loop', exact: true }).check()
  await button('Play phrase').click()
  await page.waitForFunction(() => document.querySelector('.phrase-status')?.textContent === 'Воспроизведение')
  await studioMidi(page, [0x90, 69, 96]); await page.waitForTimeout(35)
  const liveCarrier = await page.evaluate(() => { const probe = window.__studioProbe; const record = probe.oscillators.findLast(value => !value.ended && value.node.frequency.value === 440); window.__forgeUiProbe.liveCarrier = record; return Boolean(record) })
  assert.equal(liveCarrier, true)
  const contextCount = (await studioTelemetry(page)).contexts
  for (const label of ['Sample Forge', 'Learn', 'Studio', 'Sample Forge']) {
    await choose(label)
    assert.equal((await studioTelemetry(page)).contexts, contextCount)
    assert.equal(await page.locator('.phrase-status').textContent(), 'Воспроизведение')
    assert.equal(await page.evaluate(() => window.__forgeUiProbe.liveCarrier.ended), false)
  }
  await plays(() => button('▶ Selected Kick · B').click()); await stop()
  assert.equal(await page.locator('.phrase-status').textContent(), 'Воспроизведение')
  assert.equal(await page.evaluate(() => window.__forgeUiProbe.liveCarrier.ended), false)
  await studioMidi(page, [0x80, 69, 0]); await button('Stop phrase').click()
  pass('Studio Forge and Learn share live MIDI and looping Phrase Recorder without replacing context or held carrier', { contexts: contextCount })

  await page.getByRole('checkbox', { name: 'Прослушивать изменения Kick', exact: true }).check()
  await stop(); await holdOffline()
  const beforeLateStop = await starts()
  await setKick('Body Decay', 440); await waitHeld()
  await button('▶ Selected Kick · B').click(); await button('■ Stop Preview').click()
  await releaseOffline(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforeLateStop)
  pass('Stop invalidates manual and automatic preview intentions before a delayed dirty render completes')

  await holdOffline(); const beforePanic = await starts()
  await setKick('Body Decay', 450); await waitHeld()
  await button('▶ Selected Kick · B').click(); await page.keyboard.press('Escape')
  await releaseOffline(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforePanic)
  pass('Panic cancels pending dirty-render playback before its completed native buffer is delivered')

  await holdOffline(); const beforeSelection = await starts()
  await setKick('Body Decay', 460); await waitHeld()
  await selectPad(1); const selectedAfterRace = await selectedId()
  await releaseOffline(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforeSelection)
  assert.equal(await selectedId(), selectedAfterRace)
  assert.notEqual(await currentValue('Body Decay'), 460)
  pass('Changing selection discards a pending dirty-render result and cannot replay the previous sample')

  await button('Выбрать Base Patch').click(); await holdOffline()
  const beforeDirtyGenerate = await starts()
  await setKick('Body Decay', 370); await waitHeld()
  await button('GENERATE 16 VARIATIONS').click(); await releaseOffline(); await generated()
  assert.equal(await starts(), beforeDirtyGenerate)
  await button('Выбрать Base Patch').click(); assert.equal(await currentValue('Body Decay'), 370)
  assert.equal((await storageSnapshot()).banks.length, 2)
  pass('Generate snapshots a dirty Base and cancels obsolete automatic preview without deleting older banks')

  await holdOffline()
  const beforeDirtyCancel = await starts(), dirtyCancelIds = await pads().evaluateAll(items => items.map(item => item.dataset.sampleId))
  await setKick('Body Decay', 375); await waitHeld()
  await button('Regenerate Batch').click(); await button('Cancel Generation').click()
  await releaseOffline(); await settled(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforeDirtyCancel)
  assert.equal(await currentValue('Body Decay'), 375)
  assert.equal(await forge().getAttribute('data-dirty'), 'true')
  assert.deepEqual(await pads().evaluateAll(items => items.map(item => item.dataset.sampleId)), dirtyCancelIds)
  pass('Cancelling generation from a dirty Base restores its usable silent preview and retains the unsaved edit')

  await selectPad(0); await holdOffline(); const beforeBadDirtyImport = await starts()
  await setKick('Body Decay', 380); await waitHeld()
  await importFile.setInputFiles({ name: 'bad-dirty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...portable, patch: { ...portable.patch, tone: null } })) })
  await releaseOffline(); await settled(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforeBadDirtyImport)
  assert.equal(await currentValue('Body Decay'), 380)
  assert.equal(await forge().getAttribute('data-dirty'), 'true')
  assert.ok(await page.locator('.forge-error').isVisible())
  pass('Rejected JSON import restores the previous dirty draft preview and reports its error without late playback')

  await holdOffline(); const beforeDirtyImport = await starts()
  await setKick('Body Decay', 390); await waitHeld()
  await importFile.setInputFiles({ name: 'restored.json', mimeType: 'application/json', buffer: Buffer.from(patchText) })
  await releaseOffline(); await settled(); await ready(); await page.waitForTimeout(80)
  assert.equal(await starts(), beforeDirtyImport)
  assert.equal(await currentValue('Body Decay'), 430)
  assert.equal(await name.inputValue(), 'Моя бочка')
  pass('Import cancels a pending dirty preview and adopts only its strictly validated re-rendered patch')

  await holdOffline()
  const copiesBeforeStaleImport = await page.locator('.forge-copies .forge-sample-pad').count()
  await importFile.setInputFiles({ name: 'delayed.json', mimeType: 'application/json', buffer: Buffer.from(patchText) }); await waitHeld()
  await selectPad(2); const selectedDuringImport = await selectedId()
  await releaseOffline(); await settled(); await ready()
  assert.equal(await selectedId(), selectedDuringImport)
  assert.equal(await page.locator('.forge-copies .forge-sample-pad').count(), copiesBeforeStaleImport)
  pass('Selection invalidates an obsolete import before its delayed native render can overwrite newer work')

  await page.getByRole('combobox', { name: 'Открыть Sample Bank', exact: true }).selectOption(originalBankId); await generated()
  await button('Библиотека ⌄').click()
  const otherBank = twoBanks.banks.find(value => value.id !== originalBankId)
  const otherRow = page.locator('.forge-bank-list > article').filter({ hasText: otherBank.name })
  acceptDialog = false; await otherRow.getByRole('button', { name: 'Удалить', exact: true }).click()
  assert.equal((await storageSnapshot()).banks.length, 2)
  acceptDialog = true; await otherRow.getByRole('button', { name: 'Удалить', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.forge-bank-list > article').length === 1)
  assert.equal((await storageSnapshot()).banks[0].id, originalBankId)
  pass('Deleting a saved bank requires confirmation and preserves the remaining library and current bank')

  await stop()

  const deniedContext = await session.browser.newContext({ viewport: { width: 1366, height: 768 } })
  const deniedPage = await deniedContext.newPage()
  deniedPage.setDefaultTimeout(10000)
  deniedPage.on('pageerror', error => errors.push(`Forge denied storage: ${error.message}`))
  deniedPage.on('console', message => { if (message.type() === 'error') errors.push(`Forge denied storage: ${message.text()}`) })
  try {
    await installStudioProbe(deniedPage)
    await deniedPage.addInitScript(() => {
      localStorage.setItem('sound-lab.workspace.v1', 'forge')
      const nativeOpen = indexedDB.open.bind(indexedDB)
      window.__forgeDbDenial = { denied: 0, allowed: [] }
      indexedDB.open = (name, ...args) => {
        if (name === 'sound-lab.sample-forge.v1') {
          ++window.__forgeDbDenial.denied
          throw new DOMException('IndexedDB недоступна для Sample Forge: тестовый отказ доступа.', 'SecurityError')
        }
        window.__forgeDbDenial.allowed.push(name)
        return nativeOpen(name, ...args)
      }
    })
    await deniedPage.goto(url)
    await deniedPage.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.renderStatus === 'ready')
    const deniedError = await deniedPage.locator('.forge-error').innerText()
    assert.match(deniedError, /IndexedDB.*Sample Forge/)
    assert.ok(Number(await deniedPage.locator('.forge-preview > .forge-waveform').getAttribute('data-pcm-frames')) > 14000)
    await deniedPage.waitForTimeout(250)
    assert.equal(await deniedPage.locator('.forge-error').innerText(), deniedError)
    const phraseUnchanged = await deniedPage.evaluate(async () => {
      const { savePhrase, listPhrases } = await import('/src/phrases/storage.ts')
      const phrase = { version: 1, id: 'independent-phrase-sentinel', name: 'Phrase DB still works', createdAt: 1700000000000, updatedAt: 1700000000000,
        duration: 0.1, bpm: 120, recordingMode: 'free', notes: [{ id: 'one', eventId: 'one', sourceId: 'native-test', sourceName: 'Native test', channel: 1, midi: 60, velocity: 90, start: 0, end: 0.1 }], sound: null }
      await savePhrase(phrase)
      return { phrase: (await listPhrases()).phrases.find(value => value.id === phrase.id), denial: window.__forgeDbDenial }
    })
    assert.equal(phraseUnchanged.phrase.name, 'Phrase DB still works')
    assert.ok(phraseUnchanged.denial.denied >= 1)
    assert.ok(phraseUnchanged.denial.allowed.includes('sound-lab.phrases.v1'))
    await deniedPage.getByRole('button', { name: 'Studio', exact: true }).click()
    await deniedPage.getByRole('button', { name: 'Включить тон Play', exact: true }).click()
    await deniedPage.waitForFunction(() => window.__studioProbe.measure().rms > 0.001)
    await deniedPage.getByRole('button', { name: 'Остановить тон Play', exact: true }).click()
    await deniedPage.screenshot({ path: `test-results/sample-forge-denied-storage-${browserName}.png`, fullPage: true })
    pass('Forge-only IndexedDB denial preserves its startup error after fallback PCM render and leaves native synth/Phrase storage usable', { error: deniedError, denied: phraseUnchanged.denial.denied })
  } finally { await deniedContext.close() }

  const corruptContext = await session.browser.newContext({ viewport: { width: 1366, height: 768 } })
  const corruptPage = await corruptContext.newPage()
  corruptPage.setDefaultTimeout(10000)
  corruptPage.on('pageerror', error => errors.push(`Forge corrupt storage: ${error.message}`))
  corruptPage.on('console', message => { if (message.type() === 'error') errors.push(`Forge corrupt storage: ${message.text()}`) })
  try {
    await corruptPage.goto(url)
    const corrupted = { id: 'corrupt-forge-sentinel', schemaVersion: 99, name: 'Keep the original corrupt record', payload: 'must remain untouched' }
    await corruptPage.evaluate(async value => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('sound-lab.sample-forge.v1', 1)
        request.onupgradeneeded = () => { request.result.createObjectStore('banks', { keyPath: 'id' }); request.result.createObjectStore('metadata', { keyPath: 'id' }); request.result.createObjectStore('draft') }
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['metadata', 'banks'], 'readwrite')
          tx.objectStore('metadata').put(value); tx.objectStore('banks').put(value)
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error)
        })
      } finally { db.close() }
    }, corrupted)
    await corruptPage.getByRole('button', { name: 'Sample Forge', exact: true }).click()
    await corruptPage.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.renderStatus === 'ready')
    const corruptWarning = await corruptPage.locator('.forge-error').innerText()
    assert.match(corruptWarning, /Пропущено повреждённых записей: 1/)
    assert.match(corruptWarning, /не удалены/)
    assert.ok(Number(await corruptPage.locator('.forge-preview > .forge-waveform').getAttribute('data-pcm-frames')) > 14000)
    assert.equal(await corruptPage.locator('.forge-grid-panel > .forge-sample-grid > .forge-sample-pad').count(), 0)
    await corruptPage.waitForTimeout(250)
    assert.equal(await corruptPage.locator('.forge-error').innerText(), corruptWarning)
    await corruptPage.reload()
    await corruptPage.waitForFunction(() => document.querySelector('.sample-forge')?.dataset.renderStatus === 'ready')
    assert.equal(await corruptPage.locator('.forge-error').innerText(), corruptWarning)
    const preserved = await corruptPage.evaluate(async id => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('sound-lab.sample-forge.v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(['metadata', 'banks'], 'readonly'), metadata = tx.objectStore('metadata').get(id), bank = tx.objectStore('banks').get(id)
          tx.oncomplete = () => resolve({ metadata: metadata.result, bank: bank.result }); tx.onabort = () => reject(tx.error)
        })
      } finally { db.close() }
    }, corrupted.id)
    assert.deepEqual(preserved, { metadata: corrupted, bank: corrupted })
    await corruptPage.screenshot({ path: `test-results/sample-forge-corrupt-storage-${browserName}.png`, fullPage: true })
    pass('Corrupt Forge metadata warning survives fallback PCM and reload while raw metadata/bank records remain untouched', { warning: corruptWarning, preserved })
  } finally { await corruptContext.close() }

  assert.deepEqual(errors, [])
  pass('Complete Sample Forge UI flow produces no browser errors', { consoleErrors: errors, dialogs: dialogs.length })
  await mkdir('test-results', { recursive: true })
  await writeFile(`test-results/sample-forge-ui-${browserName}.json`, JSON.stringify({ browser: browserName, scenarios: results.length, results, consoleErrors: errors, dialogs }, null, 2))
  console.log(`PASS Sample Forge UI: ${results.length} scenarios (${browserName})`)
} catch (error) {
  await writeFile(`test-results/sample-forge-ui-${browserName}.json`, JSON.stringify({ browser: browserName, scenarios: results.length, results, consoleErrors: errors, dialogs, failure: error.stack ?? String(error) }, null, 2))
  await page.screenshot({ path: `test-results/sample-forge-ui-failure-${browserName}.png`, fullPage: true }).catch(() => {})
  throw error
} finally {
  await releaseOffline().catch(() => {})
  await context.close(); await session.close()
}
