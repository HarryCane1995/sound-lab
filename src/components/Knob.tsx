import { useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MidiTargetId } from '../midi/types'
import { MidiLearnButton, useMidiLearnTarget } from '../midi/MidiLearnContext'
import './knob.css'

export interface KnobProps {
  name: string
  label: string
  hint: string
  value: number
  min: number
  max: number
  step?: number
  defaultValue: number
  unit: string
  precision?: number
  logarithmic?: boolean
  disabled?: boolean
  midiTarget?: MidiTargetId
  onChange: (value: number) => void
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value))

/** Native range semantics underneath a pointer-controlled dial, with an always editable value. */
export function Knob({ name, label, hint, value, min, max, step = 0.01, defaultValue, unit, precision = 2, logarithmic = false, disabled = false, midiTarget, onChange }: KnobProps) {
  const id = useId()
  const numberRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const beforeEdit = useRef(value)
  const cancelled = useRef(false)
  const modified = useRef(false)
  const drag = useRef<{ pointerId: number; y: number; position: number } | null>(null)
  const midi = useMidiLearnTarget(midiTarget)
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  const toPosition = (next: number) => clampUnit(logarithmic ? Math.log(Math.max(min, next) / min) / Math.log(max / min) : (next - min) / (max - min))
  const fromPosition = (position: number) => {
    const raw = logarithmic ? min * Math.pow(max / min, clampUnit(position)) : min + clampUnit(position) * (max - min)
    return clamp(logarithmic ? raw : min + Math.round((raw - min) / step) * step)
  }
  const position = toPosition(value)
  const formatted = String(Number(value.toFixed(precision)))
  const valueText = `${formatted} ${unit}`
  const editNumber = () => { if (!disabled) { numberRef.current?.focus(); numberRef.current?.select() } }
  return <div className={`knob${disabled ? ' is-disabled' : ''}${midi.controlled ? ' is-midi-controlled' : ''}${midi.armed ? ' is-learning' : ''}${midi.bound ? ' is-bound' : ''}`} data-parameter={midiTarget ?? name}>
    <div className="knob-heading"><label htmlFor={`${id}-range`} title={`${name} · ${hint}`}>{label}</label>{midiTarget && <MidiLearnButton target={midiTarget} />}</div>
    <div className="knob-dial" style={{ '--knob-turn': `${position * 270 - 135}deg`, '--knob-progress': `${position * 270}deg` } as CSSProperties}>
      <span className="knob-ring" aria-hidden="true" /><span className="knob-cap" aria-hidden="true"><i /></span>
      <input id={`${id}-range`} className="knob-slider" type="range" min={logarithmic ? 0 : min} max={logarithmic ? 1000 : max} step={logarithmic ? 1 : step}
        value={logarithmic ? position * 1000 : value} aria-label={name} aria-valuetext={valueText} aria-describedby={`${id}-help`} disabled={disabled}
        title={`${name}: ${valueText}. ${hint} Вертикальный drag; Shift — точно; двойной клик — число.`}
        onChange={event => { const next = Number(event.target.value); onChange(logarithmic ? fromPosition(next / 1000) : clamp(next)) }}
        onPointerDown={event => {
          if (event.button !== 0 || disabled) return
          event.preventDefault(); event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, y: event.clientY, position }
        }}
        onPointerMove={event => {
          const active = drag.current
          if (!active || active.pointerId !== event.pointerId) return
          // Incremental movement keeps Shift changes continuous midway through a drag.
          const nextPosition = clampUnit(active.position + (active.y - event.clientY) / (event.shiftKey ? 1500 : 150))
          active.y = event.clientY; active.position = nextPosition
          onChange(fromPosition(nextPosition))
        }}
        onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
        onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
        onDoubleClick={editNumber}
        onContextMenu={event => { if (midiTarget) { event.preventDefault(); midi.beginLearn() } }} />
    </div>
    <div className="knob-value"><input ref={numberRef} type="number" aria-label={`${name}, значение`} aria-describedby={`${id}-unit`} min={min} max={max} step={step} disabled={disabled}
      value={editing ? draft : formatted}
      onFocus={() => { beforeEdit.current = value; cancelled.current = false; modified.current = false; setDraft(formatted); setEditing(true) }}
      onChange={event => {
        modified.current = true; setDraft(event.target.value)
        const next = event.target.valueAsNumber
        if (event.target.value !== '' && Number.isFinite(next) && next >= min && next <= max) onChange(next)
      }}
      onBlur={event => {
        if (!cancelled.current && modified.current) {
          const next = event.target.valueAsNumber
          const committed = event.target.value !== '' && Number.isFinite(next) ? clamp(next) : beforeEdit.current
          if (committed !== value) onChange(committed)
        }
        cancelled.current = false; setEditing(false)
      }}
      onKeyDown={event => {
        if (event.code === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.code === 'Escape') {
          event.preventDefault(); event.stopPropagation(); cancelled.current = true
          if (beforeEdit.current !== value) onChange(beforeEdit.current)
          event.currentTarget.blur()
        }
      }} /><span id={`${id}-unit`}>{unit}</span></div>
    <button type="button" className="knob-reset" aria-label={`По умолчанию: ${name}`} disabled={disabled} title={`Вернуть ${defaultValue} ${unit}`} onClick={() => onChange(defaultValue)}>↺</button>
    <span className="sr-only" id={`${id}-help`}>{hint} Стрелки меняют значение; Home и End — границы. Shift и вертикальное перетаскивание — точная настройка. Числовое поле под ручкой доступно всегда.</span>
  </div>
}
