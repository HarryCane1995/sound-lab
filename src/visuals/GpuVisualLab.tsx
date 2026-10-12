import { useEffect, useRef, useState } from 'react'
import type { AnalysisNodes, Waveform } from '../types'
import { SignalVisualizers } from './SignalVisualizers'
import { GpuScene, type GpuQuality, type GpuSettings, type GpuView } from './gpu/GpuScene'
import './gpu-visual-lab.css'

export interface GpuVisualLabProps {
  getAnalysis: () => AnalysisNodes | null
  frequency: number
  playing: boolean
  waveform: Waveform
  cutoff: number
  filterBypassed: boolean
  onLevel?: (rms: number | null) => void
}

type DisplayMode = 'waveform' | 'spectrum' | '2d'
const SETTINGS_KEY = 'sound-lab.gpu-visual.v1'
function initialSettings() {
  const defaults = { mode: 'waveform' as DisplayMode, quality: 'auto' as GpuQuality, history: 64, palette: 'cool' as 'cool' | 'heat', projection: 'perspective' as 'perspective' | 'orthographic', range: 'full', gain: 16 }
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!value || typeof value !== 'object') return defaults
    return {
      mode: ['waveform', 'spectrum', '2d'].includes(value.mode) ? value.mode as DisplayMode : defaults.mode,
      quality: ['auto', 'low', 'medium', 'high'].includes(value.quality) ? value.quality as GpuQuality : defaults.quality,
      history: [16, 32, 64, 96].includes(value.history) ? value.history as number : defaults.history,
      palette: value.palette === 'heat' ? 'heat' as const : 'cool' as const,
      projection: value.projection === 'orthographic' ? 'orthographic' as const : 'perspective' as const,
      range: ['full', 'bass', 'mid'].includes(value.range) ? value.range as string : defaults.range,
      gain: [4, 16, 64].includes(value.gain) ? value.gain as number : defaults.gain,
    }
  } catch { return defaults }
}

