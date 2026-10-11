import { useState } from 'react'
import type { EncoderMode, MidiBinding, MidiMessage, MidiState, MidiTargetId } from '../midi/types'
import { TARGETS } from '../midi/targets'
import { MidiLearnButton, useMidiActivity } from '../midi/MidiLearnContext'
import { midiName } from './Piano'
import { Hint } from './Controls'

interface MidiPanelProps {
  state: MidiState
  velocity: number | null
  activeNote: { midi: number; frequency: number; sourceName: string; channel: number } | null
  pitchBend: number
  modulation: number
  bendRange: number
  onBendRange: (range: number) => void
  onConnect: () => void
  onSelectInput: (id: string) => void
  onLearn: (target: MidiTargetId) => void
  onCancelLearn: () => void
  onResolveConflict: (replace: boolean) => void
  onRemoveBinding: (id: string) => void
  onBindingMode: (id: string, mode: EncoderMode) => void
  onClearBindings: () => void
  onClearMonitor: () => void
  onPanic: () => void
}

const STATUS_LABELS: Record<MidiState['status'], string> = {
  idle: 'Не подключён', connecting: 'Подключение…', ready: 'Подключён',
  'no-devices': 'Нет MIDI-входов', denied: 'Доступ запрещён', unsupported: 'MIDI недоступен',
  disconnected: 'Устройство отключено', error: 'Ошибка подключения',
}
const EVENT_LABELS: Record<MidiMessage['type'], string> = {
  noteon: 'Note On', noteoff: 'Note Off', cc: 'Control Change', pitchbend: 'Pitch Bend',
  aftertouch: 'Aftertouch', polyaftertouch: 'Poly Aftertouch', programchange: 'Program Change', system: 'System',
}
const targetLabel = (target: MidiTargetId) => TARGETS.find(item => item.id === target)?.label ?? target
const sourceLabel = (binding: MidiBinding) => `${binding.kind === 'cc' ? 'CC' : 'Note'} ${binding.number} · канал ${binding.channel}`

function eventDetail(event: MidiMessage) {
  if (event.type === 'noteon' || event.type === 'noteoff') return `${midiName(event.note ?? 0)} · № ${event.note} · Velocity ${event.velocity ?? event.value}`
  if (event.type === 'cc') return `CC ${event.controller} · значение ${event.value}`
  if (event.type === 'pitchbend') return `${event.value} / 16383 · ${(event.bend ?? 0) >= 0 ? '+' : ''}${((event.bend ?? 0) * 100).toFixed(1)}%`
  if (event.type === 'polyaftertouch') return `${midiName(event.note ?? 0)} · № ${event.note} · давление ${event.value}`
  if (event.type === 'aftertouch') return `Давление ${event.value}`
  if (event.type === 'programchange') return `Программа ${event.value}`
  return 'Системное сообщение'
}

