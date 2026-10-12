// Native audio instrumentation shared by the Studio/GPU integration suites.
// MIDI ports are simulated; synthesis, analyser PCM/FFT and oscillator timing
// remain the browser's real Web Audio implementation.
export async function installStudioProbe(page) {
  await page.addInitScript(() => {
    class Port extends EventTarget {
      constructor() {
        super()
        this.id = 'studio-controller'; this.name = 'Studio Test Controller'
        this.manufacturer = 'Simulated'; this.type = 'input'
        this.state = 'connected'; this.connection = 'closed'
      }
      async open() { this.connection = 'open'; return this }
      async close() { this.connection = 'closed'; return this }
    }
    const port = new Port(), access = new EventTarget()
    access.inputs = new Map([[port.id, port]]); access.outputs = new Map(); access.sysexEnabled = false
    const probe = window.__studioProbe = { contexts: [], analysers: [], oscillators: [], midiRequests: [], port, access }
    probe.send = bytes => {
      const event = new Event('midimessage')
      Object.defineProperty(event, 'data', { value: new Uint8Array(bytes) })
      port.dispatchEvent(event)
    }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async options => { probe.midiRequests.push(options); return access } })
    const NativeContext = window.AudioContext
    window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
      const context = Reflect.construct(Target, args)
      probe.contexts.push(context)
      const createAnalyser = context.createAnalyser.bind(context)
      context.createAnalyser = (...parameters) => { const analyser = createAnalyser(...parameters); probe.analysers.push(analyser); return analyser }
      const createOscillator = context.createOscillator.bind(context)
      context.createOscillator = (...parameters) => {
        const node = createOscillator(...parameters), record = { node, starts: [], stops: [], ended: false }
        probe.oscillators.push(record)
        node.addEventListener('ended', () => { record.ended = true })
        for (const method of ['start', 'stop']) {
          const native = node[method].bind(node)
          node[method] = (...values) => { record[`${method}s`].push({ at: context.currentTime, scheduledAt: values[0] ?? context.currentTime }); return native(...values) }
        }
        return node
      }
      return context
    } })
    probe.measure = (frequencies = [220, 440, 660]) => {
      const context = probe.contexts.findLast(item => item.state !== 'closed')
      const analyser = probe.analysers.find(item => item.context === context)
      if (!analyser) return { rms: 0, peak: 0, time: 0, state: context?.state ?? 'uninitialized', bands: [] }
      const pcm = new Float32Array(analyser.fftSize), fft = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatTimeDomainData(pcm); analyser.getFloatFrequencyData(fft)
      let energy = 0, peak = 0
      for (const value of pcm) { energy += value * value; peak = Math.max(peak, Math.abs(value)) }
      const binHz = context.sampleRate / analyser.fftSize
      const bands = frequencies.map(frequency => {
        const center = Math.round(frequency / binHz)
        let db = -Infinity, index = center
        for (let i = Math.max(0, center - 2); i <= Math.min(fft.length - 1, center + 2); i++) if (fft[i] > db) { db = fft[i]; index = i }
        return { frequency, db, measuredHz: index * binHz }
      })
      return { rms: Math.sqrt(energy / pcm.length), peak, time: context.currentTime, state: context.state, sampleRate: context.sampleRate, bands }
    }
    probe.telemetry = () => ({ contexts: probe.contexts.length, contextStates: probe.contexts.map(context => context.state), oscillators: probe.oscillators.length,
      starts: probe.oscillators.reduce((total, record) => total + record.starts.length, 0), liveOscillators: probe.oscillators.filter(record => record.starts.length && !record.ended).length })
  })
}

export const studioMeasure = (page, frequencies) => page.evaluate(frequencies => window.__studioProbe.measure(frequencies), frequencies)
export const studioTelemetry = page => page.evaluate(() => window.__studioProbe.telemetry())
export const studioMidi = (page, bytes) => page.evaluate(bytes => window.__studioProbe.send(bytes), bytes)
export const waitStudioSound = (page, audible) => page.waitForFunction(audible => {
  const rms = window.__studioProbe.measure().rms
  return audible ? rms > .001 : rms < .00001
}, audible, { polling: 25, timeout: 6000 })

export async function setStudioNumber(page, name, value) {
  const input = page.getByRole('spinbutton', { name: `${name}, значение`, exact: true })
  await input.fill(String(value)); await input.press('Enter')
}

export async function connectStudioMidi(page) {
  if (!await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'MIDI Monitor и привязки', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Подключить MIDI', exact: true }).click()
  await page.locator('.midi-status-ready').waitFor()
}
