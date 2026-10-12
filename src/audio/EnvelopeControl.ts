import envelopeSource from './envelope-worklet.js?raw'

export const ENVELOPE_PROCESSOR = 'sound-lab-envelope-v1'
export const ENVELOPE_LANES = 20
const READY_TIMEOUT_MS = 1500
const registrations = new WeakMap<AudioContext, Promise<void>>()
const preparations = new WeakMap<AudioContext, Promise<void>>()
const services = new WeakMap<AudioContext, EnvelopeService>()
const disposedContexts = new WeakSet<AudioContext>()
const cancelPreparations = new WeakMap<AudioContext, () => void>()

export interface EnvelopeProcessorState {
  type: 'state'
  slot: number
  generation: number
  instanceId: number
  revision: number
  appliedFrame: number
  renderedThroughFrame: number
  endFrame: number | null
  zeroFrame: number | null
  readyFrame: number
  firstProcessFrame: number | null
}

export interface InitialEnvelopePlan {
  type: 'plan'
  revision: number
  at: number
  ramps: ReadonlyArray<{ start: number; end: number; from: number; to: number }>
}

/** A per-lane facade; incoming events are actual native-port packets. */
class EnvelopePort extends EventTarget {
  onmessage: ((event: MessageEvent<EnvelopeProcessorState>) => void) | null = null
  private closed = false
  private lease: EnvelopeLease

  constructor(lease: EnvelopeLease) { super(); this.lease = lease }

  postMessage(message: Record<string, unknown>): void {
    if (!this.closed) this.lease.send(message)
  }

  start(): void { /* EventTarget delivery needs no native-port start. */ }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onmessage = null
    this.lease.release()
  }

  deliver(state: EnvelopeProcessorState): void {
    if (this.closed) return
    const event = new MessageEvent<EnvelopeProcessorState>('message', { data: state })
    this.onmessage?.(event)
    this.dispatchEvent(event)
  }
}

/** One leased output of the shared, already-running audio-thread processor. */
export class EnvelopeLease {
  readonly port: EnvelopePort
  readonly slot: number
  readonly generation: number
  readonly instanceId: number
  private service: EnvelopeService
  private released = false

  constructor(
    service: EnvelopeService,
    slot: number,
    generation: number,
    instanceId: number,
  ) {
    this.service = service
    this.slot = slot
    this.generation = generation
    this.instanceId = instanceId
    this.port = new EnvelopePort(this)
  }

  connect(destination: AudioNode | AudioParam, input = 0): void {
    if (this.released) throw new Error('The envelope lane has been released.')
    if (destination instanceof AudioParam) this.service.splitter.connect(destination, this.slot)
    else this.service.splitter.connect(destination, this.slot, input)
  }

  disconnect(): void {
    try { this.service.splitter.disconnect(this.slot) } catch { /* No remaining lane connections. */ }
  }

  send(message: Record<string, unknown>): void {
    if (this.released) return
    if (message.type === 'dispose') { this.port.close(); return }
    // Routing belongs to the lease, never caller-supplied message fields.
    this.service.send({ ...message, slot: this.slot, generation: this.generation, instanceId: this.instanceId })
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.disconnect()
    this.service.release(this)
  }
}

interface ReadyState { type: 'ready'; readyFrame: number; firstProcessFrame: number | null }

/** A single physical processor stays warm even when the synth has no notes. */
class EnvelopeService {
  readonly node: AudioWorkletNode
  readonly splitter: ChannelSplitterNode
  readonly keeper: GainNode
  readonly ready: Promise<void>
  private leases: Array<EnvelopeLease | null> = Array.from({ length: ENVELOPE_LANES }, () => null)
  private generations = Array.from({ length: ENVELOPE_LANES }, () => 0)
  private resolveReady!: () => void
  private rejectReady!: (reason: Error) => void
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  isReady = false
  disposed = false
  readyFrame: number | null = null
  firstProcessFrame: number | null = null
  private context: AudioContext
  private onFailure: (() => void) | undefined

