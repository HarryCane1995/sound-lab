import { useId } from 'react'
import type { ADSR } from '../types'

interface EnvelopeGraphProps {
  adsr: ADSR
}

const timeLabel = (value: number) => `${Number(value.toFixed(2)).toLocaleString('ru-RU')} с`

export function EnvelopeGraph({ adsr }: EnvelopeGraphProps) {
  const graphId = useId()
  const sustain = Math.max(0, Math.min(1, adsr.sustain))
  const left = 30
  const right = 610
  const top = 23
  const bottom = 119
  const sustainY = bottom - sustain * (bottom - top)
  // Minimum visual phase widths keep very short phases readable; this is a schematic.
  const attackWidth = 42 + Math.sqrt(Math.max(0, adsr.attack)) * 26
  const decayWidth = 55 + Math.sqrt(Math.max(0, adsr.decay)) * 28
  const releaseWidth = 65 + Math.sqrt(Math.max(0, adsr.release)) * 34
  const attackX = left + attackWidth
  const decayX = attackX + decayWidth
  const releaseX = right - releaseWidth
  const path = `M ${left} ${bottom} L ${attackX} ${top} L ${decayX} ${sustainY} L ${releaseX} ${sustainY} L ${right} ${bottom}`
  const phases = [
    { label: `A · ${timeLabel(adsr.attack)}`, x: (left + attackX) / 2 },
    { label: `D · ${timeLabel(adsr.decay)}`, x: (attackX + decayX) / 2 },
    { label: `S · ${Math.round(sustain * 100)}%`, x: (decayX + releaseX) / 2 },
    { label: `R · ${timeLabel(adsr.release)}`, x: (releaseX + right) / 2 },
  ]

  return (
    <div className="envelope-graph">
      <svg viewBox="0 0 640 164" role="img" aria-labelledby={`${graphId}-title ${graphId}-description`}>
        <title id={`${graphId}-title`}>Огибающая ADSR</title>
        <desc id={`${graphId}-description`}>
          Attack {timeLabel(adsr.attack)}, Decay {timeLabel(adsr.decay)}, Sustain {Math.round(sustain * 100)} процентов, Release {timeLabel(adsr.release)}.
          Ширина фаз на схеме условная. Sustain задаёт уровень; длительность удержания определяется нажатием кнопки.
        </desc>
        <defs>
          <linearGradient id={`${graphId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#65d8ed" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#65d8ed" stopOpacity="0.015" />
          </linearGradient>
        </defs>
        <rect x={decayX} y={top} width={Math.max(0, releaseX - decayX)} height={bottom - top} fill="#65d8ed" opacity="0.025" />
        {[0, 0.5, 1].map((level) => (
          <g key={level}>
            <line x1={left} x2={right} y1={bottom - level * (bottom - top)} y2={bottom - level * (bottom - top)} stroke="rgba(132,160,181,0.14)" />
            <text x={left - 8} y={bottom - level * (bottom - top) + 3} textAnchor="end" fill="#8b9eae" fontSize="10">{level}</text>
          </g>
        ))}
        {[attackX, decayX, releaseX].map((x) => (
          <line key={x} x1={x} x2={x} y1={top} y2={bottom} stroke="rgba(132,160,181,0.24)" strokeDasharray="3 5" />
        ))}
        <path d={`${path} L ${left} ${bottom} Z`} fill={`url(#${graphId}-fill)`} />
        <path d={path} fill="none" stroke="#65d8ed" strokeWidth="2.25" strokeLinejoin="round" />
        {[[left, bottom], [attackX, top], [decayX, sustainY], [releaseX, sustainY], [right, bottom]].map(([x, y], index) => (
          <circle key={index} cx={x} cy={y} r="3" fill="#65d8ed" />
        ))}
        <text x={(decayX + releaseX) / 2} y={12} textAnchor="middle" fill="#8b9eae" fontSize="10">удержание ноты</text>
        {phases.map((phase) => (
          <text key={phase.label} x={phase.x} y={141} textAnchor="middle" fill="#b9cbd9" fontSize="11">{phase.label}</text>
        ))}
      </svg>
      <p className="envelope-caption">Схема фаз: ширина условная. S задаёт уровень; время удержания зависит от длительности нажатия.</p>
    </div>
  )
}
