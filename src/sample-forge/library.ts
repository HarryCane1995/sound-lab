import { canonicalKickPatch, kickPatchFingerprint, validateKickPatch } from './kickPatch'
import { amplitudeDbfs, type KickAudioMetrics } from './audio/features'
import { KICK_PEAK_CEILING, KICK_SAMPLE_RATE, type RenderedKick } from './audio/KickRenderer'
import { FORGE_SCHEMA_VERSION, VARIATION_COUNT, type ForgeSample, type SampleBank } from './model'
import { normalizeTags, validateGeneratorVersion, validateKickCharacter, validateSampleName } from './patchJson'

export { normalizeTags } from './patchJson'
export const SAMPLE_FORGE_DB = 'sound-lab.sample-forge.v1'
export const MAX_SAMPLE_BANKS = 100
export const MAX_BANK_COPIES = 32
export const MAX_BANK_BYTES = 32 * 1024 * 1024
export const MAX_SAMPLE_LIBRARY_BYTES = 256 * 1024 * 1024
const MAX_RENDER_FRAMES = KICK_SAMPLE_RATE * 2
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const timestamp = (value: unknown): value is number => finite(value, 0, 1e15) && Number.isInteger(value)
const uint32 = (value: unknown): value is number => finite(value, 0, 0xffffffff) && Number.isInteger(value)
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Недопустимый ID Sample Forge.')
  return value
}

export interface SampleBankSummary {
  schemaVersion: 1
  id: string
  name: string
  tags: string[]
  createdAt: number
  updatedAt: number
  generatorVersion: string
  intensity: 'medium'
  batchSeed: number
  sampleCount: number
  copyCount: number
  bytes: number
}

function validateSummary(value: unknown): SampleBankSummary {
  if (!record(value) || value.schemaVersion !== FORGE_SCHEMA_VERSION || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || value.updatedAt < value.createdAt || value.intensity !== 'medium' || !uint32(value.batchSeed) || value.sampleCount !== VARIATION_COUNT
    || !finite(value.copyCount, 0, MAX_BANK_COPIES) || !Number.isInteger(value.copyCount) || !finite(value.bytes, 1, MAX_BANK_BYTES)) throw new Error('Повреждены сведения о банке Sample Forge.')
  return { schemaVersion: 1, id: identity(value.id), name: validateSampleName(value.name), tags: normalizeTags(value.tags),
    createdAt: value.createdAt, updatedAt: value.updatedAt, generatorVersion: validateGeneratorVersion(value.generatorVersion),
    intensity: 'medium', batchSeed: value.batchSeed, sampleCount: VARIATION_COUNT, copyCount: value.copyCount, bytes: value.bytes }
}

/** Validate actual PCM and every WAV sample, not just a trusted metric/fingerprint. */
export function validateRenderedKick(value: unknown, expectedPatch?: unknown): RenderedKick {
  if (!record(value) || value.sampleRate !== KICK_SAMPLE_RATE || !(value.pcm instanceof Float32Array)
    || value.pcm.length < 2 || value.pcm.length > MAX_RENDER_FRAMES || !(value.wav instanceof Uint8Array) || !record(value.metrics)) throw new Error('Повреждён отрендеренный Kick.')
  const patch = validateKickPatch(value.patch)
  if (value.fingerprint !== kickPatchFingerprint(patch) || (expectedPatch !== undefined && canonicalKickPatch(patch) !== canonicalKickPatch(validateKickPatch(expectedPatch)))) {
    throw new Error('Patch и WAV не соответствуют друг другу. Выполните Re-render и Save Changes.')
  }
  const pcm = value.pcm, wav = value.wav, metric = value.metrics
  const size = pcm.length * 3
  if (wav.length !== 44 + size + (size & 1)) throw new Error('Повреждена длина WAV.')
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (offset: number, text: string) => [...text].every((character, index) => view.getUint8(offset + index) === character.charCodeAt(0))
  if (!ascii(0, 'RIFF') || view.getUint32(4, true) !== wav.length - 8 || !ascii(8, 'WAVE') || !ascii(12, 'fmt ')
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== KICK_SAMPLE_RATE
    || view.getUint32(28, true) !== KICK_SAMPLE_RATE * 3 || view.getUint16(32, true) !== 3 || view.getUint16(34, true) !== 24
    || !ascii(36, 'data') || view.getUint32(40, true) !== size || ((size & 1) && wav[wav.length - 1] !== 0)) throw new Error('Требуется WAV: mono / 48000 Hz / signed PCM 24-bit.')
  let peak = 0, power = 0, sum = 0
  for (let index = 0; index < pcm.length; ++index) {
    const sample = pcm[index]
    if (!Number.isFinite(sample) || Math.abs(sample) > KICK_PEAK_CEILING + 1e-6) throw new Error('PCM содержит NaN, Infinity или недопустимые пики.')
    peak = Math.max(peak, Math.abs(sample)); power += sample * sample; sum += sample
    const encoded = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff), offset = 44 + index * 3
    if (wav[offset] !== (encoded & 255) || wav[offset + 1] !== ((encoded >> 8) & 255) || wav[offset + 2] !== ((encoded >> 16) & 255)) throw new Error('WAV не соответствует сохранённому PCM.')
  }
  const rms = Math.sqrt(power / pcm.length), dcOffset = sum / pcm.length, duration = pcm.length / KICK_SAMPLE_RATE
  const near = (actual: unknown, expected: number, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
  if (pcm[0] !== 0 || pcm[pcm.length - 1] !== 0 || Math.abs(dcOffset) > 1e-4 || metric.frames !== pcm.length
    || !near(metric.duration, duration, 1e-10) || !near(metric.peak, peak) || !near(metric.rms, rms) || !near(metric.dcOffset, dcOffset)
    || !near(metric.peakDbfs, amplitudeDbfs(peak), 1e-4) || !near(metric.rmsDbfs, amplitudeDbfs(rms), 1e-4)
    || !finite(metric.attenuationDb, -1000, 0) || !finite(metric.spectralCentroidHz, 0, KICK_SAMPLE_RATE / 2) || !finite(metric.lowBandRatio, 0, 1)) throw new Error('Повреждены аудиометрики или границы Kick.')
  const metrics: KickAudioMetrics = { peak, peakDbfs: amplitudeDbfs(peak), rms, rmsDbfs: amplitudeDbfs(rms), dcOffset, duration, frames: pcm.length,
    attenuationDb: metric.attenuationDb, spectralCentroidHz: metric.spectralCentroidHz, lowBandRatio: metric.lowBandRatio }
  return { patch, pcm: new Float32Array(pcm), wav: new Uint8Array(wav), sampleRate: KICK_SAMPLE_RATE, metrics, fingerprint: value.fingerprint as string }
}

