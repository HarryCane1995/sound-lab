import { DeviceManager } from './DeviceManager'
import { parseMidiMessage } from './parser'
import { bindingSignal, loadMidiSettings, saveMidiSettings } from './storage'
import type { MidiSettings } from './storage'
import { clampNormalized, TARGETS } from './targets'
import { INITIAL_MIDI_STATE } from './types'
import type { EncoderMode, MidiBinding, MidiCallbacks, MidiMessage, MidiState, MidiTargetId } from './types'

function messageSignal(message: MidiMessage): string | null {
  if (message.channel === null) return null
  if (message.type === 'cc') return JSON.stringify([message.sourceId, message.channel, 'cc', message.controller])
  if (message.type === 'noteon' || message.type === 'noteoff') return JSON.stringify([message.sourceId, message.channel, 'note', message.note])
  return null
}

/** The three relative encodings are explicit user choices, never inferred. */
export function relativeDelta(value: number, mode: EncoderMode): number {
  if (mode === 'relative-twos-complement') return value < 64 ? value : value - 128
  if (mode === 'relative-binary-offset') return value - 64
  if (mode === 'relative-sign-magnitude') return value < 64 ? value : -(value - 64)
  return 0
}

export class MidiController {
  private callbacks: MidiCallbacks
  private state: MidiState
  private manager: DeviceManager
  private preferred: MidiSettings['selectedInput']
  private disposed = false
  private pressed = new Set<string>()
  private consumedNotes = new Set<string>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(callbacks: MidiCallbacks) {
    this.callbacks = callbacks
    const { settings, error } = loadMidiSettings()
    this.preferred = settings.selectedInput
    this.state = { ...INITIAL_MIDI_STATE, inputs: [], events: [], bindings: settings.bindings, storageError: error, preferredName: settings.selectedInput?.name ?? null }
    this.manager = new DeviceManager({
      onMessage: (event, input) => {
        if (!event.data) return
        const message = parseMidiMessage(event.data, input, event.timeStamp)
        if (message) this.receive(message)
      },
      onDisconnect: sourceId => {
        this.resetPressed()
        this.state = { ...this.state, learning: null, conflict: null }
        this.callbacks.onDisconnect(sourceId)
      },
      canRestoreByName: sourceId => !this.state.bindings.some(binding => binding.sourceId === sourceId),
      onChange: snapshot => {
        const previous = this.preferred
        this.preferred = snapshot.preferred
        // Migrate only the previously selected source after a unique-name port
        // match, preserving mappings across an OS-assigned replacement port id.
        if (previous && snapshot.preferred && snapshot.replacedSourceId === previous.id && previous.name === snapshot.preferred.name) {
          const otherSignals = new Set(this.state.bindings.filter(binding => binding.sourceId !== previous.id).map(bindingSignal))
          this.state = { ...this.state, bindings: this.state.bindings.map(binding => {
            if (binding.sourceId !== previous.id || binding.sourceName !== previous.name) return binding
            const migrated = { ...binding, sourceId: snapshot.preferred!.id }
            const signal = bindingSignal(migrated)
            // Defend the stored schema even if a future device policy allows
            // restoring onto a port with existing assignments. Keep the old
            // valid mapping when a physical signal is already assigned there.
            if (otherSignals.has(signal)) return binding
            otherSignals.add(signal)
            return migrated
          }) }
        }
        this.state = { ...this.state, inputs: snapshot.inputs, selectedId: snapshot.selectedId, preferredName: snapshot.preferred?.name ?? null, status: snapshot.status,
          message: snapshot.status === 'ready' ? `Подключено: ${snapshot.preferred?.name}.` : snapshot.status === 'disconnected' ? `Устройство «${snapshot.preferred?.name}» отключено или недоступно. Подключите его снова либо выберите другой вход.` : 'MIDI-входы не найдены. Подключите контроллер по USB; Bluetooth MIDI должен быть уже доступен Windows.' }
        this.persist()
        this.notify()
      },
      onError: () => this.patch({ status: 'error', message: 'Не удалось открыть MIDI-вход. Проверьте устройство и попробуйте подключиться снова.' }),
    }, settings.selectedInput)
  }

  getState(): MidiState { return this.state }

