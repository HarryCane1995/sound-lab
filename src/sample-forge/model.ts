import type { KickPatch } from './kickPatch'
import type { RenderedKick } from './audio/KickRenderer'

export const FORGE_SCHEMA_VERSION = 1 as const
export const GENERATOR_VERSION = '1.0.0'
export const VARIATION_COUNT = 16
export type KickCharacter = 'sub' | 'punch' | 'tight' | 'warm' | 'base' | 'custom'

/** patch/render are a committed pair; editor drafts live outside this record. */
export interface ForgeSample {
  id: string
  name: string
  character: KickCharacter
  tags: string[]
  favorite: boolean
  seed: number
  generatedPatch: KickPatch
  patch: KickPatch
  render: RenderedKick
  createdAt: number
  updatedAt: number
}

export interface SampleBank {
  schemaVersion: typeof FORGE_SCHEMA_VERSION
  id: string
  name: string
  tags: string[]
  createdAt: number
  updatedAt: number
  generatorVersion: string
  intensity: 'medium'
  batchSeed: number
  base: ForgeSample
  /** Exactly sixteen generated variants. Base and user copies are separate. */
  samples: ForgeSample[]
  copies: ForgeSample[]
}

export interface PortableKickPatch {
  format: 'sound-lab.kick-patch'
  version: 1
  generatorVersion: string
  name: string
  tags: string[]
  character: KickCharacter
  patch: KickPatch
  generatedPatch: KickPatch
}

export function copyRender(render: RenderedKick): RenderedKick {
  return { ...render, patch: { ...render.patch }, metrics: { ...render.metrics }, pcm: render.pcm.slice(), wav: render.wav.slice() }
}

export function copySample(sample: ForgeSample): ForgeSample {
  return { ...sample, tags: [...sample.tags], generatedPatch: { ...sample.generatedPatch }, patch: { ...sample.patch }, render: copyRender(sample.render) }
}

export function copyBank(bank: SampleBank): SampleBank {
  return { ...bank, tags: [...bank.tags], base: copySample(bank.base), samples: bank.samples.map(copySample), copies: bank.copies.map(copySample) }
}

export function samplesInBank(bank: SampleBank): ForgeSample[] { return [bank.base, ...bank.samples, ...bank.copies] }