export function GpuVisualLab(props: GpuVisualLabProps) {
  const [settings, setSettings] = useState(initialSettings)
  const [frozen, setFrozen] = useState(false)
  const [status, setStatus] = useState('Реальный выход · WebGL2')
  const [unavailable, setUnavailable] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const scene = useRef<GpuScene | null>(null)
  const latest = useRef(props)
  latest.current = props
  const compatible = settings.mode === '2d' || unavailable
  const currentSettings = useRef<GpuSettings>({ mode: 'waveform', quality: settings.quality, history: settings.history, frozen, frequency: props.frequency, minFrequency: 20, maxFrequency: 20000, palette: settings.palette, projection: settings.projection, gain: settings.gain })
  currentSettings.current = {
    mode: settings.mode === 'spectrum' ? 'spectrum' : 'waveform', quality: settings.quality,
    history: settings.history, frozen, frequency: props.frequency, palette: settings.palette,
    projection: settings.projection, minFrequency: settings.range === 'mid' ? 100 : 20,
    maxFrequency: settings.range === 'bass' ? 2000 : settings.range === 'mid' ? 8000 : 20000,
    gain: settings.gain,
  }

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* Visual preferences never block the instrument. */ }
  }, [settings])

  useEffect(() => {
    if (compatible || !canvasHost.current) { latest.current.onLevel?.(null); return }
    // StrictMode deliberately mounts/cleans up/mounts effects. Each GPU lifetime
    // owns a fresh native canvas, so a released WebGL context is never reused.
    const element = document.createElement('canvas')
    element.className = 'gpu-canvas'
    element.setAttribute('role', 'img')
    element.setAttribute('aria-label', currentSettings.current.mode === 'spectrum' ? 'Трёхмерная история измеренного FFT-спектра: частота по X, уровень dBFS по Y, история по Z.' : 'Трёхмерная история реального PCM: время по X, амплитуда по Y, история по Z.')
    canvasHost.current.append(element)
    canvas.current = element
    try {
      const instance = new GpuScene(element, () => latest.current.getAnalysis(), setStatus, { overlay: overlay.current ?? undefined, onFailure: message => { setStatus(message); setUnavailable(true) }, onLevel: props.onLevel ? value => latest.current.onLevel?.(value) : undefined })
      scene.current = instance
      instance.configure(currentSettings.current)
      setStatus('Реальный выход · WebGL2')
      return () => { instance.dispose(); element.remove(); if (scene.current === instance) scene.current = null; if (canvas.current === element) canvas.current = null }
    } catch (reason) {
      element.remove()
      canvas.current = null
      setStatus(reason instanceof Error ? reason.message : 'GPU недоступен — включён совместимый режим 2D.')
      setUnavailable(true)
    }
  }, [compatible])

  useEffect(() => {
    scene.current?.configure(currentSettings.current)
    canvas.current?.setAttribute('aria-label', settings.mode === 'spectrum' ? 'Трёхмерная история измеренного FFT-спектра: частота по X, уровень dBFS по Y, история по Z.' : 'Трёхмерная история реального PCM: время по X, амплитуда по Y, история по Z.')
  }, [settings, frozen, props.frequency])

  const chooseMode = (mode: DisplayMode) => { setSettings(value => ({ ...value, mode })); if (mode !== '2d') setUnavailable(false) }
  const camera = (view: GpuView) => scene.current?.setView(view)
  const spectrum = settings.mode === 'spectrum'

  return (
    <section className="gpu-visual-lab panel" aria-label="GPU Visual Lab">
      <div className="gpu-toolbar">
        <div className="gpu-mode-controls" role="group" aria-label="Вид визуализации">
          <button type="button" className={!compatible && !spectrum ? 'active' : ''} aria-pressed={!compatible && !spectrum} onClick={() => chooseMode('waveform')}>Waveform 3D</button>
          <button type="button" className={!compatible && spectrum ? 'active' : ''} aria-pressed={!compatible && spectrum} onClick={() => chooseMode('spectrum')}>Spectral Landscape</button>
          <button type="button" className={compatible ? 'active' : ''} aria-pressed={compatible} onClick={() => chooseMode('2d')}>2D</button>
        </div>
        {!compatible && <div className="gpu-camera-controls" role="group" aria-label="Камера визуализации">
          <button type="button" aria-pressed={frozen} className={frozen ? 'active' : ''} onClick={() => setFrozen(value => !value)}>{frozen ? 'Resume' : 'Freeze'}</button>
          <button type="button" onClick={() => scene.current?.resetCamera()} onDoubleClick={() => scene.current?.resetCamera()} title="Вернуть исходный ракурс">Reset Camera</button>
          <select aria-label="Ракурс камеры" defaultValue="perspective" onChange={event => camera(event.target.value as GpuView)}>
            <option value="perspective">Perspective</option><option value="front">Front</option><option value="top">Top</option><option value="side">Side</option>
          </select>
        </div>}
      </div>
      {compatible ? <div className="gpu-compatible"><SignalVisualizers {...props} /></div> : <>
        <div className="gpu-canvas-wrap">
          <div ref={canvasHost} className="gpu-canvas-host" />
          <div ref={overlay} className="gpu-measurement-overlay" aria-hidden="true" />
          <div className="gpu-axis-labels" aria-hidden="true">
            <span>X · {spectrum ? 'Hz · log' : 'ms · окно PCM'}</span>
            <span>Y · {spectrum ? '−100…0 dBFS' : `AMP · ×${settings.gain} · ±${Number((1.2 / settings.gain).toFixed(4))}`}</span>
            <span>Z · история измерений</span>
          </div>
          <span className={`gpu-live-tag ${frozen ? 'frozen' : ''}`}>{frozen ? 'FROZEN · звук работает' : props.playing ? 'LIVE · все голоса' : 'OUTPUT · все голоса'}</span>
        </div>
        <div className="gpu-options">
          <label>QUALITY <select aria-label="Качество GPU" value={settings.quality} onChange={event => setSettings(value => ({ ...value, quality: event.target.value as GpuQuality }))}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label>HISTORY <select aria-label="Глубина истории" value={settings.history} onChange={event => setSettings(value => ({ ...value, history: Number(event.target.value) }))}><option value={16}>16</option><option value={32}>32</option><option value={64}>64</option><option value={96}>96</option></select></label>
          {!spectrum && <label>SCALE <select aria-label="Масштаб волны GPU" title="Только график; громкость звука не меняется" value={settings.gain} onChange={event => setSettings(value => ({ ...value, gain: Number(event.target.value) }))}><option value={4}>×4</option><option value={16}>×16</option><option value={64}>×64</option></select></label>}
          <label>COLOR <select aria-label="Цвет амплитуды" value={settings.palette} onChange={event => setSettings(value => ({ ...value, palette: event.target.value as 'cool' | 'heat' }))}><option value="cool">Cool</option><option value="heat">Heat</option></select></label>
          {spectrum && <label>RANGE <select aria-label="Частотный диапазон" value={settings.range} onChange={event => setSettings(value => ({ ...value, range: event.target.value }))}><option value="full">20–20k Hz</option><option value="bass">20–2k Hz</option><option value="mid">100–8k Hz</option></select></label>}
          <label>CAM <select aria-label="Проекция камеры" value={settings.projection} onChange={event => setSettings(value => ({ ...value, projection: event.target.value as GpuSettings['projection'] }))}><option value="perspective">Perspective</option><option value="orthographic">Ortho</option></select></label>
        </div>
      </>}
      <div className="gpu-footer"><span role="status">{status}</span><span title="ЛКМ: вращение · колесо: масштаб · ПКМ: сдвиг">{compatible ? 'Совместимый Canvas 2D' : spectrum ? 'FFT после фильтра и ADSR · математический график, не акустика помещения' : 'PCM после фильтра и ADSR · ЛКМ: вращать / колесо: масштаб / ПКМ: сдвиг'}</span></div>
    </section>
  )
}