function validateSample(value: unknown): ForgeSample {
  if (!record(value) || typeof value.favorite !== 'boolean' || !uint32(value.seed) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) throw new Error('Повреждены настройки сэмпла.')
  const patch = validateKickPatch(value.patch)
  return { id: identity(value.id), name: validateSampleName(value.name), character: validateKickCharacter(value.character), tags: normalizeTags(value.tags), favorite: value.favorite,
    seed: value.seed, generatedPatch: validateKickPatch(value.generatedPatch), patch, render: validateRenderedKick(value.render, patch), createdAt: value.createdAt, updatedAt: value.updatedAt }
}

export function sampleBankBytes(bank: SampleBank): number {
  const samples = [bank.base, ...bank.samples, ...bank.copies]
  const metadata = JSON.stringify({ ...bank, base: undefined, samples: undefined, copies: undefined, records: samples.map(sample => ({ ...sample, render: { ...sample.render, pcm: undefined, wav: undefined } })) })
  return new TextEncoder().encode(metadata).length + samples.reduce((sum, sample) => sum + sample.render.pcm.byteLength + sample.render.wav.byteLength, 0)
}

/** No recovery clamping: corrupted records remain untouched and can be diagnosed. */
export function validateSampleBank(value: unknown): SampleBank {
  if (!record(value) || value.schemaVersion !== FORGE_SCHEMA_VERSION || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || value.intensity !== 'medium' || !uint32(value.batchSeed) || !Array.isArray(value.samples) || value.samples.length !== VARIATION_COUNT
    || !Array.isArray(value.copies) || value.copies.length > MAX_BANK_COPIES) throw new Error('Неподдерживаемый или повреждённый банк Sample Forge.')
  const bank: SampleBank = { schemaVersion: 1, id: identity(value.id), name: validateSampleName(value.name), tags: normalizeTags(value.tags),
    createdAt: value.createdAt, updatedAt: value.updatedAt, generatorVersion: validateGeneratorVersion(value.generatorVersion), intensity: 'medium', batchSeed: value.batchSeed,
    base: validateSample(value.base), samples: value.samples.map(validateSample), copies: value.copies.map(validateSample) }
  const ids = [bank.base, ...bank.samples, ...bank.copies].map(sample => sample.id)
  if (new Set(ids).size !== ids.length) throw new Error('В банке повторяются ID сэмплов.')
  if (sampleBankBytes(bank) > MAX_BANK_BYTES) throw new Error('Банк превышает 32 MiB. Удалите лишние копии после резервного экспорта.')
  return bank
}

function bankSummary(bank: SampleBank): SampleBankSummary {
  return { schemaVersion: 1, id: bank.id, name: bank.name, tags: [...bank.tags], createdAt: bank.createdAt, updatedAt: bank.updatedAt,
    generatorVersion: bank.generatorVersion, intensity: bank.intensity, batchSeed: bank.batchSeed, sampleCount: bank.samples.length, copyCount: bank.copies.length, bytes: sampleBankBytes(bank) }
}

