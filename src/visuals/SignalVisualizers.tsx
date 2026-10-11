import { useEffect, useRef, useState } from 'react'
import { Hint } from '../components/Controls'
import type { AnalysisNodes, Waveform } from '../types'

interface SignalVisualizersProps {
  getAnalysis: () => AnalysisNodes | null
  frequency: number
  playing: boolean
  waveform: Waveform
  cutoff: number
  filterBypassed: boolean
}

const COLORS = {
  grid: 'rgba(132, 160, 181, 0.12)',
  axis: 'rgba(132, 160, 181, 0.26)',
  text: '#8b9eae',
  signal: '#65d8ed',
  amber: '#f8c06b',
}

const frequencyLabel = (value: number) =>
  value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(Math.round(value))

function sizeCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const context = canvas.getContext('2d')
  if (!context) return null
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  context.font = '10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  context.lineWidth = 1
  return { context, width, height }
}

function drawScope(canvas: HTMLCanvasElement, samples: Float32Array | null, sampleRate: number, frequency: number, amplitudeLimit: number) {
  const dimensions = sizeCanvas(canvas)
  if (!dimensions) return
  const { context: ctx, width, height } = dimensions
  if (width < 70 || height < 70) return
  const left = 46
  const right = width - 16
  const top = 18
  const bottom = height - 35
  const plotWidth = right - left
  const plotHeight = bottom - top
  const safeFrequency = Math.max(1, frequency)
  const desiredSamples = Math.max(2, Math.round((sampleRate / safeFrequency) * 3))
  const sampleCount = samples ? Math.min(desiredSamples, Math.max(2, Math.floor(samples.length * 0.85))) : desiredSamples
  const durationMs = ((sampleCount - 1) / sampleRate) * 1000

  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let row = 0; row <= 4; row += 1) {
    const y = top + (row / 4) * plotHeight
    const amplitude = (1 - row / 2) * amplitudeLimit
    ctx.strokeStyle = row === 2 ? COLORS.axis : COLORS.grid
    ctx.beginPath()
    ctx.moveTo(left, y + 0.5)
    ctx.lineTo(right, y + 0.5)
    ctx.stroke()
    ctx.fillStyle = COLORS.text
    ctx.fillText(String(Number(amplitude.toFixed(3))), left - 8, y)
  }
  const columns = width < 400 ? 3 : 4
  for (let column = 0; column <= columns; column += 1) {
    const x = left + (column / columns) * plotWidth
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(x + 0.5, top)
    ctx.lineTo(x + 0.5, bottom)
    ctx.stroke()
    ctx.fillStyle = COLORS.text
    ctx.textAlign = column === 0 ? 'left' : column === columns ? 'right' : 'center'
    ctx.textBaseline = 'top'
    const time = (column / columns) * durationMs
    ctx.fillText(time.toFixed(durationMs < 10 ? 2 : 1), x, bottom + 8)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.text
  ctx.fillText('AMP', 2, 2)
  ctx.textAlign = 'right'
  ctx.fillText('ms', right, height - 11)

  // Trigger the actual waveform on a rising zero crossing. No synthetic trace is used.
  let start = 0
  if (samples) {
    const searchLimit = samples.length - sampleCount
    for (let index = 1; index < searchLimit; index += 1) {
      if (samples[index - 1] <= 0 && samples[index] > 0) {
        start = index
        break
      }
    }
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, plotWidth, plotHeight)
  ctx.clip()
  ctx.strokeStyle = COLORS.signal
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.beginPath()
  let clipped = false
  if (samples) {
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = Number.isFinite(samples[start + index]) ? samples[start + index] : 0
      const x = left + (index / (sampleCount - 1)) * plotWidth
      if (Math.abs(sample) > amplitudeLimit + 0.00001) clipped = true
      const y = top + ((1 - sample / amplitudeLimit) / 2) * plotHeight
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  } else {
    ctx.moveTo(left, top + plotHeight / 2)
    ctx.lineTo(right, top + plotHeight / 2)
  }
  ctx.stroke()
  ctx.restore()
  if (clipped) {
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(16,21,29,0.9)'
    ctx.fillRect(Math.max(left, right - 115), top + 4, Math.min(plotWidth, 115), 16)
    ctx.fillStyle = COLORS.amber
    ctx.fillText('Выход за шкалу', right - 5, top + 7)
  }
}

