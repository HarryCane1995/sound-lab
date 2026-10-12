import { chromium } from 'playwright'
import { createServer } from 'vite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const URL = process.env.SOUND_LAB_TEST_URL || 'http://127.0.0.1:5173/'

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
    args: ['--autoplay-policy=no-user-gesture-required', ...(options.args ?? [])],
  })
}

export async function startTestBrowser() {
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
    await page.goto(URL)
    await page.locator('h1').waitFor()
    return { browser, page, close: async () => { await browser.close(); if (server) await server.close() } }
  } catch (error) {
    if (browser) await browser.close()
    if (server) await server.close()
    throw error
  }
}
