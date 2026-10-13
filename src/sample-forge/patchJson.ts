import { validateKickPatch } from './kickPatch'
import { GENERATOR_VERSION, type ForgeSample, type KickCharacter, type PortableKickPatch } from './model'

export const MAX_PATCH_JSON_BYTES = 64 * 1024
export const MAX_SAMPLE_TAGS = 24
export const MAX_TAG_LENGTH = 48
const characters: KickCharacter[] = ['sub', 'punch', 'tight', 'warm', 'base', 'custom']
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Preserve the first display spelling while comparing normalized case/space. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SAMPLE_TAGS) throw new Error(`Допустимо не более ${MAX_SAMPLE_TAGS} тегов.`)
  const result: string[] = [], seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('Тег должен быть текстом.')
    const tag = raw.trim().replace(/\s+/gu, ' ').normalize('NFC')
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/u.test(tag)) throw new Error(`Тег должен содержать до ${MAX_TAG_LENGTH} символов.`)
    const key = tag.toLocaleLowerCase('en-US')
    if (!seen.has(key)) { seen.add(key); result.push(tag) }
  }
  return result
}

export function validateSampleName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Название должно содержать от 1 до 120 символов.')
  return value.trim()
}

export function validateGeneratorVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][a-zA-Z0-9.-]{1,32})?$/u.test(value)) throw new Error('Недопустимая версия генератора Kick.')
  return value
}

export function validateKickCharacter(value: unknown): KickCharacter {
  if (!characters.includes(value as KickCharacter)) throw new Error('Недопустимый характер Kick.')
  return value as KickCharacter
}

/** Only allowlisted plain data survives import, including independently copied patches. */
export function validatePortableKickPatch(value: unknown): PortableKickPatch {
  if (!record(value) || value.format !== 'sound-lab.kick-patch' || value.version !== 1) throw new Error('Неподдерживаемый или повреждённый Kick Patch JSON.')
  return { format: 'sound-lab.kick-patch', version: 1, generatorVersion: validateGeneratorVersion(value.generatorVersion),
    name: validateSampleName(value.name), tags: normalizeTags(value.tags), character: validateKickCharacter(value.character),
    patch: validateKickPatch(value.patch), generatedPatch: validateKickPatch(value.generatedPatch) }
}

export function portableKickPatch(sample: ForgeSample, generatorVersion = GENERATOR_VERSION): PortableKickPatch {
  return validatePortableKickPatch({ format: 'sound-lab.kick-patch', version: 1, generatorVersion,
    name: sample.name, tags: sample.tags, character: sample.character, patch: sample.patch, generatedPatch: sample.generatedPatch })
}

export function exportPatchJson(value: PortableKickPatch | ForgeSample, generatorVersion = GENERATOR_VERSION): string {
  const portable = 'format' in value ? validatePortableKickPatch(value) : portableKickPatch(value, generatorVersion)
  return JSON.stringify(portable, null, 2)
}

export function importPatchJson(raw: string): PortableKickPatch {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_PATCH_JSON_BYTES) throw new Error('Kick Patch JSON больше 64 KiB.')
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error('Не удалось прочитать Kick Patch JSON: повреждённый JSON.') }
  return validatePortableKickPatch(value)
}
