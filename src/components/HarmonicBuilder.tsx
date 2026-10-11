import { useId, useMemo, useState } from 'react'
import { copyAdditive, type AdditiveConfig, type SynthMode, type SynthParams, type Waveform } from '../types'
import { HARMONIC_EXPERIMENTS, HARMONIC_TEMPLATES } from '../content/harmonics'
import { getHarmonicCoefficients, getHarmonicScale } from '../harmonics/model'
import { MidiLearnButton } from '../midi/MidiLearnContext'
import { Hint } from './Controls'
import './harmonic-builder.css'

interface HarmonicBuilderProps {
  params: SynthParams
  onChange: (config: AdditiveConfig) => void
  onMode: (mode: SynthMode) => void
  onTemplate: (id: string) => void
  onCompare: (waveform: Waveform, mode: SynthMode) => void
  onReset: () => void
  onSave: () => void
  onLoad: () => void
  patchStatus: string
  referenceFrequency: number
  referenceLabel: string
  sampleRate: number
}

const harmonicNumbers = Array.from({ length: 16 }, (_, index) => index + 1)
const frequencyText = (frequency: number) => `${Number(frequency.toFixed(frequency < 1000 ? 2 : 0))} Hz`

function makePath(coefficients: number[], kind: 'fundamental' | 'additional' | 'sum', additional: number, center: number) {
  const samples = 768
  const coordinates: string[] = []
  for (let sample = 0; sample <= samples; sample++) {
    const phase = sample / samples * 2 * Math.PI
    let value = 0
    if (kind === 'sum') coefficients.forEach((coefficient, index) => { value += coefficient * Math.sin((index + 1) * phase) })
    else {
      const harmonic = kind === 'fundamental' ? 1 : additional
      value = coefficients[harmonic - 1] * Math.sin(harmonic * phase)
    }
    coordinates.push(`${sample === 0 ? 'M' : 'L'}${(24 + sample / samples * 712).toFixed(2)} ${(center - value * 24).toFixed(2)}`)
  }
  return coordinates.join(' ')
}