  constructor(context: AudioContext, onFailure?: () => void) {
    this.context = context
    this.onFailure = onFailure
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.node = new AudioWorkletNode(context, ENVELOPE_PROCESSOR, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [ENVELOPE_LANES],
      channelCount: ENVELOPE_LANES, channelCountMode: 'explicit',
      processorOptions: { lanes: ENVELOPE_LANES },
    })
    this.splitter = context.createChannelSplitter(ENVELOPE_LANES)
    this.keeper = context.createGain()
    this.keeper.gain.value = 0
    this.node.connect(this.splitter)
    this.node.connect(this.keeper)
    this.keeper.connect(context.destination)
    this.node.port.onmessage = (event: MessageEvent<EnvelopeProcessorState | ReadyState>) => {
      if (this.disposed) return
      const packet = event.data
      if (packet?.type === 'ready') {
        this.readyFrame = packet.readyFrame
        this.firstProcessFrame = packet.firstProcessFrame
        if (packet.firstProcessFrame !== null && !this.isReady) {
          this.isReady = true
          this.clearReadyWait()
          this.resolveReady()
        }
      } else if (packet?.type === 'state') {
        const lease = this.leases[packet.slot]
        if (lease?.generation === packet.generation && lease.instanceId === packet.instanceId) lease.port.deliver(packet)
      }
    }
    this.node.onprocessorerror = () => {
      if (!this.isReady) this.rejectReady(new Error('The audio envelope processor failed to initialize.'))
      // A failed processor outputs silence, but its held voices still need
      // cancellation. Stop the clock before the engine discards their graph.
      const stopped = context.state === 'running' ? context.suspend() : Promise.resolve()
      void stopped.catch(() => context.state === 'closed' ? undefined : context.close())
        .finally(() => { this.dispose(); this.onFailure?.() })
    }
    context.addEventListener('statechange', this.onContextState)
    this.readyTimer = setTimeout(() => {
      if (this.isReady || this.disposed) return
      this.rejectReady(new Error('The audio envelope processor did not become ready.'))
      this.dispose()
    }, READY_TIMEOUT_MS)
  }

  acquire(instanceId: number, initialPlan?: InitialEnvelopePlan): EnvelopeLease {
    if (!this.isReady || this.disposed || this.context.state !== 'running') throw new Error('The audio envelope service is unavailable.')
    const slot = this.leases.findIndex(lease => lease === null)
    if (slot < 0) throw new Error('The audio envelope lane limit was reached.')
    const lease = new EnvelopeLease(this, slot, ++this.generations[slot], instanceId)
    this.leases[slot] = lease
    this.send({ type: 'claim', slot, generation: lease.generation, instanceId, initialPlan })
    return lease
  }

  send(message: Record<string, unknown>): void {
    if (!this.disposed) this.node.port.postMessage(message)
  }

  release(lease: EnvelopeLease): void {
    if (this.leases[lease.slot] !== lease) return
    this.leases[lease.slot] = null
    this.send({ type: 'release', slot: lease.slot, generation: lease.generation, instanceId: lease.instanceId })
  }

  diagnostics() {
    return {
      physicalEnvelopeProcessorCount: this.disposed ? 0 : 1,
      maxPhysicalEnvelopeProcessors: 1,
      activeEnvelopeLeaseCount: this.leases.filter(Boolean).length,
      maxEnvelopeLeases: ENVELOPE_LANES,
      envelopeServiceReady: this.isReady && !this.disposed,
      envelopeServiceReadyFrame: this.readyFrame,
      envelopeServiceFirstProcessFrame: this.firstProcessFrame,
    }
  }

  dispose(): void {
    if (this.disposed) return
    if (!this.isReady) this.rejectReady(new Error('The audio envelope service was cancelled before readiness.'))
    this.clearReadyWait()
    this.context.removeEventListener('statechange', this.onContextState)
    for (const lease of this.leases) lease?.port.close()
    this.node.port.postMessage({ type: 'dispose' })
    this.disposed = true
    this.isReady = false
    this.node.disconnect()
    this.splitter.disconnect()
    this.keeper.disconnect()
    this.node.port.onmessage = null
    this.node.onprocessorerror = null
    this.node.port.close()
  }

  private onContextState = (): void => {
    if (this.context.state === 'closed') this.dispose()
  }

  private clearReadyWait(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }
}

export function envelopeWorkletReady(context: AudioContext): boolean {
  const service = services.get(context)
  return !!service?.isReady && !service.disposed
}

export function ensureEnvelopeWorklet(context: AudioContext, onFailure?: () => void): Promise<void> {
  if (disposedContexts.has(context) || context.state === 'closed') return Promise.reject(new Error('The audio envelope context has been disposed.'))
  const pending = preparations.get(context)
  if (pending && !services.get(context)?.disposed) return pending
  let registration = registrations.get(context)
  if (!registration) {
    // Bundle the module so an older open PWA window never fetches a removed
    // hashed asset after another window activates an update.
    const moduleUrl = URL.createObjectURL(new Blob([envelopeSource], { type: 'text/javascript' }))
    registration = context.audioWorklet.addModule(moduleUrl)
      .catch((error: unknown) => { registrations.delete(context); throw error })
      .finally(() => { URL.revokeObjectURL(moduleUrl) })
    registrations.set(context, registration)
  }
  let cancel!: () => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => { reject(new Error('The audio envelope preparation was cancelled.')) }
  })
  const onClosed = () => { if (context.state === 'closed') cancel() }
  context.addEventListener('statechange', onClosed)
  cancelPreparations.set(context, cancel)
  const initialization = registration.then(() => {
    if (disposedContexts.has(context) || context.state === 'closed') throw new Error('The audio context closed before envelope initialization.')
    let service = services.get(context)
    if (!service || service.disposed) {
      service = new EnvelopeService(context, onFailure)
      services.set(context, service)
    }
    return service.ready
  })
  const preparation = Promise.race([initialization, cancellation])
    .catch((error: unknown) => { preparations.delete(context); throw error })
    .finally(() => {
      if (cancelPreparations.get(context) === cancel) cancelPreparations.delete(context)
      context.removeEventListener('statechange', onClosed)
    })
  preparations.set(context, preparation)
  return preparation
}

export function createEnvelopeControl(context: AudioContext, instanceId: number, initialPlan?: InitialEnvelopePlan): EnvelopeLease {
  const service = services.get(context)
  if (!service) throw new Error('Prepare the audio envelope service before starting notes.')
  return service.acquire(instanceId, initialPlan)
}

export function getEnvelopeServiceDiagnostics(context: AudioContext | null) {
  return (context && services.get(context))?.diagnostics() ?? {
    physicalEnvelopeProcessorCount: 0, maxPhysicalEnvelopeProcessors: 1,
    activeEnvelopeLeaseCount: 0, maxEnvelopeLeases: ENVELOPE_LANES,
    envelopeServiceReady: false, envelopeServiceReadyFrame: null, envelopeServiceFirstProcessFrame: null,
  }
}

export function disposeEnvelopeWorklet(context: AudioContext): void {
  disposedContexts.add(context)
  cancelPreparations.get(context)?.()
  services.get(context)?.dispose()
  preparations.delete(context)
}
