import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PhraseController } from '../phrases/usePhraseRecorder'
import type { Phrase, PhraseNote, Quantization } from '../phrases/types'
import { MAX_PHRASE_NOTES, MAX_PHRASE_SECONDS } from '../phrases/types'
import { importPhraseJson, importLibraryJson, MAX_IMPORT_BYTES, MAX_LIBRARY_IMPORT_BYTES } from '../phrases/storage'
import { midiName } from './Piano'
import './phrase-recorder.css'

const formatTime = (seconds: number) => {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${Math.floor(safe % 60).toString().padStart(2, '0')}.${Math.floor(safe % 1 * 1000).toString().padStart(3, '0')}`
}
const shortTime = (seconds: number) => `${Number(seconds.toFixed(2))} с`
const statusLabels = { stopped: 'Остановлено', recording: 'Запись', 'count-in': 'Отсчёт · 1 такт', playing: 'Воспроизведение', paused: 'Пауза' }
const quantizations: Quantization[] = ['off', '1/4', '1/8', '1/16', '1/32']

function PianoRoll({ notes, duration, position, bpm, tempo, running, compact = false }: {
  notes: PhraseNote[]; duration: number; position: number; bpm: number; tempo: boolean; running: boolean; compact?: boolean
}) {
  const id = useId()
  const scroll = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const shownDuration = Math.max(1, duration)
  const graph = useMemo(() => {
    const pitches = notes.map(note => note.midi)
    const low = pitches.length ? Math.max(0, Math.floor((Math.min(...pitches) - 1) / 12) * 12) : 48
    const high = pitches.length ? Math.min(127, Math.max(low + 11, Math.ceil((Math.max(...pitches) + 2) / 12) * 12 - 1)) : 71
    const rows = high - low + 1
    const rowHeight = Math.max(3, Math.min(compact ? 11 : 16, (compact ? 85 : 400) / rows))
    const left = 54
    const width = 900 * zoom
    const innerWidth = width - left - 16
    const height = rows * rowHeight + 40
    const x = (time: number) => left + Math.min(shownDuration, Math.max(0, time)) / shownDuration * innerWidth
    const y = (midi: number) => 24 + (high - midi) * rowHeight
    let interval = tempo ? 60 / bpm : 1
    while (shownDuration / interval > 80) interval *= 2
    const ticks = Array.from({ length: Math.floor(shownDuration / interval) + 1 }, (_, index) => index * interval)
    const rowsSvg = Array.from({ length: rows }, (_, index) => high - index).map(midi => <g key={midi}>
      <rect x={left} y={y(midi)} width={innerWidth} height={rowHeight} fill={[1, 3, 6, 8, 10].includes(midi % 12) ? '#101923' : '#17222d'} />
      <line x1={left} x2={width - 16} y1={y(midi)} y2={y(midi)} stroke="#2b3946" strokeWidth=".5" />
      {((!compact && rows <= 36) || midi % 12 === 0) && <text x="43" y={y(midi) + rowHeight * .72} textAnchor="end" fill={midi % 12 === 0 ? '#b1c4d4' : '#8097ac'} fontSize={compact ? 9 : Math.max(5, Math.min(9, rowHeight * .7))}>{midiName(midi)}</text>}
    </g>)
    const gridSvg = ticks.map(time => <g key={time}>
      <line x1={x(time)} x2={x(time)} y1="24" y2={height - 16} stroke="#405263" strokeWidth=".6" strokeDasharray="2 3" />
      <text x={x(time)} y="15" fill="#8ba2b7" fontSize="9">{tempo ? `${Math.floor(time / (60 / bpm) / 4) + 1}.${Math.round(time / (60 / bpm) % 4) + 1}` : `${Number(time.toFixed(2))}с`}</text>
    </g>)
    const notesSvg = notes.map(note => <rect className="phrase-roll-note" key={note.id} data-midi={note.midi} data-velocity={note.velocity} data-start={note.start} data-end={note.end} x={x(note.start)} y={y(note.midi) + .6} width={Math.max(1.5, x(note.end) - x(note.start))} height={Math.max(2, rowHeight - 1.2)} rx="1.5" fill="#b9ee84" fillOpacity={.24 + note.velocity / 127 * .76}>
      <title>{midiName(note.midi)} · MIDI {note.midi} · Velocity {note.velocity} · {shortTime(note.start)} — {shortTime(note.end)} · {note.sourceName}{note.channel === null ? '' : ` · канал ${note.channel}`}</title>
    </rect>)
    return { width, height, x, rowsSvg, gridSvg, notesSvg, low, high }
  }, [notes, shownDuration, bpm, tempo, zoom, compact])
  useEffect(() => {
    const viewport = scroll.current
    if (!viewport || !running) return
    const cursor = graph.x(position) / graph.width * viewport.scrollWidth
    if (cursor > viewport.scrollLeft + viewport.clientWidth - 35 || cursor < viewport.scrollLeft) viewport.scrollLeft = Math.max(0, cursor - viewport.clientWidth / 3)
  }, [position, running, graph])
  return <div className="phrase-roll">
    <div className="phrase-roll-toolbar"><p>{notes.length} нот · {midiName(graph.low)}—{midiName(graph.high)} · {shortTime(duration)}</p><label>Масштаб <select aria-label="Масштаб Piano Roll" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[1, 2, 4, 8].map(value => <option value={value} key={value}>×{value}</option>)}</select></label></div>
    <div className="phrase-roll-scroll" ref={scroll} tabIndex={0} aria-label="Прокрутка Piano Roll">
      <svg className="phrase-roll-graph" style={{ width: `${zoom * 100}%`, height: graph.height }} viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="none" role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>Piano Roll — записанные ноты</title><desc id={`${id}-description`}>Время по горизонтали, высота ноты по вертикали. {notes.length} нот, длительность {shortTime(duration)}. Яркость показывает Velocity. График только для просмотра; курсор {shortTime(position)}.</desc>
        {graph.rowsSvg}{graph.gridSvg}{graph.notesSvg}
        <line className="phrase-roll-cursor" x1={graph.x(position)} x2={graph.x(position)} y1="22" y2={graph.height - 15} stroke="#65d8ed" strokeWidth="1.5" />
      </svg>
    </div>
    <p className="phrase-help">Светлее — выше Velocity. Аккорды видны друг над другом. Только просмотр: изменение сетки не меняет исходные ноты.</p>
  </div>
}

export function PhraseRecorder({ controller, compact = false, transportTarget = null }: { controller: PhraseController; compact?: boolean; transportTarget?: HTMLElement | null }) {
  const [name, setName] = useState('')
  const [bpmText, setBpmText] = useState(String(controller.bpm))
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [expandedRoll, setExpandedRoll] = useState(false)
  const [showMigration, setShowMigration] = useState(() => {
    if (!import.meta.env.PROD) return false
    try { return localStorage.getItem('sound-lab.production-migration.v1') !== '1' } catch { return true }
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  const busy = controller.status === 'recording' || controller.status === 'count-in'
  const playback = controller.status === 'playing' || controller.status === 'paused'
  const hasNotes = Boolean(controller.draft?.notes.length)
  const library = useMemo(() => [...controller.library].sort((a, b) => b.createdAt - a.createdAt), [controller.library])
  useEffect(() => { setName(controller.draft?.name ?? '') }, [controller.draft?.id, controller.draft?.name])
  useEffect(() => { setBpmText(String(controller.bpm)) }, [controller.bpm])
  useEffect(() => {
    if (!renameId || library.some(phrase => phrase.id === renameId)) return
    setRenameId(null)
    controller.setPendingEdit('rename', false)
  }, [renameId, library, controller])
  const beginRecord = () => {
    if (hasNotes && !window.confirm('Начать новую запись? Текущий черновик будет заменён. Сохранённые фразы останутся в библиотеке.')) return
    controller.record()
  }
  const play = (phrase = controller.draft) => {
    if (!phrase) return
    if (controller.status !== 'paused' && controller.soundChoice === 'original' && phrase.sound && controller.liveVoices > 0 && !window.confirm('Original Sound заменит настройки синтезатора и изменит тембр звучащих живых нот. Продолжить?')) return
    controller.play()
  }
  const clear = () => {
    if (controller.draft && !window.confirm('Очистить текущий черновик? Сохранённые фразы останутся в библиотеке.')) return
    controller.clear()
  }
  const confirmReplace = () => !hasNotes || controller.selectedId !== null || window.confirm('Заменить несохранённый черновик? Сначала сохраните его в My Phrases, если он нужен.')
  const selectSaved = (phrase: Phrase) => { if (confirmReplace()) controller.select(phrase.id) }
  const playSaved = (phrase: Phrase) => { if (confirmReplace()) { controller.select(phrase.id); play(phrase) } }
  const commitBpm = () => {
    const value = Number(bpmText)
    if (Number.isFinite(value) && value >= 30 && value <= 300) controller.setBpm(value)
    else setBpmText(String(controller.bpm))
    controller.setPendingEdit('bpm', false)
  }
  const importFile = async (file: File | undefined) => {
    setImportError(null)
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) { setImportError(`JSON-файл больше ${MAX_IMPORT_BYTES / 1024 / 1024} MiB. Выберите файл меньшего размера.`); if (fileInput.current) fileInput.current.value = ''; return }
    const release = controller.beginDataOperation('import')
    try {
      const raw = await file.text()
      importPhraseJson(raw) // Validate before asking to replace an unsaved draft.
      if (confirmReplace()) await controller.importJson(raw)
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : 'Не удалось прочитать JSON-файл.') }
    finally { release(); if (fileInput.current) fileInput.current.value = '' }
  }
  const importLibraryFile = async (file: File | undefined) => {
    setImportError(null)
    if (!file) return
    const release = controller.beginDataOperation('import')
    try {
      if (file.size > MAX_LIBRARY_IMPORT_BYTES) throw new Error('Library JSON больше 64 MiB.')
      const raw = await file.text(), backup = importLibraryJson(raw)
      const replacement = backup.draft ? ' Текущий черновик будет заменён черновиком из копии.' : ''
      if (window.confirm(`Добавить ${backup.phrases.length} фраз из резервной копии? Существующие фразы не перезаписываются.${replacement}`)) await controller.importLibraryJson(raw)
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : 'Не удалось прочитать Library JSON.') }
    finally { release(); if (libraryInput.current) libraryInput.current.value = '' }
  }
  const transport = <div className="phrase-transport-combined"><div className="phrase-transport-main"><div className="phrase-buttons"><button className="phrase-record-button" aria-label="Record phrase" disabled={busy || playback || controller.importBusy} onClick={beginRecord}><span aria-hidden="true">●</span> Record</button><button aria-label="Stop phrase" disabled={controller.status === 'stopped' && !controller.preparing} onClick={controller.stop}>■ Stop</button><button aria-label={controller.status === 'paused' ? 'Resume phrase' : 'Play phrase'} disabled={busy || controller.dataBusy || !hasNotes || controller.status === 'playing' || controller.preparing} onClick={() => play()}>▶ {controller.status === 'paused' ? 'Resume' : 'Play'}</button><button aria-label="Pause phrase" disabled={controller.status !== 'playing'} onClick={controller.pause}>Ⅱ Pause</button><button aria-label="Clear phrase" disabled={busy || playback || controller.dataBusy || !controller.draft} onClick={clear}>Clear</button></div><output className="phrase-timer" aria-label="Время фразы">{formatTime(busy ? controller.elapsed : controller.position)}<small> / {formatTime(controller.duration)}</small></output></div>{compact && <div className="studio-transport-options"><label>BPM <input aria-label="Studio BPM" type="number" min="30" max="300" value={bpmText} disabled={busy || playback || controller.dataBusy} onChange={event => { setBpmText(event.target.value); controller.setPendingEdit('bpm', event.target.value !== String(controller.bpm)) }} onBlur={commitBpm} onKeyDown={event => { if (event.key === 'Enter') { commitBpm(); event.currentTarget.blur() } }} /></label><label><input aria-label="Studio Loop" type="checkbox" checked={controller.loop} onChange={event => controller.setLoop(event.target.checked)} />Loop</label><span className={busy ? 'studio-recording-indicator' : ''} role="status">{controller.preparing ? 'Подготовка' : statusLabels[controller.status]}</span></div>}</div>
  const migrationNotice = showMigration ? <aside className="phrase-migration" aria-label="Перенос записей в PWA"><p><strong>Перенесите записи с локального адреса.</strong> В прежней SOUND LAB на localhost или 127.0.0.1 нажмите «Export library JSON», сохраните файл и откройте его здесь через «Import library JSON». Эти адреса и опубликованная PWA используют разные хранилища; записи автоматически не переносятся.</p><p>Музыкальные записи хранятся локально на этом устройстве, а не в GitHub. Веб-версия и установленное приложение одного адреса используют одну библиотеку в одном профиле браузера. Очистка данных сайта или удаление профиля удалит записи: сохраняйте JSON-копии.</p><button onClick={() => { try { localStorage.setItem('sound-lab.production-migration.v1', '1') } catch { /* Notice may reappear if storage is unavailable. */ } setShowMigration(false) }}>Понятно</button></aside> : null
  const saveControls = <div className="phrase-save"><label>Название фразы<input aria-label="Название фразы" value={name} maxLength={120} placeholder="Например: идея для куплета" disabled={busy || playback || controller.dataBusy} onChange={event => { setName(event.target.value); controller.setPendingName(event.target.value) }} /></label><button aria-label="Save phrase" disabled={!hasNotes || busy || playback || controller.dataBusy || !name.trim()} onClick={() => controller.save(name.trim())}>Save phrase</button><p>До {MAX_PHRASE_SECONDS / 60} минут и {MAX_PHRASE_NOTES.toLocaleString('ru-RU')} нот в одной фразе.</p></div>
  return <section className={`panel phrase-recorder ${compact ? 'phrase-compact' : ''} ${expandedRoll ? 'roll-expanded' : ''}`} aria-label="Phrase Recorder">
    <div className="section-heading phrase-heading"><div className="section-title"><span className="section-index">●</span><div><h2>Сохраните музыкальную мысль</h2><span className="eyebrow">PHRASE RECORDER · НОТЫ И VELOCITY</span></div></div><span className={`phrase-status ${busy ? 'is-recording' : ''}`} role="status">{controller.preparing ? 'Подготовка аудио' : statusLabels[controller.status]}</span></div>
    <p className="phrase-intro">Запишите мелодию или аккорды с MIDI-клавиатуры, клавиш компьютера и виртуального пианино. Это запись нот и Velocity: аудио, CC, Pitch Bend и изменения ручек не записываются.</p>
    {!compact && migrationNotice}
    {compact && <><div className="studio-phrase-quick"><label>MY PHRASES <select aria-label="Быстрый выбор фразы" value={controller.selectedId ?? ''} disabled={busy || playback || controller.dataBusy} onChange={event => { const phrase = library.find(item => item.id === event.target.value); if (phrase) selectSaved(phrase) }}><option value="">Текущий черновик</option>{library.map(phrase => <option key={phrase.id} value={phrase.id}>{phrase.name}</option>)}</select></label><span className={controller.hasUnsavedChanges ? 'is-unsaved' : ''} role="status">{controller.hasUnsavedChanges ? '● Несохранено' : controller.selectedId ? 'В библиотеке' : 'Черновик'}</span><button aria-label={expandedRoll ? 'Свернуть Piano Roll' : 'Развернуть Piano Roll'} aria-pressed={expandedRoll} onClick={() => setExpandedRoll(value => !value)}>{expandedRoll ? '↙ Roll' : '↗ Roll'}</button></div>{saveControls}</>}
    <details className="phrase-section phrase-transport" open={!compact}>
      <summary>{compact ? 'RECORDER OPTIONS' : 'PHRASE RECORDER'} <span>запись и воспроизведение</span></summary>
      {compact && transportTarget ? createPortal(transport, transportTarget) : transport}
      {playback && <p className="phrase-help phrase-transport-help">Чтобы начать запись, нажмите Stop. Наложение новой записи на воспроизведение не поддерживается.</p>}
      <div className="phrase-options"><fieldset className="phrase-mode"><legend>Режим записи</legend><button aria-pressed={controller.recordingMode === 'free'} disabled={busy || playback || controller.dataBusy} onClick={() => controller.setRecordingMode('free')}>Free</button><button aria-pressed={controller.recordingMode === 'tempo'} disabled={busy || playback || controller.dataBusy} onClick={() => controller.setRecordingMode('tempo')}>Tempo</button></fieldset><label>BPM <input aria-label="Phrase BPM" type="number" min="30" max="300" step="1" value={bpmText} disabled={busy || playback || controller.dataBusy} onChange={event => { setBpmText(event.target.value); controller.setPendingEdit('bpm', event.target.value !== String(controller.bpm)) }} onBlur={commitBpm} onKeyDown={event => { if (event.key === 'Enter') { commitBpm(); event.currentTarget.blur() } }} /><small>4/4</small></label><label className="phrase-checkbox"><input type="checkbox" checked={controller.metronome} disabled={busy || playback || controller.dataBusy || controller.recordingMode !== 'tempo'} onChange={event => controller.setMetronome(event.target.checked)} />Метроном</label><label className="phrase-checkbox"><input type="checkbox" checked={controller.countIn} disabled={busy || playback || controller.dataBusy || controller.recordingMode !== 'tempo'} onChange={event => controller.setCountIn(event.target.checked)} />Отсчёт 1 такт</label><label className="phrase-checkbox"><input type="checkbox" checked={controller.loop} onChange={event => controller.setLoop(event.target.checked)} />Loop</label>{controller.recordingMode === 'free' && <p className="phrase-help">Метроном и отсчёт доступны в Tempo.</p>}</div>
      <div className="phrase-edit-options"><label>Квантизация <select aria-label="Квантизация фразы" value={controller.quantization} disabled={busy || playback || controller.dataBusy} onChange={event => controller.setQuantization(event.target.value as Quantization)}>{quantizations.map(value => <option value={value} key={value}>{value === 'off' ? 'Off' : value}</option>)}</select></label><fieldset className="phrase-mode"><legend>Ноты для просмотра и Play</legend><button aria-pressed={controller.view === 'original'} disabled={busy || playback || controller.dataBusy} onClick={() => controller.setView('original')}>Original</button><button aria-pressed={controller.view === 'quantized'} disabled={busy || playback || controller.dataBusy} onClick={() => controller.setView('quantized')}>Quantized</button></fieldset><label>Звук при Play <select aria-label="Звук воспроизведения фразы" value={controller.soundChoice} disabled={busy || playback || controller.dataBusy} onChange={event => controller.setSoundChoice(event.target.value as 'current' | 'original')}><option value="current">Current Sound</option><option value="original" disabled={!controller.draft?.sound}>Original Sound</option></select></label><label className="phrase-checkbox"><input type="checkbox" checked={controller.saveSound} disabled={busy || playback || controller.dataBusy} onChange={event => controller.setSaveSound(event.target.checked)} />Сохранить настройки звука</label></div>
      <p className="phrase-help phrase-transport-help">Квантизация создаёт отдельную версию времени нот; Original остаётся неизменным. Current Sound играет текущим тембром. Original Sound восстанавливает сохранённые настройки перед Play.</p>
      {!compact && saveControls}
    </details>
    <details className="phrase-section" open><summary>PIANO ROLL <span>{controller.view === 'original' ? 'Original' : `Quantized · ${controller.quantization === 'off' ? 'Off' : controller.quantization}`} · только просмотр</span></summary><PianoRoll notes={controller.displayNotes} duration={controller.duration} position={busy ? controller.elapsed : controller.position} bpm={controller.draft?.bpm ?? controller.bpm} tempo={(controller.draft?.recordingMode ?? controller.recordingMode) === 'tempo'} running={busy || controller.status === 'playing'} compact={compact && !expandedRoll} /></details>
    <details className="phrase-section phrase-library" open={!compact}><summary>MY PHRASES <span>{library.length} сохранено · сначала новые</span></summary>
      {compact && migrationNotice}
      <div className="phrase-library-actions"><button aria-label="Export phrase MIDI" disabled={!hasNotes || busy || controller.dataBusy} onClick={controller.exportMidi}>Export MIDI</button><button aria-label="Export phrase JSON" disabled={!hasNotes || busy || controller.dataBusy} onClick={controller.exportJson}>Export JSON</button><label className={`phrase-import ${busy || playback || controller.dataBusy ? 'is-disabled' : ''}`}>Import JSON<input ref={fileInput} aria-label="Import phrase JSON" type="file" accept=".json,application/json" disabled={busy || playback || controller.dataBusy} onChange={event => { void importFile(event.target.files?.[0]) }} /></label><button aria-label="Export phrase library JSON" disabled={busy || controller.dataBusy || (!library.length && !hasNotes)} onClick={controller.exportLibraryJson}>Export library JSON</button><label className={`phrase-import ${busy || playback || controller.dataBusy ? 'is-disabled' : ''}`}>Import library JSON<input ref={libraryInput} aria-label="Import phrase library JSON" type="file" accept=".json,application/json" disabled={busy || playback || controller.dataBusy} onChange={event => { void importLibraryFile(event.target.files?.[0]) }} /></label><span>JSON ≤ {MAX_IMPORT_BYTES / 1024 / 1024} MiB · MIDI содержит ноты, Velocity и темп</span></div>
      {library.length === 0 ? <p className="phrase-empty">Пока пусто. Запишите фразу и нажмите Save phrase — она сохранится в этом браузере.</p> : <ul className="phrase-list">{library.map(phrase => <li className={controller.selectedId === phrase.id ? 'is-selected' : ''} key={phrase.id}>
        <div className="phrase-list-info">{renameId === phrase.id ? <form onSubmit={event => { event.preventDefault(); if (renameText.trim()) { controller.rename(phrase.id, renameText.trim()); setRenameId(null); controller.setPendingEdit('rename', false) } }}><input aria-label={`Новое название: ${phrase.name}`} value={renameText} maxLength={120} autoFocus onChange={event => { setRenameText(event.target.value); controller.setPendingEdit('rename', event.target.value !== phrase.name) }} /><button type="submit" disabled={!renameText.trim() || controller.dataBusy}>Сохранить имя</button><button type="button" onClick={() => { setRenameId(null); controller.setPendingEdit('rename', false) }}>Отмена</button></form> : <button className="phrase-name" aria-label={`Открыть фразу: ${phrase.name}`} disabled={busy || playback || controller.dataBusy} onClick={() => selectSaved(phrase)}>{phrase.name}</button>}<p><time dateTime={new Date(phrase.createdAt).toISOString()}>{new Date(phrase.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> · {shortTime(phrase.duration)} · {phrase.bpm} BPM · {phrase.notes.length} нот{phrase.sound ? ' · со звуком' : ''}</p></div>
        <div className="phrase-list-buttons"><button aria-label={`Play saved phrase: ${phrase.name}`} disabled={busy || playback || controller.dataBusy} onClick={() => playSaved(phrase)}>▶ Play</button><button aria-label={`Rename phrase: ${phrase.name}`} disabled={busy || playback || controller.dataBusy} onClick={() => { setRenameId(phrase.id); setRenameText(phrase.name) }}>Rename</button><button aria-label={`Duplicate phrase: ${phrase.name}`} disabled={busy || playback || controller.dataBusy} onClick={() => controller.duplicate(phrase.id)}>Copy</button><button aria-label={`Delete phrase: ${phrase.name}`} disabled={busy || playback || controller.dataBusy} onClick={() => { if (window.confirm(`Удалить «${phrase.name}» из библиотеки? Это действие нельзя отменить.`)) controller.remove(phrase.id) }}>Delete</button></div>
      </li>)}</ul>}
    </details>
    {(controller.error || importError) && <p className="phrase-error" role="alert">{importError || controller.error}</p>}
    {controller.notice && <p className="phrase-notice" role="status">{controller.notice}</p>}
    <p className="phrase-storage-note">Музыкальные записи хранятся локально на этом устройстве, а не в GitHub. IndexedDB сохраняет фразы при обычных обновлениях. Очистка данных сайта или удаление профиля браузера удаляет библиотеку. Export library JSON сохраняет все фразы, черновик и снимки звука (до 64 MiB); Import library JSON добавляет их без перезаписи существующих фраз. Для переноса с localhost в PWA экспортируйте файл на прежнем адресе и импортируйте здесь. MIDI Learn и Harmonic Patch в этот файл не входят.</p>
  </section>
}
