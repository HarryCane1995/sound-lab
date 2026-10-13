import { chromium } from 'playwright'
import { createServer } from 'vite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const URL = process.env.SOUND_LAB_TEST_URL || 'http://127.0.0.1:5173/'
export const WORKSPACE_KEY = 'sound-lab.workspace.v1'

// Legacy suites exercise the retained educational controls. They deliberately
// select Learn without changing the application's Studio default or weakening
// any of their original UI/audio assertions. The script also restores Learn
// after a legacy scenario clears its own isolated test storage and reloads.
export async function initializeTestWorkspace(target, workspace = 'learn') {
  if (!['learn', 'studio', 'forge'].includes(workspace)) throw new Error(`Unknown test workspace: ${workspace}`)
  await target.addInitScript(({ key, workspace }) => {
    try {
      const saved = localStorage.getItem(key)
      if (saved !== 'learn' && saved !== 'studio' && saved !== 'forge') localStorage.setItem(key, workspace)
    } catch { /* Storage-denial scenarios must still be able to mount the app. */ }
  }, { key: WORKSPACE_KEY, workspace })
}

export async function chooseWorkspace(page, workspace) {
  if (!['learn', 'studio', 'forge'].includes(workspace)) throw new Error(`Unknown test workspace: ${workspace}`)
  const label = workspace === 'learn' ? 'Learn' : workspace === 'forge' ? 'Sample Forge' : 'Studio'
  const selected = page.getByRole('button', { name: label, exact: true })
  await selected.waitFor()
  if (await selected.getAttribute('aria-pressed') !== 'true') await selected.click()
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === label && button.getAttribute('aria-pressed') === 'true'), label)
  for (const name of ['Studio', 'Learn', 'Sample Forge'].filter(name => name !== label)) {
    if (await page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed') !== 'false') throw new Error('Workspace controls must expose a mutually exclusive pressed state')
  }
}

export function testBrowserExecutable() {
  const override = process.env.SOUND_LAB_BROWSER
  if (override) {
    if (!existsSync(override)) throw new Error(`SOUND_LAB_BROWSER does not exist: ${override}`)
    return override
  }
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean)
  // An undefined executablePath selects Playwright's downloaded Chromium in CI.
  return candidates.find(candidate => existsSync(candidate))
}

export function testBrowserName() {
  const executable = testBrowserExecutable()
  return !executable ? 'chromium' : /msedge/i.test(executable) ? 'edge' : 'chrome'
}

export async function launchTestBrowser(options = {}) {
  return chromium.launch({
    ...options,
    executablePath: options.executablePath ?? testBrowserExecutable(),
    headless: options.headless ?? true,
    // Hardwareless Linux CI still exercises an actual WebGL2 implementation;
    // Windows keeps its native GPU path. This flag only affects test browsers.
    args: ['--autoplay-policy=no-user-gesture-required', ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []), ...(options.args ?? [])],
  })
}

export async function startTestBrowser({ workspace = 'learn' } = {}) {
  mkdirSync('test-results', { recursive: true })
  let server = null
  let browser = null
  try {
    let available = false
    try {
      const response = await fetch(URL, { signal: AbortSignal.timeout(1500) })
      available = response.ok && (await response.text()).includes('SOUND LAB')
    } catch { /* Launch our own server if none is running. */ }
    if (!available) {
      if (process.env.SOUND_LAB_TEST_URL) throw new Error(`Development test server is unavailable: ${URL}`)
      server = await createServer()
      await server.listen()
    }
    browser = await launchTestBrowser()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
    await initializeTestWorkspace(page, workspace)
    await page.goto(URL)
    await page.locator('h1').waitFor()
    await chooseWorkspace(page, workspace)
    return { browser, page, close: async () => { await browser.close(); if (server) await server.close() } }
  } catch (error) {
    if (browser) await browser.close()
    if (server) await server.close()
    throw error
  }
}