function HarmonicTheory({ config, additional, onAdditional, referenceFrequency, referenceLabel, sampleRate }: {
  config: AdditiveConfig; additional: number; onAdditional: (harmonic: number) => void; referenceFrequency: number; referenceLabel: string; sampleRate: number
}) {
  const id = useId()
  const coefficients = useMemo(() => getHarmonicCoefficients(config), [config])
  const paths = useMemo(() => [
    makePath(coefficients, 'fundamental', additional, 49),
    makePath(coefficients, 'additional', additional, 121),
    makePath(coefficients, 'sum', additional, 193),
  ], [coefficients, additional])
  const aboveNyquist = harmonicNumbers.filter(number => coefficients[number - 1] !== 0 && referenceFrequency * number >= sampleRate / 2)
  return <div className="harmonic-theory">
    <div className="harmonic-subheading"><div><h3>Как складывается волна</h3><p>Расчётная модель одного голоса · {referenceLabel}: {frequencyText(referenceFrequency)}</p></div>
      <label className="harmonic-trace-selector">Дополнительная гармоника <select aria-label="Гармоника на расчётном графике" value={additional} onChange={event => onAdditional(Number(event.target.value))}>{harmonicNumbers.slice(1).map(number => <option value={number} key={number}>H{number} · ×{number}</option>)}</select></label>
    </div>
    <svg className="harmonic-theory-graph" viewBox="0 0 760 232" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>Первая гармоника, H{additional} и сумма гармоник</title>
      <desc id={`${id}-description`}>Расчётные кривые одного периода основной частоты. H1: {frequencyText(referenceFrequency)}; H{additional}: {frequencyText(referenceFrequency * additional)}. Сумма учитывает уровни, фазу, включение и Solo. Это математическая модель до ADSR, фильтра и LFO, а не измерение аудиовыхода.</desc>
      {[49, 121, 193].map(center => <g key={center}><line x1="24" y1={center} x2="736" y2={center} stroke="#334251" strokeWidth="0.7" /><line x1="24" y1={center - 24} x2="736" y2={center - 24} stroke="#27333f" strokeWidth="0.5" strokeDasharray="3 4" /><line x1="24" y1={center + 24} x2="736" y2={center + 24} stroke="#27333f" strokeWidth="0.5" strokeDasharray="3 4" /></g>)}
      {[24, 202, 380, 558, 736].map(x => <line key={x} x1={x} y1="22" x2={x} y2="218" stroke="#27333f" strokeWidth="0.5" />)}
      <text x="24" y="15" fill="#b9ee84">H1 · основная частота</text><text x="24" y="87" fill="#65d8ed">H{additional} · {frequencyText(referenceFrequency * additional)}</text><text x="24" y="159" fill="#c3a6f7">Σ · нормализованная сумма</text>
      <path d={paths[0]} fill="none" stroke="#b9ee84" strokeWidth="1.5" /><path d={paths[1]} fill="none" stroke="#65d8ed" strokeWidth="1.5" /><path d={paths[2]} fill="none" stroke="#c3a6f7" strokeWidth="1.7" />
      <text x="24" y="230" fill="#8395aa">0</text><text x="380" y="230" fill="#8395aa" textAnchor="middle">T / 2</text><text x="736" y="230" fill="#8395aa" textAnchor="end">T · один период</text>
    </svg>
    <p className="harmonic-model-note"><b>Модель, не аудиозапись.</b> Верхние осциллограф и спектр показывают реальный общий звук всех голосов после обработки. Эти три кривые показывают только состав выбранного тембра, с одинаковым масштабом ±1.</p>
    {aboveNyquist.length > 0 && <p className="harmonic-nyquist" role="status">H{aboveNyquist.join(', H')} достигают или превышают {frequencyText(sampleRate / 2)} — предел Найквиста при этой высоте. В модели они видны; в звуке браузер исключает недоступные частоты. Для других нот предел достигается на другом номере гармоники.</p>}
  </div>
}

