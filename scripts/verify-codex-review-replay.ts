/** Replay an existing official-native Review capture through the production
 * handler, manager, SQLite and browser without launching native/model work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { AdapterEvent, CreateOpts, EventData, StoredEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { sourceFingerprint } from './lib/gate-report.js';

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const captureOption = option('--capture'); const reportOption = option('--report');
if (!captureOption || !reportOption) throw new Error('Provide an existing --capture and a new private --report.');
const capture = resolve(captureOption); const report = resolve(reportOption); const bytes = await readFile(capture);
type Envelope = { id: number; source: string; direction: 'in' | 'out'; channel: string; receivedAt: string; payload: Record<string, unknown> };
const original = JSON.parse(bytes.toString()) as { kind: string; passed: boolean; nativeId: string; nativeVersion: string; nativeFrames: Envelope[] };
assert.equal(original.kind, 'official-native-review-with-controlled-local-model');
const frames = original.nativeFrames.filter(row => row.source === 'transport' && row.channel === 'rpc');
const expected = frames.flatMap(row => {
  const params = row.payload['params'] as { turnId?: string; item?: { id: string; type: string; review: string } } | undefined;
  return row.direction === 'in' && row.payload['method'] === 'item/completed' && params?.item?.type === 'exitedReviewMode'
    ? [{ root: params.turnId!, item: params.item }] : [];
});
assert.ok(expected.length > 0, 'NOT_TRIGGERED: capture has no native Review result');
const evidence: Record<string, unknown> = { kind: 'captured-official-native-controlled-model-replay', passed: false, capture,
  captureSha256: createHash('sha256').update(bytes).digest('hex'), originalCapturePassed: original.passed, nativeVersion: original.nativeVersion,
  nativeId: original.nativeId, sourceFingerprint: sourceFingerprint(), nativeFramesReplayed: frames.length, newNativeRequests: 0, newModelRequests: 0 };
await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let browser: Browser | undefined;
try {
  ctx = await createSourceTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
  adapter.onEvent = value => { emit = value; };
  const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return { ...await create(value), nativeId: original.nativeId }; };
  adapter.send = async () => { throw new Error('Replay cannot submit a new native input'); };
  ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Captured native Review', ctx.dataDir);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const replay = CodexAdapter.replay(session.id, original.nativeId); const startedAt = Date.parse(frames[0]!.receivedAt);
  for (const row of frames) {
    const frame: TraceFrame = { i: row.id, t: Date.parse(row.receivedAt) - startedAt, dir: row.direction, ch: row.channel, frame: row.payload };
    const receipt = opts.nativeEvents!.record(frame);
    for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
  }
  const deadline = Date.now() + 5000;
  while (ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length < expected.length) {
    assert.ok(Date.now() < deadline, 'Captured Review root completion missing'); await new Promise(resolve => setTimeout(resolve, 30));
  }
  const events = ctx.store.allEvents(session.id);
  const results = events.filter(event => (event.native as { type?: string } | null)?.type === 'exitedReviewMode');
  assert.equal(results.length, expected.length);
  for (const item of expected) {
    const result = results.find(event => event.itemKey === item.item.id); assert.ok(result);
    assert.deepEqual(result.native, item.item);
    const completed = frames.find(row => row.payload['method'] === 'turn/completed' && (row.payload['params'] as { turn: { id: string } }).turn.id === item.root);
    assert.ok(completed, 'Native root terminal missing');
    const status = (completed.payload['params'] as { turn: { status: string } }).turn.status;
    const end = events.find(event => event.turnId === result.turnId && event.kind === 'turn.completed');
    assert.equal((end?.data as EventData['turn.completed'])?.status, status);
  }
  assert.equal(new Set(results.map(result => result.turnId)).size, expected.length);
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
  assert.ok(address && typeof address !== 'string'); const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(base + '/s/' + session.id);
  const verify = async () => {
    for (const item of expected) {
      const deadline = Date.now() + 10_000; let shown: (string | null)[] = [];
      do {
        shown = await page.getByTestId('codex-review-result').evaluateAll((elements, key) => elements
          .filter(element => element.getAttribute('data-native-item-key') === key)
          .map(element => element.getAttribute('data-raw-text')), item.item.id);
        if (shown.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (Date.now() < deadline);
      assert.deepEqual(shown, [item.item.review], 'Original Review item identity/text missing in browser');
    }
  };
  await verify(); await page.reload(); await verify(); assert.deepEqual(errors, []);
  Object.assign(evidence, { passed: true, results: results.map((event: StoredEvent) => ({ turnId: event.turnId, itemKey: event.itemKey, native: event.native })),
    publicReviewCount: expected.length, exactOriginalResults: true, refreshPreserved: true, browserErrors: errors, finalSourceFingerprint: sourceFingerprint() });
} catch (error) { evidence['error'] = String(error); process.exitCode = 1; }
finally {
  for (const close of [() => browser?.close(), () => ctx?.close()]) { try { await close(); } catch (error) { evidence['cleanupError'] = String(error); evidence['passed'] = false; process.exitCode = 1; } }
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n'); process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], report }) + '\n');
}