function drawSpectrum(
  canvas: HTMLCanvasElement,
  bins: Float32Array | null,
  sampleRate: number,
  cutoff: number,
  filterBypassed: boolean,
) {
  const dimensions = sizeCanvas(canvas)
  if (!dimensions) return
  const { context: ctx, width, height } = dimensions
  if (width < 70 || height < 70) return
  const left = 37
  const right = width - 16
  const top = 18
  const bottom = height - 35
  const plotWidth = right - left
  const plotHeight = bottom - top
  const minFrequency = 20
  const maxFrequency = Math.min(20000, sampleRate / 2)
  const logRange = Math.log(maxFrequency / minFrequency)
  const frequencyToX = (value: number) => left + (Math.log(value / minFrequency) / logRange) * plotWidth
  const dbToY = (value: number) => top + ((0 - Math.max(-100, Math.min(0, value))) / 100) * plotHeight

  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let db = 0; db >= -100; db -= 20) {
    const y = dbToY(db)
    ctx.strokeStyle = db === 0 ? COLORS.axis : COLORS.grid
    ctx.beginPath()
    ctx.moveTo(left, y + 0.5)
    ctx.lineTo(right, y + 0.5)
    ctx.stroke()
    ctx.fillStyle = COLORS.text
    ctx.fillText(String(db), left - 8, y)
  }
  const ticks = width < 430 ? [20, 100, 1000, 10000, 20000] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  for (const tick of ticks) {
    if (tick > maxFrequency) continue
    const x = frequencyToX(tick)
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(x + 0.5, top)
    ctx.lineTo(x + 0.5, bottom)
    ctx.stroke()
    ctx.fillStyle = COLORS.text
    ctx.textAlign = tick === minFrequency ? 'left' : tick === maxFrequency ? 'right' : 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(frequencyLabel(tick), x, bottom + 8)
  }
  ctx.fillStyle = COLORS.text
  ctx.textAlign = 'left'
  ctx.fillText('dBFS', 2, 2)
  ctx.textAlign = 'right'
  ctx.fillText('Hz · log', right, height - 11)

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, plotWidth, plotHeight)
  ctx.clip()
  const trace = new Path2D()
  const resolution = Math.max(1, Math.floor(plotWidth))
  const binWidth = bins ? sampleRate / (bins.length * 2) : 1
  for (let pixel = 0; pixel <= resolution; pixel += 1) {
    const lowFrequency = minFrequency * Math.exp((pixel / resolution) * logRange)
    const highFrequency = minFrequency * Math.exp(((pixel + 1) / resolution) * logRange)
    let db = -Infinity
    if (bins) {
      const firstBin = Math.max(1, Math.min(bins.length - 1, Math.floor(lowFrequency / binWidth)))
      const lastBin = Math.max(firstBin, Math.min(bins.length - 1, Math.ceil(highFrequency / binWidth)))
      for (let index = firstBin; index <= lastBin; index += 1) {
        if (Number.isFinite(bins[index])) db = Math.max(db, bins[index])
      }
    }
    const x = left + (pixel / resolution) * plotWidth
    const y = dbToY(db)
    if (pixel === 0) trace.moveTo(x, y)
    else trace.lineTo(x, y)
  }
  if (bins) {
    const area = new Path2D(trace)
    area.lineTo(right, bottom)
    area.lineTo(left, bottom)
    area.closePath()
    const fill = ctx.createLinearGradient(0, top, 0, bottom)
    fill.addColorStop(0, 'rgba(101, 216, 237, 0.22)')
    fill.addColorStop(1, 'rgba(101, 216, 237, 0.015)')
    ctx.fillStyle = fill
    ctx.fill(area)
  }
  ctx.strokeStyle = COLORS.signal
  ctx.lineWidth = 1.5
  ctx.stroke(trace)
  if (!filterBypassed && cutoff >= minFrequency && cutoff <= maxFrequency) {
    const cutoffX = frequencyToX(cutoff)
    ctx.strokeStyle = COLORS.amber
    ctx.lineWidth = 1
    ctx.setLineDash([4, 5])
    ctx.beginPath()
    ctx.moveTo(cutoffX, top)
    ctx.lineTo(cutoffX, bottom)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = COLORS.amber
    ctx.textAlign = cutoffX > right - 70 ? 'right' : 'left'
    ctx.fillText('CUTOFF', cutoffX > right - 70 ? cutoffX - 5 : cutoffX + 5, top + 6)
  }
  ctx.restore()
}

