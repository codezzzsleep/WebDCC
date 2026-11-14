import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, TEST_TOKEN } from '../packages/server/test/helpers.js';

/** Serve the current source from a real temporary origin, so Chromium's local
 * network policy observes the actual listener. Deployment files are unused. */
export async function createSourceTestApp() {
  const webDist = await mkdtemp(join(tmpdir(), 'wdcc-repair-browser-'));
  try {
    await build({ entryPoints: ['packages/web/src/main.tsx'], bundle: true, outfile: join(webDist, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic', external: ['/fonts/*'], define: { 'import.meta.env': JSON.stringify({ DEV: true, MODE: 'test' }) } });
    await writeFile(join(webDist, 'index.html'), '<html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
    const ctx = await createTestApp({}, TEST_TOKEN, {}, { webDist });
    const close = ctx.close;
    ctx.close = async () => { try { await close(); } finally { await rm(webDist, { recursive: true, force: true }); } };
    return ctx;
  } catch (error) { await rm(webDist, { recursive: true, force: true }); throw error; }
}
