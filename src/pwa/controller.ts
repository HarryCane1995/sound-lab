import { useSyncExternalStore } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
interface PwaState {
  online: boolean
  installed: boolean
  installAvailable: boolean
  offlineReady: boolean
  needRefresh: boolean
  updating: boolean
  checking: boolean
  error: string | null
}
type ReloadGuard = { blocked: () => string | null; prepare: () => void }
let state: PwaState = {
  online: navigator.onLine, installed: matchMedia('(display-mode: standalone)').matches,
  installAvailable: false, offlineReady: false, needRefresh: false, updating: false, checking: false, error: null,
}
const listeners = new Set<() => void>()
let registration: ServiceWorkerRegistration | undefined
let installPrompt: InstallPrompt | null = null
let initialized = false
let reloadGuard: ReloadGuard | null = null
let changedController = false
let activationTimeout: number | undefined
const emit = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function usePwaState() { return useSyncExternalStore(subscribe, () => state) }

function reloadIfSafe() {
  if (!reloadGuard) return
  const guard = reloadGuard
  const reason = guard.blocked()
  if (reason) {
    reloadGuard = null
    emit({ updating: false, needRefresh: true, error: `Обновление отложено: ${reason}` })
    return
  }
  try {
    guard.prepare()
    location.reload()
  } catch (error) {
    reloadGuard = null
    emit({ updating: false, error: `Не удалось сохранить настройки перед обновлением: ${String(error)}` })
  }
}

export async function checkForUpdate() {
  if (!registration || !navigator.onLine || state.checking) return
  emit({ checking: true, error: null })
  try {
    await registration.update()
    if (registration.waiting) emit({ needRefresh: true })
  } catch {
    if (navigator.onLine) emit({ error: 'Не удалось проверить обновление. Текущая версия продолжает работать; повторите позже.' })
  } finally { emit({ checking: false }) }
}

export function requestUpdate(guard: ReloadGuard) {
  const reason = guard.blocked()
  if (reason) { emit({ error: `Обновление отложено: ${reason}` }); return }
  reloadGuard = guard
  emit({ updating: true, error: null })
  if (changedController) { reloadIfSafe(); return }
  if (!registration?.waiting) {
    reloadGuard = null
    emit({ updating: false, error: 'Обновление ещё не готово. Нажмите «Проверить обновления».' })
    return
  }
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  window.clearTimeout(activationTimeout)
  activationTimeout = window.setTimeout(() => {
    reloadGuard = null
    emit({ updating: false, error: 'Обновление ещё активируется. Повторите после завершения или при следующем запуске.' })
  }, 15000)
}

export async function promptInstall() {
  if (!installPrompt || state.installed) return
  const prompt = installPrompt
  installPrompt = null
  emit({ installAvailable: false, error: null })
  try {
    await prompt.prompt()
    await prompt.userChoice
    // Only appinstalled / display-mode confirms installation.
  } catch { emit({ error: 'Установка не завершена. Можно воспользоваться меню браузера.' }) }
}

export function initializePwa() {
  if (initialized || !import.meta.env.PROD) return
  initialized = true
  const mode = matchMedia('(display-mode: standalone)')
  mode.addEventListener('change', () => emit({ installed: mode.matches }))
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event as InstallPrompt
    emit({ installAvailable: true })
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null; emit({ installed: true, installAvailable: false })
  })
  window.addEventListener('online', () => { emit({ online: true }); void checkForUpdate() })
  window.addEventListener('offline', () => emit({ online: false }))
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    emit({ error: 'Офлайн-режим требует Service Worker и HTTPS (или localhost).' }); return
  }
  let controller = navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const next = navigator.serviceWorker.controller
    const update = controller !== null && next !== controller
    controller = next
    emit({ offlineReady: next !== null })
    if (!update) return
    changedController = true
    window.clearTimeout(activationTimeout)
    emit({ needRefresh: true })
    // Another open window may activate an update. Never reload this window without
    // its own confirmation, and recheck recording/data work at activation time.
    reloadIfSafe()
  })
  const observe = (worker: ServiceWorker | null) => {
    if (!worker) return
    const change = () => {
      if (worker.state === 'installed' && registration?.waiting) emit({ needRefresh: true })
      if (worker.state === 'activated') emit({ offlineReady: true })
      if (worker.state === 'redundant' && !registration?.active) emit({ error: 'Офлайн-кэш не установлен. Проверьте сеть и свободное место, затем перезагрузите приложение.' })
    }
    worker.addEventListener('statechange', change)
    change()
  }
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL, updateViaCache: 'none',
  }).then(value => {
    registration = value
    emit({ offlineReady: !!value.active, needRefresh: !!value.waiting })
    observe(value.installing)
    value.addEventListener('updatefound', () => observe(value.installing))
    void checkForUpdate()
  }).catch(() => emit({ error: 'Не удалось включить офлайн-режим. Проверьте сеть, разрешения браузера и свободное место.' }))
  window.setInterval(() => { if (!document.hidden) void checkForUpdate() }, 60 * 60 * 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkForUpdate() })
}
