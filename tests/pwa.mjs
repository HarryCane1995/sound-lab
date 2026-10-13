import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chooseWorkspace, initializeTestWorkspace, launchTestBrowser, testBrowserName } from './helpers.mjs'

// This serves the actual production output, never Vite's HMR server. Two copies
// append harmless JS/HTML markers to the real bundle, change the JS content URL,
// and update the real Workbox manifest. Source files/dist remain untouched.
const base = '/sound-lab/'
const origin = 'http://127.0.0.1:4173'
const url = `${origin}${base}`
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const results = [], errors = [], badResponses = []
const temporary = await mkdtemp(path.join(tmpdir(), 'sound-lab-pwa-'))
let browser, context, migrationContext, primaryServer, migrationServer
let version = 'a'
const pass = (name, metrics = {}) => { results.push({ name, metrics }); console.log(`PASS ${name}`, JSON.stringify(metrics)) }
const fixtureDirectories = {}

async function prepareFixture(label) {
  const directory = path.join(temporary, label)
  await cp('dist', directory, { recursive: true })
  const filename = path.join(directory, 'index.html')
  const originalHtml = await readFile(filename, 'utf8')
  const script = originalHtml.match(/src="([^"]+\.js)"/)
  assert.ok(script?.[1].startsWith(base), 'Production JS is rooted in /sound-lab/')
  const originalAsset = script[1].slice(base.length)
  const payload = `${await readFile(path.join(directory, originalAsset), 'utf8')}\n;globalThis.__soundLabPwaFixture = ${JSON.stringify(label)};\n`
  const asset = `assets/pwa-fixture-${label}-${createHash('sha256').update(payload).digest('hex').slice(0, 12)}.js`
  await writeFile(path.join(directory, asset), payload)
  const html = originalHtml.replace(script[1], `${base}${asset}`).replace('</head>', `<meta name="sound-lab-pwa-fixture" content="${label}"></head>`)
  await writeFile(filename, html)
  const revision = createHash('md5').update(html).digest('hex')
  const workerFile = path.join(directory, 'sw.js')
  let replaced = 0, replacedAsset = 0
  const worker = (await readFile(workerFile, 'utf8')).replace(/\{[^{}]+\}/g, entry => {
    let next = entry
    if (/["']?url["']?\s*:\s*["'](?:\.\/|\/sound-lab\/)?index\.html["']/.test(entry)) {
      next = next.replace(/(["']?revision["']?\s*:\s*["'])[^"']+(["'])/, (_match, prefix, suffix) => `${prefix}${revision}${suffix}`)
      if (next !== entry) replaced++
    }
    next = next.replace(/(["']?url["']?\s*:\s*["'])([^"']+)(["'])/, (match, prefix, source, suffix) => {
      if (source !== originalAsset) return match
      replacedAsset++
      return `${prefix}${asset}${suffix}`
    })
    return next
  })
  assert.equal(replaced, 1, 'The actual generated worker must precache index.html with a revision')
  assert.equal(replacedAsset, 1, 'The actual generated worker must precache the newly named JS payload')
  await writeFile(workerFile, `${worker}\n// PWA production fixture ${label}\n`)
  fixtureDirectories[label] = directory
  return { revision, asset, directory }
}

async function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname)
      if (!pathname.startsWith(base)) { response.writeHead(404).end('Outside the production base'); return }
      const relative = pathname.slice(base.length) || 'index.html'
      const root = fixtureDirectories[version]
      const file = path.resolve(root, relative)
      if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return }
      const bytes = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': base })
      response.end(bytes)
    } catch { response.writeHead(404).end('Not found') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}

function observe(page) {
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }) })
}

async function initialize(testContext) {
  // Preserve the complete 0.6 educational/PWA regression path. GPU/Studio
  // offline assertions explicitly switch workspaces later in this suite.
  await initializeTestWorkspace(testContext, 'learn')
  await testContext.addInitScript(() => {
    const scenario = sessionStorage.getItem('sound-lab.pwa-midi-scenario') ?? 'ready'
    class Port extends EventTarget {
      constructor() { super(); this.id = 'pwa-midi'; this.name = 'PWA Test Keyboard'; this.type = 'input'; this.state = 'connected'; this.connection = 'closed'; this.manufacturer = 'Simulated' }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map(scenario === 'empty' ? [] : [[port.id, port]])
    access.outputs = new Map(); access.sysexEnabled = false
    window.__pwaMidi = { requests: [], send(raw) { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(raw) }); port.dispatchEvent(event) } }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: scenario === 'unsupported' ? undefined : async options => {
      window.__pwaMidi.requests.push(options)
      if (scenario === 'denied') throw new DOMException('PWA test permission denial', 'NotAllowedError')
      return access
    } })
    // Only MIDI hardware is simulated. All RMS/FFT samples below are read from
    // the real application's native, production-bundled Web Audio graph.
    window.__pwaAudio = { contexts: [], analysers: [] }
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
      const audio = Reflect.construct(Target, args)
      window.__pwaAudio.contexts.push(audio)
      const createAnalyser = audio.createAnalyser.bind(audio)
      audio.createAnalyser = (...parameters) => { const node = createAnalyser(...parameters); window.__pwaAudio.analysers.push(node); return node }
      return audio
    } })
    window.__pwaMeasure = () => {
      const audio = window.__pwaAudio.contexts.findLast(item => item.state !== 'closed')
      const analyser = window.__pwaAudio.analysers.find(item => item.context === audio)
      if (!analyser) return { rms: 0, peak: 0, state: audio?.state ?? 'uninitialized', bands: [] }
      const time = new Float32Array(analyser.fftSize), spectrum = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatTimeDomainData(time); analyser.getFloatFrequencyData(spectrum)
      const bin = audio.sampleRate / analyser.fftSize
      return { rms: Math.sqrt(time.reduce((sum, sample) => sum + sample * sample, 0) / time.length), peak: Math.max(...time.map(Math.abs)), state: audio.state,
        bands: [220, 440, 660].map(frequency => Math.max(...spectrum.slice(Math.max(0, Math.round(frequency / bin) - 2), Math.round(frequency / bin) + 3))) }
    }
  })
}

