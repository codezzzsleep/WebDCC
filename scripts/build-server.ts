/**
 * 生产构建：把服务端打成单文件 ESM（原生模块 better-sqlite3 保持 external）。
 * 产物：packages/server/dist/main.js
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('packages/server/dist', { recursive: true });
await build({
  entryPoints: ['packages/server/src/main.ts'],
  outfile: 'packages/server/dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: ['better-sqlite3'],
  banner: {
    js: "import { createRequire as __wdccCreateRequire } from 'node:module'; const require = __wdccCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
process.stdout.write('built packages/server/dist/main.js\n');
