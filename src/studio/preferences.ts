export type WorkspaceMode = 'studio' | 'forge' | 'learn'
export type StudioDensity = 'compact' | 'comfortable'
export const WORKSPACE_KEY = 'sound-lab.workspace.v1'
const DISPLAY_KEY = 'sound-lab.display.v1'

export function readWorkspace(): WorkspaceMode {
  try { const saved = localStorage.getItem(WORKSPACE_KEY); return saved === 'learn' || saved === 'forge' ? saved : 'studio' }
  catch { return 'studio' }
}

export function readDisplay(): { density: StudioDensity; scale: number } {
  const defaults = { density: 'compact' as StudioDensity, scale: 100 }
  try {
    const value = JSON.parse(localStorage.getItem(DISPLAY_KEY) || 'null')
    if (!value || typeof value !== 'object') return defaults
    return {
      density: value.density === 'comfortable' ? 'comfortable' : 'compact',
      scale: typeof value.scale === 'number' && Number.isFinite(value.scale) ? Math.max(80, Math.min(110, value.scale)) : 100,
    }
  } catch { return defaults }
}

export function saveDisplay(density: StudioDensity, scale: number) {
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify({ density, scale })) }
  catch { /* Display preferences must never prevent playing or saving a phrase. */ }
}
