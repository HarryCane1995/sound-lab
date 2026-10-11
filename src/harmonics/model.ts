import { copyAdditive, type AdditiveConfig, type Waveform } from '../types'

export const HARMONIC_COUNT = 16

function activeCoefficients(config: AdditiveConfig): number[] {
  const safe = copyAdditive(config)
  return safe.levels.map((level, index) => {
    if (!safe.enabled[index] || (safe.solo !== null && safe.solo !== index + 1)) return 0
    return level === 0 ? 0 : level / 100 * (safe.phases[index] === 180 ? -1 : 1)
  })
}

function scaleFor(coefficients: number[]): number {
  return 1 / Math.max(1, coefficients.reduce((sum, value) => sum + Math.abs(value), 0))
}

/** A transparent peak bound: the sum of absolute sine amplitudes is at most 1. */
export function getHarmonicScale(config: AdditiveConfig): number {
  return scaleFor(activeCoefficients(config))
}

/** Effective signed sine coefficients, including mute, solo and L1 scaling. */
export function getHarmonicCoefficients(config: AdditiveConfig): number[] {
  const coefficients = activeCoefficients(config)
  const scale = scaleFor(coefficients)
  return coefficients.map(value => value * scale)
}

/** The comparison only attenuates Classic; normal Classic has its original gain. */
export function getClassicComparisonGain(config: AdditiveConfig, waveform: Waveform): number {
  const coefficients = getHarmonicCoefficients(config)
  const additiveRms = Math.sqrt(coefficients.reduce((sum, value) => sum + value * value, 0) / 2)
  const classicRms = waveform === 'sine' ? Math.SQRT1_2 : waveform === 'square' ? 1 : 1 / Math.sqrt(3)
  return Math.min(1, additiveRms / classicRms)
}
