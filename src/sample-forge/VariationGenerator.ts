import { copyKickPatch, kickPatchFingerprint, normalizeKickPatch, seededRandom, type KickPatch } from './kickPatch'
import { renderKick, type RenderedKick } from './audio/KickRenderer'
import { FORGE_SCHEMA_VERSION, GENERATOR_VERSION, VARIATION_COUNT, type ForgeSample, type KickCharacter, type SampleBank } from './model'

export interface VariationDescriptor { index: number; character: KickCharacter; patch: KickPatch }
export interface GenerationOptions { signal?: AbortSignal; onProgress?: (value: number) => void }
const characters = ['sub', 'punch', 'tight', 'warm'] as const
const tags = { sub: ['Kick', 'Sub', 'Deep', 'Soft'], punch: ['Kick', 'Punchy', 'Hard'], tight: ['Kick', 'Tight', 'Short'], warm: ['Kick', 'Warm', 'Soft'] }
const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Генерация отменена.', 'AbortError') }

/** Directional, relative Medium variation; seed controls both parameters/noise. */
function variant(base: KickPatch, batchSeed: number, index: number, attempt = 0): VariationDescriptor {
  const seed = (batchSeed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(attempt + 1, 0x85ebca6b)) >>> 0
  const random = seededRandom(seed)
  const character = characters[Math.floor(index / 4)]
  const patch = copyKickPatch(base)
  const amount = () => 0.1 + random() * 0.15
  const relative = (value: number, sign: number, nearZero: number) => value < nearZero ? Math.max(0, value + sign * nearZero * (0.35 + random() * 0.65)) : value * Math.exp(sign * Math.log1p(amount()))
  if (character === 'sub') {
    patch.startFrequency = relative(base.startFrequency, -1, 1)
    patch.endFrequency = relative(base.endFrequency, -1, 1)
    patch.bodyDecay = relative(base.bodyDecay, 1, 1)
    patch.clickAmount = relative(base.clickAmount, -1, 0.03)
    patch.drive = relative(base.drive, -1, 0.03)
    patch.tone = relative(base.tone, -1, 1)
  } else if (character === 'punch') {
    patch.startFrequency = relative(base.startFrequency, 1, 1)
    patch.pitchDecay = relative(base.pitchDecay, -1, 1)
    patch.clickAmount = relative(base.clickAmount, 1, 0.03)
    patch.drive = relative(base.drive, 1, 0.03)
    patch.bodyDecay = relative(base.bodyDecay, random() > 0.5 ? 1 : -1, 1)
  } else if (character === 'tight') {
    patch.bodyDecay = relative(base.bodyDecay, -1, 1)
    patch.pitchDecay = relative(base.pitchDecay, -1, 1)
    patch.clickDecay = relative(base.clickDecay, -1, 1)
    patch.attack = relative(base.attack, -1, 0.3)
    patch.endFrequency = base.endFrequency * (1.05 + random() * 0.1)
  } else {
    patch.tone = relative(base.tone, -1, 1)
    patch.startFrequency = relative(base.startFrequency, -1, 1)
    patch.clickAmount = relative(base.clickAmount, -1, 0.03)
    patch.drive = relative(base.drive, 1, 0.03)
    patch.bodyDecay = relative(base.bodyDecay, 1, 1)
  }
  patch.pitchCurve *= 0.9 + random() * 0.2
  patch.seed = seed
  return { index, character, patch: normalizeKickPatch(patch) }
}

const parameterKey = (patch: KickPatch) => kickPatchFingerprint({ ...patch, seed: 0 })

/** Pure and deterministic. The base is excluded from all sixteen results. */
export function generateVariantPatches(input: KickPatch, seed: number): VariationDescriptor[] {
  const base = copyKickPatch(input)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed: целое число от 0 до 4294967295.')
  const seen = new Set([parameterKey(base)])
  const results: VariationDescriptor[] = []
  for (let index = 0; index < VARIATION_COUNT; index++) {
    let chosen: VariationDescriptor | undefined
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = variant(base, seed, index, attempt)
      if (seen.has(parameterKey(candidate.patch))) continue
      chosen = candidate; seen.add(parameterKey(candidate.patch)); break
    }
    if (!chosen) throw new Error('Не удалось получить разные Medium-параметры. Измените Base Patch.')
    results.push(chosen)
  }
  return results
}

