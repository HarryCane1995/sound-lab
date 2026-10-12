import type { SynthParams } from '../types'
import { validateSoundSnapshot } from '../phrases/storage'

const UPDATE_SOUND_KEY = 'sound-lab.update-sound.v1'

export function restoreUpdateSound(): SynthParams | null {
  try {
    const raw = sessionStorage.getItem(UPDATE_SOUND_KEY)
    sessionStorage.removeItem(UPDATE_SOUND_KEY)
    if (!raw || raw.length > 20000) return null
    return validateSoundSnapshot(JSON.parse(raw))
  } catch { return null }
}

export function preserveUpdateSound(params: SynthParams) {
  sessionStorage.setItem(UPDATE_SOUND_KEY, JSON.stringify(validateSoundSnapshot(params)))
}
