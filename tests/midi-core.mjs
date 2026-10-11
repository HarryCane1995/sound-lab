import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { startTestBrowser } from './helpers.mjs'

const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { MidiController, relativeDelta } = await import('/src/midi/MidiController.ts')
    const { parseMidiMessage, midiNoteName, midiNoteFrequency } = await import('/src/midi/parser.ts')
    const { TARGETS, getTargetNormalized, setTargetNormalized } = await import('/src/midi/targets.ts')
    const { STORAGE_KEY, loadMidiSettings } = await import('/src/midi/storage.ts')
    const { DEFAULT_PARAMS } = await import('/src/types.ts')
    const results = []
    const controllers = []
    const check = (name, assertions) => results.push({ name, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess')
    const originalStorage = localStorage.getItem(STORAGE_KEY)
    let requests = 0
    let options = null
    class Input extends EventTarget {
      constructor(id, name = 'Generic USB Controller') { super(); this.id = id; this.name = name; this.manufacturer = 'Mock'; this.state = 'connected'; this.listeners = new Set(); this.opens = 0; this.closes = 0 }
      addEventListener(type, listener, config) { super.addEventListener(type, listener, config); if (type === 'midimessage') this.listeners.add(listener) }
      removeEventListener(type, listener, config) { super.removeEventListener(type, listener, config); if (type === 'midimessage') this.listeners.delete(listener) }
      open() { this.opens++; return Promise.resolve(this) }
      close() { this.closes++; return Promise.resolve(this) }
      send(bytes) { const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array(bytes) }); this.dispatchEvent(event) }
    }
    class Access extends EventTarget {
      constructor(inputs) { super(); this.inputs = new Map(inputs.map(input => [input.id, input])) }
      changed() { this.dispatchEvent(new Event('statechange')) }
    }
    const mockAccess = access => Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async config => { requests++; options = config; return access } })
    const create = () => {
      const events = [], targets = [], disconnects = [], states = []
      const positions = new Map()
      const controller = new MidiController({ onState: state => states.push(state), onMessage: (message, consumed) => events.push({ message, consumed }), onTarget: (target, normalized, message) => { targets.push({ target, normalized, message }); if (normalized !== null) positions.set(target, normalized) }, onDisconnect: id => disconnects.push(id), getTargetNormalized: target => positions.get(target) ?? 0.5 })
      controllers.push(controller)
      return { controller, events, targets, disconnects, states, positions }
    }
    const learn = (target, bytes, ctx, input) => { ctx.controller.beginLearn(target); input.send(bytes) }
    const last = values => values.at(-1)
    try {
      localStorage.removeItem(STORAGE_KEY)
      const source = { id: 'a', name: 'Test' }
      const parse = bytes => parseMidiMessage(bytes, source, 42)
      check('MIDI parser and note math', [
        ['Note On retains source, channel16, note and velocity', parse([0x9f, 69, 100]).type === 'noteon' && parse([0x9f, 69, 100]).channel === 16 && parse([0x9f, 69, 100]).sourceId === 'a' && parse([0x9f, 69, 100]).velocity === 100],
        ['velocity0 Note On becomes Note Off', parse([0x90, 60, 0]).type === 'noteoff'],
        ['normal Note Off preserves release velocity', parse([0x80, 60, 42]).type === 'noteoff' && parse([0x80, 60, 42]).velocity === 42],
        ['CC, channel pressure and poly pressure parse', parse([0xb2, 74, 127]).controller === 74 && parse([0xd2, 15]).type === 'aftertouch' && parse([0xa2, 60, 16]).type === 'polyaftertouch'],
        ['program and system messages appear in monitor', parse([0xc0, 5]).type === 'programchange' && parse([0xf8]).type === 'system'],
        ['14bit pitch bend has exact -1/0/+1', parse([0xe0, 0, 0]).bend === -1 && parse([0xe0, 0, 64]).bend === 0 && parse([0xe0, 127, 127]).bend === 1],
        ['malformed channel messages are ignored', parse([0x90, 60]) === null && parse([0xb0, 1, 128]) === null && parse([12, 60, 100]) === null],
        ['MIDI69 = A4 =440Hz and MIDI60=C4', midiNoteName(69) === 'A4' && midiNoteFrequency(69) === 440 && midiNoteName(60) === 'C4'],
      ])
      const bounds = [['frequency', 20, 20000], ['amplitude', 0, 1], ['adsr.attack', .005, 4], ['adsr.decay', .01, 3], ['adsr.sustain', 0, 1], ['adsr.release', .01, 5], ['filter.cutoff', 20, 20000], ['filter.q', .1, 10], ['lfo.rate', .1, 12], ['lfo.depth', 0, 1]]
      const value = (params, target) => target.includes('.') ? params[target.split('.')[0]][target.split('.')[1]] : params[target]
      check('Parameter ranges and logarithmic scales', [
        ['all continuous targets roundtrip0/1 and clamp bounds', bounds.every(([target, low, high]) => Math.abs(value(setTargetNormalized(DEFAULT_PARAMS, target, -1), target) - low) < 1e-8 && Math.abs(value(setTargetNormalized(DEFAULT_PARAMS, target, 2), target) - high) < 1e-8 && Math.abs(getTargetNormalized(setTargetNormalized(DEFAULT_PARAMS, target, .371), target) - .371) < 1e-8)],
        ['frequency midpoint uses geometric mean', Math.abs(setTargetNormalized(DEFAULT_PARAMS, 'frequency', .5).frequency - Math.sqrt(20 * 20000)) < 1e-8],
        ['waveform CC spans all4 waveforms', [0, 32, 64, 96, 127].map(number => setTargetNormalized(DEFAULT_PARAMS, 'waveform', number / 127).waveform).join() === 'sine,square,sawtooth,triangle,triangle'],
        ['all27 targets are unique and include existing actions plus synthesis mode', TARGETS.length === 27 && new Set(TARGETS.map(target => target.id)).size === 27 && TARGETS.find(target => target.id === 'filter.bypass').kind === 'action' && TARGETS.find(target => target.id === 'synthesis.mode').kind === 'action'],
        ['Classic waveform CC selects Classic without losing harmonics', (() => { const additive = { ...DEFAULT_PARAMS, mode: 'additive', additive: { ...DEFAULT_PARAMS.additive, levels: Array(16).fill(42) } }; const classic = setTargetNormalized(additive, 'waveform', 1); return classic.mode === 'classic' && classic.waveform === 'triangle' && classic.additive.levels.every(level => level === 42) })()],
      ])
      const first = new Input('a'), second = new Input('b', 'Second Controller')
      const access = new Access([first, second])
      mockAccess(access)
      const ctx = create()
      check('Permission is deferred', [['constructor never requests MIDI', requests === 0 && first.listeners.size === 0]])
      await ctx.controller.connect()
      await ctx.controller.connect()
      check('Explicit MIDI access and subscription', [
        ['one access request, sysexfalse', requests === 1 && options.sysex === false],
        ['discovers bothdevices, initialselectedinput has1subscription', ctx.controller.getState().inputs.length === 2 && ctx.controller.getState().selectedId === 'a' && first.listeners.size === 1 && second.listeners.size === 0],
      ])
      first.send([0x90, 60, 100]); first.send([0x90, 60, 0]); first.send([0xe0, 0, 64]); first.send([0xd0, 33]); first.send([0xa0, 60, 44])
      check('Unbound musical messages route intact', [['notes, pitch and pressure are notconsumed', ctx.events.length === 5 && ctx.events.every(event => !event.consumed) && ctx.events[1].message.type === 'noteoff']])
      learn('filter.cutoff', [0xb0, 74, 90], ctx, first)
      check('MIDI Learn capture is inert', [['capture createscorrectCCbinding withoutapplyingvalue', ctx.targets.length === 0 && last(ctx.events).consumed && ctx.controller.getState().bindings[0].target === 'filter.cutoff' && ctx.controller.getState().bindings[0].number === 74]])
      first.send([0xb0, 74, 127]); first.send([0xb1, 74, 32]); second.send([0xb0, 74, 32])
      check('Bound CC routing matches channel and source', [['onlycorrectsource+channel controlsnormalizedparameter', ctx.targets.length === 1 && ctx.targets[0].normalized === 1 && ctx.targets[0].target === 'filter.cutoff']])
      const binding = ctx.controller.getState().bindings[0]
      ctx.controller.setBindingMode(binding.id, 'relative-twos-complement')
      ctx.positions.set('filter.cutoff', .5); first.send([0xb0, 74, 1]); first.send([0xb0, 74, 127])
      const twoSteps = ctx.targets.slice(-2)
      ctx.controller.setBindingMode(binding.id, 'relative-binary-offset'); first.send([0xb0, 74, 65]); first.send([0xb0, 74, 63])
      const offsetSteps = ctx.targets.slice(-2)
      ctx.controller.setBindingMode(binding.id, 'relative-sign-magnitude'); first.send([0xb0, 74, 1]); first.send([0xb0, 74, 65])
      ctx.positions.set('filter.cutoff', 0); first.send([0xb0, 74, 65]); const low = last(ctx.targets).normalized
      ctx.positions.set('filter.cutoff', 1); first.send([0xb0, 74, 1]); const high = last(ctx.targets).normalized
      check('Explicit relative encoder modes', [
        ['twos complement1/127 changesby±1/127', Math.abs(twoSteps[0].normalized - (.5 + 1 / 127)) < 1e-8 && Math.abs(twoSteps[1].normalized - .5) < 1e-8],
        ['binaryoffset65/63 changesby±1/127', Math.abs(offsetSteps[0].normalized - (.5 + 1 / 127)) < 1e-8 && Math.abs(offsetSteps[1].normalized - .5) < 1e-8],
        ['signmagnitude1/65 and neutralvalues decodeexplicitly', relativeDelta(1, 'relative-sign-magnitude') === 1 && relativeDelta(65, 'relative-sign-magnitude') === -1 && relativeDelta(64, 'relative-sign-magnitude') === 0 && relativeDelta(64, 'relative-binary-offset') === 0],
        ['relativevalues clampat0..1', low === 0 && high === 1],
      ])
      const beforeConflict = ctx.targets.length
      learn('amplitude', [0xb0, 74, 64], ctx, first); first.send([0xb0, 74, 90])
      check('Conflict requires explicit replacement', [['pendingassignmentdoesnotapplyoldornewtarget', ctx.controller.getState().conflict?.existing.target === 'filter.cutoff' && ctx.targets.length === beforeConflict]])
      ctx.controller.resolveConflict(false)
      learn('waveform.sine', [0x90, 37, 100], ctx, first)
      const removedNoteBinding = ctx.controller.getState().bindings.find(binding => binding.target === 'waveform.sine')
      ctx.controller.removeBinding(removedNoteBinding.id); first.send([0x80, 37, 0])
      check('Removing a held pad mapping does not leak its release', [['capturednotereleaseremainsconsumedaftermapremoval', last(ctx.events).consumed && !ctx.controller.getState().bindings.some(binding => binding.id === removedNoteBinding.id)]])
      check('Conflict cancellation preserves existing map', [['existingbindingremains', ctx.controller.getState().bindings.length === 1 && ctx.controller.getState().bindings[0].target === 'filter.cutoff']])
      learn('amplitude', [0xb0, 74, 64], ctx, first); ctx.controller.resolveConflict(true); first.send([0xb0, 74, 127])
      check('Conflict replacement is unique', [['onephysicalsignalhasonebinding', ctx.controller.getState().bindings.length === 1 && last(ctx.targets).target === 'amplitude' && last(ctx.targets).normalized === 1]])
      const beforePad = ctx.targets.length
      learn('waveform.next', [0x90, 36, 100], ctx, first)
      first.send([0x90, 36, 100]); first.send([0x90, 36, 0]); first.send([0x90, 36, 120]); first.send([0x90, 36, 120]); first.send([0x80, 36, 70])
      check('Pad learn, rising edge and release consumption', [
        ['learnandheldrepeatnevertrigger, releasearmsnextpress', ctx.targets.length === beforePad + 1 && last(ctx.targets).target === 'waveform.next' && last(ctx.targets).normalized === null],
        ['allboundpadNoteOn/Offareconsumed', ctx.events.slice(-6).every(event => event.consumed)],
      ])
      learn('panic', [0x90, 36, 100], ctx, first); first.send([0x80, 36, 0])
      check('Conflicting captured pad release is consumed', [['pendingnotedoesnotleakmusicalNoteOff', ctx.controller.getState().conflict !== null && last(ctx.events).consumed]])
      ctx.controller.resolveConflict(false)
      const beforeToggle = ctx.targets.length
      learn('lfo.enabled', [0xb0, 20, 100], ctx, first); first.send([0xb0, 20, 127]); first.send([0xb0, 20, 63]); first.send([0xb0, 20, 64]); first.send([0xb0, 20, 100])
      check('CC action toggles only on rising threshold', [['capture+heldvaluesinertthenonepress', ctx.targets.length === beforeToggle + 1 && last(ctx.targets).target === 'lfo.enabled']])
      ctx.controller.resetPressed(); first.send([0xb0, 20, 100])
      check('Panic clears action held latch', [['nextCCpressworksafterresetPressed', ctx.targets.length === beforeToggle + 2]])
      learn('frequency', [0xb0, 123, 0], ctx, first)
      check('Channel All Notes Off is never learn captured', [['CC123remainsunconsumedanddoesnotcreatebinding', !last(ctx.events).consumed && ctx.controller.getState().learning === 'frequency']])
      ctx.controller.cancelLearn()
      const persisted = loadMidiSettings()
      check('Versioned persistence', [['choseninputandbindingmodearesaved', persisted.error === null && persisted.settings.selectedInput.id === 'a' && persisted.settings.bindings.length === 3]])
      for (let i = 0; i < 40; i++) first.send([0xb0, 2, i])
      await wait(40)
      check('Monitor is bounded and clearable', [['keepslatest30events', ctx.controller.getState().events.length === 30 && ctx.controller.getState().events[0].value === 39]])
      ctx.controller.clearMonitor()
      check('Monitor clear', [['emptieseventbuffer', ctx.controller.getState().events.length === 0]])
      first.send([0x90, 60, 100]); first.state = 'disconnected'; access.changed()
      check('Disconnect releases source and waits for preferreddevice', [['disconnectcallbackfiresandunrelateddeviceisnotautoselected', last(ctx.disconnects) === 'a' && ctx.controller.getState().status === 'disconnected' && ctx.controller.getState().selectedId === '' && first.listeners.size === 0 && second.listeners.size === 0]])
      first.state = 'connected'; access.changed()
      check('Automatic reattach withoutduplicatehandlers', [['preferredinputreturnsand1subscription', ctx.controller.getState().selectedId === 'a' && first.listeners.size === 1]])
      ctx.controller.selectInput('b')
      check('Explicit source switch', [['oldnotesreleasedbeforeswitchandonlynewsourcehaslistener', last(ctx.disconnects) === 'a' && first.listeners.size === 0 && second.listeners.size === 1 && ctx.controller.getState().selectedId === 'b']])
      ctx.controller.dispose()
      const restored = create()
      check('Reload restores maps but requestsnothing', [['settingsloadedandpermissionremainsuserinitiated', restored.controller.getState().bindings.length === 3 && restored.controller.getState().preferredName === 'Second Controller' && second.listeners.size === 0 && requests === 1]])
      await restored.controller.connect()
      check('Explicit connect restores selecteddevice', [['preferreddevicebselected', restored.controller.getState().selectedId === 'b' && second.listeners.size === 1]])
      restored.controller.dispose()
      localStorage.removeItem(STORAGE_KEY)
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => { throw new DOMException('denied', 'NotAllowedError') } })
      const denied = create(); await denied.controller.connect()
      check('Permission denial is recoverable', [['reportsdeniedwithoutthrowing', denied.controller.getState().status === 'denied']]); denied.controller.dispose()
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: undefined })
      const unsupported = create(); await unsupported.controller.connect()
      check('Unsupported browser is explained', [['reportsunsupported', unsupported.controller.getState().status === 'unsupported']]); unsupported.controller.dispose()
      mockAccess(new Access([])); const empty = create(); await empty.controller.connect()
      check('No MIDI hardware is valid', [['reportsnodevices', empty.controller.getState().status === 'no-devices']]); empty.controller.dispose()
      localStorage.setItem(STORAGE_KEY, '{broken json')
      const corrupt = create()
      check('Corrupt storage is safe', [['discardsmalformedsettingsandwarns', corrupt.controller.getState().bindings.length === 0 && !!corrupt.controller.getState().storageError]]); corrupt.controller.dispose()
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, selectedInput: null, bindings: [] }))
      check('Unknown storage version is rejected', [['schemaerrorreported', !!loadMidiSettings().error]])
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selectedInput: null, bindings: [{ id: 'invalid', target: 'frequency', sourceId: 'a', sourceName: 'Test', channel: 1, kind: 'note', number: 1, mode: 'absolute' }] }))
      check('Invalid binding types are rejected', [['continuousparametercannotloadnotebinding', !!loadMidiSettings().error]])
      const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError') } })
        mockAccess(new Access([new Input('private')]))
        const privateStorage = create(); await privateStorage.controller.connect()
        check('Unavailable localStorage does not disable MIDI', [['connectionworksandsessiononlywarningisshown', privateStorage.controller.getState().status === 'ready' && !!privateStorage.controller.getState().storageError]])
        privateStorage.controller.dispose()
      } finally { Object.defineProperty(window, 'localStorage', storageDescriptor) }
      localStorage.removeItem(STORAGE_KEY)
      let resolveAccess
      const late = new Input('late'), lateAccess = new Access([late])
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => new Promise(resolve => { resolveAccess = resolve }) })
      const pending = create(); const connecting = pending.controller.connect(); pending.controller.dispose(); resolveAccess(lateAccess); await connecting; lateAccess.changed()
      check('Async connect cleanup / StrictMode safety', [['resolvedpermissionafterdisposeaddsnohandler', late.listeners.size === 0 && pending.controller.getState().selectedId === '']])
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selectedInput: { id: 'old', name: 'Moved Controller' }, bindings: [{ id: 'saved', target: 'amplitude', sourceId: 'old', sourceName: 'Moved Controller', channel: 1, kind: 'cc', number: 7, mode: 'absolute' }] }))
      const moved = new Input('new', 'Moved Controller'), movedAccess = new Access([moved]); mockAccess(movedAccess)
      const migration = create(); await migration.controller.connect(); moved.send([0xb0, 7, 127])
      check('Unique-name reconnect migrates port IDs', [['savedmappingfollowsuniquematchingdevice', migration.controller.getState().selectedId === 'new' && migration.controller.getState().bindings[0].sourceId === 'new' && last(migration.targets)?.normalized === 1]])
      migration.controller.dispose()
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selectedInput: { id: 'missing', name: 'Duplicate' }, bindings: [] }))
      const duplicate1 = new Input('d1', 'Duplicate'), duplicate2 = new Input('d2', 'Duplicate'); mockAccess(new Access([duplicate1, duplicate2]))
      const ambiguous = create(); await ambiguous.controller.connect()
      check('Ambiguous matching names neverautoselect', [['requiresuserchoicewhentwonamesmatch', ambiguous.controller.getState().status === 'disconnected' && duplicate1.listeners.size === 0 && duplicate2.listeners.size === 0]])
      ambiguous.controller.dispose()
      const separateControllerSettings = { version: 1, selectedInput: { id: 'old-selected', name: 'Same Model' }, bindings: [
        { id: 'original-map', target: 'amplitude', sourceId: 'old-selected', sourceName: 'Same Model', channel: 1, kind: 'cc', number: 7, mode: 'absolute' },
        { id: 'other-map', target: 'frequency', sourceId: 'known-other', sourceName: 'Same Model', channel: 1, kind: 'cc', number: 7, mode: 'absolute' },
      ] }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(separateControllerSettings))
      const knownOther = new Input('known-other', 'Same Model'); mockAccess(new Access([knownOther]))
      const separateControllers = create(); await separateControllers.controller.connect()
      const waitingSettings = loadMidiSettings()
      check('Known same-name controller cannot impersonate missing preferred input', [
        ['requires explicit device choice despite unique currently connected name', separateControllers.controller.getState().status === 'disconnected' && separateControllers.controller.getState().selectedId === '' && knownOther.listeners.size === 0],
        ['both source mappings remain valid and survive reload', waitingSettings.error === null && waitingSettings.settings.bindings.length === 2 && waitingSettings.settings.bindings[0].sourceId === 'old-selected' && waitingSettings.settings.bindings[1].sourceId === 'known-other'],
      ])
      separateControllers.controller.selectInput('known-other'); knownOther.send([0xb0, 7, 127])
      check('Explicit same-name device choice preserves independent mappings', [
        ['only its original physical mapping executes', last(separateControllers.targets)?.target === 'frequency' && separateControllers.targets.length === 1],
        ['manual switch never migrates another source or corrupts persistence', loadMidiSettings().error === null && separateControllers.controller.getState().bindings[0].sourceId === 'old-selected'],
      ])
      separateControllers.controller.dispose()
    } finally {
      controllers.forEach(controller => controller.dispose())
      if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess
      if (originalStorage === null) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, originalStorage)
    }
    return results
  })
  await writeFile('test-results/midi-core.json', JSON.stringify(report, null, 2))
  const checks = report.flatMap(result => result.checks)
  for (const result of report) for (const check of result.checks) assert.equal(check.passed, true, `${result.name}: ${check.description}`)
  console.log(`MIDI core: ${report.length} scenarios / ${checks.length} checks passed (simulated MIDI in Chromium).`)
} finally { await session.close() }