function acceptable(render: RenderedKick): boolean {
  const value = render.metrics
  return value.duration >= 0.07 && value.duration <= 1.05 && value.peak >= 0.005 && value.peak <= 10 ** (-1 / 20) + 1e-6
    && value.rms >= 0.0003 && Math.abs(value.dcOffset) < 1e-5
    && Number.isFinite(value.spectralCentroidHz) && value.spectralCentroidHz > 15 && value.spectralCentroidHz < 10000
}

export function createForgeSample(patch: KickPatch, render: RenderedKick, options: { name: string; character?: KickCharacter; tags?: string[]; id?: string; at?: number }): ForgeSample {
  const at = options.at ?? Date.now()
  return { id: options.id ?? crypto.randomUUID(), name: options.name, character: options.character ?? 'custom', tags: options.tags ?? ['Kick'], favorite: false,
    seed: patch.seed, generatedPatch: copyKickPatch(patch), patch: copyKickPatch(patch), render, createdAt: at, updatedAt: at }
}

/** One bounded offline render at a time; never publishes a partial bank. */
export async function generateSampleBank(input: KickPatch, seed: number, options: GenerationOptions = {}): Promise<SampleBank> {
  const basePatch = copyKickPatch(input)
  const descriptors = generateVariantPatches(basePatch, seed)
  cancelled(options.signal)
  options.onProgress?.(0)
  const baseRender = await renderKick(basePatch, { signal: options.signal })
  if (!acceptable(baseRender)) throw new Error('Base Kick слишком тихий или вне диапазона one-shot. Проверьте Output и Decay.')
  const at = Date.now(), samples: ForgeSample[] = [], acceptedParameters = new Set([parameterKey(basePatch)]), features = new Set<string>()
  options.onProgress?.(1 / 17)
  for (const descriptor of descriptors) {
    let accepted: ForgeSample | null = null
    for (let attempt = 0; attempt < 8; attempt++) {
      cancelled(options.signal)
      const candidate = attempt === 0 ? descriptor : variant(basePatch, seed, descriptor.index, attempt + 32)
      if (acceptedParameters.has(parameterKey(candidate.patch))) continue
      const render = await renderKick(candidate.patch, { signal: options.signal })
      const feature = [Math.round(render.metrics.duration * 10000), Math.round(render.metrics.rms * 100000), Math.round(render.metrics.spectralCentroidHz * 100)].join(':')
      if (!acceptable(render) || features.has(feature)) continue
      features.add(feature); acceptedParameters.add(parameterKey(candidate.patch))
      accepted = createForgeSample(candidate.patch, render, { name: `Kick_${String(descriptor.index + 1).padStart(2, '0')}`, character: descriptor.character,
        tags: [...tags[descriptor.character as keyof typeof tags]], at })
      break
    }
    if (!accepted) throw new Error(`Kick_${descriptor.index + 1}: не удалось получить пригодный и отличающийся one-shot. Измените Base или Seed.`)
    samples.push(accepted)
    options.onProgress?.((samples.length + 1) / 17)
    await yieldToUi()
  }
  cancelled(options.signal)
  return { schemaVersion: FORGE_SCHEMA_VERSION, id: crypto.randomUUID(), name: `Kick Pack ${seed}`, tags: ['Kick'], createdAt: at, updatedAt: at,
    generatorVersion: GENERATOR_VERSION, intensity: 'medium', batchSeed: seed,
    base: createForgeSample(basePatch, baseRender, { name: 'Base Kick', character: 'base', tags: ['Kick'], id: 'base', at }), samples, copies: [] }
}