export function HarmonicBuilder({ params, onChange, onMode, onTemplate, onCompare, onReset, onSave, onLoad, patchStatus, referenceFrequency, referenceLabel, sampleRate }: HarmonicBuilderProps) {
  const [additional, setAdditional] = useState(2)
  const [comparison, setComparison] = useState<'square' | 'sawtooth' | 'triangle'>('square')
  const config = params.additive
  const update = (change: (next: AdditiveConfig) => void) => { const next = copyAdditive(config); change(next); onChange(next) }
  const loadTemplate = (id: string) => {
    const wave = HARMONIC_TEMPLATES.find(template => template.id === id)?.classic
    if (wave === 'square' || wave === 'sawtooth' || wave === 'triangle') setComparison(wave)
    onTemplate(id)
  }
  const activeHigher = config.levels.slice(8).filter((level, index) => level > 0 && config.enabled[index + 8]).length
  const scale = getHarmonicScale(config)
  const harmonic = (number: number) => {
    const index = number - 1, enabled = config.enabled[index], level = config.levels[index]
    const excludedBySolo = config.solo !== null && config.solo !== number
    return <div className={`harmonic-column${!enabled || excludedBySolo ? ' harmonic-muted' : ''}${config.solo === number ? ' harmonic-solo' : ''}`} key={number}>
      <label className="harmonic-label" htmlFor={`harmonic-level-${number}`}>H{number}<small>{number === 1 ? '×1 · основная' : `×${number}`}</small></label>
      <output aria-label={`Уровень H${number}`}>{Number(level.toFixed(1))}<small>%</small></output>
      <div className="harmonic-slider-slot"><input id={`harmonic-level-${number}`} className="harmonic-slider" type="range" min={0} max={100} step={1} value={level} aria-label={`Гармоника H${number}`} aria-orientation="vertical" aria-valuetext={`${Number(level.toFixed(1))} процентов, ${frequencyText(referenceFrequency * number)}${!enabled ? ', выключена' : ''}${excludedBySolo ? ', заглушена Solo' : ''}`} style={{ '--harmonic-fill': `${level}%` } as React.CSSProperties} onChange={event => update(next => { next.levels[index] = Number(event.target.value); next.compare = false })} /></div>
      <span className="harmonic-frequency" title={frequencyText(referenceFrequency * number)}>{frequencyText(referenceFrequency * number)}</span>
      <div className="harmonic-column-actions"><button type="button" role="switch" aria-checked={enabled} aria-label={`Включить H${number}`} title={`Включить или заглушить H${number}; уровень сохраняется`} onClick={() => update(next => { next.enabled[index] = !enabled; next.compare = false })}>{enabled ? 'On' : 'Off'}</button><button type="button" aria-pressed={config.solo === number} aria-label={`Solo H${number}`} title={`Слушать только H${number}; повторное нажатие возвращает остальные гармоники`} onClick={() => update(next => { next.solo = next.solo === number ? null : number; next.compare = false })}>S</button></div>
    </div>
  }
  return <section className="panel harmonic-builder" aria-label="Harmonic Builder">
    <div className="section-heading harmonic-heading"><div className="section-title"><span className="section-index">Σ</span><div><h2>Соберите свой тембр <Hint text="Аддитивный синтез складывает синусоидальные гармоники. H1 задаёт основную частоту, H2 колеблется вдвое быстрее, H3 втрое. Уровни определяют тембр; ADSR, Velocity, фильтр и LFO продолжают работать с каждым голосом." /></h2><span className="eyebrow">HARMONIC BUILDER · 16 ГАРМОНИК</span></div></div>
      <div className="harmonic-mode" role="group" aria-label="Режим синтеза"><button type="button" aria-pressed={params.mode === 'classic'} onClick={() => onMode('classic')}>Classic Oscillator</button><button type="button" aria-pressed={params.mode === 'additive'} onClick={() => onMode('additive')}>Additive Synthesis</button><MidiLearnButton target="synthesis.mode" /></div>
    </div>
    <div className="harmonic-intro"><p>Поднимайте гармоники и слушайте, как один тон обретает характер. Ноты остаются полифоническими: у каждой свой основной тон и те же пропорции гармоник.</p>{params.mode === 'classic' && <p className="harmonic-mode-hint">Сейчас звучит Classic Oscillator. Изменение гармоник автоматически включает Additive Synthesis, чтобы вы сразу услышали результат.</p>}</div>
    <div className="harmonic-controls" aria-label="Уровни гармоник H1–H8">{harmonicNumbers.slice(0, 8).map(harmonic)}</div>
    <details className="harmonic-higher"><summary>Дополнительные гармоники H9–H16 <span>{activeHigher > 0 ? `· включено ${activeHigher}` : '· тонкие детали тембра'}</span></summary><div className="harmonic-controls" aria-label="Уровни гармоник H9–H16">{harmonicNumbers.slice(8).map(harmonic)}</div></details>
    <div className="harmonic-state"><span>Частоты: <b>{referenceLabel}</b> · {frequencyText(referenceFrequency)} × номер H</span><span>Защита суммы: ×{Number(scale.toFixed(3))} <Hint text="Если сумма модулей уровней превышает 100%, она масштабируется целиком. Пропорции сохраняются и расчётная сумма остаётся в пределах ±1. Amplitude управляет итоговым уровнем; включение новых гармоник может менять воспринимаемую громкость." /></span>{config.solo !== null && <button type="button" onClick={() => update(next => { next.solo = null; next.compare = false })}>Снять Solo H{config.solo}</button>}</div>
    <details className="harmonic-phase"><summary>Фаза гармоник <span>· дополнительно</span></summary><p>180° переворачивает синусоиду. В расчётной модели форма суммы меняется, а уровни линий спектра сохраняются. Фильтр и защита выхода могут влиять на реальный сигнал. Фазу можно менять для каждой гармоники отдельно.</p><div className="harmonic-phase-grid">{harmonicNumbers.map(number => <button key={number} type="button" aria-pressed={config.phases[number - 1] === 180} aria-label={`Инвертировать фазу H${number}`} onClick={() => update(next => { next.phases[number - 1] = next.phases[number - 1] === 0 ? 180 : 0; next.compare = false })}><span>H{number}</span><b>{config.phases[number - 1]}°</b></button>)}</div></details>
    <div className="harmonic-templates"><div className="harmonic-subheading"><div><h3>Начните с готового состава</h3><p>Шаблон загружает гармоники и нейтральные настройки прослушивания.</p></div><button type="button" className="harmonic-text-button" title="Reset Harmonics" onClick={onReset}>Сбросить гармоники</button></div><div className="harmonic-template-grid">{HARMONIC_TEMPLATES.map(template => <button type="button" key={template.id} onClick={() => loadTemplate(template.id)}><b>{template.name}</b><span>{template.description}</span></button>)}</div></div>
    <HarmonicTheory config={config} additional={additional} onAdditional={setAdditional} referenceFrequency={referenceFrequency} referenceLabel={referenceLabel} sampleRate={sampleRate} />
    <div className="harmonic-comparison"><div className="harmonic-subheading"><div><h3>Сравните с классической волной</h3><p>Конечная сумма 16 синусоид приближает форму. У классического осциллятора может быть больше гармоник.</p></div><select aria-label="Волна для сравнения" value={comparison} onChange={event => { const wave = event.target.value as typeof comparison; setComparison(wave); loadTemplate(`${wave}-approx`) }}><option value="square">Square · квадрат</option><option value="sawtooth">Sawtooth · пила</option><option value="triangle">Triangle · треугольник</option></select></div><p className="harmonic-compare-help">Выбор волны и первое сравнение загружают выбранную аппроксимацию и нейтральные настройки. Затем кнопки переключают ту же удерживаемую ноту между Additive и Classic.</p><div className="harmonic-compare-actions"><button type="button" aria-pressed={config.compare && params.mode === 'additive' && params.waveform === comparison} onClick={() => onCompare(comparison, 'additive')}>Сравнить: Additive</button><button type="button" aria-pressed={config.compare && params.mode === 'classic' && params.waveform === comparison} onClick={() => onCompare(comparison, 'classic')}>Сравнить: Classic</button><span>Сравнение приближает громкость по расчётному RMS, снижая уровень Classic. Реальный уровень после обработки может отличаться; выше обычного уровня громкость не увеличивается.</span></div></div>
    <div className="harmonic-experiments"><div className="harmonic-subheading"><div><h3>Собери звук из гармоник</h3><p>Три маленьких эксперимента. Удерживайте ноту или аккорд; изменения тембра не перезапускают огибающие.</p></div></div><div className="harmonic-experiment-grid">{HARMONIC_EXPERIMENTS.map((experiment, index) => <details key={experiment.id}><summary><small>0{index + 1}</small>{experiment.title}</summary><div><p><b>Измените</b>{experiment.change}</p><p><b>Услышьте</b>{experiment.listen}</p><p><b>Увидьте</b>{experiment.observe}</p><p><b>Почему</b>{experiment.why}</p><button type="button" onClick={() => loadTemplate(experiment.templateId)}>Начать эксперимент {index + 1}</button></div></details>)}</div></div>
    <div className="harmonic-patch"><div><button type="button" title="Save Harmonic Patch" onClick={onSave}>Сохранить патч</button><button type="button" title="Load Harmonic Patch" onClick={onLoad}>Загрузить патч</button></div><p role="status">{patchStatus || 'Гармоники и режим сохраняются в этом браузере. Патч хранит отдельный состав; временные Solo и сравнение не сохраняются.'}</p></div>
  </section>
}