export function SignalVisualizers(props: SignalVisualizersProps) {
  const [amplitudeLimit, setAmplitudeLimit] = useState(0.25)
  const scopeRef = useRef<HTMLCanvasElement>(null)
  const spectrumRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef<HTMLSpanElement>(null)
  const current = useRef({ ...props, amplitudeLimit })
  current.current = { ...props, amplitudeLimit }

  useEffect(() => {
    const scope = scopeRef.current
    const spectrum = spectrumRef.current
    if (!scope || !spectrum) return
    let frame = 0
    let lastPaint = -Infinity
    let timeData: Float32Array<ArrayBuffer> | null = null
    let frequencyData: Float32Array<ArrayBuffer> | null = null
    let observedAnalysis: AnalysisNodes | null = null
    let disposed = false

    const paint = () => {
      if (disposed) return
      const settings = current.current
      const analysis = settings.getAnalysis()
      if (
        analysis?.time !== observedAnalysis?.time ||
        analysis?.frequency !== observedAnalysis?.frequency ||
        (analysis && (timeData?.length !== analysis.time.fftSize || frequencyData?.length !== analysis.frequency.frequencyBinCount))
      ) {
        observedAnalysis = analysis
        timeData = analysis ? new Float32Array(analysis.time.fftSize) : null
        frequencyData = analysis ? new Float32Array(analysis.frequency.frequencyBinCount) : null
      }
      const hasSignal = Boolean(settings.playing && analysis && timeData && frequencyData)
      if (hasSignal && analysis && timeData && frequencyData) {
        analysis.time.getFloatTimeDomainData(timeData)
        analysis.frequency.getFloatFrequencyData(frequencyData)
      }
      const sampleRate = analysis?.sampleRate || 48000
      drawScope(scope, hasSignal ? timeData : null, sampleRate, settings.frequency, settings.amplitudeLimit)
      drawSpectrum(spectrum, hasSignal ? frequencyData : null, sampleRate, settings.cutoff, settings.filterBypassed)
      if (statusRef.current) statusRef.current.textContent = hasSignal ? 'Реальный сигнал · 30 fps' : 'Тишина · −∞ dBFS'
    }
    const animate = (time: number) => {
      if (!document.hidden && time - lastPaint >= 1000 / 30) {
        paint()
        lastPaint = time
      }
      frame = window.requestAnimationFrame(animate)
    }
    const observer = new ResizeObserver(() => {
      if (!document.hidden) paint()
    })
    observer.observe(scope)
    observer.observe(spectrum)
    const onVisibility = () => {
      if (!document.hidden) {
        lastPaint = -Infinity
        paint()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    paint()
    frame = window.requestAnimationFrame(animate)
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div className="signal-visualizers">
      <section className="visual-panel panel" aria-labelledby="scope-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">TIME DOMAIN</p>
            <h2 id="scope-title">Осциллограмма <Hint text="Общий сигнал всех голосов во времени (Time Domain). По горизонтали — миллисекунды, по вертикали — нормированная амплитуда AMP. Шкала увеличивает только график. LIVE означает измерение текущего сигнала." /></h2>
          </div>
          <div className="visual-tools">
            <select className="scope-scale" aria-label="Шкала амплитуды" title="Фиксированная шкала амплитуды: увеличивает график, не меняя звук. При выходе сигнала за шкалу выберите ×1." value={amplitudeLimit} onChange={event => setAmplitudeLimit(Number(event.target.value))}>
              <option value={1}>×1 · ±1</option>
              <option value={0.25}>×4 · ±0.25</option>
              <option value={0.1}>×10 · ±0.1</option>
            </select>
            <span className={`tag ${props.playing ? 'tag-live' : ''}`}>{props.playing ? 'LIVE' : 'Пауза'}</span>
          </div>
        </div>
        <canvas className="scope-canvas" ref={scopeRef} role="img" aria-label={`Осциллограмма реального выходного сигнала. По горизонтали время в миллисекундах, по вертикали амплитуда от −${amplitudeLimit} до ${amplitudeLimit}.`} />
        <div className="visual-caption">
          <span>Реальный выход · все голоса / ADSR / фильтр</span>
          <span ref={statusRef}>Тишина · −∞ dBFS</span>
        </div>
      </section>
      <section className="visual-panel panel" aria-labelledby="spectrum-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">FREQUENCY DOMAIN</p>
            <h2 id="spectrum-title">Частотный спектр <Hint text="Частотный состав общего сигнала всех голосов (Frequency Domain). FFT раскладывает сигнал на частоты, log означает логарифмическую шкалу. dBFS — децибелы относительно цифрового максимума: 0 dBFS — максимум, отрицательные значения — тише. Частота в Hz." /></h2>
          </div>
          <span className="tag">FFT · log</span>
        </div>
        <canvas className="spectrum-canvas" ref={spectrumRef} role="img" aria-label="Измеренный спектр реального выходного сигнала. Частота от 20 герц до 20 килогерц на логарифмической оси, уровень от −100 до 0 dBFS." />
        <div className="visual-caption">
          <span>Частота, Hz · уровень, dBFS</span>
          <span>{props.filterBypassed ? 'Фильтр обойдён' : `Cutoff ${frequencyLabel(props.cutoff)} Hz`}</span>
        </div>
      </section>
    </div>
  )
}
