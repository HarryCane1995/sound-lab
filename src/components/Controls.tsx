import { useId, useRef, useState } from 'react'
import type { MidiTargetId } from '../midi/types'
import { MidiLearnButton } from '../midi/MidiLearnContext'

export function Hint({ text }: { text: string }) {
  return <span className="hint" tabIndex={0} role="note" aria-label={text}>
    <span aria-hidden="true">?</span><span className="hint-popover" role="tooltip">{text}</span>
  </span>
}

interface ParameterProps {
  name: string
  term: string
  hint: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (value: number) => void
  logarithmic?: boolean
  disabled?: boolean
  precision?: number
  endpoints?: [string, string]
  midiTarget?: MidiTargetId
}

export function Parameter({ name, term, hint, value, min, max, step = 0.01, unit, onChange, logarithmic = false, disabled = false, precision = 2, endpoints, midiTarget }: ParameterProps) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cancelled = useRef(false)
  const modified = useRef(false)
  const beforeEdit = useRef(value)
  const formatted = String(Number(value.toFixed(precision)))
  const normalized = logarithmic ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min)
  const clamp = (number: number) => Math.min(max, Math.max(min, number))
  return <div className={`parameter ${disabled ? 'parameter-disabled' : ''}`}>
    <div className="parameter-heading">
      <label htmlFor={id}>{name} <span className="term">{term}</span></label>
      {midiTarget && <MidiLearnButton target={midiTarget} />}
      <Hint text={hint} />
    </div>
    <div className="parameter-value">
      <input aria-label={`${name}, значение`} aria-describedby={`${id}-unit`} type="number" min={min} max={max} step={step} value={editing ? draft : formatted} disabled={disabled}
        onFocus={() => { beforeEdit.current = value; cancelled.current = false; modified.current = false; setDraft(formatted); setEditing(true) }}
        onChange={event => {
          modified.current = true
          const raw = event.target.value
          setDraft(raw)
          const next = event.target.valueAsNumber
          // Keep intermediate text (empty, decimal point, a value below min)
          // intact so typing 440 never turns into 20 → 204 → 2040.
          if (raw !== '' && Number.isFinite(next) && next >= min && next <= max) onChange(next)
        }}
        onBlur={event => {
          if (!cancelled.current && modified.current) {
            const next = event.target.valueAsNumber
            const committed = event.target.value !== '' && Number.isFinite(next) ? clamp(next) : beforeEdit.current
            if (committed !== value) onChange(committed)
          }
          cancelled.current = false
          setEditing(false)
        }}
        onKeyDown={event => {
          if (event.code === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
          if (event.code === 'Escape') {
            cancelled.current = true
            if (beforeEdit.current !== value) onChange(beforeEdit.current)
            event.currentTarget.blur()
          }
        }} />
      <span id={`${id}-unit`}>{unit}</span>
    </div>
    <input id={id} aria-label={name} aria-valuetext={`${formatted} ${unit}`} type="range" min={logarithmic ? 0 : min} max={logarithmic ? 1000 : max} step={logarithmic ? 1 : step}
      value={logarithmic ? normalized * 1000 : value} disabled={disabled}
      style={{ '--range-fill': `${Math.min(100, Math.max(0, normalized * 100))}%` } as React.CSSProperties}
      onChange={event => { const next = Number(event.target.value); onChange(logarithmic ? clamp(min * Math.pow(max / min, next / 1000)) : next) }} />
    <div className="parameter-endpoints"><span>{endpoints?.[0] ?? `${min} ${unit}`}</span><span>{endpoints?.[1] ?? `${max} ${unit}`}</span></div>
  </div>
}

export function Toggle({ checked, onChange, label, hint, midiTarget }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string; midiTarget?: MidiTargetId }) {
  return <div className="toggle-container"><button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
    <span className="toggle-track"><span /></span><span>{label}</span>
  </button>{midiTarget && <MidiLearnButton target={midiTarget} />}{hint && <Hint text={hint} />}</div>
}

export function WaveIcon({ waveform }: { waveform: string }) {
  const paths: Record<string, string> = {
    sine: 'M2 22 C9 22 8 5 17 5 S25 39 34 39 S42 5 51 5 S59 22 66 22',
    square: 'M2 36 H12 V8 H34 V36 H56 V8 H66',
    sawtooth: 'M2 36 L24 8 V36 L46 8 V36 L66 10',
    triangle: 'M2 22 L13 5 L35 39 L57 5 L66 22',
  }
  return <svg width="68" height="44" viewBox="0 0 68 44" fill="none" aria-hidden="true"><path d={paths[waveform]} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
}

export function SectionHeading({ index, title, term, hint, children }: { index: string; title: string; term: string; hint: string; children?: React.ReactNode }) {
  return <div className="section-heading"><div className="section-title"><span className="section-index">{index}</span><div><h2>{title} <Hint text={hint} /></h2><span className="eyebrow">{term}</span></div></div>{children}</div>
}
