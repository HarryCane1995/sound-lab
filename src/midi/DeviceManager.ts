import type { MidiDevice } from './types'
import type { MidiSettings } from './storage'

interface DeviceSnapshot {
  inputs: MidiDevice[]
  selectedId: string
  preferred: MidiSettings['selectedInput']
  replacedSourceId: string | null
  status: 'ready' | 'no-devices' | 'disconnected'
}
interface DeviceCallbacks {
  onChange: (snapshot: DeviceSnapshot) => void
  onMessage: (event: MIDIMessageEvent, input: MIDIInput) => void
  onDisconnect: (sourceId: string) => void
  onError: (error: unknown) => void
  canRestoreByName: (sourceId: string) => boolean
}

/** Owns exactly one input subscription. Construction never requests permission. */
export class DeviceManager {
  private access: MIDIAccess | null = null
  private selected: MIDIInput | null = null
  private preferred: MidiSettings['selectedInput']
  private disposed = false
  private pending: Promise<void> | null = null
  private callbacks: DeviceCallbacks

  constructor(callbacks: DeviceCallbacks, preferred: MidiSettings['selectedInput']) {
    this.callbacks = callbacks
    this.preferred = preferred
  }

  private handleMessage = (event: MIDIMessageEvent): void => {
    if (!this.disposed && this.selected) this.callbacks.onMessage(event, this.selected)
  }
  private handleStateChange = (): void => { this.refresh() }

  async connect(): Promise<void> {
    if (this.disposed) return
    if (this.access) {
      this.refresh()
      // An explicit retry should retry a port that failed to open previously.
      if (this.selected) await this.selected.open()
      return
    }
    if (this.pending) return this.pending
    this.pending = this.requestAccess()
    try { await this.pending } finally { this.pending = null }
  }

  private async requestAccess(): Promise<void> {
    const access = await navigator.requestMIDIAccess({ sysex: false })
    if (this.disposed) return
    this.access = access
    access.addEventListener('statechange', this.handleStateChange)
    this.refresh()
  }

  private detach(): void {
    if (!this.selected) return
    const old = this.selected
    this.selected = null
    old.removeEventListener('midimessage', this.handleMessage)
    // Release notes from the old source before any new source can deliver notes.
    this.callbacks.onDisconnect(old.id)
  }

  private attach(input: MIDIInput | null): void {
    if (input === this.selected) return
    this.detach()
    if (!input || this.disposed) return
    this.selected = input
    input.addEventListener('midimessage', this.handleMessage)
    // Listening implicitly opens a Web MIDI input. Explicit open lets us report
    // OS-level errors, while the disposed check prevents stale async UI updates.
    void input.open().catch(error => { if (!this.disposed && this.selected === input) this.callbacks.onError(error) })
  }

  private connectedInputs(): MIDIInput[] {
    return this.access ? Array.from(this.access.inputs.values()).filter(input => input.state === 'connected') : []
  }

  private refresh(): void {
    if (this.disposed || !this.access) return
    const inputs = this.connectedInputs()
    const previousId = this.preferred?.id ?? null
    let replacedSourceId: string | null = null
    let next = this.preferred ? inputs.find(input => input.id === this.preferred?.id) : inputs[0]
    if (!next && this.preferred) {
      // Some systems issue a new port id after reconnection. A unique exact name
      // is a useful fallback; never select between identically named devices.
      const matches = inputs.filter(input => (input.name || 'MIDI input') === this.preferred?.name)
      // A port already known through other mappings is a distinct controller,
      // even when it is the only same-named port currently connected.
      if (matches.length === 1 && this.callbacks.canRestoreByName(matches[0].id)) {
        next = matches[0]
        replacedSourceId = previousId
      }
    }
    this.attach(next ?? null)
    if (next) this.preferred = { id: next.id, name: next.name || 'MIDI input' }
    this.callbacks.onChange({
      inputs: inputs.map(input => ({ id: input.id, name: input.name || 'MIDI input', manufacturer: input.manufacturer || '', state: input.state })),
      selectedId: this.selected?.id ?? '', preferred: this.preferred, replacedSourceId,
      status: this.selected ? 'ready' : this.preferred ? 'disconnected' : 'no-devices',
    })
  }

  selectInput(id: string): void {
    if (this.disposed || !this.access) return
    const input = this.connectedInputs().find(input => input.id === id)
    if (!input) return
    this.preferred = { id: input.id, name: input.name || 'MIDI input' }
    this.attach(input)
    this.refresh()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const selected = this.selected
    this.detach()
    this.access?.removeEventListener('statechange', this.handleStateChange)
    this.access = null
    // close is best effort: cleanup must still succeed if a device vanished.
    if (selected) void selected.close().catch(() => {})
  }
}
