import { useEffect, useRef, useState } from 'react'
import { HARMONIC_TEMPLATES } from '../content/harmonics'
import { getHarmonicScale } from '../harmonics/model'
import { copyAdditive } from '../types'
import type { AdditiveConfig, SynthMode, SynthParams, Waveform } from '../types'
import './compact-harmonics.css'

export interface CompactHarmonicsProps {
  params: SynthParams
  onChange: (config: AdditiveConfig) => void
  onMode?: (mode: SynthMode) => void
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

const numbers = Array.from({ length: 16 }, (_, index) => index + 1)

function HarmonicValue({ harmonic, value, onChange }: { harmonic: number; value: number; onChange: (value: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const before = useRef(value)
  const cancelled = useRef(false)
  const modified = useRef(false)
  return <input className="compact-harmonic-value" type="number" aria-label={`Уровень H${harmonic}, значение`} title={`Уровень H${harmonic}, %`} min={0} max={100} step={1}
    value={editing ? draft : Number(value.toFixed(1))}
    onFocus={() => { before.current = value; cancelled.current = false; modified.current = false; setDraft(String(Number(value.toFixed(1)))); setEditing(true) }}
    onChange={event => { modified.current = true; setDraft(event.target.value); const next = event.target.valueAsNumber; if (event.target.value !== '' && Number.isFinite(next) && next >= 0 && next <= 100) onChange(next) }}
    onBlur={event => {
      if (!cancelled.current && modified.current) {
        const parsed = event.target.valueAsNumber
        const next = event.target.value !== '' && Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : before.current
        if (next !== value) onChange(next)
      }
      cancelled.current = false; setEditing(false)
    }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; onChange(before.current); event.currentTarget.blur() }
    }} />
}

export function CompactHarmonics({ params, onChange, onTemplate, onCompare, onReset, onSave, onLoad, patchStatus, referenceFrequency, referenceLabel, sampleRate }: CompactHarmonicsProps) {
  const [actions, setActions] = useState<number | null>(null)
  const [comparison, setComparison] = useState<'square' | 'sawtooth' | 'triangle'>('square')
  const menuRef = useRef<HTMLDivElement>(null)
  const config = params.additive
  const latestConfig = useRef(config)
  latestConfig.current = config
  const update = (change: (next: AdditiveConfig) => void) => {
    const next = copyAdditive(latestConfig.current)
    change(next); next.compare = false
    // Multiple native input events can arrive before React commits new props.
    latestConfig.current = next
    onChange(next)
  }
  useEffect(() => {
    if (actions === null) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Element
      if (!menuRef.current?.contains(target) && !target.closest('.compact-harmonic-actions')) setActions(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setActions(null) } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [actions])
  const openActions = (harmonic: number) => setActions(current => current === harmonic ? null : harmonic)
  const aboveNyquist = numbers.filter(number => config.enabled[number - 1] && config.levels[number - 1] > 0 && referenceFrequency * number >= sampleRate / 2)
  return <section className="compact-harmonics" aria-label="Harmonic Builder">
    <header className="compact-harmonics-heading"><h2>HARMONIC BUILDER <span>16 PARTIALS</span></h2><div className="compact-harmonic-toolbar"><select aria-label="Harmonic Template" value="" onChange={event => {
      const template = HARMONIC_TEMPLATES.find(item => item.id === event.target.value)
      if (template?.classic && template.classic !== 'sine') setComparison(template.classic)
      onTemplate(event.target.value)
    }}><option value="" disabled>Template…</option>{HARMONIC_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select><button type="button" aria-label="Сбросить гармоники" title="Reset Harmonics: H1 100%, остальные 0%" onClick={onReset}>↺ Reset</button></div></header>
    <div className="compact-harmonic-grid" aria-label="Уровни гармоник H1–H16">{numbers.map(number => {
      const index = number - 1, level = config.levels[index], enabled = config.enabled[index]
      const muted = !enabled || (config.solo !== null && config.solo !== number)
      const frequency = Number((referenceFrequency * number).toFixed(1))
      return <div key={number} className={`compact-harmonic-column${muted ? ' is-muted' : ''}${level > 0 && !muted ? ' is-active' : ''}${config.solo === number ? ' is-solo' : ''}`}>
        <label htmlFor={`studio-harmonic-${number}`} title={`H${number} · ×${number} · ${frequency} Hz${config.phases[index] === 180 ? ' · фаза 180°' : ''}`}>H{number}<span>{config.phases[index] === 180 ? '−' : `×${number}`}</span></label>
        <input id={`studio-harmonic-${number}`} className="compact-harmonic-slider" type="range" aria-label={`Гармоника H${number}`} aria-orientation="vertical" aria-valuetext={`${Number(level.toFixed(1))} процентов, ${frequency} Hz${muted ? ', заглушена' : ''}`} min={0} max={100} step={1} value={level}
          style={{ '--harmonic-fill': `${level}%` } as React.CSSProperties} onChange={event => update(next => { next.levels[index] = Number(event.target.value) })}
          onDoubleClick={event => { const input = event.currentTarget.parentElement?.querySelector<HTMLInputElement>('.compact-harmonic-value'); input?.focus(); input?.select() }}
          onContextMenu={event => { event.preventDefault(); openActions(number) }} />
        <div className="compact-harmonic-value-row"><HarmonicValue harmonic={number} value={level} onChange={nextLevel => update(next => { next.levels[index] = nextLevel })} />
        <button type="button" className="compact-harmonic-actions" aria-label={`Действия H${number}`} aria-expanded={actions === number} title={`H${number}: Solo / Mute / фаза; также правый клик`} onClick={() => openActions(number)}>{config.solo === number ? 'S' : !enabled ? 'M' : '···'}</button></div>
        {actions === number && <div className="compact-harmonic-menu" ref={menuRef} aria-label={`Настройки H${number}`}>
          <button type="button" aria-label={`Solo H${number}`} aria-pressed={config.solo === number} onClick={() => update(next => { next.solo = next.solo === number ? null : number })}>Solo</button>
          <button type="button" aria-label={`Включить H${number}`} aria-pressed={enabled} onClick={() => update(next => { next.enabled[index] = !enabled })}>{enabled ? 'Mute' : 'Unmute'}</button>
          <button type="button" aria-label={`Инвертировать фазу H${number}`} aria-pressed={config.phases[index] === 180} onClick={() => update(next => { next.phases[index] = next.phases[index] === 0 ? 180 : 0 })}>{config.phases[index]}°</button>
          <button type="button" aria-label={`Закрыть действия H${number}`} onClick={() => setActions(null)}>Закрыть</button>
        </div>}
      </div>
    })}</div>
    <footer className="compact-harmonics-footer"><span title="Частота каждой составляющей равна частоте ноты, умноженной на номер гармоники">{referenceLabel} · {Number(referenceFrequency.toFixed(1))} Hz · LEVEL %</span><span title="Сумма модулей коэффициентов выше 100% масштабируется до безопасного уровня, пропорции сохраняются">Σ ×{Number(getHarmonicScale(config).toFixed(3))}</span>{config.solo !== null && <button type="button" onClick={() => update(next => { next.solo = null })}>Снять Solo H{config.solo}</button>}<span className="compact-harmonic-mode">{params.mode === 'classic' ? 'Edit → Additive' : 'Additive'}</span>
    <details className="compact-harmonics-advanced"><summary>Дополнительно: гармоники</summary><div className="compact-harmonics-advanced-content">
      <div className="compact-harmonic-phase-grid">{numbers.map(number => <button type="button" key={number} aria-label={`Инвертировать фазу H${number}`} aria-pressed={config.phases[number - 1] === 180} onClick={() => update(next => { next.phases[number - 1] = next.phases[number - 1] === 0 ? 180 : 0 })}>H{number} · {config.phases[number - 1]}°</button>)}</div>
      <div className="compact-harmonic-compare"><label>COMPARE <select aria-label="Волна для сравнения" value={comparison} onChange={event => setComparison(event.target.value as typeof comparison)}><option value="square">Square</option><option value="sawtooth">Sawtooth</option><option value="triangle">Triangle</option></select></label><button type="button" aria-pressed={config.compare && params.mode === 'additive' && params.waveform === comparison} onClick={() => onCompare(comparison, 'additive')}>Сравнить: Additive</button><button type="button" aria-pressed={config.compare && params.mode === 'classic' && params.waveform === comparison} onClick={() => onCompare(comparison, 'classic')}>Сравнить: Classic</button></div>
      <p>Конечная сумма 16 гармоник приближает классическую волну. Сравнение загружает нейтральные ADSR, отключает LFO и обходит фильтр; уровень Classic снижается по расчётному RMS. Фаза меняет форму суммы при тех же уровнях.</p>
      {aboveNyquist.length > 0 && <p>H{aboveNyquist.join(', H')} выше предела Найквиста для этой ноты; браузер исключает недоступные частоты.</p>}
      <div className="compact-harmonic-patch"><button type="button" title="Save Harmonic Patch" onClick={onSave}>Сохранить гармонический патч</button><button type="button" title="Load Harmonic Patch" onClick={onLoad}>Загрузить гармонический патч</button></div>
    </div></details></footer>
    <p className="compact-harmonic-status" role="status" title={patchStatus}>{patchStatus || 'Коэффициенты общие для всех голосов. Изменение уровня включает Additive.'}</p>
  </section>
}
