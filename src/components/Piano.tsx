import { useState } from 'react'
import { Hint } from './Controls'
import '../audio/polyphony.css'

export const KEY_CODES = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK']
const KEY_LABELS = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K']
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
export const midiFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)
export const midiName = (midi: number) => `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

export function describeFrequency(frequency: number) {
  const exact = 69 + 12 * Math.log2(frequency / 440)
  const midi = Math.round(exact)
  const cents = Math.round((exact - midi) * 100)
  return { midi, name: midiName(midi), cents }
}

interface PianoProps {
  octave: number
  setOctave: (octave: number) => void
  activeMidis: number[]
  heldCount: number
  voiceCount: number
  activeNotes: { id: string; midi: number; sourceName: string; channel: number | null }[]
  frequency: number
  onDown: (id: string, midi: number) => void
  onUp: (id: string) => void
}

export function Piano({ octave, setOctave, activeMidis, heldCount, voiceCount, activeNotes, frequency, onDown, onUp }: PianoProps) {
  const [focused, setFocused] = useState(false)
  const highlighted = new Set(activeMidis)
  const keys = Array.from({ length: 13 }, (_, index) => {
    const midi = 12 * (octave + 1) + index
    return { index, midi, black: [1, 3, 6, 8, 10].includes(index) }
  })
  const tuning = describeFrequency(frequency)
  const octaveChange = (next: number) => setOctave(Math.max(1, Math.min(6, next)))
  return <section className="panel keyboard-panel" aria-label="Виртуальная клавиатура">
    <div className="keyboard-heading"><div><span className="eyebrow">ИГРАЙТЕ И ИССЛЕДУЙТЕ</span><h2>Ноты под рукой <Hint text="До 16 голосов одновременно. Каждая нота имеет собственную огибающую и Velocity. Отпускание одной клавиши не прерывает остальные; её голос завершает Release. Частота ручного прослушивания задаётся отдельно." /></h2></div>
      <div className="note-readout" aria-label="Тон ручного прослушивания"><span>{tuning.name}{tuning.cents !== 0 && <small> {tuning.cents > 0 ? '+' : ''}{tuning.cents} ¢</small>}</span><span>{frequency.toFixed(2)} Hz · Play</span></div>
      <div className="octave-control"><button aria-label="Октава ниже" disabled={octave === 1} onClick={() => octaveChange(octave - 1)}>−</button><span>C{octave} — C{octave + 1}</span><button aria-label="Октава выше" disabled={octave === 6} onClick={() => octaveChange(octave + 1)}>+</button></div>
    </div>
    <div className="polyphony-status">
      <span>Удерживается <output aria-label="Удерживаемые ноты">{heldCount}</output></span>
      <span>Звучит <output aria-label="Звучащие голоса">{voiceCount}</output> <small>· лимит 16</small> <Hint text="Число голосов включает затухающие Release и отдельный голос Play. При замене голоса короткие затухающие переходы временно добавляются к лимиту 16. Подсветка показывает удерживаемые клавиши." /></span>
    </div>
    <ul className="polyphony-notes" aria-label="Активные ноты">
      {activeNotes.length ? activeNotes.map(note => <li key={note.id} title={`${note.sourceName}${note.channel === null ? '' : ` · канал ${note.channel}`} · MIDI ${note.midi}`}><b>{midiName(note.midi)}</b><small>{note.sourceName}{note.channel === null ? '' : ` · ${note.channel}`}</small></li>) : <li className="polyphony-empty">Нажмите несколько клавиш, чтобы услышать аккорд.</li>}
    </ul>
    <div className={`piano ${focused ? 'piano-focused' : ''}`}>
      {keys.map(({ index, midi, black }) => <button key={midi} className={`piano-key ${black ? 'black-key' : 'white-key'} ${highlighted.has(midi) ? 'key-active' : ''}`}
        style={black ? { left: `${({ 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 } as Record<number, number>)[index] / 8 * 100}%` } : undefined}
        aria-label={`Нота ${midiName(midi)}`} aria-pressed={highlighted.has(midi)} aria-describedby="piano-instructions"
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onUp(`focus:${midi}`) }}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onDown(`pointer:${event.pointerId}`, midi) }}
        onPointerUp={event => { onUp(`pointer:${event.pointerId}`); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={event => onUp(`pointer:${event.pointerId}`)}
        onLostPointerCapture={event => onUp(`pointer:${event.pointerId}`)}
        onClick={event => {
          // Screen readers activate buttons with a click, without pointer or
          // key down/up. Each explicitly activated key has its own identity.
          // Pointer clicks have detail > 0; Space/Enter prevent their default click.
          if (event.detail !== 0) return
          const id = `assistive:${midi}`
          if (activeNotes.some(note => note.id === id)) onUp(id)
          else onDown(id, midi)
        }}
        onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (!event.repeat) onDown(`focus:${midi}`, midi) } }}
        onKeyUp={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); onUp(`focus:${midi}`) } }}>
        <span className="key-note">{midiName(midi)}</span><span className="key-shortcut">{KEY_LABELS[index]}</span>
      </button>)}
    </div>
    <p id="piano-instructions" className="sr-only">Удерживайте мышью, несколькими пальцами или клавишей Space либо Enter. При использовании экранного диктора активация удерживает выбранную ноту, повторная активация отпускает только её. Можно удерживать несколько нот. Esc останавливает все голоса.</p>
    <div className="keyboard-footer"><span><kbd>A</kbd>—<kbd>K</kbd> · белые и чёрные клавиши по подписям · работает и с русской раскладкой</span><span>Удержать → Note On <span className="muted">/</span> отпустить → Note Off</span></div>
  </section>
}
