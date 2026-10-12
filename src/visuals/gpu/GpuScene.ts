import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { AnalysisDataProvider } from './AnalysisDataProvider'
import type { AnalysisNodes } from '../../types'

export type GpuMode = 'waveform' | 'spectrum'
export type GpuQuality = 'low' | 'medium' | 'high' | 'auto'
export type GpuView = 'perspective' | 'front' | 'top' | 'side'
export interface GpuSettings {
  mode: GpuMode
  quality: GpuQuality
  history: number
  frozen: boolean
  frequency: number
  minFrequency: number
  maxFrequency: number
  palette: 'cool' | 'heat'
  projection: 'perspective' | 'orthographic'
  gain: number
}

const MAX_HISTORY = 96
const MAX_POINTS = 256
const PROFILES = {
  low: { points: 128, history: 32, dpr: 1, fps: 30, reads: 20 },
  medium: { points: 192, history: 64, dpr: 1.5, fps: 30, reads: 30 },
  high: { points: 256, history: 96, dpr: 2, fps: 60, reads: 30 },
} as const
const DEFAULTS: GpuSettings = { mode: 'waveform', quality: 'auto', history: 64, frozen: false, frequency: 220, minFrequency: 20, maxFrequency: 20000, palette: 'cool', projection: 'perspective', gain: 16 }
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
let liveScenes = 0
let createdScenes = 0
let disposedScenes = 0
let savedCamera: { position: number[]; target: number[]; zoom: number; projection: GpuSettings['projection'] } | null = null
interface AxisLabel { node: HTMLSpanElement; world: THREE.Vector3; projected: THREE.Vector3; axis: 'x' | 'y' | 'z'; fraction: number }
interface SceneOptions { overlay?: HTMLElement; onFailure?: (message: string) => void; onLevel?: (rms: number | null) => void }

/** Bounded reusable buffers. Audio is only observed, never connected or changed. */
export class GpuScene {
  readonly canvas: HTMLCanvasElement
  readonly provider: AnalysisDataProvider
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private perspective: THREE.PerspectiveCamera
  private orthographic: THREE.OrthographicCamera
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private controls: OrbitControls
  private geometry: THREE.BufferGeometry
  private material: THREE.LineBasicMaterial
  private lines: THREE.LineSegments
  private grid: THREE.GridHelper
  private axes: THREE.AxesHelper
  private positions = new Float32Array(MAX_HISTORY * MAX_POINTS * 3)
  private colors = new Float32Array(MAX_HISTORY * MAX_POINTS * 3)
  private indices = new Uint16Array(MAX_HISTORY * (MAX_POINTS - 1) * 2)
  private waveHistory = new Float32Array(MAX_HISTORY * MAX_POINTS)
  private spectrumHistory = new Float32Array(MAX_HISTORY * MAX_POINTS)
  private stamps = new Float64Array(MAX_HISTORY)
  private head = -1
  private count = 0
  private historyWrites = 0
  private settings = { ...DEFAULTS }
  private effectiveQuality: 'low' | 'medium' | 'high' = 'high'
  private frame = 0
  private disposed = false
  private contextLost = false
  private intersecting = true
  private lastRender = -Infinity
  private lastRead = -Infinity
  private frameTimes = new Float32Array(180)
  private frameCursor = 0
  private measuredFrames = 0
  private renderDurationTotal = 0
  private actualFps = 0
  private frameWindowStart = 0
  private frameWindowCount = 0
  private slowWindows = 0
  private pcmWindowMs = 0
  private plotHalfWidth = 3
  private axisLabels: AxisLabel[] = []
  private clipLabel: HTMLSpanElement | null = null
  private lastLabelUpdate = -Infinity
  private lastLevel = -Infinity
  private options: SceneOptions
  private failed = false
  private observer: ResizeObserver
  private intersection: IntersectionObserver | null = null
  private onStatus: (status: string) => void
  private onVisibility = () => { if (document.hidden) this.stop(); else this.start() }
  private onLost = (event: Event) => {
    event.preventDefault()
    this.contextLost = true
    this.stop()
    this.onStatus('Контекст GPU потерян. Ожидание восстановления; звук продолжает работать.')
  }
  private onRestored = () => {
    if (this.disposed) return
    this.contextLost = false
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
    this.onStatus('WebGL2 восстановлен')
    this.start()
  }