const readStore = (page, store) => page.evaluate(store => new Promise((resolve, reject) => {
  const request = indexedDB.open('sound-lab.phrases.v1', 1)
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result, tx = db.transaction(store, 'readonly')
    const read = store === 'draft' ? tx.objectStore(store).get('current') : tx.objectStore(store).getAll()
    tx.oncomplete = () => { resolve(read.result ?? null); db.close() }; tx.onerror = () => { reject(tx.error); db.close() }
  }
}), store)
const localData = page => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])))
const fixture = page => page.locator('meta[name="sound-lab-pwa-fixture"]').getAttribute('content')
const recorder = page => page.getByRole('region', { name: 'Phrase Recorder', exact: true })
const transport = (page, name) => recorder(page).getByRole('button', { name, exact: true })
const status = (page, value) => page.waitForFunction(value => document.querySelector('.phrase-status')?.textContent === value, value)
const midi = (page, raw) => page.evaluate(raw => window.__pwaMidi.send(raw), raw)
const waitSound = (page, audible) => page.waitForFunction(audible => audible ? window.__pwaMeasure().rms > .001 : window.__pwaMeasure().rms < .00001, audible, { polling: 25, timeout: 5000 })
async function connect(page) {
  assert.equal(await page.evaluate(() => window.__pwaMidi.requests.length), 0, 'MIDI must never be requested on mount')
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.locator('.midi-status-ready').waitFor()
  assert.deepEqual(await page.evaluate(() => window.__pwaMidi.requests), [{ sysex: false }])
}
async function download(page, name) {
  const pending = page.waitForEvent('download')
  await recorder(page).getByRole('button', { name, exact: true }).click()
  const item = await pending
  return { filename: item.suggestedFilename(), data: await readFile(await item.path()) }
}
async function importLibrary(page, envelope) {
  page.once('dialog', dialog => dialog.accept())
  await recorder(page).getByLabel('Import phrase library JSON', { exact: true }).setInputFiles({ name: 'sound-lab-library.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
  await page.waitForFunction(() => document.querySelector('input[aria-label="Import phrase library JSON"]').value === '')
}

async function offlineGpu(page) {
  assert.equal(await page.evaluate(() => navigator.onLine), false)
  const personalKeys = ['sound-lab.midi.v1', 'sound-lab.harmonics.v1', 'sound-lab.harmonic-patch.v1']
  const before = await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), personalKeys)
  await chooseWorkspace(page, 'studio')
  await page.locator('.gpu-canvas').waitFor()
  await page.getByRole('button', { name: 'Waveform 3D', exact: true }).click()
  await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitSound(page, true)
  await page.waitForFunction(() => {
    const value = document.querySelector('.gpu-canvas')?.gpuDiagnostics?.()
    return value && value.webgl2 && value.drawCalls > 0 && value.rms > .001 && value.newestWavePeak > .001 && value.analysisReads > 0
  }, null, { timeout: 10000 })
  const waveform = await page.locator('.gpu-canvas').evaluate(element => element.gpuDiagnostics())
  await page.getByRole('button', { name: 'Spectral Landscape', exact: true }).click()
  await page.waitForFunction(() => {
    const value = document.querySelector('.gpu-canvas')?.gpuDiagnostics?.()
    return value && value.mode === 'spectrum' && value.newestSpectrumPeak > -75
  })
  const spectrum = await page.locator('.gpu-canvas').evaluate(element => element.gpuDiagnostics())
  await page.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitSound(page, false)
  await chooseWorkspace(page, 'learn')
  assert.deepEqual(await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), personalKeys), before, 'Offline GPU work must preserve MIDI settings and saved harmonic data')
  return { waveform, spectrum }
}

// Read only native production IndexedDB; no development modules or controller
// shortcuts. SHA-256 covers every stored PCM/WAV byte across a real SW update.
async function readForgeSnapshot(page) {
  return page.evaluate(async () => {
    const stored = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sound-lab.sample-forge.v1', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['banks', 'metadata', 'draft'], 'readonly')
        const banks = tx.objectStore('banks').getAll(), metadata = tx.objectStore('metadata').getAll(), draft = tx.objectStore('draft').get('base')
        tx.oncomplete = () => { resolve({ banks: banks.result, metadata: metadata.result, draft: draft.result ?? null }); db.close() }
        tx.onabort = () => { reject(tx.error); db.close() }
      }
    })
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    const sample = async value => ({ ...value, render: { ...value.render, pcm: undefined, wav: undefined,
      pcmFrames: value.render.pcm.length, pcmSha256: await hash(value.render.pcm), wavBytes: value.render.wav.length, wavSha256: await hash(value.render.wav) } })
    return { banks: await Promise.all(stored.banks.sort((a, b) => a.id.localeCompare(b.id)).map(async bank => ({ ...bank,
      base: await sample(bank.base), samples: await Promise.all(bank.samples.map(sample)), copies: await Promise.all(bank.copies.map(sample)) }))),
    metadata: stored.metadata.sort((a, b) => a.id.localeCompare(b.id)), draft: stored.draft ? await sample(stored.draft) : null }
  })
}

