import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Where /api is proxied in dev and preview. E2E tests point it at their own server.
const api = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/sw.ts): needed for photo caching now, Background Sync later.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Ask before updating; registration happens in <UpdatePrompt>.
      registerType: 'prompt',
      injectRegister: false,
      // Icons, favicon and Apple touch icon generated from public/icon.svg.
      pwaAssets: { config: true, overrideManifestIcons: true },
      manifest: {
        name: 'Nemeton',
        short_name: 'Nemeton',
        description: 'Festival schedule that works offline.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#11130e',
        background_color: '#11130e',
      },
      injectManifest: {
        // The web manifest is added by the plugin itself; listing it here too would duplicate it.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      // Off in dev: a caching service worker fights with hot reload. Use `npm run preview`.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: Number(process.env.PORT ?? 5317),
    // When a launcher assigns a port, fail instead of silently moving to another one.
    strictPort: Boolean(process.env.PORT),
    proxy: { '/api': api },
  },
  preview: {
    port: Number(process.env.PORT ?? 5318),
    strictPort: Boolean(process.env.PORT),
    proxy: { '/api': api },
  },
});
