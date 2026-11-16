/** Replay captured native body events with the production handler and UI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { AdapterEvent, CreateOpts, EventData, TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { sourceFingerprint } from './lib/gate-report.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const captureOption = option('--capture');
const reportOption = option('--report');
if (!captureOption || !reportOption) throw new Error('Provide an existing --capture and a new private --report.');
const capture = resolve(captureOption);
const report = resolve(reportOption);
const bytes = await readFile(capture);
type Envelope = { id: number; source: string; direction: 'in' | 'out'; channel: string; receivedAt: string; payload: Record<string, unknown> };
type Reasoning = { id: string; type: 'reasoning'; summary: string[]; content: string[] };
const original = JSON.parse(bytes.toString()) as {
  kind: string; passed: boolean; nativeId: string; nativeVersion: string; binarySha256: string; nativeFrames: Envelope[];
};
assert.equal(original.kind, 'official-native-reasoning-body-controlled-model');
const frames = original.nativeFrames.filter(row => row.source === 'transport' && row.channel === 'rpc');
const expected = frames.flatMap(row => {
  const params = row.payload['params'] as { turnId?: string; item?: Reasoning } | undefined;
  return row.direction === 'in' && row.payload['method'] === 'item/completed' && params?.item?.type === 'reasoning'
    ? [{ nativeTurnId: params.turnId!, item: params.item }] : [];
});
assert.ok(expected.some(value => value.item.content.length > 0), 'NOT_TRIGGERED: capture has no original native body');
const evidence: Record<string, unknown> = {
  runId: randomUUID(), kind: 'captured-official-native-reasoning-controlled-model-replay', passed: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  capture, captureSha256: createHash('sha256').update(bytes).digest('hex'), originalCapturePassed: original.passed,
  nativeId: original.nativeId, nativeVersion: original.nativeVersion, binarySha256: original.binarySha256,
  originalRpcReplayed: frames.length, newNativeRequests: 0, newModelRequests: 0,
};
await mkdir(dirname(report), { recursive: true });
await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
let browser: Browser | undefined;
try {
  ctx = await createSourceTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let emit!: (id: string, event: AdapterEvent) => void;
  let opts!: CreateOpts;
  adapter.onEvent = value => { emit = value; };
  const create = adapter.create.bind(adapter);
  adapter.create = async value => { opts = value; return { ...await create(value), nativeId: original.nativeId }; };
  adapter.send = async () => { throw new Error('Replay cannot submit a native input'); };
  ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Captured native reasoning body', ctx.dataDir);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const replay = CodexAdapter.replay(session.id, original.nativeId);
  const startedAt = Date.parse(frames[0]!.receivedAt);
  for (const row of frames) {
    const frame: TraceFrame = { i: row.id, t: Date.parse(row.receivedAt) - startedAt, dir: row.direction, ch: row.channel, frame: row.payload };
    const receipt = opts.nativeEvents!.record(frame);
    for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
  }
  // A turn observed without a Web send first commits its public activation.
  // Await the durable terminal before inspecting its stored item identities.
  const terminalCount = new Set(expected.map(value => value.nativeTurnId)).size;
  const deadline = Date.now() + 5000;
  while (ctx.store.allEvents(session.id).filter(row => row.kind === 'turn.completed').length < terminalCount) {
    assert.ok(Date.now() < deadline, 'Captured native terminal was not committed');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const events = ctx.store.allEvents(session.id);
  const results = expected.map(value => {
    const event = events.find(row => {
      if (row.kind !== 'reasoning' || row.itemKey !== value.item.id || row.nativeEnvelopeId === undefined) return false;
      const envelope = ctx!.store.nativeEvents.get(row.nativeEnvelopeId);
      return envelope?.nativeTurnId === value.nativeTurnId;
    });
    assert.ok(event, 'Native reasoning item/turn identity missing');
    const mapping = ctx!.store.nativeEvents.get(event.nativeEnvelopeId!);
    assert.ok(mapping && mapping.source === 'mapping');
    assert.ok(mapping.rawEnvelopeId !== null, 'Original RPC link missing');
    const raw = ctx!.store.nativeEvents.get(mapping.rawEnvelopeId);
    assert.ok(raw && raw.source === 'transport');
    assert.equal(raw.nativeTurnId, value.nativeTurnId);
    assert.deepEqual((raw.payload as { params: { item: Reasoning } }).params.item, value.item);
    assert.deepEqual(event.native, value.item);
    const data = event.data as EventData['reasoning'];
    assert.equal(data.text, value.item.summary.join('\n'));
    assert.deepEqual(data.nativeContent, value.item.content.map((text, index) => ({ index, text })));
    const nativeEnd = frames.find(row => row.payload['method'] === 'turn/completed'
      && (row.payload['params'] as { turn: { id: string } }).turn.id === value.nativeTurnId);
    assert.ok(nativeEnd, 'Native terminal missing');
    const end = events.find(row => row.turnId === event.turnId && row.kind === 'turn.completed');
    assert.equal((end?.data as EventData['turn.completed'])?.status, (nativeEnd.payload['params'] as { turn: { status: string } }).turn.status);
    return { itemKey: event.itemKey, nativeTurnId: value.nativeTurnId, publicTurnId: event.turnId,
      mappingEnvelopeId: mapping.id, rawEnvelopeId: raw.id, data, native: event.native };
  });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(base + '/s/' + session.id);
  const verify = async () => {
    await page.locator('.turn-title').first().click();
    const thinking = page.getByRole('button', { name: '思考', exact: true });
    await thinking.first().waitFor();
    for (const button of await thinking.all()) await button.click();
    const contents = page.getByTestId('native-reasoning-content');
    for (const summary of await contents.locator('summary').all()) await summary.click();
    const shown = await page.getByTestId('native-reasoning-part').evaluateAll(elements => elements.map(element => ({
      itemKey: element.getAttribute('data-native-item-key'),
      index: Number(element.getAttribute('data-native-index')), text: element.getAttribute('data-raw-text'),
    })));
    for (const value of expected) {
      assert.deepEqual(shown.filter(row => row.itemKey === value.item.id).map(row => ({ index: row.index, text: row.text })),
        value.item.content.map((text, index) => ({ index, text })));
      for (const summary of value.item.summary) assert.ok((await page.locator('.turn').textContent())?.includes(summary));
    }
  };
  await verify();
  await page.reload();
  await verify();
  assert.deepEqual(errors, []);
  const fingerprint = sourceFingerprint();
  assert.equal(fingerprint, evidence['sourceFingerprint'], 'Source changed during replay');
  Object.assign(evidence, { passed: true, results, refreshPreserved: true, browserErrors: errors, finalSourceFingerprint: fingerprint });
} catch (error) {
  evidence['error'] = String(error);
  process.exitCode = 1;
} finally {
  for (const close of [() => browser?.close(), () => ctx?.close()]) {
    try { await close(); } catch (error) { evidence['cleanupError'] = String(error); evidence['passed'] = false; process.exitCode = 1; }
  }
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], report }) + '\n');
}