  constructor(canvas: HTMLCanvasElement, getAnalysis: () => AnalysisNodes | null, onStatus: (status: string) => void = () => {}, options: SceneOptions = {}) {
    this.canvas = canvas
    this.onStatus = onStatus
    this.options = options
    this.provider = new AnalysisDataProvider(getAnalysis)
    // Explicit WebGL2 request prevents a false success on WebGL1-only systems.
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'default' })
    if (!context) throw new Error('WebGL2 недоступен — используйте совместимый режим 2D.')
    this.renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false })
    this.renderer.setClearColor(0x080e15, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x080e15, 9, 22)
    this.perspective = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    this.orthographic = new THREE.OrthographicCamera(-4.5, 4.5, 3, -3, 0.1, 100)
    this.camera = savedCamera?.projection === 'orthographic' ? this.orthographic : this.perspective
    this.settings.projection = savedCamera?.projection ?? 'perspective'
    this.camera.position.set(1.6, 3.6, 7.2)
    if (savedCamera) { this.camera.position.fromArray(savedCamera.position); this.camera.zoom = savedCamera.zoom }
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1
    this.controls.minDistance = 3
    this.controls.maxDistance = 18
    this.controls.minZoom = 0.5
    this.controls.maxZoom = 4
    this.controls.target.set(0, 0, 0)
    if (savedCamera) this.controls.target.fromArray(savedCamera.target)
    this.controls.update()
    this.controls.saveState()
    this.grid = new THREE.GridHelper(6, 12, 0x355265, 0x1b2b39)
    this.grid.position.y = -1.2
    this.scene.add(this.grid)
    this.axes = new THREE.AxesHelper(3)
    this.axes.position.set(-3, -1.2, -1.6)
    this.scene.add(this.axes)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1).setUsage(THREE.DynamicDrawUsage))
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 7)
    this.material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.88 })
    this.lines = new THREE.LineSegments(this.geometry, this.material)
    this.lines.frustumCulled = false
    this.scene.add(this.lines)
    if (options.overlay) {
      for (const axis of ['x', 'y', 'z'] as const) for (const fraction of [0, 0.5, 1]) {
        const node = document.createElement('span')
        node.className = `gpu-tick gpu-tick-${axis}`
        options.overlay.append(node)
        this.axisLabels.push({ node, world: new THREE.Vector3(axis === 'x' ? fraction * 6 - 3 : -3, axis === 'y' ? fraction * 2.4 - 1.2 : -1.2, axis === 'z' ? fraction * 3.2 - 1.6 : -1.6), projected: new THREE.Vector3(), axis, fraction })
      }
      this.clipLabel = document.createElement('span')
      this.clipLabel.className = 'gpu-clipped'
      this.clipLabel.textContent = 'PCM выходит за шкалу ±0.3 · звук не ограничен графиком'
      this.clipLabel.hidden = true
      options.overlay.append(this.clipLabel)
    }
    this.rebuildIndex()
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersection = new IntersectionObserver(entries => {
        this.intersecting = entries[0]?.isIntersecting !== false
        if (this.intersecting) this.start(); else this.stop()
      })
      this.intersection.observe(canvas)
    }
    document.addEventListener('visibilitychange', this.onVisibility)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    Object.defineProperty(canvas, 'gpuDiagnostics', { configurable: true, value: () => this.diagnostics() })
    liveScenes++
    createdScenes++
    this.resize()
    this.start()
  }

  configure(next: Partial<GpuSettings>) {
    const previous = this.settings
    this.settings = { ...previous, ...next }
    this.settings.history = Math.round(clamp(finite(this.settings.history, 64), 8, MAX_HISTORY))
    this.settings.frequency = clamp(finite(this.settings.frequency, 220), 8, 20000)
    this.settings.minFrequency = clamp(finite(this.settings.minFrequency, 20), 20, 10000)
    this.settings.maxFrequency = clamp(finite(this.settings.maxFrequency, 20000), this.settings.minFrequency * 1.1, 24000)
    this.settings.gain = clamp(finite(this.settings.gain, 16), 1, 128)
    this.lastLabelUpdate = -Infinity
    const quality = this.settings.quality === 'auto' ? this.effectiveQuality : this.settings.quality
    if (quality !== this.effectiveQuality) {
      this.effectiveQuality = quality
      this.rebuildIndex()
      this.head = -1
      this.count = 0
      this.resize()
    }
    if (previous.minFrequency !== this.settings.minFrequency || previous.maxFrequency !== this.settings.maxFrequency) {
      this.head = -1
      this.count = 0
    }
    if (previous.projection !== this.settings.projection) this.setProjection(this.settings.projection)
    this.updateGeometry()
    this.render()
  }

  private rebuildIndex() {
    const points = PROFILES[this.effectiveQuality].points
    let index = 0
    for (let row = 0; row < MAX_HISTORY; row++) {
      for (let x = 0; x < points - 1; x++) {
        this.indices[index++] = row * MAX_POINTS + x
        this.indices[index++] = row * MAX_POINTS + x + 1
      }
    }
    if (this.geometry.index) this.geometry.index.needsUpdate = true
    this.geometry.setDrawRange(0, 0)
  }

  private setProjection(projection: GpuSettings['projection']) {
    const previous = this.camera
    this.camera = projection === 'orthographic' ? this.orthographic : this.perspective
    this.camera.position.copy(previous.position)
    this.camera.quaternion.copy(previous.quaternion)
    this.controls.object = this.camera
    this.controls.update()
    this.resize()
  }

  setView(view: GpuView) {
    if (view === 'front') this.camera.position.set(0, 0.1, 9)
    else if (view === 'top') this.camera.position.set(0, 9, 0.01)
    else if (view === 'side') this.camera.position.set(9, 0.1, 0)
    else this.camera.position.set(1.6, 3.6, 7.2)
    this.camera.up.set(0, 1, 0)
    this.controls.target.set(0, 0, 0)
    this.camera.zoom = 1
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.render()
  }

  resetCamera() { this.setView('perspective') }

  private resize() {
    if (this.disposed || this.contextLost) return
    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    this.plotHalfWidth = clamp(width / height * 2, 3, 9)
    this.grid.scale.set(this.plotHalfWidth / 3, 1, 3.2 / 6)
    this.axes.position.x = -this.plotHalfWidth
    this.axes.scale.set(this.plotHalfWidth * 2 / 3, 0.8, 3.2 / 3)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PROFILES[this.effectiveQuality].dpr))
    this.renderer.setSize(width, height, false)
    this.perspective.aspect = width / height
    this.perspective.updateProjectionMatrix()
    this.orthographic.left = -3.5 * width / height
    this.orthographic.right = 3.5 * width / height
    this.orthographic.top = 3.5
    this.orthographic.bottom = -3.5
    this.orthographic.updateProjectionMatrix()
    this.updateGeometry()
    this.render()
  }

  private ingest(stamp: number) {
    const data = this.provider.read(stamp)
    this.updateLevel(stamp)
    if (!data.active || !data.time.length || !data.frequency.length) return
    this.head = (this.head + 1) % MAX_HISTORY
    this.historyWrites++
    this.count = Math.min(MAX_HISTORY, this.count + 1)
    this.stamps[this.head] = stamp
    const points = PROFILES[this.effectiveQuality].points
    const offset = this.head * MAX_POINTS
    // Every row shares the same PCM time window, including when a new MIDI note
    // changes pitch. Older rows must retain the meaning of their X coordinate.
    const sampleCount = Math.max(2, Math.min(data.time.length, Math.round(data.sampleRate * 0.02)))
    let trigger = 0
    for (let i = 1; i < data.time.length - sampleCount; i++) {
      if (data.time[i - 1] <= 0 && data.time[i] > 0) { trigger = i; break }
    }
    this.pcmWindowMs = (sampleCount - 1) / data.sampleRate * 1000
    const minFrequency = this.settings.minFrequency
    const maxFrequency = Math.min(this.settings.maxFrequency, data.sampleRate / 2)
    const logarithmicRange = Math.log(maxFrequency / minFrequency)
    const binWidth = data.sampleRate / (data.frequency.length * 2)
    const rangeFirst = Math.max(1, Math.ceil(minFrequency / binWidth))
    const rangeLast = Math.min(data.frequency.length - 1, Math.floor(maxFrequency / binWidth))
    for (let x = 0; x < points; x++) {
      const sample = data.time[Math.min(data.time.length - 1, trigger + Math.round(x / (points - 1) * (sampleCount - 1)))]
      this.waveHistory[offset + x] = Number.isFinite(sample) ? sample : 0
      const low = minFrequency * Math.exp(x / points * logarithmicRange)
      const high = minFrequency * Math.exp((x + 1) / points * logarithmicRange)
      let first = Math.max(rangeFirst, Math.ceil(low / binWidth))
      let last = Math.min(rangeLast, Math.ceil(high / binWidth) - 1)
      // Narrow log columns can be smaller than one FFT bin. Reuse the nearest
      // measured bin, constrained to the selected full frequency range.
      if (last < first) first = last = clamp(Math.round(Math.sqrt(low * high) / binWidth), rangeFirst, rangeLast)
      let db = -100
      for (let i = first; i <= last; i++) if (Number.isFinite(data.frequency[i])) db = Math.max(db, data.frequency[i])
      this.spectrumHistory[offset + x] = clamp(db, -100, 0)
    }
    this.updateGeometry()
  }

  private updateLevel(stamp: number) {
    if (this.options.onLevel && stamp - this.lastLevel >= 100) {
      this.lastLevel = stamp
      this.options.onLevel(this.provider.active ? this.provider.rms : null)
    }
  }

  private updateGeometry() {
    const profile = PROFILES[this.effectiveQuality]
    const rows = Math.min(this.count, this.settings.history, profile.history)
    const newestStamp = this.head >= 0 ? this.stamps[this.head] : 0
    const oldestSlot = (this.head - Math.max(0, rows - 1) + MAX_HISTORY) % MAX_HISTORY
    const span = Math.max(1, newestStamp - this.stamps[oldestSlot])
    const spectrum = this.settings.mode === 'spectrum'
    for (let row = 0; row < rows; row++) {
      const slot = (this.head - row + MAX_HISTORY) % MAX_HISTORY
      const age = (newestStamp - this.stamps[slot]) / span
      const brightness = 1 - age * 0.72
      for (let x = 0; x < profile.points; x++) {
        const value = (spectrum ? this.spectrumHistory : this.waveHistory)[slot * MAX_POINTS + x]
        const at = (row * MAX_POINTS + x) * 3
        const intensity = spectrum ? (value + 100) / 100 : Math.min(1, Math.abs(value) * 4)
        this.positions[at] = (x / (profile.points - 1) * 2 - 1) * this.plotHalfWidth
        // Fixed waveform gain is a display scale only; values remain actual PCM in the ring.
        this.positions[at + 1] = spectrum ? intensity * 2.4 - 1.2 : clamp(value * this.settings.gain, -1.2, 1.2)
        this.positions[at + 2] = age * 3.2 - 1.6
        if (this.settings.palette === 'heat') {
          this.colors[at] = (0.2 + intensity * 0.8) * brightness
          this.colors[at + 1] = (0.45 + intensity * 0.3) * brightness
          this.colors[at + 2] = (0.8 - intensity * 0.55) * brightness
        } else {
          this.colors[at] = (0.24 + intensity * 0.2) * brightness
          this.colors[at + 1] = (0.65 + intensity * 0.25) * brightness
          this.colors[at + 2] = 0.94 * brightness
        }
      }
    }
    this.geometry.setDrawRange(0, rows * (profile.points - 1) * 2)
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
  }

  private render() {
    if (this.disposed || this.contextLost || this.failed || document.hidden || !this.intersecting) return
    try {
      this.renderer.render(this.scene, this.camera)
      this.updateAxisLabels()
    } catch (reason) {
      this.failed = true
      this.stop()
      const message = `Ошибка GPU. Доступен совместимый режим 2D. ${reason instanceof Error ? reason.message : ''}`
      this.onStatus(message)
      this.options.onFailure?.(message)
    }
  }

  private updateAxisLabels() {
    if (!this.axisLabels.length) return
    const updateText = performance.now() - this.lastLabelUpdate >= 500
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    const rows = Math.min(this.count, this.settings.history, PROFILES[this.effectiveQuality].history)
    const oldest = (this.head - Math.max(0, rows - 1) + MAX_HISTORY) % MAX_HISTORY
    const historySeconds = rows && this.head >= 0 ? (this.stamps[this.head] - this.stamps[oldest]) / 1000 : 0
    for (const label of this.axisLabels) {
      label.world.x = label.axis === 'x' ? (label.fraction * 2 - 1) * this.plotHalfWidth : -this.plotHalfWidth
      label.projected.copy(label.world).project(this.camera)
      const x = (label.projected.x + 1) * width / 2
      const y = (1 - label.projected.y) * height / 2
      label.node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
      const sharedOrigin = label.fraction === 0 && label.axis !== 'x'
      label.node.hidden = sharedOrigin || (label.axis === 'z' && rows < 2) || (label.axis === 'x' && this.settings.mode === 'waveform' && this.pcmWindowMs === 0) || label.projected.z < -1 || label.projected.z > 1 || x < 5 || x > width - 12 || y < 5 || y > height - 30
      if (updateText) {
        if (label.axis === 'x') {
          const hz = this.settings.minFrequency * (Math.min(this.settings.maxFrequency, this.provider.sampleRate / 2) / this.settings.minFrequency) ** label.fraction
          label.node.textContent = this.settings.mode === 'spectrum' ? `${hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : Math.round(hz)} Hz` : `${(this.pcmWindowMs * label.fraction).toFixed(1)} ms`
        } else if (label.axis === 'y') label.node.textContent = this.settings.mode === 'spectrum' ? `${Math.round(label.fraction * 100 - 100)} dBFS` : `${Number(((label.fraction * 2 - 1) * 1.2 / this.settings.gain).toFixed(4))} AMP`
        else label.node.textContent = `${(historySeconds * label.fraction).toFixed(1)} s ago`
      }
    }
    if (updateText) {
      this.lastLabelUpdate = performance.now()
      let clipped = false
      const limit = 1.2 / this.settings.gain
      if (this.head >= 0 && this.settings.mode === 'waveform') for (let i = 0; i < PROFILES[this.effectiveQuality].points; i++) if (Math.abs(this.waveHistory[this.head * MAX_POINTS + i]) > limit) { clipped = true; break }
      if (this.clipLabel) { this.clipLabel.hidden = !clipped; this.clipLabel.textContent = `PCM выходит за шкалу ±${Number(limit.toFixed(4))} · уменьшите SCALE` }
    }
  }

  private animate = (stamp: number) => {
    this.frame = 0
    if (this.disposed || this.contextLost || this.failed || document.hidden || !this.intersecting) return
    const profile = PROFILES[this.effectiveQuality]
    // Half-millisecond tolerance avoids accidentally dividing a 60Hz RAF cadence in half.
    if (stamp - this.lastRender >= 1000 / profile.fps - 0.5) {
      const begin = performance.now()
      if (!this.settings.frozen && stamp - this.lastRead >= 1000 / profile.reads - 0.5) {
        this.ingest(stamp)
        const period = 1000 / profile.reads
        this.lastRead = Number.isFinite(this.lastRead) ? this.lastRead + Math.max(1, Math.floor((stamp - this.lastRead + 0.5) / period)) * period : stamp
      } else if (this.settings.frozen && this.options.onLevel && stamp - this.lastLevel >= 100) {
        // Freeze holds the graphic ring; the optional shared output meter stays live.
        this.provider.read(stamp)
        this.updateLevel(stamp)
      }
      this.controls.update()
      this.render()
      const duration = performance.now() - begin
      this.frameTimes[this.frameCursor++ % this.frameTimes.length] = duration
      this.measuredFrames++
      this.renderDurationTotal += duration
      this.frameWindowCount++
      if (!this.frameWindowStart) this.frameWindowStart = stamp
      if (stamp - this.frameWindowStart >= 2000) {
        this.actualFps = this.frameWindowCount * 1000 / (stamp - this.frameWindowStart)
        if (this.settings.quality === 'auto' && this.actualFps < profile.fps * 0.7) this.slowWindows++; else this.slowWindows = 0
        if (this.slowWindows >= 2 && this.effectiveQuality !== 'low') {
          this.effectiveQuality = this.effectiveQuality === 'high' ? 'medium' : 'low'
          this.rebuildIndex()
          this.count = 0
          this.head = -1
          this.resize()
          this.slowWindows = 0
          this.onStatus(`Auto: качество ${this.effectiveQuality} — приоритет звуку`)
        }
        this.frameWindowCount = 0
        this.frameWindowStart = stamp
      }
      const period = 1000 / profile.fps
      this.lastRender = Number.isFinite(this.lastRender) ? this.lastRender + Math.max(1, Math.floor((stamp - this.lastRender + 0.5) / period)) * period : stamp
    }
    this.frame = requestAnimationFrame(this.animate)
  }

  private start() {
    if (!this.frame && !this.disposed && !this.contextLost && !this.failed && !document.hidden && this.intersecting) {
      this.lastRender = -Infinity
      this.lastRead = -Infinity
      this.frameWindowStart = 0
      this.frameWindowCount = 0
      this.frame = requestAnimationFrame(this.animate)
    }
  }

  private stop() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0 }

  diagnostics() {
    const samples = Array.from(this.frameTimes.subarray(0, Math.min(this.measuredFrames, this.frameTimes.length))).sort((a, b) => a - b)
    const rows = Math.min(this.count, this.settings.history, PROFILES[this.effectiveQuality].history)
    const oldest = (this.head - Math.max(0, rows - 1) + MAX_HISTORY) % MAX_HISTORY
    const context = this.renderer.getContext()
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    let newestWavePeak = 0
    let newestSpectrumPeak = -100
    if (this.head >= 0) for (let i = 0; i < PROFILES[this.effectiveQuality].points; i++) {
      newestWavePeak = Math.max(newestWavePeak, Math.abs(this.waveHistory[this.head * MAX_POINTS + i]))
      newestSpectrumPeak = Math.max(newestSpectrumPeak, this.spectrumHistory[this.head * MAX_POINTS + i])
    }
    return Object.freeze({
      webgl2: context instanceof WebGL2RenderingContext, mode: this.settings.mode, frozen: this.settings.frozen,
      contextLost: this.contextLost, disposed: this.disposed, failed: this.failed, running: Boolean(this.frame),
      capacity: MAX_HISTORY, ringCount: this.count, historyWrites: this.historyWrites, visibleHistory: rows, pointCount: PROFILES[this.effectiveQuality].points,
      historySeconds: rows && this.head >= 0 ? (this.stamps[this.head] - this.stamps[oldest]) / 1000 : 0,
      analysisReads: this.provider.reads, analysisActive: this.provider.active, rms: this.provider.rms, peakFrequency: this.provider.peakFrequency, peakDb: this.provider.peakDb,
      fft220: this.provider.spectrumAt(220), fft440: this.provider.spectrumAt(440), fft660: this.provider.spectrumAt(660),
      newestWavePeak, newestSpectrumPeak, waveDisplayClipped: newestWavePeak > 1.2 / this.settings.gain, displayGain: this.settings.gain, plotWidth: this.plotHalfWidth * 2,
      firstSpectrumDb: this.head >= 0 ? this.spectrumHistory[this.head * MAX_POINTS] : -100,
      lastSpectrumDb: this.head >= 0 ? this.spectrumHistory[this.head * MAX_POINTS + PROFILES[this.effectiveQuality].points - 1] : -100,
      pcmWindowMs: this.pcmWindowMs, dpr: this.renderer.getPixelRatio(), quality: this.settings.quality, effectiveQuality: this.effectiveQuality,
      fps: this.actualFps, renderedFrames: this.measuredFrames,
      meanFrameMs: this.measuredFrames ? this.renderDurationTotal / this.measuredFrames : 0,
      p95FrameMs: samples.length ? samples[Math.floor((samples.length - 1) * 0.95)] : 0,
      drawCalls: this.renderer.info.render.calls, geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures,
      triangles: this.renderer.info.render.triangles, positionBytes: this.positions.byteLength, indexBytes: this.indices.byteLength, historyBytes: this.waveHistory.byteLength + this.spectrumHistory.byteLength + this.stamps.byteLength,
      renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : context.getParameter(context.RENDERER) as string,
      cameraPosition: this.camera.position.toArray(), projection: this.settings.projection,
      liveScenes, createdScenes, disposedScenes,
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    savedCamera = { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom, projection: this.settings.projection }
    this.stop()
    this.observer.disconnect()
    this.intersection?.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.controls.dispose()
    this.options.onLevel?.(null)
    for (const label of this.axisLabels) label.node.remove()
    this.axisLabels.length = 0
    this.clipLabel?.remove()
    this.geometry.dispose()
    this.material.dispose()
    this.grid.geometry.dispose()
    const gridMaterials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]
    for (const material of gridMaterials) material.dispose()
    this.axes.geometry.dispose()
    const axesMaterials = Array.isArray(this.axes.material) ? this.axes.material : [this.axes.material]
    for (const material of axesMaterials) material.dispose()
    this.scene.clear()
    this.renderer.renderLists.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    liveScenes--
    disposedScenes++
  }
}