function inspectForgeZip(bytes, savedBank) {
  // Independent standard ZIP local-record reader and bitwise CRC32. The data
  // suite separately exercises Python zipfile/wave; here the actual offline UI
  // download must contain byte-identical saved WAVs and their editable patches.
  const files = new Map()
  let cursor = 0
  const crc32 = data => {
    let value = 0xffffffff
    for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; ++bit) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0) }
    return (value ^ 0xffffffff) >>> 0
  }
  while (cursor + 30 <= bytes.length && bytes.readUInt32LE(cursor) === 0x04034b50) {
    const flags = bytes.readUInt16LE(cursor + 6), method = bytes.readUInt16LE(cursor + 8), checksum = bytes.readUInt32LE(cursor + 14)
    const packed = bytes.readUInt32LE(cursor + 18), unpacked = bytes.readUInt32LE(cursor + 22), nameBytes = bytes.readUInt16LE(cursor + 26), extraBytes = bytes.readUInt16LE(cursor + 28)
    assert.equal(method, 0); assert.equal(flags, 0x800); assert.equal(packed, unpacked)
    const name = bytes.toString('utf8', cursor + 30, cursor + 30 + nameBytes), from = cursor + 30 + nameBytes + extraBytes
    assert.ok(from + packed <= bytes.length); assert.ok(!files.has(name)); assert.ok(!name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\'))
    const data = bytes.subarray(from, from + packed)
    assert.equal(crc32(data), checksum); files.set(name, data); cursor = from + packed
  }
  assert.equal(files.size, 34); assert.equal(bytes.readUInt32LE(cursor), 0x02014b50)
  const eocd = bytes.length - 22
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50); assert.equal(bytes.readUInt16LE(eocd + 10), 34); assert.equal(bytes.readUInt32LE(eocd + 16), cursor)
  const manifestPath = [...files.keys()].find(name => name.endsWith('/manifest.json')), folder = manifestPath.slice(0, -'manifest.json'.length)
  const manifest = JSON.parse(files.get(manifestPath).toString('utf8'))
  assert.equal(manifest.format, 'sound-lab.sample-pack'); assert.equal(manifest.version, 1); assert.equal(manifest.soundLabVersion, appVersion)
  assert.equal(manifest.name, savedBank.name); assert.equal(manifest.bankId, savedBank.id); assert.equal(manifest.generatorVersion, savedBank.generatorVersion)
  assert.equal(manifest.batchSeed, savedBank.batchSeed); assert.equal(manifest.intensity, 'medium'); assert.equal(manifest.variationCount, 16); assert.equal(manifest.exportedSampleCount, 16)
  assert.deepEqual(manifest.basePatch, savedBank.base.patch); assert.deepEqual(new Set(manifest.files.map(name => folder + name)), new Set(files.keys()))
  assert.deepEqual(manifest.wavFormat, { container: 'RIFF/WAVE', encoding: 'signed PCM', bitsPerSample: 24, channels: 1, sampleRate: 48000 })
  assert.match(files.get(`${folder}README.txt`).toString('utf8'), /ready-to-use audio samples/)
  for (const item of manifest.samples) {
    const saved = savedBank.samples.find(sample => sample.id === item.id)
    assert.ok(saved); assert.equal(item.name, saved.name); assert.deepEqual(item.tags, saved.tags); assert.equal(item.favorite, saved.favorite)
    assert.equal(item.fingerprint, saved.render.fingerprint); assert.equal(item.frames, saved.render.pcmFrames); assert.equal(item.duration, saved.render.metrics.duration)
    const wav = files.get(`${folder}${item.wav}`), patch = JSON.parse(files.get(`${folder}${item.patch}`).toString('utf8'))
    assert.equal(createHash('sha256').update(wav).digest('hex'), saved.render.wavSha256)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE'); assert.equal(wav.readUInt32LE(4), wav.length - 8)
    assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 48000); assert.equal(wav.readUInt16LE(34), 24)
    assert.equal(wav.readUInt32LE(40), saved.render.pcmFrames * 3); assert.equal(wav.length, saved.render.wavBytes)
    assert.equal(patch.format, 'sound-lab.kick-patch'); assert.equal(patch.version, 1); assert.deepEqual(patch.patch, saved.patch); assert.deepEqual(patch.generatedPatch, saved.generatedPatch)
    assert.equal(patch.name, saved.name); assert.deepEqual(patch.tags, saved.tags)
  }
  return { bytes: bytes.length, files: files.size, wav: manifest.samples.length, patches: manifest.samples.length, verifiedSavedWavHashes: manifest.samples.length }
}

const forge = page => page.getByRole('region', { name: 'Sample Forge', exact: true })
async function downloadForgeZip(page, savedBank) {
  const pending = page.waitForEvent('download')
  await forge(page).getByRole('button', { name: /^Export ZIP/, exact: false }).click()
  const downloaded = await pending
  assert.match(downloaded.suggestedFilename(), /^SOUND_LAB_KICK_PACK_[a-zA-Z0-9_-]+\.zip$/)
  const bytes = await readFile(await downloaded.path())
  await forge(page).locator('.forge-progress').waitFor({ state: 'hidden' })
  return inspectForgeZip(bytes, savedBank)
}

async function playOfflineKick(page, savedBank) {
  const selected = savedBank.samples[6]
  await forge(page).getByRole('button', { name: `Выбрать ${selected.name}`, exact: true }).click()
  const graph = forge(page).getByRole('region', { name: 'Waveform Preview', exact: true }).locator('svg.forge-waveform')
  assert.equal(await graph.getAttribute('data-pcm-fingerprint'), selected.render.fingerprint)
  assert.equal(Number(await graph.getAttribute('data-pcm-frames')), selected.render.pcmFrames)
  assert.ok((await graph.locator('.forge-wave-peaks').getAttribute('d')).length > 1000, 'Main waveform displays actual non-empty PCM profile')
  assert.ok((await graph.locator('.forge-wave-envelope').getAttribute('d')).length > 1000, 'Actual windowed RMS envelope accompanies PCM')
  const contexts = await page.evaluate(() => window.__pwaAudio.contexts.length)
  await forge(page).getByRole('button', { name: '▶ Selected Kick · B', exact: true }).click(); await waitSound(page, true)
  const audio = await page.evaluate(() => window.__pwaMeasure())
  assert.equal(audio.state, 'running'); assert.ok(audio.peak > .001 && audio.peak < 1)
  await forge(page).getByRole('button', { name: '■ Stop Preview', exact: true }).click(); await waitSound(page, false)
  assert.equal(await page.evaluate(() => window.__pwaAudio.contexts.length), contexts, 'Offline one-shot preview shares the already initialized synth context')
  return audio
}

