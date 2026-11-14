/**
 * 生产构建：把服务端打成单文件 ESM（原生模块 better-sqlite3 保持 external）。
 * 产物：packages/server/dist/main.js
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BuildManifest } from '../packages/protocol/src/build.js';
import { CURRENT_SCHEMA_VERSION } from '../packages/server/src/db.js';
import { createRunIdentity } from './lib/gate-report.js';
import inventory from '../packages/server/src/native-inventory.json' with { type: 'json' };

const output = process.env['WDCC_SERVER_OUT'] ?? 'packages/server/dist/main.js';
const identity = createRunIdentity();
if (process.env['WDCC_COMMIT'] !== undefined && process.env['WDCC_COMMIT'] !== identity.commit) throw new Error('WDCC_COMMIT 不匹配实际源码提交');
const require = createRequire(import.meta.url);
const sdkPackage = JSON.parse(await readFile(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')) as { version: string };
const packageInfo = JSON.parse(await readFile('package.json', 'utf8')) as { packageManager: string };
if (sdkPackage.version !== inventory.baseline['claude-code']) throw new Error('SDK 版本与冻结协议不兼容');
const manifest: BuildManifest = { formatVersion: 1, commit: identity.commit, builtAt: process.env['WDCC_BUILT_AT'] ?? new Date().toISOString(), sourceFingerprint: identity.sourceFingerprint, schemaFingerprint: identity.schemaFingerprint,
  nativeBaseline: inventory.baseline, database: { minimum: 0, maximum: CURRENT_SCHEMA_VERSION }, toolchain: { node: process.version, packageManager: packageInfo.packageManager, sdk: sdkPackage.version } };
await mkdir(output.slice(0, output.lastIndexOf('/')) || '.', { recursive: true });
await build({
  entryPoints: ['packages/server/src/main.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  define: { __WDCC_BUILD_MANIFEST__: JSON.stringify(manifest) },
  // SDK 用 createRequire(import.meta.url) 找平台子包，打包后找不到（SPEC-M8 F1）
  external: ['better-sqlite3', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: "import { createRequire as __wdccCreateRequire } from 'node:module'; const require = __wdccCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
await writeFile(join(dirname(output), 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`built ${output} @ ${manifest.commit}\n`);
await build({ entryPoints: ['packages/server/src/native-http-recorder.ts'], outfile: join(dirname(output), 'native-http-recorder.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'info' });
