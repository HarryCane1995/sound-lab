import { MAX_BANK_BYTES, validateSampleBank } from './library'
import { exportPatchJson } from './patchJson'
import type { ForgeSample, SampleBank } from './model'

export interface SamplePackProgress { completed: number; total: number; percent: number }
export interface SamplePackOptions {
  sampleIds?: string[]
  signal?: AbortSignal
  onProgress?: (progress: SamplePackProgress) => void
}
export interface SamplePackManifest {
  format: 'sound-lab.sample-pack'
  version: 1
  bankId: string
  name: string
  instrument: 'kick'
  createdAt: number
  exportedAt: number
  soundLabVersion: string
  generatorVersion: string
  batchSeed: number
  intensity: 'medium'
  variationCount: 16
  exportedSampleCount: number
  basePatch: SampleBank['base']['patch']
  tags: string[]
  wavFormat: { container: 'RIFF/WAVE'; encoding: 'signed PCM'; bitsPerSample: 24; channels: 1; sampleRate: 48000 }
  files: string[]
  samples: {
    id: string; name: string; character: ForgeSample['character']; tags: string[]; favorite: boolean; seed: number; generatedSeed: number
    duration: number; frames: number; peakDbfs: number; rmsDbfs: number; fingerprint: string; wav: string; patch: string
  }[]
}
export interface SamplePackResult { bytes: Uint8Array<ArrayBuffer>; filename: string; manifest: SamplePackManifest }
export interface ZipEntry { path: string; data: Uint8Array; modifiedAt?: number }

const textEncoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; ++bit) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Экспорт Sample Pack отменён.', 'AbortError') }

/** Portable ASCII name; metadata retains the user's original Unicode title. */
export function safePackFilename(name: string): string {
  const safe = name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 60)
  return safe.startsWith('SOUND_LAB_KICK_PACK_') ? safe : `SOUND_LAB_KICK_PACK_${safe || 'Bank'}`
}

