import { useCallback, useEffect, useRef, useState } from 'react'
import { SynthEngine } from './audio/SynthEngine'
import { Hint, Parameter, SectionHeading, Toggle, WaveIcon } from './components/Controls'
import { KEY_CODES, Piano, midiFrequency } from './components/Piano'
import { LessonPanel } from './components/LessonPanel'
import { ENVELOPE_PRESETS, PRESETS } from './content/library'
import { SignalVisualizers } from './visuals/SignalVisualizers'
import { EnvelopeGraph } from './visuals/EnvelopeGraph'
import { copyParams, DEFAULT_PARAMS } from './types'
import type { Lesson, SynthParams, Waveform } from './types'

const WAVES: { id: Waveform; name: string; english: string; hint: string }[] = [
  { id: 'sine', name: 'Синусоида', english: 'Sine', hint: 'Чистый основной тон, практически без дополнительных гармоник.' },
  { id: 'square', name: 'Прямоугольная', english: 'Square', hint: 'Полый, яркий звук. Содержит преимущественно нечётные гармоники.' },
  { id: 'sawtooth', name: 'Пилообразная', english: 'Sawtooth', hint: 'Яркий, насыщенный звук. Содержит чётные и нечётные гармоники.' },
  { id: 'triangle', name: 'Треугольная', english: 'Triangle', hint: 'Мягкий звук. Нечётные гармоники затихают быстрее, чем у Square.' },
]

