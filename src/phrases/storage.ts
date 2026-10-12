import { copyParams, type SynthParams } from '../types'
import { copyPhrase, phraseId } from './model'
import { MAX_LIBRARY_PHRASES, MAX_PHRASE_NOTES, MAX_PHRASE_SECONDS, type Phrase, type PhraseNote } from './types'

export const PHRASE_DB = 'sound-lab.phrases.v1'
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const numberIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

function validSound(v: unknown): v is SynthParams {
  if (!isRecord(v) || !['classic', 'additive'].includes(String(v.mode)) || !['sine', 'square', 'sawtooth', 'triangle'].includes(String(v.waveform))) return false
  if (!numberIn(v.frequency, 8, 20000) || !numberIn(v.amplitude, 0, 1) || !isRecord(v.adsr) || !isRecord(v.filter) || !isRecord(v.lfo) || !isRecord(v.additive)) return false
  const a = v.adsr, f = v.filter, l = v.lfo, h = v.additive
  return numberIn(a.attack, 0, 20) && numberIn(a.decay, 0, 20) && numberIn(a.sustain, 0, 1) && numberIn(a.release, 0, 30)
    && numberIn(f.cutoff, 20, 20000) && numberIn(f.q, 0.05, 20) && typeof f.bypass === 'boolean'
    && numberIn(l.rate, 0.05, 30) && numberIn(l.depth, 0, 1) && typeof l.enabled === 'boolean' && ['pitch', 'filter'].includes(String(l.target))
    && Array.isArray(h.levels) && h.levels.length === 16 && h.levels.every(n => numberIn(n, 0, 100))
    && Array.isArray(h.phases) && h.phases.length === 16 && h.phases.every(n => n === 0 || n === 180)
    && Array.isArray(h.enabled) && h.enabled.length === 16 && h.enabled.every(n => typeof n === 'boolean')
    && (h.solo === null || (numberIn(h.solo, 1, 16) && Number.isInteger(h.solo))) && typeof h.compare === 'boolean'
}

export function validatePhrase(value: unknown): Phrase {
  if (!isRecord(value) || value.version !== 1 || !text(value.id) || !text(value.name, 120)
    || !numberIn(value.createdAt, 0, 1e15) || !numberIn(value.updatedAt, 0, 1e15)
    || !numberIn(value.duration, 0.001, MAX_PHRASE_SECONDS + 8) || !numberIn(value.bpm, 30, 300)
    || !['free', 'tempo'].includes(String(value.recordingMode)) || !Array.isArray(value.notes) || value.notes.length > MAX_PHRASE_NOTES
    || !(value.sound === null || validSound(value.sound))) throw new Error('Недопустимый формат музыкальной фразы.')
  const duration = value.duration
  const ids = new Set<string>()
  const notes: PhraseNote[] = value.notes.map(item => {
    if (!isRecord(item) || !text(item.id) || ids.has(item.id) || !text(item.eventId) || !text(item.sourceId) || !text(item.sourceName)
      || !(item.channel === null || (numberIn(item.channel, 1, 16) && Number.isInteger(item.channel)))
      || !numberIn(item.midi, 0, 127) || !Number.isInteger(item.midi) || !numberIn(item.velocity, 1, 127) || !Number.isInteger(item.velocity)
      || !numberIn(item.start, 0, MAX_PHRASE_SECONDS) || !numberIn(item.end, 0.001, MAX_PHRASE_SECONDS + 8) || item.end <= item.start || item.end > duration) throw new Error('Недопустимая нота в музыкальной фразе.')
    ids.add(item.id)
    return { id: item.id, eventId: item.eventId, sourceId: item.sourceId, sourceName: item.sourceName, channel: item.channel as number | null, midi: item.midi, velocity: item.velocity, start: item.start, end: item.end }
  })
  return { version: 1, id: value.id, name: value.name, createdAt: value.createdAt, updatedAt: value.updatedAt, duration: value.duration, bpm: value.bpm,
    recordingMode: value.recordingMode as Phrase['recordingMode'], notes, sound: value.sound ? snapshotSound(value.sound as SynthParams) : null }
}

export function snapshotSound(value: SynthParams): SynthParams {
  return copyParams({ mode: value.mode, waveform: value.waveform, frequency: value.frequency, amplitude: value.amplitude,
    additive: value.additive, adsr: value.adsr, filter: value.filter, lfo: value.lfo })
}

export function exportPhraseJson(phrase: Phrase): string { return JSON.stringify({ format: 'sound-lab.phrase', version: 1, phrase: validatePhrase(phrase) }, null, 2) }
export function importPhraseJson(raw: string): Phrase {
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error('Файл больше 32 MiB.')
  const data: unknown = JSON.parse(raw)
  if (!isRecord(data) || data.format !== 'sound-lab.phrase' || data.version !== 1) throw new Error('Неподдерживаемая версия Phrase JSON.')
  const phrase = validatePhrase(data.phrase)
  return { ...phrase, id: phraseId(), updatedAt: Date.now() }
}

let connection: Promise<IDBDatabase> | null = null
function database(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PHRASE_DB, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('phrases', { keyPath: 'id' }); request.result.createObjectStore('draft') }
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = null }; resolve(db) }
    request.onerror = () => reject(request.error ?? new Error('Хранилище недоступно.'))
    request.onblocked = () => reject(new Error('Хранилище занято другой вкладкой.'))
  }).catch(error => { connection = null; throw error })
  return connection
}
async function transact<T>(store: 'phrases' | 'draft', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode)
    const request = action(transaction.objectStore(store))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Не удалось записать данные; проверьте доступ и свободное место.'))
  })
}

export async function listPhrases(): Promise<{ phrases: Phrase[]; skipped: number }> {
  const raw = await transact<unknown[]>('phrases', 'readonly', store => store.getAll())
  const phrases: Phrase[] = []; let skipped = 0
  for (const value of raw) { try { phrases.push(validatePhrase(value)) } catch { skipped++ } }
  return { phrases: phrases.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt), skipped }
}
export async function savePhrase(phrase: Phrase): Promise<void> {
  const data = validatePhrase(phrase)
  // A single read/write transaction enforces the cap even across tabs.
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('phrases', 'readwrite'), store = tx.objectStore('phrases')
    let reason = ''
    const existing = store.get(data.id)
    existing.onsuccess = () => {
      const count = store.count()
      count.onsuccess = () => { if (!existing.result && count.result >= MAX_LIBRARY_PHRASES) { reason = 'Лимит библиотеки: 200 фраз. Экспортируйте и удалите ненужные.'; tx.abort() } else store.put(copyPhrase(data)) }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(new Error(reason || tx.error?.message || 'Не удалось сохранить фразу; проверьте свободное место.'))
  })
}
export async function deletePhrase(id: string): Promise<void> { await transact('phrases', 'readwrite', store => store.delete(id)) }
export async function saveDraft(phrase: Phrase | null): Promise<void> {
  if (phrase) await transact('draft', 'readwrite', store => store.put(validatePhrase(phrase), 'current'))
  else await transact('draft', 'readwrite', store => store.delete('current'))
}
export async function loadDraft(): Promise<Phrase | null> { const value = await transact<unknown>('draft', 'readonly', store => store.get('current')); return value === undefined ? null : validatePhrase(value) }