let connection: Promise<IDBDatabase> | null = null
function database(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false
    const request = indexedDB.open(SAMPLE_FORGE_DB, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('banks', { keyPath: 'id' }); request.result.createObjectStore('metadata', { keyPath: 'id' }); request.result.createObjectStore('draft') }
    request.onerror = () => { failed = true; reject(new Error('Sample Forge: IndexedDB недоступна. Проверьте разрешения и свободное место.')) }
    request.onblocked = () => { failed = true; reject(new Error('Sample Forge: хранилище занято другой вкладкой. Закройте старую вкладку и повторите.')) }
    request.onsuccess = () => {
      const db = request.result
      if (failed) { db.close(); return }
      db.onversionchange = () => { db.close(); connection = null }
      resolve(db)
    }
  }).catch(error => { connection = null; throw error })
  return connection
}

function storageError(error: DOMException | null | undefined, reason = ''): Error {
  return new Error(reason || (error?.name === 'QuotaExceededError'
    ? 'Недостаточно места для Sample Bank. Экспортируйте ZIP, освободите место и повторите. Существующие банки сохранены.'
    : 'Не удалось записать Sample Forge: проверьте доступ к IndexedDB и свободное место. Существующие банки сохранены.'))
}

export async function listSampleBanks(): Promise<{ banks: SampleBankSummary[]; skipped: number }> {
  const db = await database()
  const raw = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction('metadata', 'readonly'), request = tx.objectStore('metadata').getAll()
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(storageError(tx.error ?? request.error))
  })
  const banks: SampleBankSummary[] = []; let skipped = 0
  for (const value of raw) { try { banks.push(validateSummary(value)) } catch { ++skipped } }
  return { banks: banks.sort((first, second) => second.createdAt - first.createdAt || second.updatedAt - first.updatedAt), skipped }
}

export async function loadSampleBank(id: string): Promise<SampleBank | null> {
  identity(id)
  const db = await database()
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction('banks', 'readonly'), request = tx.objectStore('banks').get(id)
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(storageError(tx.error ?? request.error))
  })
  return value === undefined ? null : validateSampleBank(value)
}

/** Both metadata and all patch/PCM/WAV pairs commit or abort together. */
export async function saveSampleBank(value: SampleBank): Promise<void> {
  const bank = validateSampleBank(value), summary = bankSummary(bank), db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['banks', 'metadata'], 'readwrite'), metadata = tx.objectStore('metadata'), request = metadata.getAll()
    let reason = ''
    request.onsuccess = () => {
      const existing = request.result as unknown[]
      if (!existing.some(item => record(item) && item.id === bank.id) && existing.length >= MAX_SAMPLE_BANKS) {
        reason = `Лимит Sample Forge: ${MAX_SAMPLE_BANKS} банков. Экспортируйте ZIP и удалите ненужные.`; tx.abort(); return
      }
      let total = summary.bytes
      for (const item of existing) {
        if (record(item) && item.id !== bank.id) {
          // Corrupt summaries cannot make the conservative library budget smaller.
          try { total += validateSummary(item).bytes } catch { total += MAX_BANK_BYTES }
        }
      }
      if (total > MAX_SAMPLE_LIBRARY_BYTES) { reason = 'Локальная библиотека Sample Forge превышает 256 MiB. Экспортируйте ZIP и освободите место.'; tx.abort(); return }
      try { tx.objectStore('banks').put(bank); metadata.put(summary) }
      catch (error) {
        reason = error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'Недостаточно места для Sample Bank. Экспортируйте ZIP, освободите место и повторите. Существующие банки сохранены.'
          : 'Не удалось записать Sample Bank. Существующие банки сохранены.'
        tx.abort()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(storageError(tx.error ?? request.error, reason))
  })
}

export async function deleteSampleBank(id: string): Promise<void> {
  identity(id)
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['banks', 'metadata'], 'readwrite')
    tx.objectStore('banks').delete(id); tx.objectStore('metadata').delete(id)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(storageError(tx.error))
  })
}

/** Explicitly saved standalone Base; unrelated Phrase Recorder draft is untouched. */
export async function saveWorkingBase(value: ForgeSample): Promise<void> {
  const sample = validateSample(value), db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('draft', 'readwrite')
    let reason = ''
    try { tx.objectStore('draft').put(sample, 'base') }
    catch (error) {
      reason = error instanceof DOMException && error.name === 'QuotaExceededError'
        ? 'Недостаточно места для Base Kick. Экспортируйте Patch JSON и освободите место.' : 'Не удалось сохранить Base Kick.'
      tx.abort()
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(storageError(tx.error, reason))
  })
}

export async function loadWorkingBase(): Promise<ForgeSample | null> {
  const db = await database()
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction('draft', 'readonly'), request = tx.objectStore('draft').get('base')
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(storageError(tx.error ?? request.error))
  })
  return value === undefined ? null : validateSample(value)
}
