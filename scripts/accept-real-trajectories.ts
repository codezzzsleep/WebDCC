/** Explicit live acceptance: uses isolated native homes and private provider
 * configuration supplied by the operator. Never runs as part of unit tests. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { start } from '../packages/server/src/main.js';
import { isolatedDirs } from '../packages/server/src/test-isolation.js';
import type { ProviderInput } from '../packages/server/src/providers.js';
import type { InteractionRecord } from '../packages/server/src/interaction-recorder.js';
import { ulid, isValidEventData } from '../packages/protocol/src/index.js';

if (!process.argv.includes('--live')) throw new Error('Real model requests require explicit --live');
const inputFile = process.env['WDCC_LIVE_CONFIG'];
if (inputFile === undefined) throw new Error('Set WDCC_LIVE_CONFIG to a private JSON configuration file');
const input = JSON.parse(await readFile(inputFile, 'utf8')) as { providers: ProviderInput[]; dshHome: string; dshModel?: string; out: string };
const dirs = isolatedDirs('wdcc-live-trajectories');
await mkdir(input.out, { recursive: true, mode: 0o700 });
await writeFile(join(input.out, 'live-job.json'), JSON.stringify({ status: 'running', pid: process.pid, isolatedRoot: dirs.root, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
for (const key of ['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','DSH_HOME'] as const) process.env[key] = dirs[key];
process.env['WDCC_TEST_HOOKS'] = '0';
for (const path of ['.env', '.credentials.yaml', '.anonymous-user-id', 'profiles/web/cordis.patch.yml', 'profiles/cli/cordis.patch.yml']) {
  const target = join(dirs.DSH_HOME, path); await mkdir(join(target, '..'), { recursive: true }); await cp(join(input.dshHome, path), target).catch(() => undefined);
}
const dsh = new DshAdapter({ port: 13991, mode: 'spawn', nativeRecorder: { directory: join(dirs.data, 'traces'), module: join(process.cwd(), 'packages/server/dist/native-http-recorder.cjs') } });
const claude = new ClaudeAdapter();
const adapters = [new CodexAdapter(), claude, dsh];
const server = await start({ host: '127.0.0.1', port: 0, token: ulid()+ulid(), dataDir: dirs.data, dshPort: 13991, idleDisposeMin: 0, version: 'live-accept', recordInteractions: true }, { adapters });
claude.onEvent((sessionId, event) => { if (event.type === 'item.complete' && event.kind === 'approval.request') void server.manager.approve(sessionId, { approvalId: (event.data as { approvalId: string }).approvalId, optionId: 'allow' }); });
const base = new URL(server.url).origin;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results: unknown[] = await readFile(join(input.out, 'results.json'), 'utf8').then(text => JSON.parse(text) as unknown[]).catch(() => []);
const selectedAgents = (process.argv.find(arg => arg.startsWith('--agents='))?.slice(9) ?? 'codex,claude-code,dsh').split(',');
try {
  await page.goto(`${base}/?token=${server.config.token}`);
  await page.request.patch(`${base}/api/watchdog`, { data: { enabled: false } });
  const configured = [];
  for (const provider of input.providers) {
    const response = await page.request.post(`${base}/api/providers`, { data: provider });
    if (!response.ok()) throw new Error(`Provider import failed ${response.status()}`);
    configured.push(await response.json() as { id: string; protocols: string[]; models: string[] });
  }
  // Generate a real PNG through the browser, then upload it through Composer.
  const drawing = await browser.newPage({ viewport: { width: 240, height: 140 } });
  await drawing.setContent('<body style="margin:0;background:rgb(220,30,40);color:white;font:22px sans-serif;padding:20px">WebDCC<br>TRACE-113</body>');
  const png = await drawing.screenshot(); await drawing.close();
  const imageHash = createHash('sha256').update(png).digest('hex');
  for (const agent of ['codex','claude-code','dsh'] as const) {
    if (!selectedAgents.includes(agent)) continue;
    process.stdout.write(`live acceptance: ${agent} starting\n`);
    const cwd = join(dirs.root, `workspace-${agent}`); await mkdir(cwd); await writeFile(join(cwd, 'seed.txt'), '真实输入-113\n'); await writeFile(join(cwd, 'preview.png'), png);
    const workspace = server.store.createWorkspace(`验收 ${agent}`, cwd);
    const protocol = agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    const provider = agent === 'dsh' ? undefined : configured.find(provider => provider.protocols.includes(protocol) && (agent === 'codex' ? provider.models.includes('gpt-6.1-sol') : provider.models.includes('claude-sonnet-5-5')));
    if (agent !== 'dsh' && provider === undefined) throw new Error(`Configured provider missing for ${agent}`);
    const model = agent === 'dsh' ? input.dshModel ?? 'deepseek-v4-1-flash-261017' : agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5';
    const session = await server.manager.createSession({ workspaceId: workspace.id, agent, providerId: provider?.id ?? null, model, accessMode: agent === 'claude-code' ? 'acceptEdits' : 'danger-full-access' });
    await page.goto(`${base}/s/${session.id}`); await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.getByTestId('add-image-input').setInputFiles({ name: 'trace.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.attachment-chip')).toHaveCount(1);
    const prompt = `工作区绝对路径是 ${cwd}。读取 ${join(cwd, 'seed.txt')}，把其中全部内容原样写入指定绝对路径 ${join(cwd, 'result.txt')}，不要改写或推测路径。再查看附带图片，用一句话描述底色和可见文字。不要发起子任务。完成后附上图片 Markdown：![预览](preview.png)。`;
    await page.getByTestId('composer-input').fill(prompt); await page.getByTestId('send-button').click();
    await expect.poll(() => server.store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length, { timeout: 240_000, intervals: [500] }).toBeGreaterThan(0);
    let imageAdmission: string | undefined;
    let events = server.store.allEvents(session.id);
    let terminal = events.filter(event => event.kind === 'turn.completed').at(-1);
    if (agent === 'dsh' && (terminal?.data as { reason?: string }).reason?.includes('does not support image input')) {
      imageAdmission = 'rejected-model-capability';
      const before = events.filter(event => event.kind === 'turn.completed').length;
      await page.getByTestId('composer-input').fill(`读取指定绝对路径 ${join(cwd, 'seed.txt')}，将全部内容原样写入指定绝对路径 ${join(cwd, 'result.txt')}。只做这项文件任务，不要发起子任务。完成后附上图片 Markdown：![预览](preview.png)。`);
      await page.getByTestId('send-button').click();
      await expect.poll(() => server.store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length, { timeout: 240_000, intervals: [500] }).toBeGreaterThan(before);
      events = server.store.allEvents(session.id); terminal = events.filter(event => event.kind === 'turn.completed').at(-1);
    }
    expect(terminal?.data).toMatchObject({ status: 'completed' });
    for (const event of events) expect(isValidEventData(event.kind, event.data), `${agent} ${event.kind}`).toBe(true);
    expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('真实输入-113\n');
    await expect(page.getByTestId('timeline').locator('.assistant img.workspace-image').first()).toBeVisible();
    expect(await page.getByTestId('timeline').locator('.assistant img.workspace-image').first().evaluate((image: { naturalWidth: number }) => image.naturalWidth)).toBeGreaterThan(0);
    const summary = await server.recorder!.summary(session.id, server.store.getSession(session.id)?.nativeId, workspace.id);
    expect(summary.nativeFrames).toBeGreaterThan(0); expect(summary.modelRequests).toBeGreaterThan(0); expect(summary.incomplete).toBe(false);
    const trace = await server.recorder!.read(session.id, server.store.getSession(session.id)?.nativeId, workspace.id);
    const rows = trace.trim().split('\n').map(line => JSON.parse(line) as InteractionRecord);
    const user = events.find(event => event.kind === 'user.message')!.data as { images?: string[] };
    const uploaded = server.store.getFile(user.images![0]!)!; expect(uploaded.sha256).toBe(imageHash);
    const requests = rows.filter(row => row.source === 'model-http' && row.channel === 'request');
    const requestBodies = requests.map(row => { const value = row.value as { body?: string; value?: { body?: string } }; return Buffer.from(value.body ?? value.value?.body ?? '', 'base64').toString(); });
    if (agent === 'dsh') expect(imageAdmission).toBe('rejected-model-capability');
    else expect(requestBodies.some(body => body.includes(png.toString('base64'))), `${agent}: uploaded bytes in actual model payload`).toBe(true);
    expect(rows.some(row => row.source === 'web' && row.channel === 'command')).toBe(true);
    await page.screenshot({ path: join(input.out, `${agent}.png`), fullPage: true });
    results.push({ isolatedRoot: dirs.root, agent, sessionId: session.id, model, imageAdmission, summary, inputImageSha256: imageHash, resultSha256: createHash('sha256').update(await readFile(join(cwd, 'result.txt'))).digest('hex'), eventKinds: [...new Set(events.map(event => event.kind))] });
    await writeFile(join(input.out, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
    await server.manager.dispose(session.id);
    process.stdout.write(`live acceptance: ${agent} passed (${summary.modelRequests} model requests)\n`);
  }
  await writeFile(join(input.out, 'live-job.json'), JSON.stringify({ status: 'complete', isolatedRoot: dirs.root, results: join(input.out, 'results.json'), finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
} catch (error) {
  await writeFile(join(input.out, 'live-job.json'), JSON.stringify({ status: 'failed', isolatedRoot: dirs.root, error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  throw error;
} finally { await browser.close(); await server.close(); await dsh.shutdown(); }
