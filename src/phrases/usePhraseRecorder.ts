import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { SynthEngine } from '../audio/SynthEngine'
import type { SynthParams } from '../types'
import { PhrasePlayer } from './PhrasePlayer'
import { copyPhrase, PhraseCapture, phraseId, phraseName, playbackDuration, quantizeNotes } from './model'
import { deletePhrase, exportPhraseJson, importPhraseJson, listPhrases, loadDraft, saveDraft, savePhrase, snapshotSound } from './storage'
import { exportMidi as makeMidi } from './midiExport'
import { MAX_PHRASE_SECONDS, type LivePhraseNote, type Phrase, type PhraseNote, type Quantization, type RecordingMode } from './types'

export interface PhraseController {
  status: 'stopped' | 'recording' | 'count-in' | 'playing' | 'paused'
  preparing: boolean
  elapsed: number
  position: number
  duration: number
  draft: Phrase | null
  library: Phrase[]
  selectedId: string | null
  bpm: number
  recordingMode: RecordingMode
  metronome: boolean
  countIn: boolean
  loop: boolean
  quantization: Quantization
  view: 'original' | 'quantized'
  soundChoice: 'current' | 'original'
  saveSound: boolean
  liveVoices: number
  displayNotes: PhraseNote[]
  error: string | null
  notice: string
  record: () => void
  stop: () => void
  play: () => void
  pause: () => void
  setBpm: (bpm: number) => void
  setRecordingMode: (mode: RecordingMode) => void
  setMetronome: (value: boolean) => void
  setCountIn: (value: boolean) => void
  setLoop: (value: boolean) => void
  setQuantization: (value: Quantization) => void
  setView: (value: 'original' | 'quantized') => void
  setSoundChoice: (value: 'current' | 'original') => void
  setSaveSound: (value: boolean) => void
  save: (name: string) => void
  clear: () => void
  select: (id: string) => void
  rename: (id: string, name: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  exportMidi: () => void
  exportJson: () => void
  importJson: (text: string) => void
  onNoteOn: (note: LivePhraseNote) => void
  onNoteOff: (id: string) => void
  onSourceRelease: (source: string, channel?: number) => void
  onDisconnect: (source: string) => void
  interrupt: (reason?: string) => void
}
interface Options {
  engineRef: RefObject<SynthEngine | null>
  paramsRef: RefObject<SynthParams>
  applyParams: (params: SynthParams) => void
  getHeld: () => LivePhraseNote[]
}
const download = (data: BlobPart, type: string, name: string) => {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const fileName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'sound-lab-phrase'

export function usePhraseRecorder(options: Options): PhraseController {
  const current = useRef(options); current.current = options
  const capture = useRef(new PhraseCapture())
  const player = useRef<PhrasePlayer | null>(null)
  const playerEngine = useRef<SynthEngine | null>(null)
  const [status, setStatus] = useState<PhraseController['status']>('stopped')
  const [preparing, setPreparing] = useState(false)
  const statusRef = useRef(status)
  const [elapsed, setElapsed] = useState(0), [position, setPosition] = useState(0)
  const [draft, setDraftState] = useState<Phrase | null>(null)
  const draftRef = useRef(draft)
  const priorDraft = useRef<Phrase | null>(null)
  const [library, setLibrary] = useState<Phrase[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bpm, setBpmState] = useState(120), [recordingMode, setRecordingMode] = useState<RecordingMode>('free')
  const [metronome, setMetronome] = useState(false), [countIn, setCountIn] = useState(false), [loop, setLoopState] = useState(false)
  const [quantization, setQuantization] = useState<Quantization>('off'), [view, setView] = useState<'original' | 'quantized'>('original')
  const [soundChoice, setSoundChoice] = useState<'current' | 'original'>('current'), [saveSound, setSaveSound] = useState(true)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('Запишите идею без сетки. Ноты и Velocity; без CC, Pitch Bend и записи аудио.')
  const operation = useRef(0), draftRevision = useRef(0), lastDraftSave = useRef(0)
  const lastUiUpdate = useRef(0)
  const saveQueue = useRef(Promise.resolve())
  const armAt = useRef<number | null>(null), nextClick = useRef<number | null>(null), clickIndex = useRef(0)
  const armSound = useRef<SynthParams | null>(null)
  const recordingConfig = useRef({ bpm: 120, mode: 'free' as RecordingMode, metronome: false })
  const api = useRef<PhraseController | null>(null)
  const commitStatus = (value: PhraseController['status']) => { statusRef.current = value; setStatus(value) }
  const setDraft = (value: Phrase | null) => { draftRef.current = value; setDraftState(value) }
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
  const persistDraft = (value: Phrase | null) => {
    const copy = value ? copyPhrase(value) : null
    saveQueue.current = saveQueue.current.then(() => saveDraft(copy)).catch(fail)
  }
  const reloadLibrary = async () => { const result = await listPhrases(); setLibrary(result.phrases); if (result.skipped) setError(`${result.skipped} повреждённых фраз пропущено. Остальные доступны.`) }
  const ensurePlayer = () => {
    const engine = current.current.engineRef.current
    if (!engine) throw new Error('Аудиодвижок ещё не готов.')
    if (playerEngine.current !== engine) {
      player.current?.dispose(); playerEngine.current = engine
      player.current = new PhrasePlayer(engine, state => {
        setPreparing(false)
        if (statusRef.current !== 'recording' && statusRef.current !== 'count-in') commitStatus(state.status)
        setPosition(state.position)
      })
    }
    return player.current!
  }
  const beginCapture = (at?: number) => {
    const settings = recordingConfig.current
    capture.current.start(settings.bpm, settings.mode, armSound.current, at)
    commitStatus('recording'); armAt.current = null; setElapsed(0)
    for (const note of current.current.getHeld()) capture.current.noteOn(note)
    setNotice('Recording: сохраняется фактическое время; сетка ничего не изменяет.')
  }
  const stop = () => {
    ++operation.current; armAt.current = null; nextClick.current = null
    setPreparing(false)
    current.current.engineRef.current?.cancelMetronome('phrase-recorder')
    if (capture.current.recording) {
      const take = capture.current.stop()
      if (take) { setDraft(take); persistDraft(take); setElapsed(take.duration); setNotice('Запись завершена. Черновик сохраняется в IndexedDB. Нажмите Save, чтобы добавить в My Phrases.') }
      else { setDraft(priorDraft.current); setSelectedId(null); setNotice('Пустой дубль не сохранён. Предыдущая фраза остаётся доступной.') }
    }
    player.current?.stop(); commitStatus('stopped'); setPosition(0)
  }
  const record = () => {
    if (statusRef.current !== 'stopped') { setError('Сначала остановите воспроизведение или текущую запись. Overdub не поддерживается.'); return }
    const engine = current.current.engineRef.current
    if (!engine) return
    // Play may still be awaiting audio unlock while the visible state is stopped.
    // Invalidate that session before arming a new take.
    player.current?.stop()
    setPreparing(false)
    const token = ++operation.current
    priorDraft.current = draftRef.current ? copyPhrase(draftRef.current) : null
    ++draftRevision.current; setError(null); setSelectedId(null)
    recordingConfig.current = { bpm, mode: recordingMode, metronome }
    armSound.current = snapshotSound(current.current.paramsRef.current)
    if (recordingMode === 'free' || !countIn) {
      // Capture starts in the button gesture, independently of audio unlock.
      // Even a very short note played while resume() is pending is retained.
      beginCapture()
      void engine.prepare().then(() => {
        if (operation.current !== token || !capture.current.recording) return
        const clock = engine.getAudioClock()
        if (recordingMode === 'tempo' && metronome && clock?.state === 'running') {
          clickIndex.current = 0; nextClick.current = clock.time + 0.02
        }
      }).catch(reason => { if (operation.current === token) fail(reason) })
      return
    }
    commitStatus('count-in') // Also protects the asynchronous audio unlock.
    void engine.prepare().then(() => {
      if (operation.current !== token || statusRef.current !== 'count-in') return
      const clock = engine.getAudioClock()
      if (!clock || clock.state !== 'running') { commitStatus('stopped'); throw new Error('Аудио приостановлено браузером. Нажмите Record снова.') }
      const beat = 60 / bpm, first = clock.time + 0.02
      clickIndex.current = 0
      nextClick.current = recordingMode === 'tempo' && (metronome || countIn) ? first : null
      if (recordingMode === 'tempo' && countIn) {
        armAt.current = performance.now() + (first + 4 * beat - clock.time) * 1000
        setNotice('Count-in: один такт 4/4. Запись начнётся после четырёх долей.')
      } else beginCapture()
    }).catch(reason => { if (operation.current === token) { commitStatus('stopped'); fail(reason) } })
  }
  const play = () => {
    if (statusRef.current === 'recording' || statusRef.current === 'count-in') { setError('Сначала завершите запись. Одновременные Record и Playback не поддерживаются.'); return }
    const phrase = draftRef.current
    if (!phrase?.notes.length) { setError('Во фразе нет нот.'); return }
    setError(null)
    const resume = statusRef.current === 'paused'
    try {
      if (!resume && soundChoice === 'original' && phrase.sound) {
        current.current.applyParams(snapshotSound(phrase.sound))
        setNotice('Original Sound загружен: общие параметры синтезатора изменены, включая звучащие live-голоса.')
      } else if (!resume) setNotice('Current Sound: фраза звучит с текущими параметрами синтезатора.')
      const transport = ensurePlayer()
      if (!resume) {
        const notes = view === 'quantized' ? quantizeNotes(phrase.notes, phrase.bpm, quantization) : phrase.notes.map(note => ({ ...note }))
        transport.configure(notes, playbackDuration(phrase, notes), loop)
      }
      const token = ++operation.current
      setPreparing(true)
      void transport.play(resume ? transport.getState().position : 0)
        .catch(reason => { if (operation.current === token) { commitStatus('stopped'); fail(reason) } })
        .finally(() => { if (operation.current === token) setPreparing(false) })
    } catch (reason) { fail(reason) }
  }
  const pause = () => { ++operation.current; setPreparing(false); player.current?.pause() }
  const select = (id: string) => {
    if (capture.current.recording || statusRef.current === 'count-in') { setError('Сначала завершите текущую запись.'); return }
    const phrase = library.find(item => item.id === id)
    if (!phrase) return
    stop(); ++draftRevision.current; setDraft(copyPhrase(phrase)); setSelectedId(id); setBpmState(phrase.bpm); setRecordingMode(phrase.recordingMode); if (!phrase.sound) setSoundChoice('current'); persistDraft(phrase)
    setNotice(`Открыта фраза «${phrase.name}». ${phrase.notes.length} нот; исходный ритм сохранён.`)
  }
  const save = (name: string) => {
    if (capture.current.recording || statusRef.current === 'count-in') { setError('Нажмите Stop перед сохранением.'); return }
    const phrase = draftRef.current
    if (!phrase?.notes.length) { setError('Пустую запись сохранять не нужно.'); return }
    const value = { ...copyPhrase(phrase), name: phraseName(name), updatedAt: Date.now(), sound: saveSound ? (phrase.sound ? snapshotSound(phrase.sound) : snapshotSound(current.current.paramsRef.current)) : null }
    const revision = draftRevision.current
    setError(null)
    void savePhrase(value).then(async () => {
      if (draftRevision.current === revision && !capture.current.recording && draftRef.current?.id === value.id) {
        setDraft(value); setSelectedId(value.id); persistDraft(value)
        setNotice(`«${value.name}» сохранена в My Phrases${value.sound ? ' вместе со Sound Snapshot' : ' без снимка звука'}.`)
      }
      await reloadLibrary()
    }).catch(fail)
  }
  const mutateLibrary = (action: () => Promise<void>) => { setError(null); void action().then(reloadLibrary).catch(fail) }
  const clear = () => { stop(); ++draftRevision.current; setDraft(null); setSelectedId(null); setElapsed(0); persistDraft(null); setNotice('Текущий черновик очищен. Сохранённая библиотека не изменена.') }
  const displayNotes = useMemo(() => draft ? (view === 'quantized' ? quantizeNotes(draft.notes, draft.bpm, quantization) : draft.notes.map(note => ({ ...note }))) : [], [draft, view, quantization])
  const controller: PhraseController = {
    status, preparing, elapsed, position, draft, library, selectedId, bpm, recordingMode, metronome, countIn, loop, quantization, view, soundChoice, saveSound,
    duration: draft ? playbackDuration(draft, displayNotes) : 0, displayNotes, error, notice,
    liveVoices: current.current.engineRef.current?.getVoices().filter(voice => voice.origin !== 'sequence' && voice.gateOpen).length ?? 0,
    record, stop, play, pause, setBpm: value => setBpmState(Number.isFinite(value) ? Math.min(300, Math.max(30, value)) : 120),
    setRecordingMode, setMetronome, setCountIn, setLoop: value => { setLoopState(value); player.current?.setLoop(value) }, setQuantization, setView, setSoundChoice, setSaveSound,
    save, clear, select,
    rename: (id, name) => { const phrase = library.find(item => item.id === id), revision = draftRevision.current; if (phrase) mutateLibrary(async () => { const renamed = { ...copyPhrase(phrase), name: phraseName(name), updatedAt: Date.now() }; await savePhrase(renamed); if (draftRevision.current === revision && !capture.current.recording && statusRef.current !== 'count-in' && draftRef.current?.id === id) { setDraft(renamed); persistDraft(renamed) } }) },
    duplicate: id => { const phrase = library.find(item => item.id === id); if (phrase) mutateLibrary(() => savePhrase({ ...copyPhrase(phrase), id: phraseId(), name: phraseName(`${phrase.name} · копия`), createdAt: Date.now(), updatedAt: Date.now() })) },
    remove: id => { const revision = draftRevision.current; mutateLibrary(async () => { await deletePhrase(id); if (draftRevision.current === revision && !capture.current.recording && statusRef.current !== 'count-in' && draftRef.current?.id === id) clear() }) },
    exportMidi: () => { try { if (!draft) throw new Error('Нет фразы для экспорта.'); download(makeMidi(draft, displayNotes), 'audio/midi', `${fileName(draft.name)}.mid`); setNotice('MIDI экспортирован: ноты, Velocity, Tempo и время. Это события, а не аудио и не уникальный тембр SOUND LAB.') } catch (reason) { fail(reason) } },
    exportJson: () => { try { if (!draft) throw new Error('Нет фразы для экспорта.'); download(exportPhraseJson(draft), 'application/json', `${fileName(draft.name)}.json`) } catch (reason) { fail(reason) } },
    importJson: raw => { try { if (capture.current.recording || statusRef.current === 'count-in') throw new Error('Сначала завершите запись.'); const phrase = importPhraseJson(raw); stop(); ++draftRevision.current; setDraft(phrase); setSelectedId(null); setBpmState(phrase.bpm); setRecordingMode(phrase.recordingMode); if (!phrase.sound) setSoundChoice('current'); persistDraft(phrase); setNotice('Phrase JSON проверен и восстановлен в черновик. Нажмите Save для добавления в библиотеку.') } catch (reason) { fail(reason) } },
    onNoteOn: note => { if (armAt.current !== null && performance.now() >= armAt.current) beginCapture(armAt.current); capture.current.noteOn(note) },
    onNoteOff: id => capture.current.noteOff(id),
    onSourceRelease: (source, channel) => capture.current.releaseSource(source, channel),
    onDisconnect: source => { capture.current.releaseSource(source); if (capture.current.recording || statusRef.current === 'count-in') { stop(); setNotice('MIDI отключён: запись завершена, доступный черновик сохранён.') } },
    interrupt: reason => { const active = statusRef.current !== 'stopped' || capture.current.recording || preparing; stop(); if (active) setNotice(reason ?? 'Panic / потеря фокуса: транспорт остановлен, доступный черновик сохранён.') },
  }
  api.current = controller
  useEffect(() => {
    let active = true
    const revision = draftRevision.current
    void listPhrases().then(result => { if (active) { setLibrary(result.phrases); if (result.skipped) setError(`${result.skipped} повреждённых фраз пропущено.`) } }).catch(reason => { if (active) fail(reason) })
    void loadDraft().then(value => { if (active && draftRevision.current === revision && value) { setDraft(value); setBpmState(value.bpm); setRecordingMode(value.recordingMode); setNotice('Черновик восстановлен из IndexedDB. Исходные ноты и Sound Snapshot доступны.') } }).catch(reason => { if (active) fail(reason) })
    const timer = window.setInterval(() => {
      const engine = current.current.engineRef.current, clock = engine?.getAudioClock()
      if ((statusRef.current === 'playing' || armAt.current !== null) && clock?.state !== 'running') { api.current?.interrupt('Аудиоконтекст остановлен: запланированные события отменены, черновик сохранён.'); return }
      if (armAt.current !== null && performance.now() >= armAt.current) beginCapture(armAt.current)
      if (statusRef.current === 'count-in' && armAt.current !== null) setElapsed(Math.max(0, (armAt.current - performance.now()) / 1000))
      if (capture.current.recording && performance.now() - lastUiUpdate.current >= 100) {
        lastUiUpdate.current = performance.now()
        const value = capture.current.snapshot(); setDraft(value); setElapsed(capture.current.elapsed)
        if (performance.now() - lastDraftSave.current > 1000 && value?.notes.length) { lastDraftSave.current = performance.now(); persistDraft(value) }
        if (capture.current.elapsed >= MAX_PHRASE_SECONDS) { api.current?.stop(); setNotice('Достигнут лимит 10 минут. Черновик сохранён.') }
      }
      if (engine && clock?.state === 'running' && nextClick.current !== null) {
        const config = recordingConfig.current, beat = 60 / config.bpm
        if (nextClick.current < clock.time - 0.05) {
          const missed = Math.ceil((clock.time - 0.05 - nextClick.current) / beat)
          nextClick.current += missed * beat; clickIndex.current += missed
        }
        let budget = 8
        while (nextClick.current < clock.time + 0.12 && budget-- > 0) {
          if ((statusRef.current === 'count-in' && (config.metronome || clickIndex.current < 4)) || (capture.current.recording && config.metronome)) engine.scheduleMetronome(Math.max(clock.time, nextClick.current), clickIndex.current % 4 === 0, 'phrase-recorder')
          nextClick.current += beat; clickIndex.current++
        }
        if (statusRef.current !== 'count-in' && !config.metronome) nextClick.current = null
      }
    }, 25)
    const leave = () => { api.current?.interrupt('Вкладка закрывается: доступный черновик сохраняется.') }
    window.addEventListener('pagehide', leave)
    return () => { active = false; ++operation.current; window.clearInterval(timer); window.removeEventListener('pagehide', leave); player.current?.dispose(); player.current = null; playerEngine.current = null; current.current.engineRef.current?.cancelMetronome('phrase-recorder'); const value = capture.current.stop(); if (value) persistDraft(value) }
  }, [])
  return controller
}
