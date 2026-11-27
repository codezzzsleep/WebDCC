import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';

// 注意：Vite 8 使用 rolldown 原生二进制，本机 CPU 没有 AVX2，会 Illegal instruction。
// 所以锁定 Vite 7（rollup + esbuild）。升级前先在开发机跑 pnpm build。
export default defineConfig({
  define: { __WDCC_WEB_COMMIT__: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [],
      workbox: {
        globPatterns: ['**/*.{js,css,svg,png,woff2}'],
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // 只预缓存应用外壳；/api 永不缓存
        runtimeCaching: [{
          urlPattern: ({ request, url }) => request.mode === 'navigate' && !/^\/(?:api|files|workspace-preview)(?:\/|$)/.test(url.pathname)
            && !/\.(?:jpe?g|png|gif|webp|avif|bmp|ico)$/i.test(url.pathname),
          handler: 'NetworkFirst',
          options: { cacheName: 'webdcc-pages', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 20 } },
        }],
      },
      manifest: {
        name: 'WebDCC',
        short_name: 'WebDCC',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2f5fd0',
      },
    }),
  ],
  build: {
    outDir: process.env['WDCC_BUILD_DIR'] ?? 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
      '/files': { target: 'http://127.0.0.1:8787' },
    },
  },
});