async function createOfflineForgeBank(page) {
  assert.equal(await page.evaluate(() => navigator.onLine), false)
  const personalKeys = ['sound-lab.midi.v1', 'sound-lab.harmonics.v1', 'sound-lab.harmonic-patch.v1']
  const before = await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), personalKeys)
  await chooseWorkspace(page, 'forge')
  await forge(page).getByLabel('Generation Seed', { exact: true }).fill('424242')
  await forge(page).locator('.forge-batch-actions').getByRole('button', { name: 'GENERATE 16 VARIATIONS', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sample-forge .forge-sample-pad').length === 16, null, { timeout: 30000 })
  await forge(page).locator('.forge-progress').waitFor({ state: 'hidden' })
  await forge(page).getByRole('button', { name: 'Выбрать Kick_07', exact: true }).click()
  await forge(page).getByLabel('Название Kick', { exact: true }).fill('Offline Kick_07')
  await forge(page).getByLabel('Название Kick', { exact: true }).press('Enter')
  await forge(page).getByLabel('Новый тег Kick', { exact: true }).fill('Offline')
  await forge(page).getByLabel('Новый тег Kick', { exact: true }).press('Enter')
  await forge(page).getByRole('button', { name: 'Избранное выбранного Kick', exact: true }).click()
  await forge(page).getByLabel('Название Sample Bank', { exact: true }).fill('Offline Forge Bank 0.8')
  await forge(page).getByLabel('Название Sample Bank', { exact: true }).press('Enter')
  await forge(page).getByRole('button', { name: /^Save Bank/, exact: false }).click()
  await page.waitForFunction(() => document.querySelector('.sample-forge')?.getAttribute('data-bank-dirty') === 'false' && !document.querySelector('.sample-forge .forge-progress'))
  const snapshot = await readForgeSnapshot(page)
  assert.equal(snapshot.banks.length, 1); assert.equal(snapshot.banks[0].samples.length, 16); assert.equal(snapshot.banks[0].copies.length, 0)
  assert.equal(snapshot.banks[0].batchSeed, 424242); assert.equal(snapshot.banks[0].name, 'Offline Forge Bank 0.8')
  assert.equal(snapshot.banks[0].samples[6].name, 'Offline Kick_07'); assert.ok(snapshot.banks[0].samples[6].tags.includes('Offline')); assert.equal(snapshot.banks[0].samples[6].favorite, true)
  assert.ok(snapshot.banks[0].samples.every(sample => sample.render.pcmFrames > 1000 && sample.render.wavBytes > 3000 && sample.render.sampleRate === 48000))
  pass('Offline production Sample Forge generates sixteen native kicks and atomically saves real PCM/WAV patches, names, tags and favorites', { bankId: snapshot.banks[0].id, samples: 16, seed: 424242 })
  const audio = await playOfflineKick(page, snapshot.banks[0])
  assert.deepEqual(await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), personalKeys), before, 'Offline Sample Forge preserves MIDI/Harmonic settings')
  pass('Offline production Sample Forge renders saved PCM/RMS waveforms and previews native audio through the shared synth context', audio)
  const exported = await downloadForgeZip(page, snapshot.banks[0])
  pass('Offline production ZIP download contains sixteen exact saved WAV files, sixteen editable patches, valid CRC32 manifest and README', exported)
  await chooseWorkspace(page, 'learn')
  return snapshot
}