export default function App() {
  const [params, setParams] = useState<SynthParams>(() => copyParams(DEFAULT_PARAMS))
  const paramsRef = useRef(params)
  const engineRef = useRef<SynthEngine | null>(null)
  const [audio, setAudio] = useState({ contextState: 'not-started', gateOpen: false, audible: false })
  const [error, setError] = useState<string | null>(null)
  const [octave, setOctave] = useState(3)
  const [activeMidi, setActiveMidi] = useState<number | null>(null)
  const activeMidiRef = useRef<number | null>(null)
  const [presetId, setPresetId] = useState('')
  const [loadedLesson, setLoadedLesson] = useState<string | null>(null)
  const [notice, setNotice] = useState('Выберите форму волны и нажмите Play. Начальная громкость — 25%.')
  const held = useRef(new Map<string, number>())
  const latched = useRef(false)

  const refreshAudio = useCallback(() => {
    const next = engineRef.current?.getState() ?? { contextState: 'not-started', gateOpen: false, audible: false }
    setAudio(previous => previous.contextState === next.contextState && previous.gateOpen === next.gateOpen && previous.audible === next.audible ? previous : next)
  }, [])

  useEffect(() => {
    const engine = new SynthEngine(paramsRef.current)
    engineRef.current = engine
    const timer = window.setInterval(refreshAudio, 80)
    return () => {
      window.clearInterval(timer)
      held.current.clear()
      activeMidiRef.current = null
      engineRef.current = null
      void engine.dispose()
    }
  }, [refreshAudio])

  const applyParams = useCallback((next: SynthParams, custom = true) => {
    paramsRef.current = copyParams(next)
    engineRef.current?.setParams(paramsRef.current)
    setParams(paramsRef.current)
    if (custom) { setPresetId(''); setLoadedLesson(null) }
  }, [])

  const change = <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => applyParams({ ...paramsRef.current, [key]: value })

  const start = useCallback((frequency: number) => {
    setError(null)
    const engine = engineRef.current
    if (!engine) return
    void engine.noteOn(frequency).then(refreshAudio).catch((reason: unknown) => {
      latched.current = false
      held.current.clear()
      activeMidiRef.current = null
      setActiveMidi(null)
      setError(`Не удалось включить аудио: ${reason instanceof Error ? reason.message : String(reason)}. Проверьте разрешение звука в браузере и попробуйте Play снова.`)
      refreshAudio()
    })
  }, [refreshAudio])

  const stopAll = useCallback((immediate = false) => {
    held.current.clear()
    latched.current = false
    activeMidiRef.current = null
    setActiveMidi(null)
    if (immediate) engineRef.current?.panic()
    else engineRef.current?.noteOff()
    refreshAudio()
  }, [refreshAudio])

  const pressNote = useCallback((id: string, midi: number) => {
    if (held.current.has(id)) return
    held.current.set(id, midi)
    latched.current = false
    const frequency = midiFrequency(midi)
    applyParams({ ...paramsRef.current, frequency })
    activeMidiRef.current = midi
    setActiveMidi(midi)
    start(frequency)
  }, [applyParams, start])

  const releaseNote = useCallback((id: string) => {
    if (!held.current.delete(id)) return
    const remaining = [...held.current.values()]
    if (remaining.length) {
      const midi = remaining[remaining.length - 1]
      // Last-note priority: releasing an older key must not retrigger the current one.
      if (activeMidiRef.current !== midi) {
        const frequency = midiFrequency(midi)
        applyParams({ ...paramsRef.current, frequency })
        start(frequency)
      }
      activeMidiRef.current = midi
      setActiveMidi(midi)
    } else if (!latched.current) {
      activeMidiRef.current = null
      setActiveMidi(null)
      engineRef.current?.noteOff()
      refreshAudio()
    }
  }, [applyParams, start, refreshAudio])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Escape') { stopAll(true); setNotice('Звук остановлен клавишей Esc.'); return }
      const target = event.target as HTMLElement | null
      if (event.ctrlKey || event.metaKey || event.altKey || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return
      const offset = KEY_CODES.indexOf(event.code)
      if (offset < 0) return
      event.preventDefault()
      if (!event.repeat) pressNote(`key:${event.code}`, 12 * (octave + 1) + offset)
    }
    const up = (event: KeyboardEvent) => releaseNote(`key:${event.code}`)
    const blur = () => stopAll(true)
    const visibility = () => { if (document.hidden) stopAll(true) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [octave, pressNote, releaseNote, stopAll])

  const manualFrequency = (frequency: number) => {
    // Manual tuning takes over a held key as a continuous tone; its key-up cannot overwrite tuning.
    if (held.current.size) { held.current.clear(); latched.current = engineRef.current?.getState().gateOpen ?? false; activeMidiRef.current = null; setActiveMidi(null) }
    change('frequency', frequency)
  }

  const togglePlay = () => {
    if (engineRef.current?.getState().gateOpen || latched.current || held.current.size) stopAll()
    else { latched.current = true; start(paramsRef.current.frequency) }
  }

  const loadParams = (next: SynthParams) => {
    stopAll(true)
    applyParams(copyParams(next), false)
    setError(null)
  }

  const loadLesson = (lesson: Lesson) => {
    loadParams(lesson.params)
    setPresetId('')
    setLoadedLesson(lesson.id)
    setNotice(`Демо «${lesson.shortTitle}» готово. Нажмите Play или удерживайте клавишу.`)
  }

  const getAnalysis = useCallback(() => engineRef.current?.getAnalysis() ?? null, [])
  const lfoFilterBypassed = params.lfo.enabled && params.lfo.target === 'filter' && params.filter.bypass

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#main" aria-label="SOUND LAB — к лаборатории"><span className="brand-mark"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M4 18h5l4-11 8 22 6-17 3 6h3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg></span><span>SOUND <strong>LAB</strong><small>Лаборатория звукового синтеза</small></span></a>
      <div className="header-right"><span className={`audio-status ${audio.audible ? 'status-live' : ''}`}><i />{audio.gateOpen ? 'Звук включён' : audio.audible ? 'Затухание · Release' : 'Аудио в ожидании'}</span><span className="version-tag">ЛОКАЛЬНО <span>v0.1</span></span></div>
    </header>

    <main id="main">
      <div className="page-heading"><div><span className="eyebrow">УСЛЫШАТЬ. УВИДЕТЬ. ПОНЯТЬ.</span><h1>Из чего состоит звук<span>?</span></h1><p>Меняйте один параметр. Слушайте разницу. Следите за сигналом.</p></div><div className="preset-toolbar"><label htmlFor="preset-select">ОТПРАВНАЯ ТОЧКА <Hint text="Пресет — готовый набор параметров. Загрузка останавливает текущую ноту; запустите звук снова, чтобы услышать новую огибающую." /></label><div><select id="preset-select" value={presetId} onChange={event => {
        const preset = PRESETS.find(item => item.id === event.target.value)
        if (!preset) return
        loadParams(preset.params); setPresetId(preset.id); setLoadedLesson(null); setNotice(preset.description)
      }}><option value="" disabled>Свои настройки</option>{PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button className="reset-button" aria-label="Сбросить все параметры" title="Reset — вернуть исходные параметры и остановить звук" onClick={() => { loadParams(DEFAULT_PARAMS); setPresetId(''); setLoadedLesson(null); setNotice('Исходные параметры восстановлены. Нажмите Play, чтобы начать.'); }}>↺ <span>Сброс</span></button></div></div></div>

      <div className="workspace"><div className="synth-workspace">
        <SignalVisualizers getAnalysis={getAnalysis} frequency={params.frequency} playing={audio.audible} waveform={params.waveform} cutoff={params.filter.cutoff} filterBypassed={params.filter.bypass} />

        <section className="panel oscillator-panel" aria-label="Осциллятор">
          <SectionHeading index="01" title="Осциллятор" term="OSCILLATOR · ИСТОЧНИК ЗВУКА" hint="Осциллятор создаёт периодические колебания. Frequency задаёт высоту, Amplitude — уровень, Waveform — тембр.">
            <button className={`play-button ${audio.gateOpen ? 'is-playing' : ''}`} onClick={togglePlay} aria-label={audio.gateOpen ? 'Остановить звук' : 'Включить звук'}><span className={audio.gateOpen ? 'stop-symbol' : 'play-symbol'} aria-hidden="true" />{audio.gateOpen ? 'Stop' : 'Play'}<span className="play-label">{audio.gateOpen ? 'Отпустить ноту' : 'Слушать звук'}</span></button>
          </SectionHeading>
          <div className="oscillator-controls"><div className="waveform-control"><div className="control-label">Форма волны <span className="term">Waveform</span><Hint text="Форма волны определяет набор и уровни гармоник — окраску звука, или тембр. Значки — условные формы; графики выше измеряют реальный сигнал." /></div><div className="waveform-options" role="group" aria-label="Форма волны">{WAVES.map(wave => <button key={wave.id} aria-pressed={params.waveform === wave.id} title={wave.hint} onClick={() => change('waveform', wave.id)}><WaveIcon waveform={wave.id} /><strong>{wave.english}</strong><span>{wave.name}</span></button>)}</div></div>
            <div className="oscillator-parameters"><Parameter name="Частота" term="Frequency" hint="Число колебаний в секунду, в герцах (Hz). Больше частота — выше тон. Клавиатура задаёт частоту нотой; ручная настройка принимает управление." value={params.frequency} min={20} max={20000} step={0.1} unit="Hz" precision={2} logarithmic onChange={manualFrequency} endpoints={['20 Hz · низко', '20 kHz · высоко']} />
            <Parameter name="Амплитуда" term="Amplitude" hint="Уровень сигнала до выхода: 100% = множитель 1. Влияет на воспринимаемую громкость. Итоговую громкость также задают огибающая, фильтр и ваши колонки." value={params.amplitude * 100} min={0} max={100} step={1} unit="%" precision={0} onChange={value => change('amplitude', value / 100)} /></div></div>
          <div className="sound-properties"><span><i className="property-dot pitch-dot" /><b>Частота</b> → высота</span><span><i className="property-dot level-dot" /><b>Амплитуда</b> → громкость</span><span><i className="property-dot timbre-dot" /><b>Форма волны</b> → тембр</span></div>
        </section>

        <section className="panel envelope-panel" aria-label="Огибающая ADSR">
          <SectionHeading index="02" title="Характер звука" term="ОГИБАЮЩАЯ · ADSR" hint="ADSR управляет громкостью ноты во времени. Attack — нарастание, Decay — спад, Sustain — уровень удержания, Release — затухание после отпускания."><div className="envelope-presets" role="group" aria-label="Примеры огибающей">{ENVELOPE_PRESETS.map(preset => <button title={preset.description} key={preset.id} onClick={() => { change('adsr', { ...preset.adsr }); setNotice(`${preset.name}: ${preset.description} Отпустите и снова нажмите клавишу.`); }}>{preset.name}</button>)}</div></SectionHeading>
          <div className="envelope-layout"><EnvelopeGraph adsr={params.adsr} /><div className="envelope-parameters"><Parameter name="Нарастание" term="Attack" hint="Время от Note On до максимального уровня. Длинный Attack даёт плавное появление. Для сравнения заново нажмите ноту." value={params.adsr.attack} min={0.005} max={4} step={0.005} unit="с" precision={3} onChange={attack => change('adsr', { ...params.adsr, attack })} />
          <Parameter name="Спад" term="Decay" hint="Время снижения от пика до уровня Sustain. Для сравнения характера заново нажмите ноту." value={params.adsr.decay} min={0.01} max={3} step={0.01} unit="с" onChange={decay => change('adsr', { ...params.adsr, decay })} />
          <Parameter name="Удержание" term="Sustain" hint="Уровень во время удержания ноты — процент от пика, а не длительность. 0% позволяет получить короткий удар даже при удержании." value={params.adsr.sustain * 100} min={0} max={100} step={1} unit="%" precision={0} onChange={sustain => change('adsr', { ...params.adsr, sustain: sustain / 100 })} />
          <Parameter name="Затухание" term="Release" hint="Время плавного снижения до тишины после Note Off. Нажмите Stop или отпустите клавишу, чтобы услышать эту фазу." value={params.adsr.release} min={0.01} max={5} step={0.01} unit="с" onChange={release => change('adsr', { ...params.adsr, release })} /></div></div>
        </section>

        <div className="modulation-panels"><section className="panel filter-panel" aria-label="Фильтр низких частот">
          <SectionHeading index="03" title="Фильтр" term="LOW-PASS FILTER" hint="Пропускает низкие частоты и плавно ослабляет высокие. Гармоники исчезают постепенно, поэтому яркость тембра уменьшается."><Toggle checked={params.filter.bypass} onChange={bypass => change('filter', { ...params.filter, bypass })} label="Bypass" hint="Включённый Bypass направляет сигнал в обход фильтра. Выключите его, чтобы услышать Cutoff и Q." /></SectionHeading>
          <div className="two-parameters"><Parameter name="Частота среза" term="Cutoff" hint="Область, выше которой фильтр ослабляет частоты. Пунктирная отметка на спектре показывает базовый Cutoff; LFO может двигать фактический срез вокруг него." value={params.filter.cutoff} min={20} max={20000} step={1} unit="Hz" precision={0} logarithmic disabled={params.filter.bypass} onChange={cutoff => change('filter', { ...params.filter, cutoff })} /><Parameter name="Резонанс" term="Q" hint="Безразмерная добротность фильтра. Повышение Q подчёркивает частоты возле среза; может увеличить уровень сигнала." value={params.filter.q} min={0.1} max={10} step={0.1} unit="Q" precision={3} disabled={params.filter.bypass} onChange={q => change('filter', { ...params.filter, q })} /></div>
          <p className="panel-footnote">{params.filter.bypass ? 'Фильтр обойдён — сигнал проходит целиком.' : 'Низкие частоты проходят, верхние гармоники ослабевают.'}</p>
        </section>

        <section className="panel lfo-panel" aria-label="Низкочастотный осциллятор LFO">
          <SectionHeading index="04" title="Движение" term="LOW FREQUENCY OSCILLATOR · LFO" hint="Медленный осциллятор управляет другим параметром и не подключён к выходу как отдельный слышимый тон."><Toggle checked={params.lfo.enabled} onChange={enabled => change('lfo', { ...params.lfo, enabled })} label="LFO" hint="Включает или выключает модуляцию выбранного параметра." /></SectionHeading>
          <div className="two-parameters"><Parameter name="Скорость" term="Rate" hint="Число циклов модуляции за секунду. 1 Hz — одно движение туда и обратно за секунду." value={params.lfo.rate} min={0.1} max={12} step={0.01} unit="Hz" precision={2} logarithmic disabled={!params.lfo.enabled} onChange={rate => change('lfo', { ...params.lfo, rate })} /><Parameter name="Глубина" term="Depth" hint="Размах модуляции. 100% даёт ±100 центов для Pitch (один полутон) или ±2400 центов для среза фильтра (две октавы). Нулевая глубина не меняет звук." value={params.lfo.depth * 100} min={0} max={100} step={1} unit="%" precision={0} disabled={!params.lfo.enabled} onChange={depth => change('lfo', { ...params.lfo, depth: depth / 100 })} /></div>
          <div className="lfo-target"><span>Куда направить <span className="term">Target</span><Hint text="Pitch меняет высоту тона — вибрато. Filter Cutoff двигает срез фильтра и меняет яркость. Для второго варианта выключите Bypass." /></span><div role="group" aria-label="Цель LFO"><button aria-pressed={params.lfo.target === 'pitch'} onClick={() => change('lfo', { ...params.lfo, target: 'pitch' })}>Высота <span>Pitch</span></button><button aria-pressed={params.lfo.target === 'filter'} onClick={() => change('lfo', { ...params.lfo, target: 'filter' })}>Срез <span>Filter Cutoff</span></button></div></div>
          {lfoFilterBypassed && <p className="inline-notice">Выключите Bypass фильтра, чтобы услышать модуляцию среза.</p>}
        </section></div>

        <Piano octave={octave} setOctave={next => { stopAll(true); setOctave(next) }} activeMidi={activeMidi} frequency={params.frequency} onDown={pressNote} onUp={releaseNote} />
        <div className="status-strip" role="status"><span className="status-marker" />{notice}<span className="escape-tip"><kbd>Esc</kbd> остановить</span></div>
        {error && <div className="error-message" role="alert">{error}</div>}
      </div><LessonPanel onLoad={loadLesson} loadedLesson={loadedLesson} /></div>
    </main>
    <footer className="app-footer"><span>SOUND LAB <span>0.1</span> · Пространство для любопытства</span><span>Web Audio API <span>•</span> Всё работает в вашем браузере</span></footer>
  </div>
}
