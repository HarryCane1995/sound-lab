import { chromium } from 'playwright'
import { createServer } from 'vite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const URL = 'http://127.0.0.1:5173'

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
    if (!available) { server = await createServer(); await server.listen() }
    const candidates = [
      process.env.SOUND_LAB_BROWSER,
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    ].filter(Boolean)
    const executablePath = candidates.find(candidate => existsSync(candidate))
    browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
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
