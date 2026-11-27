import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import type { FakeAdapterOptions } from '../packages/testing/fake-adapter/src/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, TEST_TOKEN } from '../packages/server/test/helpers.js';

/** Observe the actual replay boundary on the current WebSocket, including reloads. */
export function observeSessionSnapshots(page: Page, sessionId: string): () => number | undefined {
  let generation = 0;
  let throughSeq: number | undefined;
  page.on('websocket', socket => {
    const current = ++generation;
    throughSeq = undefined;
    socket.on('framereceived', frame => {
      if (current !== generation) return;
      const message = JSON.parse(String(frame.payload)) as { op?: string; sessionId?: string; throughSeq?: number };
      if (message.op === 'snapshot' && message.sessionId === sessionId) throughSeq = message.throughSeq;
    });
  });
  return () => throughSeq;
}

/** Serve the current source from a real temporary origin, so Chromium's local
 * network policy observes the actual listener. Deployment files are unused. */
export async function createSourceTestApp(options: { dbPath?: string; adapterOptions?: FakeAdapterOptions; clientCommit?: string } = {}) {
  const webDist = await mkdtemp(join(tmpdir(), 'wdcc-repair-browser-'));
  try {
    await build({ entryPoints: ['packages/web/src/main.tsx'], bundle: true, outfile: join(webDist, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic', external: ['/fonts/*'], define: { 'import.meta.env': JSON.stringify({ DEV: true, MODE: 'test' }), __WDCC_WEB_COMMIT__: JSON.stringify(options.clientCommit ?? 'dev') } });
    await writeFile(join(webDist, 'index.html'), '<html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
    const ctx = await createTestApp(options.adapterOptions ?? {}, TEST_TOKEN, {}, { webDist, dbPath: options.dbPath });
    const close = ctx.close;
    ctx.close = async () => { try { await close(); } finally { await rm(webDist, { recursive: true, force: true }); } };
    return ctx;
  } catch (error) { await rm(webDist, { recursive: true, force: true }); throw error; }
}
