import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 注意：Vite 8 使用 rolldown 原生二进制，本机 CPU 没有 AVX2，会 Illegal instruction。
// 所以锁定 Vite 7（rollup + esbuild）。升级前先在开发机跑 pnpm build。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
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
