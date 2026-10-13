import { useId, useMemo } from 'react'
import type { RenderedKick } from './audio/KickRenderer'

interface KickWaveformProps {
  render: RenderedKick | null
  compact?: boolean
  label?: string
}

/** Fixed full-scale axes; both the peak profile and RMS envelope use final PCM. */
export function KickWaveform({ render, compact = false, label = 'Осциллограмма Kick' }: KickWaveformProps) {
  const id = useId()
  const graph = useMemo(() => {
    if (!render?.pcm.length) return null
    const pcm = render.pcm
    const bins = Math.min(pcm.length, compact ? 128 : 640)
    const left = compact ? 0 : 48, right = compact ? 800 : 784
    const top = compact ? 2 : 20, bottom = compact ? 78 : 208
    const center = (top + bottom) / 2, scale = (bottom - top) / 2
    const peaks: string[] = [], trace: string[] = [], upper: string[] = [], lower: string[] = []
    const powerPrefix = new Float64Array(compact ? 0 : pcm.length + 1)
    if (!compact) for (let index = 0; index < pcm.length; index++) powerPrefix[index + 1] = powerPrefix[index] + pcm[index] * pcm[index]
    const envelopeHalfWindow = Math.max(1, Math.round(render.sampleRate * 0.01))
    for (let bucket = 0; bucket < bins; bucket++) {
      const from = Math.floor(bucket * pcm.length / bins)
      const to = Math.max(from + 1, Math.floor((bucket + 1) * pcm.length / bins))
      let min = 1, max = -1, power = 0
      for (let index = from; index < to; index++) {
        const value = Number.isFinite(pcm[index]) ? pcm[index] : 0
        min = Math.min(min, value); max = Math.max(max, value); power += value * value
      }
      const x = left + bucket / Math.max(1, bins - 1) * (right - left)
      const middle = Math.floor((from + to) / 2)
      const envelopeFrom = Math.max(0, middle - envelopeHalfWindow), envelopeTo = Math.min(pcm.length, middle + envelopeHalfWindow)
      const rms = compact ? Math.sqrt(power / (to - from)) : Math.sqrt((powerPrefix[envelopeTo] - powerPrefix[envelopeFrom]) / Math.max(1, envelopeTo - envelopeFrom))
      peaks.push(`M${x.toFixed(2)} ${(center - max * scale).toFixed(2)}V${(center - min * scale).toFixed(2)}`)
      trace.push(`${bucket ? 'L' : 'M'}${x.toFixed(2)} ${(center - pcm[Math.min(pcm.length - 1, middle)] * scale).toFixed(2)}`)
      upper.push(`${bucket ? 'L' : 'M'}${x.toFixed(2)} ${(center - rms * scale).toFixed(2)}`)
      lower.push(`${bucket ? 'L' : 'M'}${x.toFixed(2)} ${(center + rms * scale).toFixed(2)}`)
    }
    return { peaks: peaks.join(''), trace: trace.join(''), envelope: upper.join('') + lower.join(''), left, right, top, bottom, center, scale }
  }, [render, compact])
  const duration = render?.metrics.duration ?? 0
  const height = compact ? 80 : 242
  return <svg className={`forge-waveform${compact ? ' is-thumbnail' : ''}`} viewBox={`0 0 800 ${height}`} preserveAspectRatio="none"
    role="img" aria-labelledby={`${id}-title ${id}-description`} data-pcm-fingerprint={render?.fingerprint ?? ''} data-pcm-frames={render?.pcm.length ?? 0}>
    <title id={`${id}-title`}>{label}</title>
    <desc id={`${id}-description`}>{render ? `Реальный PCM, ${render.pcm.length} отсчётов, ${Math.round(duration * 1000)} миллисекунд. Фиксированный масштаб амплитуды от −1 до +1. ${compact ? '' : 'Голубая линия — минимумы и максимумы отсчётов, золотая — оконная RMS-огибающая за 20 миллисекунд.'}` : 'Ожидание отрендеренного аудио. Декоративный сигнал не отображается.'}</desc>
    {graph && <>
      {!compact && <g className="forge-wave-grid">{[-1, -0.5, 0, 0.5, 1].map(value => <g key={value}>
        <line x1={graph.left} x2={graph.right} y1={graph.center - value * graph.scale} y2={graph.center - value * graph.scale} />
        <text x="37" y={graph.center - value * graph.scale + 3} textAnchor="end">{value > 0 ? '+' : ''}{value}</text>
      </g>)}{[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}>
        <line x1={graph.left + fraction * (graph.right - graph.left)} x2={graph.left + fraction * (graph.right - graph.left)} y1={graph.top} y2={graph.bottom} />
        <text x={graph.left + fraction * (graph.right - graph.left)} y="228" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{Math.round(duration * 1000 * fraction)} ms</text>
      </g>)}</g>}
      {compact && <line className="forge-wave-zero" x1="0" x2="800" y1={graph.center} y2={graph.center} />}
      <path className="forge-wave-peaks" d={graph.peaks} vectorEffect="non-scaling-stroke" />
      {!compact && <path className="forge-wave-trace" d={graph.trace} vectorEffect="non-scaling-stroke" />}
      {!compact && <path className="forge-wave-envelope" d={graph.envelope} vectorEffect="non-scaling-stroke" />}
    </>}
    {!graph && <text className="forge-wave-empty" x="400" y={height / 2} textAnchor="middle">{compact ? '—' : 'Рендер PCM…'}</text>}
  </svg>
}
