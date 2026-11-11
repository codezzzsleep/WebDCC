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
  // SDK 用 createRequire(import.meta.url) 找平台子包，打包后找不到（SPEC-M8 F1）
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: "import { createRequire as __wdccCreateRequire } from 'node:module'; const require = __wdccCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
process.stdout.write('built packages/server/dist/main.js\n');
