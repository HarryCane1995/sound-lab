import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const browserName = testBrowserName()
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { SynthEngine } = await import('/src/audio/SynthEngine.ts')
    const { DEFAULT_PARAMS, copyParams } = await import('/src/types.ts')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const frequency = midi => 440 * 2 ** ((midi - 69) / 12)
    const results = []
    const check = (name, metrics, assertions) => {
      results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    }
    const makeNote = (midi, options = {}) => ({ id: `A:1:${midi}`, midi, frequency: frequency(midi), velocity: 127, sourceId: 'A', sourceName: 'Simulated MIDI A', channel: 1, origin: 'midi', ...options })
    const NativeAudioContext = window.AudioContext
    const NativeAudioWorkletNode = window.AudioWorkletNode
    const contexts = []
    const controlNodes = []
    const controlSplitters = []
    const controlLeases = []
    const gainOutputs = new WeakMap()
    const envelopeOwners = new WeakMap()
    const controlMessages = new WeakMap()
    const destructionProofs = new WeakMap()
    const matchingState = (message, state) => message.type === 'state'
      && message.slot === state.slot && message.generation === state.generation
      && message.instanceId === state.instanceId && message.revision === state.revision
      && message.appliedFrame === state.appliedFrame && message.endFrame === state.endFrame
      && message.zeroFrame === state.zeroFrame && message.renderedThroughFrame === state.renderedThroughFrame
    const renderedZero = (state, messages, context) => Boolean(state?.zero
      && Number.isInteger(state.slot) && state.slot >= 0 && state.slot < 20
      && Number.isSafeInteger(state.generation) && state.generation > 0
      && Number.isSafeInteger(state.revision) && state.revision > 0
      && state.acknowledgedRevision === state.revision
      && Number.isSafeInteger(state.appliedFrame) && state.appliedFrame >= 0
      && Number.isSafeInteger(state.endFrame) && state.endFrame >= 0
      && Number.isSafeInteger(state.zeroFrame) && state.zeroFrame >= Math.max(state.endFrame, state.appliedFrame)
      && Number.isSafeInteger(state.renderedThroughFrame) && state.renderedThroughFrame >= state.zeroFrame + 127
      && messages.some(message => matchingState(message, state))
      && controlNodes.some(record => record.context === context && record.messages.some(message => matchingState(message, state))))
    const stopProof = (voice, carrier, velocity, context, startsAt) => {
      const state = destructionProofs.get(voice) ?? voice?.getEnvelopeControlState()
      const carrierLevel = Math.abs(carrier.gain.value * velocity.gain.value)
      const processorZero = state?.connected === true && !state.destroyed && renderedZero(state, controlMessages.get(voice) ?? [], context)
      // Intrinsic envelope.gain.value stays zero even while its connected
      // worklet emits a loud signal. Only the processor's actual render ACK
      // may authorize stopping an audible, already started voice.
      const reason = context.currentTime < startsAt && state?.cancelSafeBeforeStart ? 'not-started'
        : context.state !== 'running' ? 'context-not-running'
          : carrierLevel < 0.0001 ? 'carrier-zero'
            : processorZero ? 'processor-zero' : null
      return { state, carrierLevel, intrinsicEnvelopeGain: voice?.envelope.gain.value, processorZero, reason, safe: reason !== null, stoppedAt: context.currentTime }
    }
    class RecordedAudioWorkletNode extends NativeAudioWorkletNode {
      constructor(context, name, options) {
        super(context, name, options)
        if (name !== 'sound-lab-envelope-v1') return
        const record = { node: this, context, disconnected: false, portClosed: false, errors: [], messages: [], outgoing: [] }
        controlNodes.push(record)
        this.addEventListener('processorerror', () => record.errors.push('processorerror'))
        this.port.addEventListener('message', event => record.messages.push(structuredClone(event.data)))
        const postMessage = this.port.postMessage.bind(this.port)
        this.port.postMessage = (...args) => { record.outgoing.push(structuredClone(args[0])); return postMessage(...args) }
        const disconnect = this.disconnect.bind(this)
        this.disconnect = (...args) => { record.disconnected = true; return disconnect(...args) }
        const close = this.port.close.bind(this.port)
        this.port.close = () => { record.portClosed = true; return close() }
      }
    }
    class RecordedAudioContext extends NativeAudioContext {
      oscillators = []
      starts = 0
      constructor(options) { super(options); contexts.push(this) }
      createChannelSplitter(channels) {
        const splitter = super.createChannelSplitter(channels)
        const record = { splitter, context: this, channels, edges: [], maximumLanes: 0 }
        controlSplitters.push(record)
        const connect = splitter.connect.bind(splitter)
        splitter.connect = (destination, output = 0, input = 0) => {
          const result = destination instanceof AudioParam ? connect(destination, output) : connect(destination, output, input)
          if (!record.edges.some(edge => edge.active && edge.destination === destination && edge.output === output && edge.input === input)) record.edges.push({ destination, output, input, active: true })
          record.maximumLanes = Math.max(record.maximumLanes, new Set(record.edges.filter(edge => edge.active && edge.destination instanceof AudioParam).map(edge => edge.output)).size)
          return result
        }
        const disconnect = splitter.disconnect.bind(splitter)
        splitter.disconnect = (...args) => {
          const result = disconnect(...args)
          for (const edge of record.edges) if (args.length === 0
            || typeof args[0] === 'number' && edge.output === args[0]
            || args[0] === edge.destination && (args[1] === undefined || args[1] === edge.output) && (args[2] === undefined || args[2] === edge.input)) edge.active = false
          return result
        }
        return splitter
      }
      createGain() {
        const gain = super.createGain()
        const nativeConnect = gain.connect.bind(gain)
        gain.connect = (destination, ...args) => { gainOutputs.set(gain, destination); return nativeConnect(destination, ...args) }
        return gain
      }
      createOscillator() {
        const oscillator = super.createOscillator()
        const record = { oscillator, ended: false, disconnected: false, destination: null, startsAt: Infinity, stoppedVoiceLevels: [] }
        this.oscillators.push(record)
        oscillator.addEventListener('ended', () => { record.ended = true })
        const nativeStart = oscillator.start.bind(oscillator)
        oscillator.start = (...args) => { this.starts++; record.startsAt = args[0] ?? this.currentTime; nativeStart(...args) }
        const nativeConnect = oscillator.connect.bind(oscillator)
        oscillator.connect = (destination, ...args) => { record.destination = destination; return nativeConnect(destination, ...args) }
        const nativeStop = oscillator.stop.bind(oscillator)
        oscillator.stop = (...args) => {
          if ((args[0] ?? 0) <= this.currentTime + 0.00001) {
            const carrier = record.destination
            const envelope = gainOutputs.get(carrier)
            const velocity = gainOutputs.get(envelope)
            if (carrier instanceof GainNode && envelope instanceof GainNode && velocity instanceof GainNode) {
              record.stoppedVoiceLevels.push(stopProof(envelopeOwners.get(envelope), carrier, velocity, this, record.startsAt))
            }
          }
          return nativeStop(...args)
        }
        const nativeDisconnect = oscillator.disconnect.bind(oscillator)
        oscillator.disconnect = (...args) => { record.disconnected = true; return nativeDisconnect(...args) }
        return oscillator
      }
    }
    window.AudioContext = RecordedAudioContext
    window.AudioWorkletNode = RecordedAudioWorkletNode
    const engines = []
    const create = (changes = {}) => {
      const params = {
        ...copyParams(DEFAULT_PARAMS), frequency: 220, amplitude: 0.3,
        adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.18 },
        filter: { cutoff: 8000, q: 0.707, bypass: true },
        lfo: { enabled: false, rate: 3, depth: 0, target: 'pitch' }, ...changes,
      }
      const engine = new SynthEngine(params)
      const add = engine.voices.add.bind(engine.voices)
      engine.voices.add = voice => {
        envelopeOwners.set(voice.envelope, voice)
        const messages = []
        controlMessages.set(voice, messages)
        const lease = { context: voice.envelope.context, instanceId: voice.instanceId, slot: voice.envelopeControl.slot, generation: voice.envelopeControl.generation, disconnected: false, portClosed: false }
        controlLeases.push(lease)
        const disconnect = voice.envelopeControl.disconnect.bind(voice.envelopeControl)
        voice.envelopeControl.disconnect = (...args) => { const result = disconnect(...args); lease.disconnected = true; return result }
        const close = voice.envelopeControl.port.close.bind(voice.envelopeControl.port)
        voice.envelopeControl.port.close = (...args) => { const result = close(...args); lease.portClosed = true; return result }
        voice.envelopeControl.port.addEventListener('message', event => messages.push(event.data))
        const destroy = voice.destroy.bind(voice)
        voice.destroy = () => {
          if (!voice.getEnvelopeControlState().destroyed) destructionProofs.set(voice, voice.getEnvelopeControlState())
          destroy()
        }
        add(voice)
      }
      engines.push(engine)
      return { engine, update: patch => { Object.assign(params, patch); engine.setParams(params) }, params }
    }
    const analyse = engine => {
      const analysis = engine.getAnalysis()
      if (!analysis) return { rms: 0, peak: 0, bins: new Float32Array(), binWidth: 1 }
      analysis.time.fftSize = 2048
      analysis.frequency.fftSize = 16384
      analysis.frequency.smoothingTimeConstant = 0
      const samples = new Float32Array(analysis.time.fftSize)
      analysis.time.getFloatTimeDomainData(samples)
      const bins = new Float32Array(analysis.frequency.frequencyBinCount)
      analysis.frequency.getFloatFrequencyData(bins)
      return {
        rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length),
        peak: Math.max(...samples.map(value => Math.abs(value))), bins,
        binWidth: analysis.sampleRate / analysis.frequency.fftSize,
      }
    }
    const near = (data, hz, radius = data.binWidth * 2) => {
      let index = Math.max(1, Math.floor((hz - radius) / data.binWidth))
      let db = -Infinity
      for (let i = index; i <= Math.min(data.bins.length - 1, Math.ceil((hz + radius) / data.binWidth)); i++) {
        if (data.bins[i] > db) { db = data.bins[i]; index = i }
      }
      return { hz: index * data.binWidth, db }
    }
    // Integrating nearby FFT bins avoids mistaking window scalloping for a
    // velocity change. All bins come from the native post-mix analyser.
    const component = (data, hz) => {
      let energy = 0
      for (let i = Math.max(1, Math.round(hz / data.binWidth) - 3); i <= Math.min(data.bins.length - 1, Math.round(hz / data.binWidth) + 3); i++) energy += 10 ** (data.bins[i] / 10)
      return Math.sqrt(energy)
    }
    const bandDb = (data, low, high) => {
      let power = 0
      for (let i = Math.ceil(low / data.binWidth); i <= Math.min(data.bins.length - 1, Math.floor(high / data.binWidth)); i++) power += 10 ** (data.bins[i] / 10)
      return 10 * Math.log10(Math.max(1e-20, power))
    }
    const active = engine => engine.getVoices().filter(voice => !voice.retiring)
    const settleControl = async engine => {
      const target = engine.getAudioClock().time + engine.getDiagnostics().controlLeadSeconds
      while (engine.getAudioClock().time <= target) await sleep(2)
    }
    const ids = engine => active(engine).filter(voice => voice.gateOpen).map(voice => voice.id).sort()
    const close = async engine => { await engine.dispose(); await sleep(25) }
    const controlsFor = context => controlNodes.filter(record => record.context === context)
    const leasesFor = context => controlLeases.filter(record => record.context === context)
    const nativeLanesFor = context => new Set(controlSplitters.filter(record => record.context === context)
      .flatMap(record => record.edges.filter(edge => edge.active && edge.destination instanceof AudioParam).map(edge => edge.output))).size
    const waitFor = async predicate => {
      const deadline = performance.now() + 750
      while (!predicate() && performance.now() < deadline) await sleep(2)
      return predicate()
    }
    try {
      const { engine: lazy } = create()
      const initialContexts = contexts.length
      await lazy.noteOnVoice(makeNote(60, { velocity: 0 }))
      lazy.noteOffVoice('nonexistent')
      check('Polyphonic voices keep audio lazy', { state: lazy.getState(), contexts: contexts.length }, [
        ['velocity zero and unknown Note Off allocate no context', contexts.length === initialContexts && lazy.getAnalysis() === null],
        ['no pending or held voice is created', lazy.getState().pendingCount === 0 && lazy.getState().voiceCount === 0],
      ])
      await close(lazy)

      const { engine: waitingReady } = create()
      await waitingReady.prepare()
      const readyContext = contexts.at(-1)
      const preparedState = waitingReady.getState()
      const startsBeforeReady = readyContext.starts
      // The shared processor is already ready. Live construction reserves a
      // silent lane; a same-turn Note Off must cancel before the JS startup
      // commit posts an Attack or starts the native carrier.
      const readyPending = waitingReady.noteOnVoice(makeNote(60, { id: 'cancel-before-ready' }))
      const unarmedVoice = waitingReady.voices.all[0]
      const awaitingReady = unarmedVoice?.awaitingStart
      const beforeReady = unarmedVoice?.getEnvelopeControlState()
      const reservedReadyControl = waitingReady.getDiagnostics().envelopeControlCount
      const nativeReadyControls = [...controlsFor(readyContext)]
      const readyClaim = nativeReadyControls.flatMap(record => record.outgoing)
        .find(message => message.type === 'claim' && message.instanceId === unarmedVoice?.instanceId)
      const beforeReadyRamps = structuredClone(unarmedVoice?.envelopeRamps ?? [])
      waitingReady.noteOffVoice('cancel-before-ready')
      await readyPending
      await sleep(110)
      const afterReadyCancel = waitingReady.getDiagnostics()
      const readyCancelState = waitingReady.getState()
      const readyCancelSignal = analyse(waitingReady)
      const readyCancelProof = destructionProofs.get(unarmedVoice)
      await close(waitingReady)
      const readyWire = nativeReadyControls.flatMap(record => record.outgoing)
        .filter(message => message.instanceId === unarmedVoice?.instanceId)
      const readyCancelPlans = readyWire.filter(message => message.type === 'plan')
      check('Same-turn Note Off cancels a warm shared-lane voice before its scheduled audible onset', { preparedState, awaitingReady, beforeReady, beforeReadyRamps, readyClaim, readyWire, reservedReadyControl, startsBeforeReady, startsAfterCancel: readyContext.starts, readyCancelProof, readyCancelState, afterReadyCancel, rms: readyCancelSignal.rms, nativeControls: nativeReadyControls.map(({ disconnected, portClosed, errors }) => ({ disconnected, portClosed, errors })), leases: leasesFor(readyContext) }, [
        ['a prepared running context immediately reserves one silent lease before its deferred live startup', preparedState.contextState === 'running' && reservedReadyControl === 1 && nativeReadyControls.length === 1 && awaitingReady && beforeReady?.revision === 0 && beforeReady?.acknowledgedRevision === null && beforeReadyRamps.length === 0 && readyClaim && readyClaim.initialPlan === undefined && Number.isFinite(unarmedVoice.startsAt) && readyContext.starts === startsBeforeReady],
        ['canceling the startup posts only zero plans, never starts a carrier, and produces no PCM or later resurrection', readyContext.starts === startsBeforeReady && readyCancelPlans.length > 0 && readyCancelPlans.every(plan => plan.ramps.length > 0 && plan.ramps.every(ramp => ramp.from === 0 && ramp.to === 0)) && readyCancelSignal.rms < 0.00001 && readyCancelState.voiceCount === 0 && readyCancelState.pendingCount === 0 && afterReadyCancel.envelopeControlCount === 0 && afterReadyCancel.totalCarrierCount === 0],
        ['same-turn cancellation renders a latest-plan zero before balanced resource cleanup', readyCancelProof?.connected && readyCancelProof.contextState === 'running' && renderedZero(readyCancelProof, controlMessages.get(unarmedVoice), readyContext) && afterReadyCancel.createdVoiceCount === 1 && afterReadyCancel.destroyedVoiceCount === 1],
        ['cancellation releases its lane and dispose closes the one real processor port', readyContext.state === 'closed' && leasesFor(readyContext).length === 1 && leasesFor(readyContext).every(lease => lease.disconnected && lease.portClosed) && nativeLanesFor(readyContext) === 0 && nativeReadyControls.length === 1 && nativeReadyControls.every(record => record.disconnected && record.portClosed && record.errors.length === 0)],
      ])

      const { engine: control, update: updateControl } = create({ adsr: { attack: 0.004, decay: 0.004, sustain: 0, release: 0.025 } })
      await control.noteOnVoice(makeNote(60))
      const controlContext = contexts.at(-1)
      const controlledVoice = control.voices.all[0]
      const envelopeAnalyser = controlContext.createAnalyser()
      envelopeAnalyser.fftSize = 256
      const silentTap = controlContext.createGain()
      silentTap.gain.value = 0
      controlledVoice.envelopeControl.connect(envelopeAnalyser)
      envelopeAnalyser.connect(silentTap)
      silentTap.connect(controlContext.destination)
      const controlSignal = () => {
        const samples = new Float32Array(envelopeAnalyser.fftSize)
        envelopeAnalyser.getFloatTimeDomainData(samples)
        return { peak: Math.max(...samples.map(Math.abs)), mean: samples.reduce((sum, sample) => sum + sample, 0) / samples.length }
      }
      const messages = controlMessages.get(controlledVoice)
      const initialZeroArrived = await waitFor(() => renderedZero(controlledVoice.getEnvelopeControlState(), messages, controlContext))
      const initialZero = controlledVoice.getEnvelopeControlState()
      // The zero ACK proves one rendered quantum. AnalyserNode still owns a
      // 256-sample history, which must advance completely past that ACK before
      // its entire time-domain buffer can legitimately be exactly zero.
      const initialAnalyserTargetFrame = Math.max(Math.ceil(controlContext.currentTime * controlContext.sampleRate), (initialZero.renderedThroughFrame ?? -1) + 1) + envelopeAnalyser.fftSize
      const initialAnalyserWindowAdvanced = await waitFor(() => Math.floor(controlContext.currentTime * controlContext.sampleRate) >= initialAnalyserTargetFrame)
      const initialControlSignal = controlSignal()
      updateControl({ adsr: { attack: 0.004, decay: 0.004, sustain: 0.8, release: 0.025 } })
      const invalidatedZero = controlledVoice.getEnvelopeControlState()
      await sleep(100)
      const audibleControl = controlSignal()
      const audibleState = controlledVoice.getEnvelopeControlState()
      const audibleStopProof = stopProof(controlledVoice, controlledVoice.carrier.gain, controlledVoice.velocityGain, controlContext, controlledVoice.startsAt)
      const nodesBeforeChanges = controlsFor(controlContext).length
      for (let index = 0; index < 120; index++) updateControl({ adsr: { attack: 0.004 + (index % 3) * 0.001, decay: 0.004, sustain: index % 2 ? 0.8 : 0.7, release: 0.025 } })
      const rapidRevision = controlledVoice.getEnvelopeControlState().revision
      await waitFor(() => controlledVoice.getEnvelopeControlState().acknowledgedRevision === rapidRevision)
      await sleep(60)
      const rapidState = controlledVoice.getEnvelopeControlState()
      const rapidSignal = controlSignal()
      control.panic()
      await waitFor(() => control.getDiagnostics().envelopeControlCount === 0)
      const panicProof = destructionProofs.get(controlledVoice)
      await close(control)
      const releasedControl = controlledVoice.getEnvelopeControlState()
      const nativeControls = controlsFor(controlContext)
      envelopeAnalyser.disconnect()
      silentTap.disconnect()
      check('Native envelope control invalidates old zero ACKs and retires only after a latest-plan rendered zero', { initialZero, initialAnalyserTargetFrame, initialAnalyserWindowAdvanced, initialControlSignal, invalidatedZero, audibleControl, audibleState, audibleStopProof, rapidState, rapidSignal, panicProof, releasedControl, nodesBeforeChanges, nativeControls: nativeControls.map(({ disconnected, portClosed, errors }) => ({ disconnected, portClosed, errors })) }, [
        ['initial silence is proved by an actual shared-port packet and zero control samples', initialZeroArrived && renderedZero(initialZero, messages, controlContext) && initialAnalyserWindowAdvanced && initialControlSignal.peak === 0],
        ['a new musical plan immediately invalidates the previous zero acknowledgement', invalidatedZero.revision > initialZero.revision && !invalidatedZero.zero && invalidatedZero.zeroFrame === null && !invalidatedZero.safeToDestroy],
        ['intrinsic zero cannot authorize stopping a genuinely nonzero native control signal', controlledVoice.envelope.gain.value === 0 && Math.abs(audibleControl.mean - 0.8) < 0.00001 && !audibleState.zero && !audibleStopProof.safe],
        ['rapid ADSR plans are acknowledged without allocating extra native control nodes', rapidState.acknowledgedRevision === rapidRevision && rapidRevision >= invalidatedZero.revision + 120 && Math.abs(rapidSignal.mean - 0.8) < 0.00001 && nodesBeforeChanges === 1 && nativeControls.length === 1],
        ['Panic waits for a new complete zero block rather than an obsolete silent plan', renderedZero(panicProof, messages, controlContext) && panicProof.revision > rapidRevision && panicProof.connected && !panicProof.notStarted],
        ['dispose releases the leased lane and closes the physical control with no processor error', releasedControl.destroyed && !releasedControl.connected && control.getDiagnostics().envelopeControlCount === 0 && nativeLanesFor(controlContext) === 0 && leasesFor(controlContext).every(lease => lease.disconnected && lease.portClosed) && nativeControls.length === 1 && nativeControls.every(record => record.disconnected && record.portClosed && record.errors.length === 0)],
      ])

      const { engine: future } = create()
      await future.prepare()
      const futureContext = contexts.at(-1)
      const futureStart = futureContext.currentTime + 0.18
      const futureAdmissions = Array.from({ length: 16 }, (_, index) => future.scheduleNote(makeNote(48 + index, { id: `future:${index}`, sourceId: 'future', origin: 'sequence' }), futureStart, futureStart + 0.05))
      const futureVoices = [...future.voices.all]
      const reservedControls = future.getDiagnostics().envelopeControlCount
      future.releaseVoices({ sourceId: 'future' }, true)
      const canceledDiagnostics = future.getDiagnostics()
      const cancelProofs = futureVoices.map(voice => destructionProofs.get(voice))
      await sleep(300)
      const canceledSignal = analyse(future)
      await future.dispose()
      await future.dispose()
      await future.noteOnVoice(makeNote(72))
      const futureControls = controlsFor(futureContext)
      check('Canceled future sequence gates release shared lanes and never restart after their deadlines', { futureAdmissions, futureStart, reservedControls, cancelProofs, canceledDiagnostics, canceledRms: canceledSignal.rms, diagnostics: future.getDiagnostics(), nativeControls: futureControls.map(({ disconnected, portClosed, errors }) => ({ disconnected, portClosed, errors })), leases: leasesFor(futureContext) }, [
        ['sixteen future voices lease sixteen distinct lanes on exactly one real processor', futureAdmissions.every(Boolean) && futureVoices.length === 16 && reservedControls === 16 && futureControls.length === 1 && leasesFor(futureContext).length === 16 && new Set(leasesFor(futureContext).map(lease => lease.slot)).size === 16],
        ['cancellation destroys only safely distant future gates and removes every control immediately', cancelProofs.every(proof => proof?.notStarted && proof.cancelSafeBeforeStart && proof.connected && proof.contextState === 'running') && canceledDiagnostics.envelopeControlCount === 0 && canceledDiagnostics.totalCarrierCount === 0 && canceledDiagnostics.scheduledNoteCount === 0],
        ['past the original ON and OFF deadlines the native output stays silent and no voice resurrects', canceledSignal.rms < 0.00001 && future.getState().voiceCount === 0 && future.getState().pendingCount === 0],
        ['repeated disposal closes all lease ports and the shared native port without new allocation', futureContext.state === 'closed' && futureControls.every(record => record.disconnected && record.portClosed && record.errors.length === 0) && leasesFor(futureContext).every(lease => lease.disconnected && lease.portClosed) && nativeLanesFor(futureContext) === 0 && controlsFor(futureContext).length === 1 && future.getDiagnostics().envelopeControlCount === 0],
      ])

      const { engine: isolation } = create({ adsr: { attack: 0.004, decay: 0.004, sustain: 0.8, release: 0.025 } })
      await isolation.prepare()
      await Promise.all([60, 64].map(midi => isolation.noteOnVoice(makeNote(midi))))
      const isolationContext = contexts.at(-1)
      const [heldLane, releasedLane] = isolation.voices.all
      const taps = []
      const tapLane = voice => {
        const analyser = isolationContext.createAnalyser(), sink = isolationContext.createGain()
        analyser.fftSize = 256; sink.gain.value = 0
        voice.envelopeControl.connect(analyser); analyser.connect(sink); sink.connect(isolationContext.destination)
        taps.push({ analyser, sink })
        return () => {
          const samples = new Float32Array(256)
          analyser.getFloatTimeDomainData(samples)
          return { mean: samples.reduce((sum, value) => sum + value, 0) / samples.length, peak: Math.max(...samples.map(Math.abs)) }
        }
      }
      const heldSignal = tapLane(heldLane), releasedSignal = tapLane(releasedLane)
      await sleep(100)
      const heldBefore = heldSignal(), releasedBefore = releasedSignal()
      isolation.noteOffVoice(releasedLane.note.id)
      const releasedGone = await waitFor(() => isolation.getDiagnostics().envelopeControlCount === 1)
      const releasedProof = destructionProofs.get(releasedLane)
      await sleep(30) // Let the 256-sample analyser window contain only post-release samples.
      const heldAfterRelease = heldSignal(), releasedAfter = releasedSignal()
      await isolation.noteOnVoice(makeNote(67))
      const reusedLane = isolation.voices.all.find(voice => voice.note.midi === 67)
      const reusedSignal = tapLane(reusedLane)
      await sleep(80)
      const physicalIsolation = controlsFor(isolationContext)[0]
      const stalePlan = physicalIsolation.outgoing.find(message => message.type === 'plan' && message.instanceId === releasedLane.instanceId && message.generation === releasedLane.envelopeControl.generation)
      if (!stalePlan) throw new Error('Native shared port never received the released lane plan')
      const staleAt = isolationContext.currentTime + isolation.getDiagnostics().controlLeadSeconds
      const injectedStalePlan = { ...stalePlan, revision: stalePlan.revision + 1000000, at: staleAt, ramps: [{ start: staleAt, end: staleAt + 0.01, from: 0, to: 0 }] }
      // Bypass the closed facade deliberately: only processor-side generation
      // validation can reject this real native MessagePort injection.
      physicalIsolation.node.port.postMessage(injectedStalePlan)
      releasedLane.envelopeControl.port.postMessage(injectedStalePlan)
      await sleep(100)
      const heldAfterStale = heldSignal(), reusedAfterStale = reusedSignal()
      const reusedState = reusedLane.getEnvelopeControlState()
      const lanePacketsIsolated = [heldLane, releasedLane, reusedLane].every(voice => controlMessages.get(voice).every(message => message.type !== 'state'
        || message.slot === voice.envelopeControl.slot && message.generation === voice.envelopeControl.generation && message.instanceId === voice.instanceId))
      await close(isolation)
      for (const { analyser, sink } of taps) { analyser.disconnect(); sink.disconnect() }
      check('Shared envelope lanes isolate Release and reject stale generations after native slot reuse', { heldBefore, releasedBefore, releasedGone, releasedProof, heldAfterRelease, releasedAfter, heldAfterStale, reusedAfterStale, reusedState, injectedStalePlan, slots: [heldLane, releasedLane, reusedLane].map(voice => ({ instanceId: voice.instanceId, slot: voice.envelopeControl.slot, generation: voice.envelopeControl.generation })), lanePacketsIsolated }, [
        ['two independently connected native control lanes render their real sustain values', heldLane.envelopeControl.slot !== releasedLane.envelopeControl.slot && Math.abs(heldBefore.mean - 0.8) < 0.00001 && Math.abs(releasedBefore.mean - 0.8) < 0.00001],
        ['releasing one lane proves latest native zero without changing the other lane', releasedGone && renderedZero(releasedProof, controlMessages.get(releasedLane), isolationContext) && releasedAfter.peak === 0 && Math.abs(heldAfterRelease.mean - 0.8) < 0.00001],
        ['a reused slot has a new generation and cannot inherit the previous voice identity', reusedLane.envelopeControl.slot === releasedLane.envelopeControl.slot && reusedLane.envelopeControl.generation > releasedLane.envelopeControl.generation && reusedLane.instanceId !== releasedLane.instanceId],
        ['a stale native plan cannot mute the reused lane or an unrelated held lane', Math.abs(reusedAfterStale.mean - 0.8) < 0.00001 && Math.abs(heldAfterStale.mean - 0.8) < 0.00001 && reusedState.revision < injectedStalePlan.revision],
        ['facade events contain only real packets for their own slot generation and instance', lanePacketsIsolated && [heldLane, releasedLane, reusedLane].every(voice => controlMessages.get(voice).some(message => message.type === 'state'))],
        ['all three leases use one physical processor and dispose closes it with no lane left connected', controlsFor(isolationContext).length === 1 && nativeLanesFor(isolationContext) === 0 && leasesFor(isolationContext).every(lease => lease.disconnected && lease.portClosed) && physicalIsolation.disconnected && physicalIsolation.portClosed && physicalIsolation.errors.length === 0],
      ])

      const { engine: chord, update: updateChord } = create()
      const contextBeforeChord = contexts.length
      await Promise.all([60, 64, 67].map(midi => chord.noteOnVoice(makeNote(midi))))
      analyse(chord) // Resize the native FFT before accumulating its full window.
      await sleep(410)
      const chordContext = contexts.at(-1)
      const chordVoices = active(chord)
      const chordData = analyse(chord)
      const triadPeaks = [60, 64, 67].map(midi => ({ midi, expected: frequency(midi), ...near(chordData, frequency(midi)) }))
      check('C4 E4 G4 coexist in native output spectrum', { state: chord.getState(), peaks: triadPeaks, rms: chordData.rms }, [
        ['all three independently gated voices exist', chordVoices.length === 3 && chordVoices.every(voice => voice.gateOpen)],
        ['three measured fundamentals match their MIDI notes', triadPeaks.every(peak => Math.abs(peak.hz - peak.expected) <= chordData.binWidth && peak.db > -55)],
        ['one shared native AudioContext serves the chord', contexts.length === contextBeforeChord + 1 && chordContext.state === 'running'],
      ])
      updateChord({ frequency: 777, amplitude: 0.25 })
      await sleep(120)
      check('Manual frequency does not retune held keys', { voices: active(chord) }, [
        ['each keyboard voice retains its original base frequency', active(chord).every(voice => Math.abs(voice.frequency - frequency(voice.midi)) < 1e-6)],
        ['global edits preserve voice instances', active(chord).every(voice => chordVoices.some(before => before.instanceId === voice.instanceId))],
      ])
      updateChord({ amplitude: 0.3 })
      // The FFT integrates 341 ms; let the amplitude edit leave that window
      // completely before comparing an unchanged voice across Note Off.
      await sleep(430)
      const beforeRelease = analyse(chord)
      chord.noteOffVoice('A:1:64')
      const chordGateClosed = !active(chord).find(voice => voice.midi === 64).gateOpen
      await settleControl(chord)
      const duringRelease = active(chord)
      await sleep(450)
      const afterRelease = analyse(chord)
      check('Releasing E4 leaves C4 and G4 sounding', { duringRelease, after: chord.getState(), beforeLevels: [60, 64, 67].map(midi => component(beforeRelease, frequency(midi))), afterLevels: [60, 64, 67].map(midi => component(afterRelease, frequency(midi))) }, [
        ['only E4 enters its independent Release', chordGateClosed && duringRelease.find(voice => voice.midi === 64)?.phase === 'release' && duringRelease.filter(voice => voice.midi !== 64).every(voice => voice.gateOpen)],
        ['E4 output decays by at least 40 dB', near(afterRelease, frequency(64)).db < near(beforeRelease, frequency(64)).db - 40],
        ['C4 and G4 output levels remain stable', [60, 67].every(midi => Math.abs(20 * Math.log10(component(afterRelease, frequency(midi)) / component(beforeRelease, frequency(midi)))) < 1)],
        ['C4 and G4 envelopes are not restarted', active(chord).every(voice => voice.instanceId === chordVoices.find(original => original.id === voice.id)?.instanceId && voice.phase === 'sustain')],
      ])
      const startsBeforeDuplicate = chordContext.starts
      const duplicateInstance = active(chord).find(voice => voice.midi === 60)?.instanceId
      await chord.noteOnVoice(makeNote(60, { velocity: 20 }))
      check('Duplicate gated Note On is idempotent', { voices: active(chord), starts: chordContext.starts }, [
        ['a duplicate creates no oscillator or voice', active(chord).length === 2 && chordContext.starts === startsBeforeDuplicate],
        ['duplicate preserves original instance envelope and velocity', active(chord).find(voice => voice.midi === 60)?.instanceId === duplicateInstance && active(chord).find(voice => voice.midi === 60)?.velocity === 127],
      ])
      chord.noteOffVoice('A:1:60')
      chord.noteOffVoice('A:1:60')
      const releasingInstance = active(chord).find(voice => voice.midi === 60)?.instanceId
      await chord.noteOnVoice(makeNote(60, { velocity: 64 }))
      const repeatedVoices = active(chord).filter(voice => voice.midi === 60)
      check('Repressing a released identity creates an independent attack', { voices: repeatedVoices, state: chord.getState() }, [
        ['old Release overlaps the new gated instance', repeatedVoices.length === 2 && repeatedVoices.some(voice => voice.instanceId === releasingInstance && !voice.gateOpen) && repeatedVoices.some(voice => voice.instanceId !== releasingInstance && voice.gateOpen)],
        ['an unrelated held note remains gated', active(chord).find(voice => voice.midi === 67)?.gateOpen],
      ])
      await close(chord)

      const { engine: stagger, update: updateStagger } = create({ adsr: { attack: 0.35, decay: 0.1, sustain: 0.6, release: 0.35 } })
      await stagger.noteOnVoice(makeNote(60))
      analyse(stagger)
      await sleep(260)
      await stagger.noteOnVoice(makeNote(64))
      await sleep(70)
      const independentAttacks = active(stagger)
      check('Staggered notes have independent Attack histories', { voices: independentAttacks }, [
        ['first envelope is substantially ahead of second', independentAttacks.find(voice => voice.midi === 60).envelope > independentAttacks.find(voice => voice.midi === 64).envelope + 0.35],
        ['second note is in Attack without restarting first', independentAttacks.find(voice => voice.midi === 64).phase === 'attack' && independentAttacks.find(voice => voice.midi === 60).createdAt < independentAttacks.find(voice => voice.midi === 64).createdAt],
      ])
      // Both voices must occupy a full FFT window at Sustain; otherwise the
      // reference also includes the louder Decay and overstates its level.
      await sleep(850)
      const attackData = analyse(stagger)
      stagger.noteOffVoice('A:1:60')
      await sleep(100)
      await stagger.noteOnVoice(makeNote(67))
      await sleep(80)
      const independentPhases = active(stagger)
      check('Release Sustain and Attack coexist', { voices: independentPhases, spectrumRms: analyse(stagger).rms }, [
        ['C4 releases while E4 sustains and G4 attacks', independentPhases.find(voice => voice.midi === 60).phase === 'release' && independentPhases.find(voice => voice.midi === 64).phase === 'sustain' && independentPhases.find(voice => voice.midi === 67).phase === 'attack'],
        ['unreleased E4 retains actual output energy', Math.abs(20 * Math.log10(component(analyse(stagger), frequency(64)) / component(attackData, frequency(64)))) < 1.5],
      ])
      const beforeAdsrChange = active(stagger).map(voice => voice.instanceId)
      updateStagger({ adsr: { attack: 0.15, decay: 0.1, sustain: 0.3, release: 0.22 } })
      await sleep(300)
      check('Live ADSR changes preserve voice histories', { voices: active(stagger) }, [
        ['active voices retain their instance identities', active(stagger).every(voice => beforeAdsrChange.includes(voice.instanceId))],
        ['held voices reach the new sustain without retrigger', active(stagger).filter(voice => voice.gateOpen).every(voice => Math.abs(voice.envelope - 0.3) < 0.015)],
      ])
      stagger.releaseVoices({})
      const staggerGatesClosed = active(stagger).every(voice => !voice.gateOpen)
      await settleControl(stagger)
      const overlappingRelease = active(stagger)
      await sleep(420)
      check('Multiple Releases overlap and clean themselves up', { during: overlappingRelease, after: stagger.getDiagnostics(), rms: analyse(stagger).rms }, [
        ['both held notes enter Release simultaneously', staggerGatesClosed && overlappingRelease.length >= 2 && overlappingRelease.every(voice => !voice.gateOpen && voice.phase === 'release')],
        ['finished Releases remove carriers and become silent', stagger.getState().voiceCount === 0 && stagger.getDiagnostics().carrierCount === 0 && analyse(stagger).rms < 0.00001],
      ])
      await close(stagger)

      const { engine: velocities } = create({ amplitude: 0.18 })
      await Promise.all([[60, 120], [64, 70], [67, 35]].map(([midi, velocity]) => velocities.noteOnVoice(makeNote(midi, { velocity }))))
      analyse(velocities)
      await sleep(430)
      const velocityData = analyse(velocities)
      const velocityLevels = [60, 64, 67].map(midi => component(velocityData, frequency(midi)))
      check('Per-voice velocity changes actual chord balance', { levels: velocityLevels, ratios: [velocityLevels[1] / velocityLevels[0], velocityLevels[2] / velocityLevels[0]], voices: active(velocities) }, [
        ['E4 follows its own 70/120 velocity ratio', Math.abs(velocityLevels[1] / velocityLevels[0] - 70 / 120) < 0.035],
        ['G4 follows its own 35/120 velocity ratio', Math.abs(velocityLevels[2] / velocityLevels[0] - 35 / 120) < 0.035],
        ['all notes retain full independent sustain envelopes', active(velocities).every(voice => Math.abs(voice.envelope - 1) < 0.001)],
      ])
      await velocities.noteOnVoice(makeNote(64, { velocity: 0 }))
      await sleep(450)
      const afterVelocityZero = analyse(velocities)
      check('Velocity zero releases only its own note', { voices: active(velocities), state: velocities.getState() }, [
        ['only E4 is removed', JSON.stringify(ids(velocities)) === JSON.stringify(['A:1:60', 'A:1:67'])],
        ['C4 and G4 retain their signal levels', [60, 67].every(midi => Math.abs(20 * Math.log10(component(afterVelocityZero, frequency(midi)) / component(velocityData, frequency(midi)))) < 1)],
      ])
      await close(velocities)

      const { engine: bend } = create({ amplitude: 0.15 })
      const bendNotes = [60, 64, 67].map(midi => makeNote(midi)).concat([
        makeNote(75, { id: 'A:2:75', channel: 2 }),
        makeNote(81, { id: 'B:1:81', sourceId: 'B', sourceName: 'Simulated MIDI B' }),
        makeNote(84, { id: 'pc:84', sourceId: 'local', sourceName: 'PC keyboard', channel: null, origin: 'local' }),
      ])
      await Promise.all(bendNotes.map(note => bend.noteOnVoice(note)))
      analyse(bend)
      await sleep(380)
      const bendInstances = active(bend).map(voice => voice.instanceId)
      const bendContext = contexts.at(-1)
      const startsBeforeBend = bendContext.starts
      bend.setSourcePitchBend('A', 1, 2)
      await sleep(430)
      const bentSpectrum = analyse(bend)
      const bendMeasurements = bendNotes.map(note => ({ id: note.id, expected: note.frequency * 2 ** ((note.sourceId === 'A' && note.channel === 1 ? 2 : 0) / 12), peak: near(bentSpectrum, note.frequency * 2 ** ((note.sourceId === 'A' && note.channel === 1 ? 2 : 0) / 12)) }))
      check('Pitch Bend affects every voice in exactly one source and channel', { voices: active(bend), measured: bendMeasurements }, [
        ['whole A channel 1 chord inherits two semitones', active(bend).filter(voice => voice.sourceId === 'A' && voice.channel === 1).every(voice => voice.pitchBend === 2)],
        ['other source channel and local voices stay centered', active(bend).filter(voice => voice.sourceId !== 'A' || voice.channel !== 1).every(voice => voice.pitchBend === 0)],
        ['native output contains all six expected pitches', bendMeasurements.every(value => Math.abs(value.peak.hz - value.expected) <= bentSpectrum.binWidth && value.peak.db > -60)],
        ['bend creates no voice oscillator or ADSR retrigger', bendContext.starts === startsBeforeBend && active(bend).every(voice => bendInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
      ])
      await bend.noteOnVoice(makeNote(55))
      await sleep(130)
      bend.noteOffVoice('A:1:60')
      const bendGateClosed = !active(bend).find(voice => voice.midi === 60).gateOpen
      bend.setSourcePitchBend('A', 1, -2)
      await settleControl(bend)
      check('New notes and Release tails share scoped bend state', { voices: active(bend) }, [
        ['new A channel 1 note inherits stored bend', active(bend).find(voice => voice.midi === 55)?.pitchBend === -2],
        ['releasing A channel 1 voice updates along with chord', bendGateClosed && active(bend).find(voice => voice.midi === 60)?.phase === 'release' && active(bend).find(voice => voice.midi === 60)?.pitchBend === -2],
      ])
      bend.setSourcePitchBend('A', 1, 0)
      await sleep(120)
      check('Pitch Bend center restores all scoped voices', { voices: active(bend) }, [
        ['all retained base frequencies and detunes are restored', active(bend).every(voice => voice.pitchBend === 0 && voice.frequency === frequency(voice.midi))],
      ])
      await close(bend)

      const { engine: modulated, update: updateModulated } = create({ amplitude: 0.2 })
      await Promise.all([48, 60, 72].map(midi => modulated.noteOnVoice(makeNote(midi))))
      analyse(modulated)
      modulated.setSourcePitchBend('A', 1, 2)
      updateModulated({ lfo: { enabled: true, rate: 2, depth: 1, target: 'pitch' } })
      await sleep(250)
      const lfoInstances = active(modulated).map(voice => voice.instanceId)
      modulated.getAnalysis().frequency.fftSize = 4096 // Short window follows actual vibrato movement.
      await sleep(120)
      const pitchTracks = [[], [], []]
      for (let sample = 0; sample < 22; sample++) {
        const analysis = modulated.getAnalysis()
        analysis.frequency.fftSize = 4096
        analysis.frequency.smoothingTimeConstant = 0
        const bins = new Float32Array(analysis.frequency.frequencyBinCount)
        analysis.frequency.getFloatFrequencyData(bins)
        const data = { bins, binWidth: analysis.sampleRate / analysis.frequency.fftSize }
        for (const [index, midi] of [48, 60, 72].entries()) {
          const center = frequency(midi) * 2 ** (2 / 12)
          pitchTracks[index].push(near(data, center, center * 0.09).hz)
        }
        await sleep(45)
      }
      check('Pitch LFO adds to scoped bend across a chord', { tracks: pitchTracks, voices: active(modulated) }, [
        ['each actual frequency moves on both sides of its bent center', pitchTracks.every((track, index) => { const center = frequency([48, 60, 72][index]) * 2 ** (2 / 12); return Math.min(...track) < center && Math.max(...track) > center && Math.max(...track) - Math.min(...track) > center * 0.05 })],
        ['LFO and bend preserve all voice envelopes', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.pitchBend === 2 && voice.phase === 'sustain')],
      ])
      updateModulated({ lfo: { enabled: false, rate: 2, depth: 0, target: 'pitch' } })
      modulated.setSourcePitchBend('A', 1, 0)
      await sleep(180)
      let maxWaveCarriers = 0
      for (let index = 0; index < 40; index++) {
        updateModulated({ waveform: ['sine', 'square', 'sawtooth', 'triangle'][index % 4] })
        maxWaveCarriers = Math.max(maxWaveCarriers, modulated.getDiagnostics().totalCarrierCount)
        await sleep(3)
      }
      updateModulated({ waveform: 'sawtooth' })
      await sleep(430)
      const waveDiagnostics = modulated.getDiagnostics()
      const waveData = analyse(modulated)
      check('Live chord waveform crossfades remain bounded and clean', { maxWaveCarriers, diagnostics: waveDiagnostics, highBandDb: bandDb(waveData, 1000, 7000) }, [
        ['each of three voices uses at most two carriers during crossfade', maxWaveCarriers <= 6],
        ['all retired carriers are cleaned after crossfade', waveDiagnostics.totalCarrierCount === 3 && active(modulated).every(voice => voice.carrierCount === 1)],
        ['voice identities and envelopes survive waveform replacement', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.phase === 'sustain')],
        ['final sawtooth harmonics are present in native spectrum', bandDb(waveData, 1000, 7000) > -55],
      ])
      updateModulated({ filter: { cutoff: 300, q: 0.707, bypass: false } })
      await sleep(430)
      const filteredData = analyse(modulated)
      updateModulated({ filter: { cutoff: 900, q: 0.707, bypass: false }, lfo: { enabled: true, rate: 2, depth: 1, target: 'filter' } })
      const filterBands = []
      for (let index = 0; index < 12; index++) { await sleep(75); filterBands.push(bandDb(analyse(modulated), 1800, 7000)) }
      check('Shared filter and filter LFO process the real chord mix', { bypassHighBand: bandDb(waveData, 1000, 7000), filteredHighBand: bandDb(filteredData, 1000, 7000), filterBands }, [
        ['low-pass reduces real mixed high-frequency energy', bandDb(waveData, 1000, 7000) - bandDb(filteredData, 1000, 7000) > 15],
        ['filter LFO measurably changes mixed harmonic output', Math.max(...filterBands) - Math.min(...filterBands) > 5],
        ['shared processing neither replaces nor retunes voices', active(modulated).every(voice => lfoInstances.includes(voice.instanceId) && voice.frequency === frequency(voice.midi))],
      ])
      await close(modulated)

      const { engine: limits } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 2 } })
      for (let midi = 40; midi < 56; midi++) { await limits.noteOnVoice(makeNote(midi)); await sleep(2) }
      const limitsContext = contexts.at(-1)
      const fullVoices = active(limits)
      check('Sixteen independently held voices fit the declared limit', { state: limits.getState(), diagnostics: limits.getDiagnostics() }, [
        ['all sixteen managed voices are gated', fullVoices.length === 16 && limits.getState().voiceCount === 16 && limits.getState().heldCount === 16],
        ['sixteen voices share one carrier each at steady state', limits.getDiagnostics().totalCarrierCount === 16],
        ['sixteen held voices own distinct native splitter lanes on one physical processor', limits.getDiagnostics().envelopeControlCount === 16 && limits.getDiagnostics().maxEnvelopeControls === 20 && controlsFor(limitsContext).length === 1 && nativeLanesFor(limitsContext) === 16],
      ])
      limits.noteOffVoice('A:1:50')
      await limits.noteOnVoice(makeNote(56))
      const releaseFirst = limits.getVoices()
      check('Voice stealing prefers a Release before an older held note', { voices: releaseFirst, state: limits.getState() }, [
        ['released voice leaves managed pool first', !active(limits).some(voice => voice.id === 'A:1:50') && active(limits).some(voice => voice.id === 'A:1:40')],
        ['new note starts within the sixteen-voice managed pool', active(limits).length === 16 && active(limits).some(voice => voice.id === 'A:1:56' && voice.gateOpen)],
        ['stolen Release has only a bounded short fade tail', releaseFirst.filter(voice => voice.retiring).length <= 4],
      ])
      await sleep(65)
      await limits.noteOnVoice(makeNote(57))
      const oldestFirst = active(limits)
      limits.noteOffVoice('A:1:40')
      check('At capacity the oldest held voice is stolen safely', { voices: oldestFirst, state: limits.getState() }, [
        ['oldest held identity leaves managed pool', !oldestFirst.some(voice => voice.id === 'A:1:40') && oldestFirst.some(voice => voice.id === 'A:1:41')],
        ['Note Off of stolen identity cannot release a replacement', active(limits).find(voice => voice.id === 'A:1:57')?.gateOpen && limits.getState().heldCount === 16],
      ])
      let maximumManaged = 0
      let maximumRetiring = 0
      let maximumCarriers = 0
      let maximumControls = 0
      let maximumNativeControls = 0
      for (let index = 0; index < 85; index++) {
        const midi = 36 + index % 60
        await limits.noteOnVoice(makeNote(midi, { id: `burst:${index}` }))
        if (index % 2 === 0) limits.noteOffVoice(`burst:${index}`)
        const diagnostics = limits.getDiagnostics()
        maximumManaged = Math.max(maximumManaged, limits.getState().voiceCount)
        maximumRetiring = Math.max(maximumRetiring, diagnostics.retiringCount)
        maximumCarriers = Math.max(maximumCarriers, diagnostics.totalCarrierCount)
        maximumControls = Math.max(maximumControls, diagnostics.envelopeControlCount)
        maximumNativeControls = Math.max(maximumNativeControls, controlsFor(limitsContext).filter(record => !record.disconnected).length)
      }
      check('Rapid long-Release playing cannot accumulate unlimited nodes', { maximumManaged, maximumRetiring, maximumCarriers, maximumControls, maximumNativeControls, diagnostics: limits.getDiagnostics() }, [
        ['managed pool stays at or below sixteen including Release', maximumManaged <= 16],
        ['forced fade tails stay at or below four', maximumRetiring <= 4],
        ['carrier graph remains globally bounded', maximumCarriers <= 40],
        ['leased envelope lanes stay bounded and share exactly one physical processor', maximumControls > 0 && maximumControls <= 20 && maximumNativeControls === 1 && controlsFor(limitsContext).length === 1 && controlSplitters.filter(record => record.context === limitsContext).every(record => record.maximumLanes <= 20)],
      ])
      limits.panic()
      await sleep(110)
      check('Panic smoothly clears a full polyphonic graph', { state: limits.getState(), diagnostics: limits.getDiagnostics(), signal: analyse(limits).rms }, [
        ['Panic closes every gate and cancels pending notes', limits.getState().heldCount === 0 && limits.getState().pendingCount === 0],
        ['all forced fades finish with no surviving carrier or envelope control', limits.getVoices().length === 0 && limits.getDiagnostics().totalCarrierCount === 0 && limits.getDiagnostics().envelopeControlCount === 0],
        ['actual mixed output becomes silent promptly', analyse(limits).rms < 0.00001],
      ])
      await close(limits)

      const { engine: queued } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 2 } })
      for (let midi = 40; midi < 56; midi++) await queued.noteOnVoice(makeNote(midi))
      await sleep(80)
      const queuedContext = contexts.at(-1)
      const queuedAdmissions = []
      for (let index = 0; index < 24; index++) queuedAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `queued:${index}` })))
      const queuedBeforeOff = queued.getState()
      queued.noteOffVoice('queued:23')
      await Promise.all(queuedAdmissions)
      await sleep(80)
      const stopLevels = queuedContext.oscillators.flatMap(record => record.stoppedVoiceLevels)
      check('Overlapping steals wait for a zero-level tail before destroying a native oscillator', { queuedBeforeOff, diagnostics: queued.getDiagnostics(), stoppedVoiceLevels: stopLevels }, [
        ['overflow admission queues instead of exceeding the bounded tail pool', queuedBeforeOff.pendingCount > 0 && queued.getDiagnostics().retiringCount <= 4 && queued.getState().voiceCount <= 16],
        ['Note Off cancels an admission waiting for a steal slot', !queued.getVoices().some(voice => voice.id === 'queued:23') && queued.getState().pendingCount === 0],
        ['every immediate carrier destruction has actual zero evidence', stopLevels.length > 0 && stopLevels.every(proof => proof.safe) && stopLevels.some(proof => proof.reason === 'processor-zero')],
      ])
      const pendingScopeAdmissions = []
      for (let index = 0; index < 24; index++) pendingScopeAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `scope-queue:${index}`, sourceId: 'C', sourceName: 'Simulated MIDI C', channel: 3 })))
      queued.releaseVoices({ sourceId: 'C', channel: 3 }, true)
      await Promise.all(pendingScopeAdmissions)
      await sleep(80)
      check('Scoped All Sound Off cancels queued steal admissions', { state: queued.getState(), voices: queued.getVoices() }, [
        ['no canceled queued source voice can resurrect', !queued.getVoices().some(voice => voice.sourceId === 'C') && queued.getState().pendingCount === 0],
        ['other source retains held voices', active(queued).some(voice => voice.sourceId === 'A' && voice.gateOpen)],
      ])
      const pendingPanicAdmissions = []
      for (let index = 0; index < 24; index++) pendingPanicAdmissions.push(queued.noteOnVoice(makeNote(60 + index % 12, { id: `panic-queue:${index}` })))
      queued.panic()
      await Promise.all(pendingPanicAdmissions)
      await sleep(100)
      check('Panic cancels queued steals as well as sounding voices', { state: queued.getState(), diagnostics: queued.getDiagnostics() }, [
        ['no queued voice carrier or control node survives Panic', queued.getState().pendingCount === 0 && queued.getVoices().length === 0 && queued.getDiagnostics().totalCarrierCount === 0 && queued.getDiagnostics().envelopeControlCount === 0],
        ['all destroyed carriers have render-thread zero ACKs or a silent carrier or unstarted gate', queuedContext.oscillators.flatMap(record => record.stoppedVoiceLevels).every(proof => proof.safe)],
      ])
      await close(queued)

      const { engine: headroom } = create({ amplitude: 1 })
      for (let index = 0; index < 16; index++) await headroom.noteOnVoice(makeNote(60, { id: `unison:${index}` }))
      analyse(headroom)
      await sleep(450)
      const headroomSignal = analyse(headroom)
      check('Sixteen full-level unison voices have protected output headroom', { rms: headroomSignal.rms, peak: headroomSignal.peak, state: headroom.getState() }, [
        ['sixteen voices remain genuinely audible', headroom.getState().heldCount === 16 && headroomSignal.rms > 0.015],
        ['native time samples stay below digital full scale', Number.isFinite(headroomSignal.peak) && headroomSignal.peak < 0.995],
      ])
      await close(headroom)

      const { engine: scoped } = create({ adsr: { attack: 0.005, decay: 0.005, sustain: 1, release: 0.25 } })
      await Promise.all([
        makeNote(60), makeNote(60, { id: 'B:1:60', sourceId: 'B' }),
        makeNote(64, { id: 'A:2:64', channel: 2 }),
        makeNote(67, { id: 'pc:67', sourceId: 'local', channel: null, origin: 'local' }),
      ].map(note => scoped.noteOnVoice(note)))
      analyse(scoped)
      await sleep(120)
      scoped.noteOffVoice('A:1:60')
      const scopedGateClosed = !active(scoped).find(voice => voice.id === 'A:1:60').gateOpen
      await settleControl(scoped)
      check('Equal notes from two sources have independent identities', { voices: active(scoped) }, [
        ['A Note Off releases A without changing B', scopedGateClosed && active(scoped).find(voice => voice.id === 'A:1:60')?.phase === 'release' && active(scoped).find(voice => voice.id === 'B:1:60')?.gateOpen],
      ])
      scoped.releaseVoices({ sourceId: 'A', channel: 2 })
      const allNotesGateClosed = !active(scoped).find(voice => voice.id === 'A:2:64').gateOpen
      await settleControl(scoped)
      const allNotesOff = active(scoped)
      check('Scoped All Notes Off uses normal Release', { voices: allNotesOff }, [
        ['only matching held channel enters Release', allNotesGateClosed && allNotesOff.find(voice => voice.id === 'A:2:64')?.phase === 'release' && allNotesOff.find(voice => voice.id === 'B:1:60')?.gateOpen && allNotesOff.find(voice => voice.id === 'pc:67')?.gateOpen],
      ])
      await scoped.noteOnVoice(makeNote(65, { id: 'A:2:65', channel: 2 }))
      scoped.releaseVoices({ sourceId: 'A', channel: 2 }, true)
      await sleep(85)
      check('Scoped All Sound Off ends held and Release voices promptly', { voices: scoped.getVoices() }, [
        ['matching channel carriers are removed after short safety fade', !scoped.getVoices().some(voice => voice.sourceId === 'A' && voice.channel === 2)],
        ['other source and local keyboard retain their gates', ids(scoped).includes('B:1:60') && ids(scoped).includes('pc:67')],
      ])
      scoped.releaseVoices({ sourceId: 'B' }, true)
      await sleep(85)
      check('Disconnect cleanup preserves the other sources', { voices: scoped.getVoices(), state: scoped.getState() }, [
        ['all disconnected source voices are gone', !scoped.getVoices().some(voice => voice.sourceId === 'B')],
        ['local keyboard remains sounding independently', active(scoped).find(voice => voice.id === 'pc:67')?.gateOpen && analyse(scoped).rms > 0.003],
      ])
      await scoped.noteOn(220)
      await sleep(80)
      scoped.noteOff()
      await sleep(400)
      check('Audition Stop does not stop keyboard voices', { voices: scoped.getVoices(), state: scoped.getState() }, [
        ['audition has stopped while local key remains gated', !scoped.getState().auditionGateOpen && active(scoped).find(voice => voice.id === 'pc:67')?.gateOpen],
        ['audition Release cleans up independently', !active(scoped).some(voice => voice.origin === 'audition') && scoped.getState().heldCount === 1],
      ])
      await close(scoped)

      const { engine: soak, update: updateSoak } = create({ adsr: { attack: 0.005, decay: 0.01, sustain: 0.7, release: 0.025 } })
      await soak.prepare()
      analyse(soak)
      const soakContext = contexts.at(-1)
      let soakMaximumVoices = 0
      let soakMaximumCarriers = 0
      let soakMaximumControls = 0
      for (let index = 0; index < 160; index++) {
        const note = makeNote(48 + index % 36, { id: `soak:${index}` })
        await soak.noteOnVoice(note)
        if (index % 13 === 0) updateSoak({ waveform: ['sine', 'square', 'triangle'][index % 3] })
        // Observe allocated resources before the intentionally short gate is
        // canceled ahead of its scheduled audible start.
        soakMaximumVoices = Math.max(soakMaximumVoices, soak.getState().voiceCount)
        soakMaximumCarriers = Math.max(soakMaximumCarriers, soak.getDiagnostics().totalCarrierCount)
        soakMaximumControls = Math.max(soakMaximumControls, soak.getDiagnostics().envelopeControlCount)
        await sleep(4)
        soak.noteOffVoice(note.id)
      }
      await sleep(250)
      const soakDiagnostics = soak.getDiagnostics()
      check('Extended repeated playing releases finished voice resources', { soakMaximumVoices, soakMaximumCarriers, soakMaximumControls, diagnostics: soakDiagnostics, nativeOscillatorsCreated: soakContext.oscillators.length, nativeOscillatorsEnded: soakContext.oscillators.filter(record => record.ended).length }, [
        ['series remains within voice carrier and envelope control caps', soakMaximumVoices <= 16 && soakMaximumCarriers <= 40 && soakMaximumControls > 0 && soakMaximumControls <= 20],
        ['every completed voice is destroyed', soakDiagnostics.createdVoiceCount >= 160 && soakDiagnostics.createdVoiceCount === soakDiagnostics.destroyedVoiceCount],
        ['empty manager retains no voice carrier or control node', soak.getVoices().length === 0 && soakDiagnostics.totalCarrierCount === 0 && soakDiagnostics.envelopeControlCount === 0 && analyse(soak).rms < 0.00001],
        ['all native voice oscillators have ended', soakContext.oscillators.filter(record => !record.ended).length <= 1],
      ])
      await soak.noteOnVoice(makeNote(60))
      await soak.dispose()
      await soak.dispose()
      await soak.noteOnVoice(makeNote(64))
      await sleep(35)
      check('Dispose closes the shared context and all native nodes', { state: soak.getState(), diagnostics: soak.getDiagnostics(), nativeOscillators: soakContext.oscillators.map(record => ({ ended: record.ended, disconnected: record.disconnected })) }, [
        ['disposed context stays closed and no voice can restart', soak.getState().contextState === 'closed' && soak.getState().voiceCount === 0 && soak.getState().pendingCount === 0],
        ['all native oscillators are disconnected', soakContext.oscillators.every(record => record.disconnected)],
        ['dispose releases every envelope control and proves each audible native stop safe', soak.getDiagnostics().envelopeControlCount === 0 && soakContext.oscillators.flatMap(record => record.stoppedVoiceLevels).every(proof => proof.safe)],
        ['disposed engine exposes no analyser', soak.getAnalysis() === null],
      ])

      // These tests defer only native resume completion. Oscillators, routing,
      // context and signal samples remain real Web Audio objects.
      class DeferredAudioContext extends RecordedAudioContext {
        holdResume = true
        resumeCalls = 0
        get state() { return this.holdResume ? 'suspended' : super.state }
        async resume() { this.resumeCalls++; await sleep(100); this.holdResume = false; if (super.state !== 'closed') await super.resume() }
      }
      window.AudioContext = DeferredAudioContext
      const { engine: deferred } = create()
      const pendingC = deferred.noteOnVoice(makeNote(60))
      const pendingE = deferred.noteOnVoice(makeNote(64))
      const pendingG = deferred.noteOnVoice(makeNote(67))
      const deferredContext = contexts.at(-1)
      const pendingDuplicate = deferred.noteOnVoice(makeNote(64))
      deferred.noteOffVoice('A:1:60')
      await Promise.all([pendingC, pendingE, pendingG, pendingDuplicate])
      await sleep(150)
      check('Delayed resume honors per-identity Note Off and deduplicates pending notes', { state: deferred.getState(), voices: deferred.getVoices(), resumeCalls: deferredContext.resumeCalls }, [
        ['released C4 never resurrects after resume', !deferred.getVoices().some(voice => voice.id === 'A:1:60')],
        ['E4 and G4 each start exactly one independent voice', JSON.stringify(ids(deferred)) === JSON.stringify(['A:1:64', 'A:1:67']) && deferred.getState().voiceCount === 2],
        ['simultaneous pending notes share one native resume', deferredContext.resumeCalls === 1 && deferred.getState().pendingCount === 0],
      ])
      await close(deferred)
      const { engine: deferredScoped } = create()
      const pendingScoped = [makeNote(60), makeNote(64, { id: 'A:2:64', channel: 2 }), makeNote(67, { id: 'B:1:67', sourceId: 'B' })].map(note => deferredScoped.noteOnVoice(note))
      deferredScoped.releaseVoices({ sourceId: 'A', channel: 1 }, true)
      await Promise.all(pendingScoped)
      await sleep(100)
      check('Scoped cleanup cancels only matching pending voices', { state: deferredScoped.getState(), voices: deferredScoped.getVoices() }, [
        ['matching pending source/channel stays canceled', !deferredScoped.getVoices().some(voice => voice.id === 'A:1:60')],
        ['other channel and source finish initialization', JSON.stringify(ids(deferredScoped)) === JSON.stringify(['A:2:64', 'B:1:67'])],
      ])
      await close(deferredScoped)
      const { engine: deferredRepress } = create()
      const canceledFirstPress = deferredRepress.noteOnVoice(makeNote(60, { velocity: 120 }))
      deferredRepress.noteOffVoice('A:1:60')
      const replacementPress = deferredRepress.noteOnVoice(makeNote(60, { velocity: 35 }))
      await Promise.all([canceledFirstPress, replacementPress])
      await sleep(120)
      check('Repress during resume replaces only the canceled pending request', { state: deferredRepress.getState(), voices: deferredRepress.getVoices() }, [
        ['exactly the later press starts with its own velocity', active(deferredRepress).length === 1 && active(deferredRepress)[0].id === 'A:1:60' && active(deferredRepress)[0].velocity === 35],
        ['canceled press does not leave a duplicate or pending entry', deferredRepress.getState().pendingCount === 0 && deferredRepress.getDiagnostics().createdVoiceCount === 1],
      ])
      await close(deferredRepress)
      const { engine: deferredPanic } = create()
      const panicPending = [60, 64, 67].map(midi => deferredPanic.noteOnVoice(makeNote(midi)))
      deferredPanic.panic()
      await Promise.all(panicPending)
      await sleep(100)
      check('Panic cancels every pending polyphonic note', { state: deferredPanic.getState(), rms: analyse(deferredPanic).rms }, [
        ['late resume cannot recreate a canceled chord', deferredPanic.getState().voiceCount === 0 && deferredPanic.getState().pendingCount === 0 && deferredPanic.getDiagnostics().totalCarrierCount === 0],
        ['native output stays silent', analyse(deferredPanic).rms < 0.00001],
      ])
      await close(deferredPanic)
      const { engine: deferredDispose } = create()
      const disposalPending = [60, 64, 67].map(midi => deferredDispose.noteOnVoice(makeNote(midi)))
      await deferredDispose.dispose()
      await Promise.all(disposalPending)
      check('Dispose cancels an entire pending chord', { state: deferredDispose.getState(), diagnostics: deferredDispose.getDiagnostics() }, [
        ['context remains closed without pending or active voices', deferredDispose.getState().contextState === 'closed' && deferredDispose.getState().voiceCount === 0 && deferredDispose.getState().pendingCount === 0],
        ['all node references are released', deferredDispose.getDiagnostics().totalCarrierCount === 0 && deferredDispose.getDiagnostics().envelopeControlCount === 0 && deferredDispose.getAnalysis() === null],
      ])
      check('Every native context uses at most one physical envelope processor and releases every leased lane', { contexts: contexts.map(context => ({ state: context.state, processors: controlsFor(context).length, leases: leasesFor(context).length, connectedLanes: nativeLanesFor(context), maximumLanes: Math.max(0, ...controlSplitters.filter(record => record.context === context).map(record => record.maximumLanes)) })), physicalProcessors: controlNodes.map(({ disconnected, portClosed, errors }) => ({ disconnected, portClosed, errors })) }, [
        ['each context with voice leases constructed exactly one native AudioWorkletNode', contexts.every(context => controlsFor(context).length <= 1 && (leasesFor(context).length === 0 || controlsFor(context).length === 1))],
        ['independent native splitter observations never exceed twenty lanes and all leases close', controlSplitters.every(record => record.maximumLanes <= 20) && controlLeases.every(lease => lease.disconnected && lease.portClosed) && contexts.every(context => nativeLanesFor(context) === 0)],
        ['each disposed shared processor is disconnected and its actual MessagePort is closed without errors', controlNodes.length > 0 && controlNodes.every(record => record.context.state === 'closed' && record.disconnected && record.portClosed && record.errors.length === 0)],
      ])
      return { results, failures: results.flatMap(result => result.checks.filter(assertion => !assertion.passed).map(assertion => `${result.name}: ${assertion.description}`)) }
    } finally {
      window.AudioContext = NativeAudioContext
      window.AudioWorkletNode = NativeAudioWorkletNode
      await Promise.all(engines.map(engine => engine.dispose()))
    }
  })
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../test-results/poly-audio-${browserName}.json`, import.meta.url), JSON.stringify({ browser: browserName, ...report }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.failures, [], 'Polyphonic native Web Audio tests failed')
  console.log(`PASS: ${report.results.length} polyphonic audio scenarios, ${report.results.reduce((sum, result) => sum + result.checks.length, 0)} assertions (${browserName})`)
} finally {
  await session.close()
}
