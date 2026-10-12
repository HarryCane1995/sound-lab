import { ENVELOPE_PRESETS } from '../content/library'
import { MidiLearnButton } from '../midi/MidiLearnContext'
import { DEFAULT_PARAMS } from '../types'
import type { SynthMode, SynthParams, Waveform } from '../types'
import { EnvelopeGraph } from '../visuals/EnvelopeGraph'
import { Toggle, WaveIcon } from './Controls'
import { Knob } from './Knob'
import './studio-controls.css'

export interface StudioSynthControlsProps {
  params: SynthParams
  onChange: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void
  onFrequency: (frequency: number) => void
  onMode: (mode: SynthMode) => void
  onClassic: (waveform: Waveform) => void
  onPlay: () => void
  playing: boolean
  onOscillatorReset?: () => void
}

const waves: { id: Waveform; name: string; description: string }[] = [
  { id: 'sine', name: 'Sine', description: 'Синусоида' }, { id: 'square', name: 'Square', description: 'Прямоугольная' },
  { id: 'sawtooth', name: 'Sawtooth', description: 'Пилообразная' }, { id: 'triangle', name: 'Triangle', description: 'Треугольная' },
]

export function StudioSynthControls({ params, onChange, onFrequency, onMode, onClassic, onPlay, playing, onOscillatorReset }: StudioSynthControlsProps) {
  const resetOscillator = () => {
    if (onOscillatorReset) { onOscillatorReset(); return }
    onFrequency(DEFAULT_PARAMS.frequency); onChange('amplitude', DEFAULT_PARAMS.amplitude); onClassic(DEFAULT_PARAMS.waveform)
  }
  return <div className="studio-synth-controls">
    <section className="studio-module studio-oscillator" aria-label="Осциллятор">
      <header className="studio-module-heading"><h2>OSCILLATOR</h2><div className="studio-header-actions"><button type="button" className="studio-audition" aria-label={playing ? 'Остановить тон Play' : 'Включить тон Play'} aria-pressed={playing} onClick={onPlay}>{playing ? '■ Tone' : '▶ Tone'}</button><button type="button" className="studio-small-button" aria-label="Сбросить параметры осциллятора" title="Frequency 220 Hz, Amplitude 25%, Classic Sine; остальные модули сохраняются" onClick={resetOscillator}>↺</button></div></header>
      <div className="studio-oscillator-body"><div className="studio-wave-controls">
        <div className="studio-mode-buttons" role="group" aria-label="Режим синтеза"><button type="button" aria-pressed={params.mode === 'classic'} aria-label="Classic Oscillator" onClick={() => onMode('classic')}>Classic</button><button type="button" aria-pressed={params.mode === 'additive'} aria-label="Additive Synthesis" onClick={() => onMode('additive')}>Additive</button><MidiLearnButton target="synthesis.mode" /></div>
        <div className="studio-wave-buttons" role="group" aria-label="Форма волны">{waves.map(wave => <button type="button" key={wave.id} aria-pressed={params.mode === 'classic' && params.waveform === wave.id} title={wave.description} onClick={() => onClassic(wave.id)}><WaveIcon waveform={wave.id} /><span>{wave.name}</span></button>)}</div>
        <div className="studio-wave-learn"><span>WAVE</span><MidiLearnButton target="waveform" /></div>
      </div><div className="studio-knob-row">
        <Knob name="Частота" label="FREQ" hint="Frequency управляет отдельным тоном Tone. Высоты удерживаемых клавиш сохраняются." value={params.frequency} min={20} max={20000} step={0.1} defaultValue={DEFAULT_PARAMS.frequency} unit="Hz" precision={2} logarithmic midiTarget="frequency" onChange={onFrequency} />
        <Knob name="Амплитуда" label="AMP" hint="Amplitude — уровень сигнала до выходной обработки." value={params.amplitude * 100} min={0} max={100} step={1} defaultValue={DEFAULT_PARAMS.amplitude * 100} unit="%" precision={0} midiTarget="amplitude" onChange={value => onChange('amplitude', value / 100)} />
      </div></div>
    </section>
    <section className="studio-module studio-envelope" aria-label="Огибающая ADSR">
      <header className="studio-module-heading"><h2>ADSR</h2><select aria-label="Быстрый выбор огибающей" value="" onChange={event => { const selected = ENVELOPE_PRESETS.find(preset => preset.id === event.target.value); if (selected) onChange('adsr', { ...selected.adsr }) }}><option value="" disabled>Envelope…</option>{ENVELOPE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></header>
      <EnvelopeGraph adsr={params.adsr} />
      <div className="studio-knob-row">
        <Knob name="Нарастание" label="ATT" hint="Attack — время нарастания каждой ноты до максимального уровня." value={params.adsr.attack} min={0.005} max={4} step={0.005} defaultValue={DEFAULT_PARAMS.adsr.attack} unit="с" precision={3} midiTarget="adsr.attack" onChange={attack => onChange('adsr', { ...params.adsr, attack })} />
        <Knob name="Спад" label="DEC" hint="Decay — время спада от пика до Sustain." value={params.adsr.decay} min={0.01} max={3} step={0.01} defaultValue={DEFAULT_PARAMS.adsr.decay} unit="с" midiTarget="adsr.decay" onChange={decay => onChange('adsr', { ...params.adsr, decay })} />
        <Knob name="Удержание" label="SUS" hint="Sustain — уровень удерживаемой ноты, а не её длительность." value={params.adsr.sustain * 100} min={0} max={100} step={1} defaultValue={DEFAULT_PARAMS.adsr.sustain * 100} unit="%" precision={0} midiTarget="adsr.sustain" onChange={sustain => onChange('adsr', { ...params.adsr, sustain: sustain / 100 })} />
        <Knob name="Затухание" label="REL" hint="Release — время затухания после отпускания каждой клавиши." value={params.adsr.release} min={0.01} max={5} step={0.01} defaultValue={DEFAULT_PARAMS.adsr.release} unit="с" midiTarget="adsr.release" onChange={release => onChange('adsr', { ...params.adsr, release })} />
      </div>
    </section>
    <section className="studio-module studio-filter" aria-label="Фильтр низких частот">
      <header className="studio-module-heading"><h2>FILTER</h2><Toggle label="Bypass" checked={params.filter.bypass} onChange={bypass => onChange('filter', { ...params.filter, bypass })} midiTarget="filter.bypass" /></header>
      <div className="studio-filter-body"><div className="studio-knob-row">
        <Knob name="Частота среза" label="CUT" hint="Cutoff — выше этой области фильтр постепенно ослабляет спектр. Реальный спектр показан в Visual Lab." value={params.filter.cutoff} min={20} max={20000} step={1} defaultValue={DEFAULT_PARAMS.filter.cutoff} unit="Hz" precision={0} logarithmic disabled={params.filter.bypass} midiTarget="filter.cutoff" onChange={cutoff => onChange('filter', { ...params.filter, cutoff })} />
        <Knob name="Резонанс" label="RES" hint="Resonance Q подчёркивает частоты возле среза; может повысить уровень сигнала." value={params.filter.q} min={0.1} max={10} step={0.1} defaultValue={DEFAULT_PARAMS.filter.q} unit="Q" precision={3} disabled={params.filter.bypass} midiTarget="filter.q" onChange={q => onChange('filter', { ...params.filter, q })} />
      </div><div className={`studio-filter-indicator${params.filter.bypass ? ' is-bypassed' : ''}`} title="Положение базового Cutoff; измеренный спектр — в Visual Lab"><span>LOW PASS</span><div className="studio-cutoff-track"><i style={{ left: `${Math.max(0, Math.min(100, Math.log(params.filter.cutoff / 20) / Math.log(1000) * 100))}%` }} /></div><span>{params.filter.bypass ? 'BYPASSED' : `${Math.round(params.filter.cutoff)} Hz`}</span></div></div>
    </section>
    <section className="studio-module studio-lfo" aria-label="Низкочастотный осциллятор LFO">
      <header className="studio-module-heading"><h2>LFO</h2><Toggle label="LFO" checked={params.lfo.enabled} onChange={enabled => onChange('lfo', { ...params.lfo, enabled })} midiTarget="lfo.enabled" /></header>
      <div className="studio-lfo-body"><div className="studio-knob-row">
        <Knob name="Скорость" label="RATE" hint="Rate — частота медленной синусоидальной модуляции." value={params.lfo.rate} min={0.1} max={12} step={0.01} defaultValue={DEFAULT_PARAMS.lfo.rate} unit="Hz" precision={2} logarithmic disabled={!params.lfo.enabled} midiTarget="lfo.rate" onChange={rate => onChange('lfo', { ...params.lfo, rate })} />
        <Knob name="Глубина" label="DEPTH" hint="100%: ±100 центов для Pitch или ±2400 центов для Cutoff." value={params.lfo.depth * 100} min={0} max={100} step={1} defaultValue={DEFAULT_PARAMS.lfo.depth * 100} unit="%" precision={0} disabled={!params.lfo.enabled} midiTarget="lfo.depth" onChange={depth => onChange('lfo', { ...params.lfo, depth: depth / 100 })} />
      </div><div className="studio-lfo-target"><svg viewBox="0 0 100 24" aria-label="Форма LFO: синусоида" role="img"><path d="M1 12 C9 12 9 2 17 2 S25 22 33 22 S41 2 49 2 S57 22 65 22 S73 2 81 2 S89 22 99 12" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg><div role="group" aria-label="Цель LFO"><button type="button" aria-label="Высота Pitch" aria-pressed={params.lfo.target === 'pitch'} onClick={() => onChange('lfo', { ...params.lfo, target: 'pitch' })}>Pitch</button><button type="button" aria-label="Срез Filter Cutoff" aria-pressed={params.lfo.target === 'filter'} onClick={() => onChange('lfo', { ...params.lfo, target: 'filter' })}>Filter</button><MidiLearnButton target="lfo.target" /></div>{params.lfo.enabled && params.lfo.target === 'filter' && params.filter.bypass && <span className="studio-lfo-warning">Filter bypass</span>}</div></div>
    </section>
  </div>
}