export function MidiPanel({ state, velocity, activeNote, pitchBend, modulation, bendRange, onBendRange, onConnect, onSelectInput, onLearn, onCancelLearn, onResolveConflict, onRemoveBinding, onBindingMode, onClearBindings, onClearMonitor, onPanic }: MidiPanelProps) {
  const [target, setTarget] = useState<MidiTargetId>('filter.cutoff')
  const activity = useMidiActivity(state.lastActivity, 260)
  const semitones = pitchBend
  const modPercent = Math.round(Math.min(127, Math.max(0, modulation)) / 127 * 100)
  return <section className="panel midi-panel" aria-label="MIDI Controller">
    <div className="midi-heading">
      <div><span className="eyebrow">MIDI CONTROLLER</span><h2>Физический контроллер <Hint text="Подключите MIDI-клавиатуру по USB. Bluetooth MIDI работает, если устройство уже доступно Windows и браузеру. Кнопка M рядом с параметром назначает ручку или пэд." /></h2></div>
      <div className="midi-heading-actions">
        <span className={`midi-status midi-status-${state.status}`}><i aria-hidden="true" />{STATUS_LABELS[state.status]}</span>
        <button type="button" className="midi-panic" onClick={onPanic} title="Немедленно остановить все ноты и сбросить отклонение Pitch Bend">Panic <span>/ All Notes Off</span></button>
        <MidiLearnButton target="panic" />
      </div>
    </div>
    <div className="midi-main">
      <div className="midi-device">
        <div className="midi-device-controls">
          <button type="button" className="midi-connect" disabled={state.status === 'connecting'} onClick={onConnect}>{state.status === 'connecting' ? 'Подключение…' : 'Подключить MIDI'}</button>
          <select aria-label="MIDI-вход" value={state.selectedId} disabled={!state.inputs.length} onChange={event => onSelectInput(event.target.value)}>
            <option value="" disabled>Выберите MIDI-вход</option>
            {state.inputs.map(input => <option key={input.id} value={input.id}>{input.name}{input.manufacturer && !input.name.includes(input.manufacturer) ? ` · ${input.manufacturer}` : ''}</option>)}
          </select>
        </div>
        <p className="midi-message" role="status">{state.message}</p>
        <p className="midi-first-step">Назначение ручки: <b>M</b> у параметра → поверните ручку. Пэды и пресеты — в MIDI-привязках ниже.</p>
      </div>
      <div className="midi-meters" aria-label="Входящие MIDI-значения">
        <div className={`midi-meter midi-activity${activity ? ' has-activity' : ''}`}><span>Вход <i aria-hidden="true" /></span><output aria-label="MIDI-активность">{activity ? 'Сигнал' : 'Ожидание'}</output></div>
        <div className="midi-meter"><span>Velocity <Hint text="Сила нажатия от 1 до 127: влияет на громкость ноты вместе с Amplitude и ADSR. Ноль отпускает ноту." /></span><output aria-label="Текущая Velocity">{velocity === null ? '—' : velocity}<small> / 127</small></output><div className="midi-level" aria-hidden="true"><span style={{ width: `${(velocity ?? 0) / 127 * 100}%` }} /></div></div>
        <div className="midi-meter"><span>Pitch Bend <Hint text="Отклонение высоты текущей ноты, в полутонах. Центральное положение возвращает исходную высоту." /></span><output aria-label="Текущий Pitch Bend">{semitones > 0 ? '+' : ''}{semitones.toFixed(2)}<small> st</small></output><label className="midi-bend-range">± <select aria-label="Диапазон Pitch Bend" value={bendRange} onChange={event => onBendRange(Number(event.target.value))}><option value={2}>2 st</option><option value={12}>12 st</option></select></label></div>
        <div className="midi-meter"><span>Modulation <Hint text="Стандартный CC1 меняет глубину LFO. Другой CC можно назначить кнопкой M у LFO Depth." /></span><output aria-label="Текущая Modulation">{modulation}<small> / 127 · {modPercent}%</small></output><div className="midi-level" aria-hidden="true"><span style={{ width: `${modPercent}%` }} /></div></div>
      </div>
    </div>
    <div className="midi-note" aria-live="off">
      {activeNote ? <><span className="midi-note-name">{midiName(activeNote.midi)}</span><span>MIDI {activeNote.midi}</span><span>{activeNote.frequency.toFixed(2)} Hz</span><span className="midi-note-source">{activeNote.sourceName} · канал {activeNote.channel}</span></> : <span>Сыграйте ноту на MIDI-клавиатуре — здесь появятся её имя, номер и частота.</span>}
    </div>
    {state.learning && <div className="midi-learning-notice" role="status"><span><b>MIDI Learn: {targetLabel(state.learning)}</b> · {TARGETS.find(item => item.id === state.learning)?.kind === 'action' ? 'Нажмите пэд или кнопку (Note On / CC).' : 'Поверните ручку, которая отправляет CC.'} <kbd>Esc</kbd> — отмена.</span><button type="button" onClick={onCancelLearn}>Отменить MIDI Learn</button></div>}
    {state.conflict && <div className="midi-conflict" role="alert"><div><b>Этот сигнал уже назначен</b><p>{sourceLabel(state.conflict.incoming)} · {state.conflict.incoming.sourceName}: «{targetLabel(state.conflict.existing.target)}». Заменить на «{targetLabel(state.conflict.incoming.target)}»?</p></div><div><button type="button" onClick={() => onResolveConflict(true)}>Заменить привязку</button><button type="button" onClick={() => onResolveConflict(false)}>Отменить замену</button></div></div>}
    {state.storageError && <p className="midi-storage-error" role="alert">{state.storageError}</p>}
    <div className="midi-secondary">
      <details className="midi-bindings"><summary>MIDI-привязки <span>· {state.bindings.length}</span></summary>
        <div className="midi-details-content">
          <p className="midi-help">Выберите действие для пэда или параметр для ручки. Затем нажмите MIDI Learn и используйте нужный орган управления. Назначенный пэд выполняет действие без запуска ноты.</p>
          <div className="midi-learn-row"><select aria-label="Параметр для MIDI Learn" value={target} onChange={event => setTarget(event.target.value as MidiTargetId)}>{TARGETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button type="button" className="midi-secondary-button" onClick={() => onLearn(target)}>Начать MIDI Learn</button></div>
          {state.bindings.length ? <ul className="midi-binding-list">{state.bindings.map(binding => <li key={binding.id}>
            <div className="midi-binding-description"><b>{targetLabel(binding.target)}</b><span>{sourceLabel(binding)}</span><small>{binding.sourceName}</small></div>
            {binding.kind === 'cc' && TARGETS.find(item => item.id === binding.target)?.kind === 'continuous' && <select aria-label={`Режим энкодера: ${targetLabel(binding.target)}`} value={binding.mode} onChange={event => onBindingMode(binding.id, event.target.value as EncoderMode)}><option value="absolute">Абсолютный · 0–127</option><option value="relative-twos-complement">Относительный · 2’s complement</option><option value="relative-binary-offset">Относительный · binary offset</option><option value="relative-sign-magnitude">Относительный · sign magnitude</option></select>}
            <button type="button" className="midi-remove" aria-label={`Удалить MIDI-привязку: ${targetLabel(binding.target)}`} onClick={() => onRemoveBinding(binding.id)}>Удалить</button>
          </li>)}</ul> : <p className="midi-empty">Пока нет привязок. Ни один CC не назначен заранее.</p>}
          <div className="midi-bindings-footer"><p className="midi-help">Назначения сохраняются в этом браузере. Режим энкодера выбирайте по данным MIDI Monitor: автоматическое определение не используется.</p><button type="button" className="midi-text-button" disabled={!state.bindings.length} onClick={onClearBindings}>Удалить все MIDI-привязки</button></div>
        </div>
      </details>
      <details className="midi-monitor"><summary>MIDI Monitor <span>· {Math.min(state.events.length, 30)}</span></summary>
        <div className="midi-details-content"><div className="midi-monitor-tools"><p className="midi-help">Последние 30 событий. RAW — исходные MIDI-байты в шестнадцатеричном виде.</p><button type="button" className="midi-text-button" disabled={!state.events.length} onClick={onClearMonitor}>Очистить MIDI Monitor</button></div>
          {state.events.length ? <ol className="midi-event-list" aria-label="События MIDI">{state.events.slice(0, 30).map((event, index) => <li key={`${event.timestamp}-${index}`}><div className="midi-event-main"><b>{EVENT_LABELS[event.type]}</b><span>{eventDetail(event)}</span></div><div className="midi-event-meta"><span>{event.sourceName} · {event.channel === null ? 'система' : `канал ${event.channel}`}</span><code title="Исходные байты MIDI">{event.raw.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')}</code></div></li>)}</ol> : <p className="midi-empty">Событий пока нет. После подключения нажмите клавишу или поверните ручку.</p>}
        </div>
      </details>
    </div>
  </section>
}
