import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const production = command === 'build' || isPreview
  const requestedBase = env.SOUND_LAB_BASE_PATH || '/sound-lab/'
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(requestedBase)) throw new Error('SOUND_LAB_BASE_PATH must be / or an absolute directory path ending in /.')
  const base = production ? requestedBase : '/'
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
  return {
    base,
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      includeAssets: [],
      manifest: {
        id: base, name: 'SOUND LAB', short_name: 'SOUND LAB', lang: 'ru',
        description: 'Услышать, увидеть, понять: синтезатор и библиотека музыкальных фраз.',
        start_url: base, scope: base, display: 'standalone',
        background_color: '#0b0e14', theme_color: '#0b0e14',
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        cacheId: 'sound-lab',
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: `${base}index.html`,
        navigateFallbackAllowlist: [new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)],
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
      },
    })],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  }
})
