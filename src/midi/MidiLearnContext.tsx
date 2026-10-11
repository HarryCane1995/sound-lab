import { createContext, useContext, useEffect, useState } from 'react'
import { INITIAL_MIDI_STATE } from './types'
import type { MidiState, MidiTargetId } from './types'
import { TARGETS } from './targets'

interface MidiLearnContextValue {
  state: MidiState
  onLearn: (target: MidiTargetId) => void
  onRemove: (bindingId: string) => void
}

const MidiLearnContext = createContext<MidiLearnContextValue>({
  state: INITIAL_MIDI_STATE,
  onLearn: () => {},
  onRemove: () => {},
})

export const MidiLearnProvider = MidiLearnContext.Provider

/** Activity is transient, even when the controller stops sending messages. */
export function useMidiActivity(timestamp: number, duration = 1500) {
  const [recent, setRecent] = useState(false)
  useEffect(() => {
    const remaining = duration - (Date.now() - timestamp)
    if (!timestamp || remaining <= 0) { setRecent(false); return }
    setRecent(true)
    const timeout = window.setTimeout(() => setRecent(false), remaining)
    return () => window.clearTimeout(timeout)
  }, [timestamp, duration])
  return recent
}

export function MidiLearnButton({ target }: { target: MidiTargetId }) {
  const { state, onLearn } = useContext(MidiLearnContext)
  const metadata = TARGETS.find(item => item.id === target)
  const label = metadata?.label ?? target
  const bindings = state.bindings.filter(binding => binding.target === target)
  const armed = state.learning === target
  const controlled = useMidiActivity(state.lastControlled?.target === target ? state.lastControlled.timestamp : 0)
  const description = bindings.length
    ? bindings.map(binding => `${binding.kind === 'cc' ? 'CC' : 'Note'} ${binding.number} · ${binding.sourceName} · канал ${binding.channel}`).join('\n')
    : metadata?.kind === 'action' ? 'Нажмите M, затем нажмите пэд или кнопку на MIDI-контроллере.' : 'Нажмите M, затем поверните ручку на MIDI-контроллере, которая отправляет CC.'
  return <span className="midi-learn-control">
    <button type="button" className={`midi-learn-button${armed ? ' is-learning' : ''}${bindings.length ? ' is-bound' : ''}`}
      aria-label={`MIDI Learn: ${label}`} aria-pressed={armed}
      title={armed ? `Ожидание MIDI для ${label}. Esc — отмена.` : `${label}\n${description}\nНажмите для переназначения; удалить можно в MIDI-привязках.`}
      onClick={() => onLearn(target)}>M</button>
    {controlled && <span className="midi-controlled" aria-label={`${label}: управление MIDI`}>MIDI</span>}
  </span>
}