function dosTimestamp(timestamp = 0): { time: number; date: number } {
  const original = new Date(timestamp), year = Math.min(2107, Math.max(1980, original.getUTCFullYear()))
  return { time: (original.getUTCHours() << 11) | (original.getUTCMinutes() << 5) | Math.floor(original.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((original.getUTCMonth() + 1) << 5) | original.getUTCDate() }
}

async function crc32(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
  let crc = 0xffffffff
  for (let start = 0; start < bytes.length; start += 262144) {
    checkCancelled(signal)
    const end = Math.min(bytes.length, start + 262144)
    for (let index = start; index < end; ++index) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8)
    if (end < bytes.length) await yieldTask()
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** PKWARE APPNOTE 6.3.10: STORE, per-file CRC32, UTF-8 flag, central directory.
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * Small bounded packs intentionally need no compression, ZIP64, or CDN code. */
export async function createStoredZip(entries: ZipEntry[], options: Omit<SamplePackOptions, 'sampleIds'> = {}): Promise<Uint8Array<ArrayBuffer>> {
  checkCancelled(options.signal)
  if (!entries.length || entries.length > 128) throw new Error('Недопустимое число файлов ZIP.')
  const used = new Set<string>()
  const records: { entry: ZipEntry; name: Uint8Array; crc: number; offset: number; timestamp: { time: number; date: number } }[] = []
  let localSize = 0, centralSize = 0
  options.onProgress?.({ completed: 0, total: entries.length, percent: 0 })
  for (let index = 0; index < entries.length; ++index) {
    checkCancelled(options.signal)
    const entry = entries[index], key = entry.path.toLocaleLowerCase('en-US'), name = textEncoder.encode(entry.path)
    if (name.length > 250 || entry.path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/u.test(part)) || used.has(key)
      || !(entry.data instanceof Uint8Array)) throw new Error('Недопустимый или повторяющийся путь внутри ZIP.')
    used.add(key)
    const crc = await crc32(entry.data, options.signal)
    records.push({ entry, name, crc, offset: localSize, timestamp: dosTimestamp(entry.modifiedAt) })
    localSize += 30 + name.length + entry.data.length
    centralSize += 46 + name.length
    if (localSize + centralSize + 22 > MAX_BANK_BYTES) throw new Error('Sample Pack превышает 32 MiB.')
    options.onProgress?.({ completed: index + 1, total: entries.length, percent: Math.round((index + 1) / entries.length * 95) })
    await yieldTask()
  }
  checkCancelled(options.signal)
  const output = new Uint8Array(localSize + centralSize + 22), view = new DataView(output.buffer)
  let cursor = 0
  for (const { entry, name, crc, timestamp } of records) {
    checkCancelled(options.signal)
    view.setUint32(cursor, 0x04034b50, true); view.setUint16(cursor + 4, 20, true); view.setUint16(cursor + 6, 0x0800, true)
    view.setUint16(cursor + 8, 0, true); view.setUint16(cursor + 10, timestamp.time, true); view.setUint16(cursor + 12, timestamp.date, true)
    view.setUint32(cursor + 14, crc, true); view.setUint32(cursor + 18, entry.data.length, true); view.setUint32(cursor + 22, entry.data.length, true)
    view.setUint16(cursor + 26, name.length, true); view.setUint16(cursor + 28, 0, true)
    output.set(name, cursor + 30); output.set(entry.data, cursor + 30 + name.length)
    cursor += 30 + name.length + entry.data.length
  }
  for (const { entry, name, crc, offset, timestamp } of records) {
    view.setUint32(cursor, 0x02014b50, true); view.setUint16(cursor + 4, 20, true); view.setUint16(cursor + 6, 20, true)
    view.setUint16(cursor + 8, 0x0800, true); view.setUint16(cursor + 10, 0, true); view.setUint16(cursor + 12, timestamp.time, true); view.setUint16(cursor + 14, timestamp.date, true)
    view.setUint32(cursor + 16, crc, true); view.setUint32(cursor + 20, entry.data.length, true); view.setUint32(cursor + 24, entry.data.length, true)
    view.setUint16(cursor + 28, name.length, true); view.setUint32(cursor + 42, offset, true)
    output.set(name, cursor + 46); cursor += 46 + name.length
  }
  view.setUint32(cursor, 0x06054b50, true); view.setUint16(cursor + 8, entries.length, true); view.setUint16(cursor + 10, entries.length, true)
  view.setUint32(cursor + 12, centralSize, true); view.setUint32(cursor + 16, localSize, true)
  checkCancelled(options.signal)
  options.onProgress?.({ completed: entries.length, total: entries.length, percent: 100 })
  checkCancelled(options.signal)
  return output
}

export async function exportSamplePack(value: SampleBank, options: SamplePackOptions = {}): Promise<SamplePackResult> {
  checkCancelled(options.signal)
  // Snapshot and validate before the first await. UI edits cannot change a pack
  // that is already being assembled, or mismatch its committed WAV/patch pair.
  const bank = validateSampleBank(value), all = [bank.base, ...bank.samples, ...bank.copies]
  const wanted = options.sampleIds === undefined ? bank.samples.map(sample => sample.id) : [...options.sampleIds]
  if (!wanted.length || wanted.length > all.length || new Set(wanted).size !== wanted.length) throw new Error('Выберите хотя бы один уникальный Kick для экспорта.')
  const selected = wanted.map(id => { const sample = all.find(candidate => candidate.id === id); if (!sample) throw new Error('Выбранный Kick отсутствует в банке.'); return sample })
  const folder = safePackFilename(bank.name)
  const itemPaths = selected.map(sample => {
    const generatedIndex = bank.samples.findIndex(candidate => candidate.id === sample.id), copyIndex = bank.copies.findIndex(candidate => candidate.id === sample.id)
    const stem = generatedIndex >= 0 ? `Kick_${String(generatedIndex + 1).padStart(2, '0')}` : copyIndex >= 0 ? `Kick_Copy_${String(copyIndex + 1).padStart(2, '0')}` : 'Base_Kick'
    return { sample, wav: `WAV/${stem}.wav`, patch: `PATCHES/${stem}.json` }
  })
  const manifest: SamplePackManifest = {
    format: 'sound-lab.sample-pack', version: 1, bankId: bank.id, name: bank.name, instrument: 'kick', createdAt: bank.createdAt, exportedAt: Date.now(),
    soundLabVersion: __APP_VERSION__, generatorVersion: bank.generatorVersion, batchSeed: bank.batchSeed, intensity: 'medium', variationCount: 16,
    exportedSampleCount: selected.length, basePatch: { ...bank.base.patch }, tags: [...bank.tags],
    wavFormat: { container: 'RIFF/WAVE', encoding: 'signed PCM', bitsPerSample: 24, channels: 1, sampleRate: 48000 },
    files: ['manifest.json', 'README.txt', ...itemPaths.flatMap(item => [item.wav, item.patch])],
    samples: itemPaths.map(({ sample, wav, patch }) => ({ id: sample.id, name: sample.name, character: sample.character, tags: [...sample.tags], favorite: sample.favorite, seed: sample.patch.seed, generatedSeed: sample.generatedPatch.seed,
      duration: sample.render.metrics.duration, frames: sample.render.metrics.frames, peakDbfs: sample.render.metrics.peakDbfs, rmsDbfs: sample.render.metrics.rmsDbfs,
      fingerprint: sample.render.fingerprint, wav, patch })),
  }
  const readme = `SOUND LAB ${__APP_VERSION__} — SAMPLE FORGE / KICK LAB\r\n\r\nBank: ${bank.name}\r\nInstrument: synthetic Kick\r\nGenerator: ${bank.generatorVersion}\r\nBatch Seed: ${bank.batchSeed}\r\nIntensity: Medium\r\nExported samples: ${selected.length}\r\n\r\nWAV files are ready-to-use audio samples: mono, 48000 Hz, signed 24-bit PCM.\r\nPATCHES/*.json contains editable synthesis parameters, original generated parameters, metadata and reproducible noise seeds.\r\nTo restore a patch, open SAMPLE FORGE in SOUND LAB, choose Import Patch JSON, select the JSON, then Re-render and Save Changes.\r\nThe exact committed PCM used for preview is encoded into its WAV. No hidden loudness boost or LUFS claim is applied.\r\nSame patch and seed reproduce PCM within one browser engine version; different browser implementations may have small numerical differences.\r\nmanifest.json links each WAV to its patch and preserves names, IDs, tags, seeds and measured duration/levels.\r\nAll sounds were generated programmatically without source recordings. No samples were sent to a server.\r\nThe base reference is separate from the sixteen variations; its patch is included in manifest.json.\r\n`
  const entries: ZipEntry[] = [
    { path: `${folder}/manifest.json`, data: textEncoder.encode(JSON.stringify(manifest, null, 2)), modifiedAt: bank.updatedAt },
    { path: `${folder}/README.txt`, data: textEncoder.encode(readme), modifiedAt: bank.updatedAt },
    ...itemPaths.flatMap(({ sample, wav, patch }) => [
      { path: `${folder}/${wav}`, data: sample.render.wav, modifiedAt: sample.updatedAt },
      { path: `${folder}/${patch}`, data: textEncoder.encode(exportPatchJson(sample, bank.generatorVersion)), modifiedAt: sample.updatedAt },
    ]),
  ]
  const bytes = await createStoredZip(entries, options)
  return { bytes, filename: `${folder}.zip`, manifest }
}