  private notify(delayed = false): void {
    if (this.disposed) return
    if (delayed) {
      if (this.notifyTimer === null) this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.notify() }, 33)
      return
    }
    if (this.notifyTimer !== null) { clearTimeout(this.notifyTimer); this.notifyTimer = null }
    this.callbacks.onState(this.state)
  }

  private patch(change: Partial<MidiState>): void {
    this.state = { ...this.state, ...change }
    this.notify()
  }

  private persist(): void {
    const error = saveMidiSettings({ version: 1, selectedInput: this.preferred, bindings: this.state.bindings })
    this.state = { ...this.state, storageError: error }
  }

  /** Invoke only in a user gesture handler; never on mount or automatic retry. */
  async connect(): Promise<void> {
    if (this.disposed || this.state.status === 'connecting') return
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.patch({ status: 'unsupported', message: 'Web MIDI недоступен. Откройте SOUND LAB в Chrome или Edge через localhost или HTTPS.' })
      return
    }
    this.patch({ status: 'connecting', message: 'Ожидаем разрешение браузера на доступ к MIDI…' })
    try { await this.manager.connect() }
    catch (error) {
      if (this.disposed) return
      const name = error instanceof DOMException || error instanceof Error ? error.name : ''
      this.patch({ status: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error', message: name === 'NotAllowedError' || name === 'SecurityError' ? 'Доступ к MIDI запрещён. Разрешите MIDI для этого сайта в настройках Chrome/Edge и повторите подключение.' : 'Не удалось подключить MIDI. Проверьте USB-подключение и повторите попытку.' })
    }
  }

  selectInput(id: string): void {
    this.cancelLearn()
    this.manager.selectInput(id)
  }
  beginLearn(target: MidiTargetId): void {
    if (!TARGETS.some(item => item.id === target)) return
    this.patch({ learning: target, conflict: null })
  }
  cancelLearn(): void { this.patch({ learning: null, conflict: null }) }

  private installBinding(incoming: MidiBinding): void {
    this.state = { ...this.state, bindings: [...this.state.bindings.filter(binding => binding.target !== incoming.target && bindingSignal(binding) !== bindingSignal(incoming)), incoming], learning: null, conflict: null }
    this.persist()
    this.notify()
  }

  resolveConflict(replace: boolean): void {
    const conflict = this.state.conflict
    if (!conflict) return
    if (replace) this.installBinding(conflict.incoming)
    else this.cancelLearn()
  }
  removeBinding(id: string): void {
    this.state = { ...this.state, bindings: this.state.bindings.filter(binding => binding.id !== id), conflict: null }
    this.persist()
    this.notify()
  }
  setBindingMode(id: string, mode: EncoderMode): void {
    const validModes: EncoderMode[] = ['absolute', 'relative-twos-complement', 'relative-binary-offset', 'relative-sign-magnitude']
    if (!validModes.includes(mode)) return
    this.state = { ...this.state, bindings: this.state.bindings.map(binding => binding.id === id && TARGETS.find(target => target.id === binding.target)?.kind === 'continuous' ? { ...binding, mode } : binding) }
    this.persist()
    this.notify()
  }
  clearBindings(): void {
    // Keep consumed note releases until they arrive, even after removing a map.
    this.state = { ...this.state, bindings: [], learning: null, conflict: null }
    this.persist()
    this.notify()
  }
  clearMonitor(): void { this.patch({ events: [] }) }
  resetPressed(): void { this.pressed.clear(); this.consumedNotes.clear() }

  private learn(message: MidiMessage, signal: string): boolean {
    const targetId = this.state.learning
    const target = TARGETS.find(target => target.id === targetId)
    if (!target || this.state.conflict || message.channel === null) return false
    // Channel panic messages retain their MIDI meaning and cannot be reassigned.
    if (message.type === 'cc' && (message.controller === 120 || message.controller === 123)) return false
    const eligible = message.type === 'cc' ? target.kind !== 'action' || message.value >= 64 : target.kind === 'action' && message.type === 'noteon'
    if (!eligible) return false
    const kind = message.type === 'cc' ? 'cc' : 'note'
    const incoming: MidiBinding = { id: crypto.randomUUID(), target: target.id, sourceId: message.sourceId, sourceName: message.sourceName, channel: message.channel, kind, number: kind === 'cc' ? message.controller! : message.note!, mode: 'absolute' }
    // The capture is deliberately inert and seeds the held latch so a held pad
    // cannot trigger its newly assigned action before its first release.
    if (target.kind === 'action') this.pressed.add(signal)
    if (kind === 'note') this.consumedNotes.add(signal)
    const existing = this.state.bindings.find(binding => bindingSignal(binding) === signal && binding.target !== incoming.target)
    if (existing) this.patch({ conflict: { existing, incoming } })
    else this.installBinding(incoming)
    return true
  }

  private receive(message: MidiMessage): void {
    if (this.disposed) return
    this.state = { ...this.state, events: [message, ...this.state.events].slice(0, 30), lastActivity: Date.now() }
    const signal = messageSignal(message)
    let consumed = false
    if (signal) {
      const isRelease = message.type === 'noteoff' || (message.type === 'cc' && message.value < 64)
      const wasPressed = this.pressed.has(signal)
      if (isRelease) this.pressed.delete(signal)
      if (message.type === 'noteoff' && this.consumedNotes.delete(signal)) consumed = true
      const conflictSignal = this.state.conflict ? bindingSignal(this.state.conflict.incoming) : null
      if (conflictSignal === signal) {
        consumed = true
        if (message.type === 'noteon') this.consumedNotes.add(signal)
      } else if (this.learn(message, signal)) consumed = true
      else {
        const binding = this.state.bindings.find(binding => bindingSignal(binding) === signal)
        if (binding) {
          consumed = true
          const target = TARGETS.find(target => target.id === binding.target)!
          if (binding.kind === 'note' && message.type === 'noteon') this.consumedNotes.add(signal)
          let normalized: number | null = null
          let trigger = false
          if (target.kind === 'action') {
            if (!isRelease) {
              this.pressed.add(signal)
              trigger = !wasPressed
            }
          } else if (message.type === 'cc') {
            normalized = binding.mode === 'absolute' ? message.value / 127 : clampNormalized(this.callbacks.getTargetNormalized(binding.target) + relativeDelta(message.value, binding.mode) / 127)
            trigger = true
          }
          if (trigger) {
            this.state = { ...this.state, lastControlled: { target: binding.target, timestamp: Date.now() } }
            this.callbacks.onTarget(binding.target, normalized, message)
            // A MIDI-bound Panic may synchronously clear all bookkeeping. Keep
            // this specific physical press latched until its matching release.
            if (target.kind === 'action') this.pressed.add(signal)
            if (binding.kind === 'note' && message.type === 'noteon') this.consumedNotes.add(signal)
          }
        }
      }
    }
    this.callbacks.onMessage(message, consumed)
    this.notify(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer)
    this.notifyTimer = null
    this.manager.dispose()
    this.resetPressed()
  }
}