try {
  await mkdir('test-results', { recursive: true })
  const buildA = await prepareFixture('a'), buildB = await prepareFixture('b')
  assert.notEqual(buildA.revision, buildB.revision)
  assert.notEqual(buildA.asset, buildB.asset)
  primaryServer = await serve(4173)
  migrationServer = await serve(0)
  const migrationOrigin = `http://127.0.0.1:${migrationServer.address().port}`
  browser = await launchTestBrowser()
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'allow' })
  await initialize(context)
  let page = await context.newPage(); observe(page)
  await page.goto(url); await page.locator('h1').waitFor()
  assert.equal(await fixture(page), 'a')
  assert.equal(await page.evaluate(() => globalThis.__soundLabPwaFixture), 'a')
  const appPanel = () => page.getByRole('complementary', { name: 'Приложение SOUND LAB', exact: true })
  assert.ok((await appPanel().innerText()).includes(`SOUND LAB ${appVersion}`))
  await appPanel().locator('summary').click()
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifestUrl = new URL(manifestHref, url)
  assert.equal(manifestUrl.origin, origin); assert.ok(manifestUrl.pathname.startsWith(base))
  const manifestResponse = await fetch(manifestUrl); assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  assert.equal(manifest.name, 'SOUND LAB'); assert.equal(manifest.short_name, 'SOUND LAB')
  assert.equal(manifest.display, 'standalone')
  for (const field of ['id', 'start_url', 'scope']) assert.equal(new URL(manifest[field], manifestUrl).pathname, base, `${field} remains within repository subdirectory`)
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i); assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i)
  const dimensions = []
  for (const icon of manifest.icons) {
    const iconUrl = new URL(icon.src, manifestUrl)
    assert.equal(iconUrl.origin, origin); assert.ok(iconUrl.pathname.startsWith(base)); assert.equal(icon.type, 'image/png')
    const response = await fetch(iconUrl); assert.equal(response.status, 200)
    const png = Buffer.from(await response.arrayBuffer())
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    assert.equal(`${width}x${height}`, icon.sizes); dimensions.push({ width, height, purpose: icon.purpose ?? 'any' })
  }
  assert.ok(dimensions.some(icon => icon.width === 192 && icon.height === 192))
  assert.ok(dimensions.some(icon => icon.width === 512 && icon.height === 512))
  assert.ok(dimensions.some(icon => icon.purpose.split(' ').includes('maskable')))
  const cdp = await context.newCDPSession(page)
  const browserManifest = await cdp.send('Page.getAppManifest')
  assert.deepEqual(browserManifest.errors, []); assert.equal(new URL(browserManifest.url).pathname, manifestUrl.pathname)
  await cdp.detach()
  pass('Production subdirectory, browser-accepted standalone manifest, identity, dark colors and real PNG icon dimensions', { manifest: manifestUrl.pathname, icons: dimensions })

  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))
  assert.ok(resources.some(resource => /\/sound-lab\/assets\/.*\.js/.test(resource)))
  assert.ok(resources.some(resource => /\/sound-lab\/assets\/.*\.css/.test(resource)))
  assert.ok(resources.every(resource => new URL(resource).origin === origin), 'No mandatory third-party/CDN resources')
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const registration = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, worker: r.active.scriptURL } })
  assert.deepEqual(registration, { scope: url, worker: `${url}sw.js` })
  await appPanel().locator('.pwa-status').getByText(/^(?:Онлайн|Без сети) · Готово к работе офлайн$/).waitFor()
  assert.equal(badResponses.length, 0)
  assert.match(await appPanel().innerText(), /Chrome|Edge/)
  assert.match(await page.locator('body').innerText(), /Музыкальные записи хранятся локально на этом устройстве, а не в GitHub/)
  pass('All production assets are local and load; actual service worker controls /sound-lab/ and advertises offline readiness', registration)

  await connect(page)
  await page.getByRole('button', { name: 'MIDI Learn: Amplitude · Громкость', exact: true }).click()
  await midi(page, [0xb0, 74, 100])
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sound-lab.midi.v1') ?? '{}').bindings?.length === 1)
  const learned = JSON.parse((await localData(page))['sound-lab.midi.v1'])
  assert.equal(learned.bindings[0].target, 'amplitude'); assert.equal(learned.bindings[0].number, 74)
  await page.getByRole('button', { name: 'Additive Synthesis', exact: true }).click()
  await page.getByRole('slider', { name: 'Гармоника H2', exact: true }).fill('50')
  await page.getByRole('spinbutton', { name: 'Частота, значение', exact: true }).fill('220')
  await page.getByRole('spinbutton', { name: 'Частота, значение', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Сохранить патч', exact: true }).click()
  await page.waitForFunction(() => Boolean(localStorage.getItem('sound-lab.harmonic-patch.v1')))
  pass('Production MIDI permission is gesture-only without SysEx; real MIDI Learn and harmonic patch persist')

  await context.setOffline(true)
  await page.reload(); await page.locator('h1').waitFor()
  assert.equal(await fixture(page), 'a')
  assert.equal(await page.evaluate(() => navigator.onLine), false)
  await page.goto(`${url}offline-fallback?test=1#main`); await page.locator('h1').waitFor()
  assert.equal(await fixture(page), 'a')
  await page.goto(url); await page.locator('h1').waitFor()
  await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitSound(page, true)
  await page.waitForTimeout(600)
  const audioMetrics = await page.evaluate(() => window.__pwaMeasure())
  assert.equal(audioMetrics.state, 'running'); assert.ok(audioMetrics.peak > .001 && audioMetrics.peak < 1)
  assert.ok(audioMetrics.bands[0] > -60 && audioMetrics.bands[1] > -70, 'Offline native FFT includes H1=220Hz and H2=440Hz')
  assert.ok(audioMetrics.bands[2] < audioMetrics.bands[1] - 20, 'Disabled H3 remains substantially quieter than H2')
  await page.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitSound(page, false)
  assert.equal(await page.getByRole('button', { name: 'Additive Synthesis', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('slider', { name: 'Гармоника H2', exact: true }).inputValue(), '50')
  pass('Real offline cold reload runs the production synthesizer, native Web Audio and preserved additive settings', audioMetrics)
  pass('Offline production Studio loads every GPU resource and renders actual PCM and FFT without a CDN', await offlineGpu(page))
  const forgeBaseline = await createOfflineForgeBank(page)

  await connect(page)
  await transport(page, 'Record phrase').click(); await status(page, 'Запись')
  await midi(page, [0x90, 60, 41]); await midi(page, [0x90, 64, 103]); await page.waitForTimeout(160)
  await midi(page, [0x80, 60, 0]); await page.waitForTimeout(110); await midi(page, [0x80, 64, 0])
  await transport(page, 'Stop phrase').click(); await status(page, 'Остановлено')
  await recorder(page).getByLabel('Название фразы', { exact: true }).fill('Офлайн-идея 0.6')
  await transport(page, 'Save phrase').click()
  await transport(page, 'Открыть фразу: Офлайн-идея 0.6').waitFor()
  const recorded = (await readStore(page, 'phrases'))[0]
  assert.equal(recorded.notes.length, 2); assert.deepEqual(recorded.notes.map(note => note.velocity), [41, 103])
  assert.ok(recorded.notes[0].start < recorded.notes[1].end && recorded.notes[1].start < recorded.notes[0].end)
  assert.equal(recorded.sound.mode, 'additive'); assert.equal(recorded.sound.additive.levels[1], 50)
  assert.equal(await recorder(page).locator('.phrase-roll-note').count(), 2)
  await recorder(page).getByLabel('Loop', { exact: true }).check()
  await transport(page, 'Play phrase').click(); await status(page, 'Воспроизведение'); await waitSound(page, true)
  await page.waitForTimeout(recorded.duration * 1000 + 100); await status(page, 'Воспроизведение')
  await transport(page, 'Stop phrase').click(); await status(page, 'Остановлено'); await waitSound(page, false)
  await recorder(page).getByLabel('Loop', { exact: true }).uncheck()
  pass('Offline Phrase Recorder records real-time polyphonic MIDI/velocity, saves snapshots and plays Loop through existing audio', { notes: recorded.notes.length, duration: recorded.duration })

  const libraryDownload = await download(page, 'Export phrase library JSON')
  const backup = JSON.parse(libraryDownload.data.toString('utf8'))
  assert.equal(backup.format, 'sound-lab.library'); assert.equal(backup.version, 1)
  assert.deepEqual(backup.phrases[0], recorded); assert.ok(backup.draft)
  await page.close()
  page = await context.newPage(); observe(page)
  await page.goto(url); await page.locator('h1').waitFor()
  await transport(page, 'Открыть фразу: Офлайн-идея 0.6').waitFor()
  assert.deepEqual(await readStore(page, 'phrases'), [recorded])
  assert.equal(await recorder(page).locator('.phrase-roll-note').count(), 2)
  pass('Closing the tab and opening a new offline page preserves IndexedDB library, draft and downloadable full-library JSON', { backupBytes: libraryDownload.data.length })

  // A different port is a genuinely different origin. Its IndexedDB initially
  // has no old phrases: only the explicit JSON transfer can restore them.
  migrationContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'allow' })
  await initialize(migrationContext)
  const migratedPage = await migrationContext.newPage(); observe(migratedPage)
  await migratedPage.goto(`${migrationOrigin}${base}`); await migratedPage.locator('h1').waitFor()
  assert.equal((await readStore(migratedPage, 'phrases')).length, 0)
  await importLibrary(migratedPage, backup)
  await transport(migratedPage, 'Открыть фразу: Офлайн-идея 0.6').waitFor()
  const restored = (await readStore(migratedPage, 'phrases'))[0]
  assert.notEqual(restored.id, recorded.id); assert.deepEqual(restored.notes, recorded.notes); assert.deepEqual(restored.sound, recorded.sound)
  await importLibrary(migratedPage, backup)
  await migratedPage.waitForFunction(() => document.querySelectorAll('.phrase-list>li').length === 2)
  const duplicates = await readStore(migratedPage, 'phrases')
  assert.equal(new Set(duplicates.map(phrase => phrase.id)).size, 2)
  const beforeInvalid = await readStore(migratedPage, 'phrases')
  await importLibrary(migratedPage, { ...backup, phrases: [...backup.phrases, { ...backup.phrases[0], notes: [{ ...backup.phrases[0].notes[0], midi: 999 }] }] })
  await recorder(migratedPage).getByRole('alert').waitFor()
  assert.deepEqual(await readStore(migratedPage, 'phrases'), beforeInvalid, 'Invalid library import must be atomic')
  await migratedPage.reload(); await migratedPage.locator('h1').waitFor()
  assert.deepEqual(await readStore(migratedPage, 'phrases'), beforeInvalid)
  await migrationContext.close(); migrationContext = null
  pass('Explicit JSON backup migrates to another origin with regenerated IDs, append-only import and atomic malformed-data rejection')

  await context.setOffline(false)
  await connect(page)
  await appPanel().locator('summary').click()
  // Keep a second client on the old HTML with a real unsaved name edit. A
  // controllerchange caused by another client must never reload it silently.
  const second = await context.newPage(); observe(second)
  await second.goto(url); await second.locator('h1').waitFor()
  await transport(second, 'Открыть фразу: Офлайн-идея 0.6').waitFor()
  await recorder(second).getByLabel('Название фразы', { exact: true }).fill('Несохранённое имя во второй вкладке')
  assert.equal(await fixture(second), 'a')

  page.once('dialog', dialog => dialog.accept())
  await transport(page, 'Record phrase').click(); await status(page, 'Запись')
  await midi(page, [0x90, 67, 88]); await page.waitForTimeout(80)
  version = 'b'
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update() })
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))
  const update = appPanel().getByRole('button', { name: 'Обновить сейчас', exact: true })
  await update.waitFor(); assert.equal(await update.isDisabled(), true)
  await page.waitForTimeout(150); assert.equal(await fixture(page), 'a'); await status(page, 'Запись')
  await midi(page, [0x80, 67, 0]); await transport(page, 'Stop phrase').click(); await status(page, 'Остановлено')
  assert.equal(await update.isDisabled(), true, 'Unsaved take blocks update after recording stops')
  await recorder(page).getByLabel('Название фразы', { exact: true }).fill('Перед обновлением')
  await transport(page, 'Save phrase').click(); await transport(page, 'Открыть фразу: Перед обновлением').waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  pass('A genuine newer service worker waits; active recording and its unsaved take prevent activation/reload')

  await recorder(page).getByLabel('Loop', { exact: true }).check()
  await transport(page, 'Play phrase').click(); await status(page, 'Воспроизведение')
  assert.equal(await update.isDisabled(), true); assert.equal(await fixture(page), 'a')
  await transport(page, 'Pause phrase').click(); await status(page, 'Пауза'); assert.equal(await update.isDisabled(), true)
  await transport(page, 'Stop phrase').click(); await status(page, 'Остановлено'); await waitSound(page, false)
  await recorder(page).getByLabel('Loop', { exact: true }).uncheck()
  await recorder(page).getByLabel('Название фразы', { exact: true }).fill('Пока не сохранено')
  assert.equal(await update.isDisabled(), true)
  await recorder(page).getByLabel('Название фразы', { exact: true }).fill('Перед обновлением')
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  await appPanel().getByRole('button', { name: 'Позже', exact: true }).click()
  assert.equal(await fixture(page), 'a')
  await appPanel().getByRole('button', { name: 'Проверить обновления', exact: true }).click()
  await update.waitFor()
  pass('Playback, paused transport and unsaved name edits block updates; Later keeps old code and explicit check restores the offer')

  await chooseWorkspace(page, 'forge')
  const autoPreviewControl = forge(page).getByRole('checkbox', { name: 'Прослушивать изменения Kick', exact: true })
  const autoPreviewBefore = await autoPreviewControl.isChecked()
  await autoPreviewControl.uncheck()
  await forge(page).getByRole('button', { name: 'Выбрать Kick_01', exact: true }).click()
  const kickPitchDecay = forge(page).getByRole('spinbutton', { name: 'Kick Pitch Decay, значение', exact: true })
  await kickPitchDecay.fill('40'); await kickPitchDecay.press('Enter')
  await page.waitForFunction(() => document.querySelector('.sample-forge')?.getAttribute('data-dirty') === 'true')
  assert.equal(await update.isDisabled(), true, 'An unsaved Kick patch blocks a waiting native PWA update')
  await page.waitForFunction(() => document.querySelector('.sample-forge')?.getAttribute('data-render-status') === 'ready')
  await forge(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.sample-forge')?.getAttribute('data-dirty') === 'false' && document.querySelector('.sample-forge')?.getAttribute('data-render-status') === 'ready')
  await forge(page).getByRole('button', { name: '■ Stop Preview', exact: true }).click(); await waitSound(page, false)
  if (autoPreviewBefore) await autoPreviewControl.check()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  assert.deepEqual(await readForgeSnapshot(page), forgeBaseline, 'Undo releases the update guard without overwriting any committed Kick audio')
  await chooseWorkspace(page, 'learn')
  pass('A real unsaved Sample Forge patch blocks native PWA activation; Undo restores its exact original and releases the guard without rewriting saved PCM/WAV')

  const beforeRename = { phrases: await readStore(page, 'phrases'), draft: await readStore(page, 'draft') }
  await transport(page, 'Duplicate phrase: Перед обновлением').click()
  const renameCopy = 'Перед обновлением · копия'
  await transport(page, `Rename phrase: ${renameCopy}`).click()
  await recorder(page).getByLabel(`Новое название: ${renameCopy}`, { exact: true }).fill('Незавершённое переименование')
  assert.equal(await update.isDisabled(), true, 'An unfinished row rename blocks a waiting update')
  page.once('dialog', dialog => dialog.accept())
  await transport(page, `Delete phrase: ${renameCopy}`).click()
  await transport(page, `Delete phrase: ${renameCopy}`).waitFor({ state: 'hidden' })
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  assert.equal(await recorder(page).getByLabel(`Новое название: ${renameCopy}`, { exact: true }).count(), 0)
  assert.deepEqual(await readStore(page, 'phrases'), beforeRename.phrases)
  assert.deepEqual(await readStore(page, 'draft'), beforeRename.draft)
  pass('Deleting a row during its unfinished rename releases the waiting-update guard and preserves other phrases/draft')

  // Slow only the native File.text result, not React state or the update guard.
  // This models a file still being read and verifies that no reload can cut it
  // off. Cancelling the eventual confirmation leaves all data unchanged.
  await page.evaluate(() => {
    const native = File.prototype.text
    File.prototype.text = function (...args) {
      if (this.name !== 'delayed-library.json') return native.apply(this, args)
      return new Promise((resolve, reject) => { window.__pwaFinishLibraryRead = () => native.apply(this, args).then(resolve, reject) })
    }
    window.__pwaRestoreFileText = () => { File.prototype.text = native }
  })
  await recorder(page).getByLabel('Import phrase library JSON', { exact: true }).setInputFiles({ name: 'delayed-library.json', mimeType: 'application/json', buffer: libraryDownload.data })
  await page.waitForFunction(() => typeof window.__pwaFinishLibraryRead === 'function')
  assert.equal(await update.isDisabled(), true); assert.equal(await transport(page, 'Record phrase').isDisabled(), true)
  assert.equal(await fixture(page), 'a')
  page.once('dialog', dialog => dialog.dismiss())
  await page.evaluate(() => { window.__pwaFinishLibraryRead(); window.__pwaRestoreFileText() })
  await page.waitForFunction(() => document.querySelector('input[aria-label="Import phrase library JSON"]').value === '')
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  const exporting = page.waitForEvent('download')
  await transport(page, 'Export phrase library JSON').click(); await exporting
  assert.equal(await update.isDisabled(), true, 'Export owns a data-operation guard until native download preparation completes')
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  pass('Pending native JSON file read and library export block updates; a new recording cannot race an import')

  const stoppedDraft = await readStore(page, 'draft')
  await page.evaluate(() => {
    const prototype = IDBTransaction.prototype, native = Object.getOwnPropertyDescriptor(prototype, 'oncomplete')
    let armed = true
    Object.defineProperty(prototype, 'oncomplete', { configurable: true, get: native.get, set(handler) {
      if (armed && this.mode === 'readonly' && this.objectStoreNames.contains('phrases')) {
        armed = false
        native.set.call(this, function (event) { window.__pwaDeliverExportRead = () => handler.call(this, event) })
      } else native.set.call(this, handler)
    } })
    window.__pwaRestoreExportRead = () => Object.defineProperty(prototype, 'oncomplete', native)
  })
  const racingDownload = page.waitForEvent('download')
  await transport(page, 'Export phrase library JSON').click()
  await page.waitForFunction(() => typeof window.__pwaDeliverExportRead === 'function')
  assert.equal(await transport(page, 'Record phrase').isDisabled(), false, 'A library read/export must not prevent capturing the next idea')
  page.once('dialog', dialog => dialog.accept())
  await transport(page, 'Record phrase').click(); await status(page, 'Запись')
  await midi(page, [0x90, 72, 75]); await page.waitForTimeout(80)
  await page.evaluate(() => { window.__pwaRestoreExportRead(); window.__pwaDeliverExportRead() })
  const racingFile = await racingDownload
  const racingBackup = JSON.parse(await readFile(await racingFile.path(), 'utf8'))
  assert.deepEqual(racingBackup.draft, stoppedDraft, 'Export freezes the stopped draft before its first asynchronous read; a new partial take cannot replace it')
  await midi(page, [0x80, 72, 0]); await transport(page, 'Stop phrase').click(); await status(page, 'Остановлено')
  await recorder(page).getByLabel('Название фразы', { exact: true }).fill('Экспорт без гонки')
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Save phrase"]').disabled)
  await transport(page, 'Save phrase').click(); await transport(page, 'Открыть фразу: Экспорт без гонки').waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Обновить сейчас')?.disabled)
  pass('An actual delayed IndexedDB export keeps the stopped draft while a new MIDI take starts; the next take remains independently saveable')

  if (await page.getByRole('switch', { name: 'Bypass', exact: true }).getAttribute('aria-checked') === 'true') await page.getByRole('switch', { name: 'Bypass', exact: true }).click()
  if (await page.getByRole('switch', { name: 'LFO', exact: true }).getAttribute('aria-checked') === 'false') await page.getByRole('switch', { name: 'LFO', exact: true }).click()
  const retainedParameters = { 'Частота': 330, 'Амплитуда': 37, 'Нарастание': .21, 'Спад': .42, 'Удержание': 63, 'Затухание': .17, 'Частота среза': 2400, 'Резонанс': .8, 'Скорость': 3.7, 'Глубина': 31 }
  for (const [name, value] of Object.entries(retainedParameters)) {
    const input = page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
    await input.fill(String(value)); await input.press('Enter')
  }
  await page.getByRole('group', { name: 'Цель LFO', exact: true }).getByRole('button', { name: 'Срез Filter Cutoff', exact: true }).click()

  const beforeUpdate = { phrases: await readStore(page, 'phrases'), draft: await readStore(page, 'draft'), local: await localData(page), forge: await readForgeSnapshot(page) }
  assert.deepEqual(beforeUpdate.forge, forgeBaseline, 'Legacy phrase flows must preserve the complete saved Sample Forge bank')
  const cacheSentinels = await page.evaluate(async () => {
    const scope = (await navigator.serviceWorker.ready).scope
    const obsolete = `workbox-precache-v0-${scope}`
    await (await caches.open(obsolete)).put(`${scope}obsolete-test`, new Response('obsolete'))
    await (await caches.open('sound-lab-unrelated-test')).put(`${scope}unrelated-test`, new Response('preserve'))
    return { obsolete, unrelated: 'sound-lab-unrelated-test' }
  })
  await update.click()
  await page.waitForFunction(() => document.querySelector('meta[name="sound-lab-pwa-fixture"]')?.content === 'b' && globalThis.__soundLabPwaFixture === 'b')
  await page.locator('h1').waitFor()
  await transport(page, 'Открыть фразу: Перед обновлением').waitFor()
  assert.deepEqual(await readStore(page, 'phrases'), beforeUpdate.phrases)
  assert.deepEqual(await readStore(page, 'draft'), beforeUpdate.draft)
  const afterLocal = await localData(page)
  for (const key of ['sound-lab.midi.v1', 'sound-lab.harmonics.v1', 'sound-lab.harmonic-patch.v1']) assert.equal(afterLocal[key], beforeUpdate.local[key], `${key} survives activation`)
  assert.equal(JSON.parse(afterLocal['sound-lab.midi.v1']).bindings[0].number, 74)
  for (const [name, value] of Object.entries(retainedParameters)) assert.equal(Number(await page.getByRole('spinbutton', { name: `${name}, значение`, exact: true }).inputValue()), value, `${name} survives the confirmed update`)
  assert.equal(await page.getByRole('switch', { name: 'Bypass', exact: true }).getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByRole('switch', { name: 'LFO', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await page.getByRole('group', { name: 'Цель LFO', exact: true }).getByRole('button', { name: 'Срез Filter Cutoff', exact: true }).getAttribute('aria-pressed'), 'true')
  const cacheNames = await page.evaluate(() => caches.keys())
  assert.ok(!cacheNames.includes(cacheSentinels.obsolete)); assert.ok(cacheNames.includes(cacheSentinels.unrelated))
  assert.equal(await fixture(second), 'a'); assert.equal(await recorder(second).getByLabel('Название фразы', { exact: true }).inputValue(), 'Несохранённое имя во второй вкладке')
  assert.equal(await second.evaluate(() => globalThis.__soundLabPwaFixture), 'a')
  pass('Confirmed native worker activation loads new production HTML, preserves phrase/draft/MIDI/harmonic data and cleans only obsolete Workbox caches')
  pass('A new hashed production JS payload executes and preserves non-default amplitude, ADSR, filter and LFO values', { from: buildA.asset, to: buildB.asset, retainedParameters })
  pass('Another client never reloads an old open page or destroys its unsaved edit on controllerchange')
  assert.deepEqual(await readForgeSnapshot(page), beforeUpdate.forge)
  pass('Confirmed native PWA update preserves every Sample Forge bank patch, generated original, tag, favorite and exact PCM/WAV byte hash', { banks: beforeUpdate.forge.banks.length, wavHashes: beforeUpdate.forge.banks[0].samples.length + 1 })

  await second.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready
    return navigator.serviceWorker.controller === registration.active && !registration.waiting
  })
  assert.equal(await second.evaluate(() => window.__pwaAudio.contexts.length), 0, 'The old open client has never initialized audio before the newer worker takes over')
  assert.equal(await second.evaluate(async asset => Boolean(await caches.match(new URL(asset, (await navigator.serviceWorker.ready).scope).href)), buildA.asset), false, 'Activation has removed the old client bundle from the actual precache')
  assert.equal(Number(await second.getByRole('spinbutton', { name: 'Частота, значение', exact: true }).inputValue()), 220)
  assert.equal(await second.getByRole('button', { name: 'Additive Synthesis', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await second.getByRole('slider', { name: 'Гармоника H2', exact: true }).inputValue(), '50')
  await context.setOffline(true)
  await second.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitSound(second, true)
  await second.waitForTimeout(600)
  const oldClientAudio = await second.evaluate(() => window.__pwaMeasure())
  assert.equal(oldClientAudio.state, 'running'); assert.ok(oldClientAudio.peak > .001 && oldClientAudio.peak < 1)
  assert.ok(oldClientAudio.bands[0] > -60 && oldClientAudio.bands[1] > -70, 'The old bundle initializes real offline audio with its 220Hz and 440Hz components after the new worker cleans caches')
  assert.ok(oldClientAudio.bands[2] < oldClientAudio.bands[1] - 20)
  await second.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitSound(second, false)
  const oldClientSilence = await second.evaluate(() => window.__pwaMeasure())
  assert.ok(oldClientSilence.rms < .00001)
  assert.equal(await second.evaluate(() => globalThis.__soundLabPwaFixture), 'a')
  assert.equal(await recorder(second).getByLabel('Название фразы', { exact: true }).inputValue(), 'Несохранённое имя во второй вкладке')
  pass('An old open bundle initializes native audio for the first time offline after a new worker activates and removes its old precache', { audible: oldClientAudio, stoppedRms: oldClientSilence.rms })
  await second.close()

  await context.setOffline(true)
  await page.reload(); await page.locator('h1').waitFor()
  assert.equal(await fixture(page), 'b')
  assert.equal(await page.evaluate(() => globalThis.__soundLabPwaFixture), 'b')
  assert.deepEqual(await readStore(page, 'phrases'), beforeUpdate.phrases)
  pass('Updated production version and all saved phrases cold-reload offline after activation')
  pass('Updated production Studio cold-reloads its complete WebGL2 module and real audio visualizations offline', await offlineGpu(page))
  assert.deepEqual(await readForgeSnapshot(page), beforeUpdate.forge)
  await chooseWorkspace(page, 'forge')
  await page.waitForFunction(() => document.querySelectorAll('.sample-forge .forge-sample-pad').length === 16)
  const updatedKickAudio = await playOfflineKick(page, beforeUpdate.forge.banks[0])
  const updatedKickZip = await downloadForgeZip(page, beforeUpdate.forge.banks[0])
  assert.deepEqual(await readForgeSnapshot(page), beforeUpdate.forge)
  await chooseWorkspace(page, 'learn')
  pass('Updated production Sample Forge cold-reloads offline, restores the editable sixteen-kick bank, plays PCM and exports the same saved WAV/JSON pairs', { audio: updatedKickAudio, zip: updatedKickZip })

  await context.setOffline(false)
  for (const scenario of ['unsupported', 'denied', 'empty']) {
    await page.evaluate(scenario => sessionStorage.setItem('sound-lab.pwa-midi-scenario', scenario), scenario)
    await page.reload(); await page.locator('h1').waitFor()
    assert.equal(await page.evaluate(() => window.__pwaMidi.requests.length), 0)
    await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
    const expected = scenario === 'unsupported' ? /Web MIDI недоступен/ : scenario === 'denied' ? /разрешени|запрет|доступ.*MIDI/i : /Устройство.*отключено или недоступно/
    await page.getByRole('region', { name: 'MIDI Controller', exact: true }).getByText(expected).waitFor()
    if (scenario === 'empty') assert.equal(await page.getByLabel('MIDI-вход', { exact: true }).isDisabled(), true)
    if (scenario !== 'unsupported') assert.deepEqual(await page.evaluate(() => window.__pwaMidi.requests), [{ sysex: false }])
    await page.getByRole('button', { name: 'Включить тон Play', exact: true }).click(); await waitSound(page, true)
    await page.getByRole('button', { name: 'Остановить тон Play', exact: true }).click(); await waitSound(page, false)
    assert.equal((await readStore(page, 'phrases')).length, beforeUpdate.phrases.length)
  }
  pass('Unsupported Web MIDI, rejected permission and empty devices leave production audio and saved phrases usable')

  await page.screenshot({ path: `test-results/pwa-${testBrowserName()}.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Production PWA UI must fit a 390px viewport')
  await page.screenshot({ path: `test-results/pwa-mobile-${testBrowserName()}.png`, fullPage: true })
  pass('Production PWA installation/update and phrase-backup panels fit a mobile viewport')
  assert.deepEqual(badResponses, []); assert.deepEqual(errors, [])
  pass('Production, offline, update and denied-MIDI flows emit no page/console errors or HTTP failures')
  console.log(`PWA: ${results.length} scenarios passed (${testBrowserName()})`)
} finally {
  await writeFile(`test-results/pwa-${testBrowserName()}.json`, JSON.stringify({ results, errors, badResponses }, null, 2))
  await migrationContext?.close()
  await context?.close()
  await browser?.close()
  await Promise.all([primaryServer, migrationServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))))
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()))
  assert.ok(path.basename(temporary).startsWith('sound-lab-pwa-'))
  await rm(temporary, { recursive: true, force: true })
}
