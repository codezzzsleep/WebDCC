import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 注意：Vite 8 使用 rolldown 原生二进制，本机 CPU 没有 AVX2，会 Illegal instruction。
// 所以锁定 Vite 7（rollup + esbuild）。升级前先在开发机跑 pnpm build。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/files\//, /\.(?:jpe?g|png|gif|webp|avif|bmp|ico)(?:[?#]|$)/i],
        cleanupOutdatedCaches: true,
        // 只预缓存应用外壳；/api 永不缓存
        runtimeCaching: [],
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
