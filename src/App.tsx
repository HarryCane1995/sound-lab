import { useCallback, useEffect, useRef, useState } from 'react'
import { SynthEngine } from './audio/SynthEngine'
import type { VoiceSnapshot } from './audio/voiceTypes'
import { Hint, Parameter, SectionHeading, Toggle, WaveIcon } from './components/Controls'
import { KEY_CODES, Piano, midiFrequency, midiName } from './components/Piano'
import { HarmonicBuilder } from './components/HarmonicBuilder'
import { LessonPanel } from './components/LessonPanel'
import { ENVELOPE_PRESETS, PRESETS } from './content/library'
import { HARMONIC_TEMPLATES } from './content/harmonics'
import { HARMONIC_PATCH_KEY, loadHarmonicState, saveHarmonicState } from './harmonics/storage'
import { SignalVisualizers } from './visuals/SignalVisualizers'
import { EnvelopeGraph } from './visuals/EnvelopeGraph'
import { copyAdditive, copyParams, defaultAdditive, DEFAULT_PARAMS } from './types'
import type { AdditiveConfig, Lesson, SynthMode, SynthParams, Waveform } from './types'
import { MidiController } from './midi/MidiController'
import { HeldNotes, midiNoteId } from './midi/HeldNotes'
import type { HeldNote } from './midi/HeldNotes'
import { getTargetNormalized, setTargetNormalized } from './midi/targets'
import { INITIAL_MIDI_STATE } from './midi/types'
import type { MidiCallbacks, MidiMessage, MidiState, MidiTargetId } from './midi/types'
import { MidiLearnButton, MidiLearnProvider } from './midi/MidiLearnContext'
import { MidiPanel } from './components/MidiPanel'
import { PhraseRecorder } from './components/PhraseRecorder'
import { usePhraseRecorder, type PhraseController } from './phrases/usePhraseRecorder'
import './midi/midi.css'

const midiSource = (id: string) => `midi:${JSON.stringify(id)}`

const WAVES: { id: Waveform; name: string; english: string; hint: string }[] = [
  { id: 'sine', name: 'Синусоида', english: 'Sine', hint: 'Чистый основной тон, практически без дополнительных гармоник.' },
  { id: 'square', name: 'Прямоугольная', english: 'Square', hint: 'Полый, яркий звук. Содержит преимущественно нечётные гармоники.' },
  { id: 'sawtooth', name: 'Пилообразная', english: 'Sawtooth', hint: 'Яркий, насыщенный звук. Содержит чётные и нечётные гармоники.' },
  { id: 'triangle', name: 'Треугольная', english: 'Triangle', hint: 'Мягкий звук. Нечётные гармоники затихают быстрее, чем у Square.' },
]

