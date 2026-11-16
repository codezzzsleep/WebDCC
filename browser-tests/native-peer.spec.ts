import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { issueCookie } from '../packages/server/src/auth.js';
import { registerNativeTerminalRoutes } from '../packages/server/src/native-terminal-routes.js';
import { createPeerFixture } from '../packages/server/test/native-peer-fixture.js';
import type FastifyFactory from '../packages/server/node_modules/fastify/fastify.js';
import type WebsocketPlugin from '../packages/server/node_modules/@fastify/websocket/index.js';

const requireServer = createRequire(new URL('../packages/server/package.json', import.meta.url));
const Fastify = requireServer('fastify') as typeof FastifyFactory;
const websocket = requireServer('@fastify/websocket') as typeof WebsocketPlugin;

it('routes source browser input to a peer, restores it after refresh/switch and closes only that view', async () => {
  const ctx = await createPeerFixture(); const web = join(ctx.root, 'web'); await mkdir(web);
  const app = Fastify(); const token = 'isolated-native-peer-browser'; let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {NativeSurface} from './src/components/NativeSurface.tsx';
      function App(){const[id,setId]=useState('web-parent');return <><button onClick={()=>setId(id==='web-parent'?'other-session':'web-parent')}>Switch session</button><NativeSurface sessionId={id} agent="codex" initialCommand="/ps"/></>};createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: fileURLToPath(new URL('../packages/web/', import.meta.url)), loader: 'tsx' }, bundle: true, outfile: join(web, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic' });
    await app.register(websocket);
    app.get('/', async (_request, reply) => reply.header('set-cookie', `wdcc-auth=${issueCookie(token)}; Path=/; HttpOnly; SameSite=Lax`)
      .type('text/html').send('<html><head><link rel="stylesheet" href="/ui.css"></head><body><main id="root"></main><script type="module" src="/ui.js"></script></body></html>'));
    app.get('/ui.js', async (_request, reply) => reply.type('text/javascript').send(createReadStream(join(web, 'ui.js'))));
    app.get('/ui.css', async (_request, reply) => reply.type('text/css').send(createReadStream(join(web, 'ui.css'))));
    app.get('/api/native-terminal', async () => ({ terminals: [] }));
    app.get('/api/native-terminal/takeover-status', async () => ({ allowed: false, reason: 'active fixture parent' }));
    registerNativeTerminalRoutes(app, { base: '/api/native-peer', supervisor: ctx.supervisor, config: { host: '127.0.0.1', port: 0, token }, executeControl: async (_action, run) => run(), takeoverStatus: () => ({ allowed: true, reason: '' }) });
    expect((await app.inject({ method: 'POST', url: '/api/native-peer', payload: { sessionId: 'web-parent', intent: 'live-session', commandId: 'UNAUTHENTICATED' } })).statusCode).toBe(401);
    const headers = { cookie: `wdcc-auth=${issueCookie(token)}` };
    expect((await app.inject({ method: 'POST', url: '/api/native-peer', headers, payload: { sessionId: 'web-parent', intent: 'same-session', commandId: 'INVALID-INTENT' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/native-peer', headers, payload: { sessionId: 'web-parent', intent: 'live-session', commandId: 'INJECTED-ARGV', argv: ['arbitrary'] } })).statusCode).toBe(400);
    expect(ctx.metrics().held).toBe(0);
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(address);
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '打开当前原生界面', exact: true }).click();
    await expect.poll(() => ctx.supervisor.list('web-parent')[0]?.nativeIdentityVerified).toBe(true);
    const peer = ctx.supervisor.list('web-parent')[0]!;
    await page.getByRole('button', { name: '填入原生指令', exact: true }).click();
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Enter');
    await page.getByText('RESULT /ps', { exact: true }).first().waitFor();
    expect(ctx.requests.filter(frame => frame['method'] === 'fixture/command')).toEqual([{ id: 2, method: 'fixture/command', params: { text: '/ps' } }]);
    await page.reload(); await page.getByText('RESULT /ps', { exact: true }).first().waitFor();
    expect(ctx.supervisor.list('web-parent')[0]?.id).toBe(peer.id); expect(ctx.metrics().held).toBe(1);
    await page.getByRole('button', { name: 'Switch session' }).click();
    await expect.poll(() => page.locator('.native-terminal').count()).toBe(0);
    await page.getByRole('button', { name: 'Switch session' }).click(); await page.getByText('RESULT /ps', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '关闭原生界面', exact: true }).click();
    await expect.poll(() => ctx.metrics().held).toBe(0);
    expect(ctx.parent).toEqual({ nativeId: 'parent-native', ownerId: 'original-owner' });
    await page.getByRole('button', { name: '关闭并清除日志', exact: true }).click();
    await expect.poll(() => ctx.supervisor.list('web-parent').length).toBe(0);
    expect(ctx.metrics()).toEqual({ held: 0, releases: 1 });
    expect(ctx.requests.filter(frame => frame['method'] === 'fixture/command')).toHaveLength(1);
  } finally { await browser?.close(); await app.close(); await ctx.close(); await rm(web, { recursive: true, force: true }); }
});