export default function App() {
  const [initialHarmonics] = useState(() => loadHarmonicState())
  const [params, setParams] = useState<SynthParams>(() => copyParams({ ...DEFAULT_PARAMS,
    mode: initialHarmonics.state?.mode ?? 'classic', additive: initialHarmonics.state?.additive ?? DEFAULT_PARAMS.additive }))
  const [patchStatus, setPatchStatus] = useState(initialHarmonics.error ?? 'Режим и гармоники сохраняются автоматически. Solo и Compare действуют только в этой сессии.')
  const paramsRef = useRef(params)
  const engineRef = useRef<SynthEngine | null>(null)
  const phraseRef = useRef<PhraseController | null>(null)
  const [audio, setAudio] = useState({ contextState: 'not-started', gateOpen: false, audible: false, auditionGateOpen: false, pendingCount: 0 })
  const [voices, setVoices] = useState<VoiceSnapshot[]>([])
  const voiceDisplayKey = useRef('')
  const [heldNotes, setHeldNotes] = useState<HeldNote[]>([])
  const held = useRef(new HeldNotes())
  const noteRequests = useRef(new Map<string, number>())
  const requestSerial = useRef(0)
  const auditionRequested = useRef(false)
  const auditionPending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [octave, setOctave] = useState(3)
  const [midiState, setMidiState] = useState<MidiState>(INITIAL_MIDI_STATE)
  const midiRef = useRef<MidiController | null>(null)
  const midiHandlers = useRef<Omit<MidiCallbacks, 'onState'> | null>(null)
  const pitchBends = useRef(new Map<string, { sourceId: string; channel: number; value: number }>())
  const [bendRange, setBendRange] = useState(2)
  const bendRangeRef = useRef(2)
  const [pitchBend, setPitchBend] = useState(0)
  const lastBend = useRef(0)
  const [velocity, setVelocity] = useState<number | null>(null)
  const [modulation, setModulation] = useState(0)
  const acceptsMidiNotes = useRef(true)
  const [presetId, setPresetId] = useState('')
  const [loadedLesson, setLoadedLesson] = useState<string | null>(null)
  const [notice, setNotice] = useState('Играйте аккорды или нажмите Play для отдельного тона. До 16 голосов.')

  const refreshAudio = useCallback(() => {
    const engine = engineRef.current
    const state = engine?.getState()
    if (!auditionPending.current && !state?.auditionGateOpen) auditionRequested.current = false
    const next = {
      contextState: state?.contextState ?? 'not-started', gateOpen: state?.gateOpen ?? false,
      audible: state?.audible ?? false, auditionGateOpen: Boolean(state?.auditionGateOpen || auditionPending.current),
      pendingCount: state?.pendingCount ?? 0,
    }
    setAudio(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    const snapshots = engine?.getVoices() ?? []
    // Envelope levels change continuously; UI only needs identities, gates and bends.
    const key = snapshots.map(voice => `${voice.instanceId}:${voice.gateOpen}:${voice.frequency}:${voice.pitchBend}:${voice.retiring}`).join('|')
    if (key !== voiceDisplayKey.current) { voiceDisplayKey.current = key; setVoices(snapshots) }
  }, [])

  useEffect(() => {
    const engine = new SynthEngine(paramsRef.current)
    engineRef.current = engine
    const timer = window.setInterval(refreshAudio, 80)
    return () => {
      window.clearInterval(timer)
      held.current.clear(); noteRequests.current.clear()
      auditionRequested.current = false; auditionPending.current = false
      engineRef.current = null
      void engine.dispose()
    }
  }, [refreshAudio])

  const syncHeld = useCallback(() => setHeldNotes(held.current.values), [])
  const applyParams = useCallback((next: SynthParams, custom = true) => {
    paramsRef.current = copyParams(next)
    engineRef.current?.setParams(paramsRef.current)
    setParams(paramsRef.current)
    if (custom) { setPresetId(''); setLoadedLesson(null) }
  }, [])
  const change = <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => applyParams({ ...paramsRef.current, [key]: value })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const error = saveHarmonicState(paramsRef.current)
      if (error) setPatchStatus(error)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [params.mode, params.additive])

  useEffect(() => {
    const flush = () => { saveHarmonicState(paramsRef.current) }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  const selectMode = (mode: SynthMode) => applyParams({ ...paramsRef.current, mode, additive: { ...paramsRef.current.additive, compare: false } })
  const selectClassic = (waveform: Waveform) => applyParams({ ...paramsRef.current, mode: 'classic', waveform, additive: { ...paramsRef.current.additive, compare: false } })
  const editHarmonics = (additive: AdditiveConfig) => applyParams({ ...paramsRef.current, mode: 'additive', additive: { ...copyAdditive(additive), compare: false } })
  const loadHarmonicTemplate = (id: string) => {
    const template = HARMONIC_TEMPLATES.find(item => item.id === id)
    if (!template) return
    applyParams({ ...paramsRef.current, mode: 'additive', additive: copyAdditive(template.config), amplitude: 0.2,
      adsr: { attack: 0.01, decay: 0.05, sustain: 1, release: 0.15 }, filter: { ...paramsRef.current.filter, bypass: true }, lfo: { ...paramsRef.current.lfo, enabled: false } })
    const message = `${template.name}: гармоники загружены. ADSR: 0.01 / 0.05 / 100% / 0.15 с; Amplitude 20%; фильтр в Bypass; LFO выключен. Частота и удерживаемые ноты сохранены.`
    setPatchStatus(message); setNotice(message)
  }
  const compareClassic = (waveform: Waveform, mode: SynthMode) => {
    const firstComparison = !paramsRef.current.additive.compare || paramsRef.current.waveform !== waveform
    const template = HARMONIC_TEMPLATES.find(item => item.classic === waveform)
    const additive = firstComparison && template ? copyAdditive(template.config) : copyAdditive(paramsRef.current.additive)
    applyParams({ ...paramsRef.current, mode, waveform, additive: { ...additive, compare: true },
      ...(firstComparison ? { amplitude: 0.2, adsr: { attack: 0.01, decay: 0.05, sustain: 1, release: 0.15 },
        filter: { ...paramsRef.current.filter, bypass: true }, lfo: { ...paramsRef.current.lfo, enabled: false } } : {}) })
    setPatchStatus(`${firstComparison ? `${template?.name ?? waveform} загружен; ADSR 0.01 / 0.05 / 100% / 0.15 с, Amplitude 20%, Bypass, LFO выключен. ` : ''}Compare: уровень Classic уменьшен по расчётному RMS аддитивной суммы. Реальная громкость может немного различаться. Удерживаемая нота сохраняется; 16 гармоник лишь приближают классическую форму.`)
  }
  const resetHarmonics = () => {
    editHarmonics(defaultAdditive())
    setPatchStatus('Reset Harmonics: H1 = 100%, H2–H16 = 0%, фазы 0°. Остальные параметры и MIDI-привязки сохранены.')
  }
  const saveHarmonicPatch = () => setPatchStatus(saveHarmonicState(paramsRef.current, HARMONIC_PATCH_KEY) ?? 'Harmonic Patch сохранён: режим, уровни, включение и фазы. Solo и Compare временные. MIDI-привязки сохранены.')
  const loadHarmonicPatch = () => {
    const loaded = loadHarmonicState(HARMONIC_PATCH_KEY)
    if (!loaded.state) { setPatchStatus(loaded.error ?? 'Сохранённого Harmonic Patch пока нет. Сначала нажмите Save Harmonic Patch.'); return }
    applyParams({ ...paramsRef.current, mode: loaded.state.mode, additive: loaded.state.additive })
    setPatchStatus('Harmonic Patch загружен. Частота, огибающая, фильтр, LFO и MIDI-привязки сохранены.')
  }

  const audioError = useCallback((reason: unknown) => {
    setError(`Не удалось включить аудио: ${reason instanceof Error ? reason.message : String(reason)}. Проверьте разрешение звука в браузере и попробуйте Play снова.`)
  }, [])

  const stopAll = useCallback(() => {
    phraseRef.current?.interrupt()
    held.current.clear(); noteRequests.current.clear(); syncHeld()
    auditionRequested.current = false; auditionPending.current = false
    engineRef.current?.panic()
    for (const bend of pitchBends.current.values()) engineRef.current?.setSourcePitchBend(midiSource(bend.sourceId), bend.channel, 0)
    engineRef.current?.setPitchBend(0)
    pitchBends.current.clear(); lastBend.current = 0; setPitchBend(0)
    refreshAudio()
  }, [refreshAudio, syncHeld])

  const pressHeldNote = useCallback((note: HeldNote) => {
    if (!held.current.press(note)) return
    phraseRef.current?.onNoteOn({ ...note, sourceId: note.origin === 'midi' ? midiSource(note.sourceId) : note.sourceId })
    syncHeld(); setError(null)
    if (note.origin === 'midi') setVelocity(note.velocity)
    const engine = engineRef.current
    if (!engine) { held.current.release(note.id); syncHeld(); return }
    const token = ++requestSerial.current
    noteRequests.current.set(note.id, token)
    // Note frequencies belong to their voices, never to the manual Frequency control.
    void engine.noteOnVoice({ ...note, sourceId: note.origin === 'midi' ? midiSource(note.sourceId) : note.sourceId, frequency: midiFrequency(note.midi) }).then(() => {
      if (engineRef.current === engine) refreshAudio()
    }).catch((reason: unknown) => {
      if (engineRef.current !== engine || noteRequests.current.get(note.id) !== token) return
      noteRequests.current.delete(note.id); held.current.release(note.id); phraseRef.current?.onNoteOff(note.id); syncHeld()
      engine.noteOffVoice(note.id, true); audioError(reason); refreshAudio()
    })
    refreshAudio()
  }, [audioError, refreshAudio, syncHeld])

  const pressNote = useCallback((id: string, midi: number) => {
    const pc = id.startsWith('key:')
    pressHeldNote({ id, midi, velocity: 127, sourceId: pc ? 'pc' : 'virtual', sourceName: pc ? 'Клавиатура ПК' : 'Виртуальная клавиатура', channel: null, origin: 'local' })
  }, [pressHeldNote])

  const releaseNote = useCallback((id: string) => {
    phraseRef.current?.onNoteOff(id)
    noteRequests.current.delete(id)
    held.current.release(id); syncHeld()
    engineRef.current?.noteOffVoice(id)
    refreshAudio()
  }, [refreshAudio, syncHeld])

  const releaseLocalNotes = () => {
    for (const note of held.current.values) if (note.origin === 'local') { noteRequests.current.delete(note.id); phraseRef.current?.onNoteOff(note.id) }
    held.current.removeWhere(note => note.origin === 'local'); syncHeld()
    engineRef.current?.releaseVoices({ sourceId: 'pc' }, true)
    engineRef.current?.releaseVoices({ sourceId: 'virtual' }, true)
    refreshAudio()
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        if (midiRef.current?.getState().learning || midiRef.current?.getState().conflict) {
          midiRef.current.cancelLearn(); setNotice('MIDI Learn отменён.'); return
        }
        stopAll(); setNotice('Все голоса остановлены клавишей Esc.'); return
      }
      const target = event.target as HTMLElement | null
      if (event.ctrlKey || event.metaKey || event.altKey || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return
      const offset = KEY_CODES.indexOf(event.code)
      if (offset < 0) return
      event.preventDefault()
      if (!event.repeat) pressNote(`key:${event.code}`, 12 * (octave + 1) + offset)
    }
    const up = (event: KeyboardEvent) => releaseNote(`key:${event.code}`)
    const blur = () => { acceptsMidiNotes.current = false; stopAll() }
    const focus = () => { acceptsMidiNotes.current = true }
    const visibility = () => { if (document.hidden) stopAll() }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    window.addEventListener('blur', blur); window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [octave, pressNote, releaseNote, stopAll])

  const manualFrequency = (frequency: number) => change('frequency', frequency)
  const togglePlay = () => {
    const engine = engineRef.current
    if (!engine) return
    if (auditionRequested.current || engine.getState().auditionGateOpen) {
      auditionRequested.current = false; auditionPending.current = false
      engine.noteOff(); refreshAudio(); return
    }
    auditionRequested.current = true; auditionPending.current = true; setError(null)
    const token = ++requestSerial.current
    noteRequests.current.set('audition', token)
    void engine.noteOn(paramsRef.current.frequency).then(() => {
      if (engineRef.current !== engine || noteRequests.current.get('audition') !== token) return
      auditionPending.current = false; refreshAudio()
    }).catch((reason: unknown) => {
      if (engineRef.current !== engine || noteRequests.current.get('audition') !== token) return
      auditionPending.current = false; auditionRequested.current = false; audioError(reason); refreshAudio()
    })
    refreshAudio()
  }

  const loadParams = (next: SynthParams) => {
    stopAll(); applyParams({ ...copyParams(next), additive: { ...copyAdditive(paramsRef.current.additive), solo: null, compare: false } }, false); setError(null)
  }
  const loadLesson = (lesson: Lesson) => {
    loadParams(lesson.params); setPresetId(''); setLoadedLesson(lesson.id)
    setNotice(`Демо «${lesson.shortTitle}» готово. Нажмите Play или сыграйте аккорд.`)
  }
  const reset = () => {
    stopAll(); applyParams(copyParams(DEFAULT_PARAMS), false); setError(null); setPresetId(''); setLoadedLesson(null)
    setNotice('Исходные параметры восстановлены. MIDI-привязки сохранены. Нажмите Play или сыграйте ноты.')
  }
  const beginLearn = (target: MidiTargetId) => { stopAll(); midiRef.current?.beginLearn(target) }

  const disconnectSource = (sourceId: string) => {
    phraseRef.current?.onDisconnect(midiSource(sourceId))
    for (const note of held.current.values) if (note.origin === 'midi' && note.sourceId === sourceId) noteRequests.current.delete(note.id)
    held.current.removeWhere(note => note.origin === 'midi' && note.sourceId === sourceId); syncHeld()
    // Disconnect only this source, including its Release tails and pending resumes.
    engineRef.current?.releaseVoices({ sourceId: midiSource(sourceId) }, true)
    for (const [key, bend] of pitchBends.current) if (bend.sourceId === sourceId) {
      engineRef.current?.setSourcePitchBend(midiSource(sourceId), bend.channel, 0); pitchBends.current.delete(key)
    }
    lastBend.current = 0; setPitchBend(0); refreshAudio()
  }

  const handleMidiMessage = (message: MidiMessage, consumed: boolean) => {
    const channel = message.channel
    if (channel === null) return
    if (message.type === 'cc' && (message.controller === 120 || message.controller === 123)) {
      phraseRef.current?.onSourceRelease(midiSource(message.sourceId), channel)
      for (const note of held.current.values) if (note.origin === 'midi' && note.sourceId === message.sourceId && note.channel === channel) noteRequests.current.delete(note.id)
      held.current.removeWhere(note => note.origin === 'midi' && note.sourceId === message.sourceId && note.channel === channel); syncHeld()
      engineRef.current?.releaseVoices({ sourceId: midiSource(message.sourceId), channel }, message.controller === 120)
      refreshAudio(); return
    }
    if (message.type === 'pitchbend') {
      const value = message.bend ?? 0
      pitchBends.current.set(JSON.stringify([message.sourceId, channel]), { sourceId: message.sourceId, channel, value })
      lastBend.current = value; setPitchBend(value * bendRangeRef.current)
      engineRef.current?.setSourcePitchBend(midiSource(message.sourceId), channel, value * bendRangeRef.current)
      refreshAudio()
    }
    if (consumed) return
    if (message.type === 'noteon' && message.note !== undefined) {
      if (document.hidden || !acceptsMidiNotes.current) return
      pressHeldNote({ id: midiNoteId(message.sourceId, channel, message.note), midi: message.note, velocity: message.velocity ?? 127, sourceId: message.sourceId, sourceName: message.sourceName, channel, origin: 'midi' })
    } else if (message.type === 'noteoff' && message.note !== undefined) releaseNote(midiNoteId(message.sourceId, channel, message.note))
    else if (message.type === 'cc' && message.controller === 1) {
      setModulation(message.value)
      applyParams({ ...paramsRef.current, lfo: { ...paramsRef.current.lfo, depth: message.value / 127 } })
    }
  }

  const handleMidiTarget = (target: MidiTargetId, normalized: number | null, message: MidiMessage) => {
    if (normalized !== null) {
      applyParams(setTargetNormalized(paramsRef.current, target, normalized))
      if (target === 'lfo.depth') setModulation(Math.round(normalized * 127))
      return
    }
    if (target === 'panic') { stopAll(); setNotice('Panic: все голоса остановлены.'); return }
    if (target === 'reset') { reset(); return }
    if (target.startsWith('preset.')) {
      const preset = PRESETS.find(item => item.id === target.slice(7))
      if (preset) { loadParams(preset.params); setPresetId(preset.id); setLoadedLesson(null); setNotice(`${preset.name} · MIDI ${message.sourceName}`) }
      return
    }
    if (target === 'waveform.next') {
      const index = WAVES.findIndex(item => item.id === paramsRef.current.waveform)
      selectClassic(WAVES[(index + 1) % WAVES.length].id)
    } else if (target.startsWith('waveform.')) {
      const waveform = WAVES.find(item => item.id === target.slice(9))?.id
      if (waveform) selectClassic(waveform)
    } else if (target === 'synthesis.mode') selectMode(paramsRef.current.mode === 'classic' ? 'additive' : 'classic')
    else if (target === 'filter.bypass') change('filter', { ...paramsRef.current.filter, bypass: !paramsRef.current.filter.bypass })
    else if (target === 'lfo.enabled') change('lfo', { ...paramsRef.current.lfo, enabled: !paramsRef.current.lfo.enabled })
    else if (target === 'lfo.target') change('lfo', { ...paramsRef.current.lfo, target: paramsRef.current.lfo.target === 'pitch' ? 'filter' : 'pitch' })
  }
  midiHandlers.current = {
    onMessage: handleMidiMessage, onTarget: handleMidiTarget, onDisconnect: disconnectSource,
    getTargetNormalized: target => getTargetNormalized(paramsRef.current, target),
  }
  useEffect(() => {
    const controller = new MidiController({
      onState: setMidiState,
      onMessage: (message, consumed) => midiHandlers.current?.onMessage(message, consumed),
      onTarget: (target, value, message) => midiHandlers.current?.onTarget(target, value, message),
      onDisconnect: sourceId => midiHandlers.current?.onDisconnect(sourceId),
      getTargetNormalized: target => midiHandlers.current?.getTargetNormalized(target) ?? 0,
    })
    midiRef.current = controller; setMidiState(controller.getState())
    return () => { midiRef.current = null; controller.dispose() }
  }, [])
  const connectMidi = () => {
    if (typeof navigator.requestMIDIAccess === 'function' && window.isSecureContext) {
      void engineRef.current?.prepare().catch(() => setError('Аудио приостановлено браузером. Нажмите Play, затем Stop, чтобы разрешить звук MIDI.'))
    }
    void midiRef.current?.connect()
  }
  const changeBendRange = (range: number) => {
    const bounded = Math.min(24, Math.max(0, range))
    bendRangeRef.current = bounded; setBendRange(bounded); setPitchBend(lastBend.current * bounded)
    for (const bend of pitchBends.current.values()) engineRef.current?.setSourcePitchBend(midiSource(bend.sourceId), bend.channel, bend.value * bounded)
    refreshAudio()
  }
  const getAnalysis = useCallback(() => engineRef.current?.getAnalysis() ?? null, [])
  const phraseController = usePhraseRecorder({ engineRef, paramsRef, applyParams,
    getHeld: () => held.current.values.map(note => ({ ...note, sourceId: note.origin === 'midi' ? midiSource(note.sourceId) : note.sourceId })) })
  phraseRef.current = phraseController
  const lfoFilterBypassed = params.lfo.enabled && params.lfo.target === 'filter' && params.filter.bypass
  const activeNotes = heldNotes.map(note => ({ id: note.id, midi: note.midi, sourceName: note.sourceName, channel: note.channel }))
  const activeMidis = [...new Set(heldNotes.map(note => note.midi))]
  const midiNotes = voices.filter(voice => voice.origin === 'midi' && voice.gateOpen && voice.midi !== null && voice.channel !== null).map(voice => ({
    id: String(voice.instanceId), midi: voice.midi!, frequency: voice.frequency * 2 ** (voice.pitchBend / 12), sourceName: voice.sourceName, channel: voice.channel!,
  }))
  const scopeFrequency = voices.length ? Math.min(...voices.map(voice => voice.frequency * 2 ** (voice.pitchBend / 12))) : params.frequency
  const referenceVoice = [...voices].reverse().find(voice => voice.gateOpen && !voice.retiring)
  const referenceFrequency = referenceVoice ? referenceVoice.frequency * 2 ** (referenceVoice.pitchBend / 12) : params.frequency
  const referenceLabel = referenceVoice?.midi !== null && referenceVoice?.midi !== undefined ? `${midiName(referenceVoice.midi)} · ${referenceVoice.sourceName} (последняя удерживаемая)` : 'Play · Frequency'

  return <MidiLearnProvider value={{ state: midiState, onLearn: beginLearn, onRemove: id => midiRef.current?.removeBinding(id) }}><div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#main" aria-label="SOUND LAB — к лаборатории"><span className="brand-mark"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M4 18h5l4-11 8 22 6-17 3 6h3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg></span><span>SOUND <strong>LAB</strong><small>Лаборатория звукового синтеза</small></span></a>
      <div className="header-right"><span className={`audio-status ${audio.audible ? 'status-live' : ''}`}><i />{audio.gateOpen ? 'Звук включён' : audio.audible ? 'Затухание · Release' : 'Аудио в ожидании'}</span><span className="version-tag">ЛОКАЛЬНО <span>v0.5</span></span></div>
    </header>

    <main id="main">
      <div className="page-heading"><div><span className="eyebrow">УСЛЫШАТЬ. УВИДЕТЬ. ПОНЯТЬ.</span><h1>Из чего состоит звук<span>?</span></h1><p>Меняйте один параметр. Слушайте разницу. Следите за сигналом.</p></div><div className="preset-toolbar"><label htmlFor="preset-select">ОТПРАВНАЯ ТОЧКА <Hint text="Пресет — готовый набор параметров. Загрузка останавливает все голоса. Сыграйте новые ноты или нажмите Play, чтобы услышать пресет." /></label><div><select id="preset-select" value={presetId} onChange={event => {
        const preset = PRESETS.find(item => item.id === event.target.value)
        if (!preset) return
        loadParams(preset.params); setPresetId(preset.id); setLoadedLesson(null); setNotice(preset.description)
      }}><option value="" disabled>Свои настройки</option>{PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button className="reset-button" aria-label="Сбросить все параметры" title="Reset — вернуть исходные параметры и остановить звук" onClick={reset}>↺ <span>Сброс</span></button><MidiLearnButton target="reset" /></div></div></div>

      <div className="workspace"><div className="synth-workspace">
        <SignalVisualizers getAnalysis={getAnalysis} frequency={scopeFrequency} playing={audio.audible} waveform={params.waveform} cutoff={params.filter.cutoff} filterBypassed={params.filter.bypass} />
        <MidiPanel state={midiState} velocity={velocity} activeNotes={midiNotes} pitchBend={pitchBend} modulation={modulation} bendRange={bendRange} onBendRange={changeBendRange}
          onConnect={connectMidi} onSelectInput={id => midiRef.current?.selectInput(id)} onLearn={beginLearn} onCancelLearn={() => midiRef.current?.cancelLearn()}
          onResolveConflict={replace => midiRef.current?.resolveConflict(replace)} onRemoveBinding={id => midiRef.current?.removeBinding(id)} onBindingMode={(id, mode) => midiRef.current?.setBindingMode(id, mode)}
          onClearBindings={() => midiRef.current?.clearBindings()} onClearMonitor={() => midiRef.current?.clearMonitor()} onPanic={() => { stopAll(); setNotice('Panic: все ноты остановлены.'); }} />

        <section className="panel oscillator-panel" aria-label="Осциллятор">
          <SectionHeading index="01" title="Осциллятор" term="OSCILLATOR · ИСТОЧНИК ЗВУКА" hint="Осциллятор создаёт периодические колебания. Frequency задаёт высоту, Amplitude — уровень, Waveform — тембр.">
            <button className={`play-button ${audio.auditionGateOpen ? 'is-playing' : ''}`} onClick={togglePlay} aria-label={audio.auditionGateOpen ? 'Остановить тон Play' : 'Включить тон Play'} title="Play и Stop управляют отдельным тоном. Клавиши продолжают звучать; Panic останавливает все голоса."><span className={audio.auditionGateOpen ? 'stop-symbol' : 'play-symbol'} aria-hidden="true" />{audio.auditionGateOpen ? 'Stop' : 'Play'}<span className="play-label">{audio.auditionGateOpen ? 'Отпустить Play' : 'Слушать тон'}</span></button>
          </SectionHeading>
          <div className="oscillator-controls"><div className="waveform-control"><div className="control-label">Форма волны <span className="term">Classic Waveform</span><MidiLearnButton target="waveform" /><Hint text="Эти четыре кнопки включают Classic Oscillator. Аддитивный тембр строится в Harmonic Builder ниже. Значки условные; графики выше измеряют реальный сигнал." /></div><div className="waveform-options" role="group" aria-label="Форма волны">{WAVES.map(wave => <button key={wave.id} aria-pressed={params.mode === 'classic' && params.waveform === wave.id} title={wave.hint} onClick={() => selectClassic(wave.id)}><WaveIcon waveform={wave.id} /><strong>{wave.english}</strong><span>{wave.name}</span></button>)}</div></div>
            <div className="oscillator-parameters"><Parameter midiTarget="frequency" name="Частота" term="Frequency" hint="Число колебаний в секунду, в герцах (Hz). Больше частота — выше тон. Frequency управляет отдельным тоном Play. Высоты удерживаемых клавиш не меняются." value={params.frequency} min={20} max={20000} step={0.1} unit="Hz" precision={2} logarithmic onChange={manualFrequency} endpoints={['20 Hz · низко', '20 kHz · высоко']} />
            <Parameter midiTarget="amplitude" name="Амплитуда" term="Amplitude" hint="Уровень сигнала до выхода: 100% = множитель 1. Влияет на воспринимаемую громкость. Итоговую громкость также задают огибающая, фильтр и ваши колонки." value={params.amplitude * 100} min={0} max={100} step={1} unit="%" precision={0} onChange={value => change('amplitude', value / 100)} /></div></div>
          <div className="sound-properties"><span><i className="property-dot pitch-dot" /><b>Частота</b> → высота</span><span><i className="property-dot level-dot" /><b>Амплитуда</b> → громкость</span><span><i className="property-dot timbre-dot" /><b>Форма волны</b> → тембр</span></div>
        </section>

        <HarmonicBuilder params={params} onChange={editHarmonics} onMode={selectMode} onTemplate={loadHarmonicTemplate}
          onCompare={compareClassic} onReset={resetHarmonics} onSave={saveHarmonicPatch} onLoad={loadHarmonicPatch}
          patchStatus={patchStatus} referenceFrequency={referenceFrequency} referenceLabel={referenceLabel} sampleRate={getAnalysis()?.sampleRate ?? 48000} />

        <section className="panel envelope-panel" aria-label="Огибающая ADSR">
          <SectionHeading index="02" title="Характер звука" term="ОГИБАЮЩАЯ · ADSR" hint="ADSR управляет громкостью ноты во времени. Attack — нарастание, Decay — спад, Sustain — уровень удержания, Release — затухание после отпускания."><div className="envelope-presets" role="group" aria-label="Примеры огибающей">{ENVELOPE_PRESETS.map(preset => <button title={preset.description} key={preset.id} onClick={() => { change('adsr', { ...preset.adsr }); setNotice(`${preset.name}: ${preset.description} Отпустите и снова нажмите клавишу.`); }}>{preset.name}</button>)}</div></SectionHeading>
          <div className="envelope-layout"><EnvelopeGraph adsr={params.adsr} /><div className="envelope-parameters"><Parameter midiTarget="adsr.attack" name="Нарастание" term="Attack" hint="Время от Note On до максимального уровня. Длинный Attack даёт плавное появление. Для сравнения заново нажмите ноту." value={params.adsr.attack} min={0.005} max={4} step={0.005} unit="с" precision={3} onChange={attack => change('adsr', { ...params.adsr, attack })} />
          <Parameter midiTarget="adsr.decay" name="Спад" term="Decay" hint="Время снижения от пика до уровня Sustain. Для сравнения характера заново нажмите ноту." value={params.adsr.decay} min={0.01} max={3} step={0.01} unit="с" onChange={decay => change('adsr', { ...params.adsr, decay })} />
          <Parameter midiTarget="adsr.sustain" name="Удержание" term="Sustain" hint="Уровень во время удержания ноты — процент от пика, а не длительность. 0% позволяет получить короткий удар даже при удержании." value={params.adsr.sustain * 100} min={0} max={100} step={1} unit="%" precision={0} onChange={sustain => change('adsr', { ...params.adsr, sustain: sustain / 100 })} />
          <Parameter midiTarget="adsr.release" name="Затухание" term="Release" hint="Время плавного снижения до тишины после Note Off. Отпустите клавишу, чтобы услышать Release только её голоса. Stop отпускает отдельный тон Play." value={params.adsr.release} min={0.01} max={5} step={0.01} unit="с" onChange={release => change('adsr', { ...params.adsr, release })} /></div></div>
        </section>

        <div className="modulation-panels"><section className="panel filter-panel" aria-label="Фильтр низких частот">
          <SectionHeading index="03" title="Фильтр" term="LOW-PASS FILTER" hint="Пропускает низкие частоты и плавно ослабляет высокие. Гармоники исчезают постепенно, поэтому яркость тембра уменьшается."><Toggle midiTarget="filter.bypass" checked={params.filter.bypass} onChange={bypass => change('filter', { ...params.filter, bypass })} label="Bypass" hint="Включённый Bypass направляет сигнал в обход фильтра. Выключите его, чтобы услышать Cutoff и Q." /></SectionHeading>
          <div className="two-parameters"><Parameter midiTarget="filter.cutoff" name="Частота среза" term="Cutoff" hint="Область, выше которой фильтр ослабляет частоты. Пунктирная отметка на спектре показывает базовый Cutoff; LFO может двигать фактический срез вокруг него." value={params.filter.cutoff} min={20} max={20000} step={1} unit="Hz" precision={0} logarithmic disabled={params.filter.bypass} onChange={cutoff => change('filter', { ...params.filter, cutoff })} /><Parameter midiTarget="filter.q" name="Резонанс" term="Q" hint="Безразмерная добротность фильтра. Повышение Q подчёркивает частоты возле среза; может увеличить уровень сигнала." value={params.filter.q} min={0.1} max={10} step={0.1} unit="Q" precision={3} disabled={params.filter.bypass} onChange={q => change('filter', { ...params.filter, q })} /></div>
          <p className="panel-footnote">{params.filter.bypass ? 'Фильтр обойдён — сигнал проходит целиком.' : 'Низкие частоты проходят, верхние гармоники ослабевают.'}</p>
        </section>

        <section className="panel lfo-panel" aria-label="Низкочастотный осциллятор LFO">
          <SectionHeading index="04" title="Движение" term="LOW FREQUENCY OSCILLATOR · LFO" hint="Медленный осциллятор управляет другим параметром и не подключён к выходу как отдельный слышимый тон."><Toggle midiTarget="lfo.enabled" checked={params.lfo.enabled} onChange={enabled => change('lfo', { ...params.lfo, enabled })} label="LFO" hint="Включает или выключает модуляцию выбранного параметра." /></SectionHeading>
          <div className="two-parameters"><Parameter midiTarget="lfo.rate" name="Скорость" term="Rate" hint="Число циклов модуляции за секунду. 1 Hz — одно движение туда и обратно за секунду." value={params.lfo.rate} min={0.1} max={12} step={0.01} unit="Hz" precision={2} logarithmic disabled={!params.lfo.enabled} onChange={rate => change('lfo', { ...params.lfo, rate })} /><Parameter midiTarget="lfo.depth" name="Глубина" term="Depth" hint="Размах модуляции. 100% даёт ±100 центов для Pitch (один полутон) или ±2400 центов для среза фильтра (две октавы). Нулевая глубина не меняет звук." value={params.lfo.depth * 100} min={0} max={100} step={1} unit="%" precision={0} disabled={!params.lfo.enabled} onChange={depth => change('lfo', { ...params.lfo, depth: depth / 100 })} /></div>
          <div className="lfo-target"><span>Куда направить <span className="term">Target</span><MidiLearnButton target="lfo.target" /><Hint text="Pitch меняет высоту тона — вибрато. Filter Cutoff двигает срез фильтра и меняет яркость. Для второго варианта выключите Bypass." /></span><div role="group" aria-label="Цель LFO"><button aria-pressed={params.lfo.target === 'pitch'} onClick={() => change('lfo', { ...params.lfo, target: 'pitch' })}>Высота <span>Pitch</span></button><button aria-pressed={params.lfo.target === 'filter'} onClick={() => change('lfo', { ...params.lfo, target: 'filter' })}>Срез <span>Filter Cutoff</span></button></div></div>
          {lfoFilterBypassed && <p className="inline-notice">Выключите Bypass фильтра, чтобы услышать модуляцию среза.</p>}
        </section></div>

        <Piano octave={octave} setOctave={next => { releaseLocalNotes(); setOctave(next) }} activeMidis={activeMidis} activeNotes={activeNotes} heldCount={heldNotes.length} voiceCount={voices.length} frequency={params.frequency} onDown={pressNote} onUp={releaseNote} />
        <PhraseRecorder controller={phraseController} />
        <div className="status-strip" role="status"><span className="status-marker" />{notice}<span className="escape-tip"><kbd>Esc</kbd> остановить</span></div>
        {error && <div className="error-message" role="alert">{error}</div>}
      </div><LessonPanel onLoad={loadLesson} loadedLesson={loadedLesson} /></div>
    </main>
    <footer className="app-footer"><span>SOUND LAB <span>0.5</span> · Пространство для любопытства</span><span>Web Audio + Web MIDI <span>•</span> Всё работает в вашем браузере</span></footer>
  </div></MidiLearnProvider>
}
