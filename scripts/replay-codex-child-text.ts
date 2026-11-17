/** Replay original child text through the production handler, storage and UI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import { currentCodexSubagents, type AdapterEvent, type CreateOpts, type EventData, type TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { sourceFingerprint } from './lib/gate-report.js';

type Envelope = { id: number; source: string; direction: 'in' | 'out'; channel: string; receivedAt: string; payload: Record<string, unknown> };
type Params = { threadId?: string; turnId?: string; itemId?: string; delta?: string;
  item?: { type: string; id: string; text?: string; phase?: string | null; tool?: string; status?: string }; turn?: { id: string; status: string } };
const params = (row: Envelope): Params => (row.payload['params'] ?? {}) as Params;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const options = parseArgs({ options: { capture: { type: 'string' }, report: { type: 'string' } } }).values;
assert.ok(options.capture && options.report, 'Provide an existing --capture and a new private --report.');
const capture = resolve(options.capture); const report = resolve(options.report);
const bytes = await readFile(capture);
const original = JSON.parse(bytes.toString()) as { kind: string; runId: string; passed: boolean; phase: string; requests: number;
  nativeId: string; nativeVersion: string; binarySha256: string; nativeFrames: Envelope[] };
const evidence: Record<string, unknown> = { runId: randomUUID(), kind: 'original-official-child-text-controlled-model-replay', passed: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  capture, captureSha256: hash(bytes), originalRunId: original.runId, originalCapturePassed: original.passed,
  originalPhase: original.phase, originalLocalModelRequests: original.requests, nativeVersion: original.nativeVersion,
  binarySha256: original.binarySha256, compatibilitySchemaSha256: hash(await readFile('packages/adapters/codex/src/json-schema/compatibility-0.169.0.schemas.json')),
  newNativeRequests: 0, newModelRequests: 0, newPaidRequests: 0,
  runtimeSetup: 'Controlled replay binding; production handler, manager, SQLite, HTTP, WebSocket and Chromium. No official CLI/model invoked.' };
await mkdir(dirname(report), { recursive: true });
const output = await open(report, 'wx', 0o600);
const save = async () => {
  const data = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  let offset = 0;
  while (offset < data.length) {
    const result = await output.write(data, offset, data.length - offset, offset);
    assert.ok(result.bytesWritten > 0); offset += result.bytesWritten;
  }
  await output.truncate(data.length); await output.sync();
};
await save();
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let browser: Browser | undefined;
const cleanupErrors: string[] = [];
try {
  assert.equal(original.kind, 'actual-official-codex-with-controlled-local-model');
  assert.equal(original.nativeVersion, 'codex-cli 0.169.0');
  assert.equal(evidence['compatibilitySchemaSha256'], '96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995');
  const frames = original.nativeFrames.filter(row => row.source === 'transport' && row.channel === 'rpc');
  assert.ok(frames.length > 0 && new Set(frames.map(row => row.id)).size === frames.length);
  const childDeltas = frames.filter(row => row.direction === 'in' && row.payload['method'] === 'item/agentMessage/delta'
    && typeof params(row).threadId === 'string' && params(row).threadId !== original.nativeId);
  if (childDeltas.length === 0) evidence['notTriggered'] = 'Capture has no original child text delta';
  assert.ok(childDeltas.length > 0, 'NOT_TRIGGERED: original child text delta missing');
  const first = childDeltas[0]!; const firstParams = params(first);
  assert.ok(firstParams.threadId && firstParams.turnId && firstParams.itemId && typeof firstParams.delta === 'string');
  const prefixIndex = frames.indexOf(first);
  evidence['originalRpcReplayed'] = frames.length; evidence['originalChildDeltas'] = childDeltas.length;
  evidence['nativeWaitAcceptance'] = frames.some(row => row.payload['method'] === 'item/completed'
    && params(row).item?.type === 'collabAgentToolCall' && params(row).item?.tool === 'wait')
    ? 'Wait frame retained; full wait acceptance is outside this replay' : 'NOT_TRIGGERED in original capture';
  ctx = await createSourceTestApp();
  const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
  adapter.onEvent = value => { emit = value; }; const create = adapter.create.bind(adapter);
  adapter.create = async value => { opts = value; return { ...await create(value), nativeId: original.nativeId }; };
  adapter.send = async () => { throw new Error('Captured replay must not submit another native/model task'); };
  ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Original native child text replay', ctx.dataDir);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const replay = CodexAdapter.replay(session.id, original.nativeId); const start = Date.parse(frames[0]!.receivedAt);
  const rawByOriginal = new Map<number, number>();
  const feed = (row: Envelope) => {
    const frame: TraceFrame = { i: row.id, t: Date.parse(row.receivedAt) - start, dir: row.direction, ch: row.channel, frame: row.payload };
    const receipt = opts.nativeEvents!.record(frame);
    rawByOriginal.set(row.id, receipt.envelopeId);
    for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
  };
  for (const row of frames.slice(0, prefixIndex + 1)) feed(row);
  const prefixChild = currentCodexSubagents(ctx.store.allEvents(session.id)).find(child => child.childId === firstParams.threadId);
  assert.ok(prefixChild, 'Original native lineage missing');
  const prefix = prefixChild.results.find(result => result.nativeTurnId === firstParams.turnId && result.itemId === firstParams.itemId);
  const initial = frames.slice(0, prefixIndex).find(row => row.payload['method'] === 'item/started'
    && params(row).threadId === firstParams.threadId && params(row).turnId === firstParams.turnId && params(row).item?.id === firstParams.itemId);
  assert.ok(prefix?.incomplete); assert.equal(prefix.text, (initial === undefined ? '' : params(initial).item?.text ?? '') + firstParams.delta);
  evidence['prefix'] = { childId: prefixChild.childId, parentThreadId: prefixChild.parentThreadId, originalEnvelopeId: first.id, ...prefix };
  await save();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
  assert.ok(address && typeof address !== 'string'); const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(8000);
  const browserErrors: string[] = []; page.on('pageerror', error => browserErrors.push(error.message));
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  const showResult = async (activePage: Page, childId: string, nativeTurnId: string, itemId: string, text: string, incomplete: boolean) => {
    await activePage.getByTestId('codex-subagents-panel').waitFor();
    await activePage.waitForFunction(identity => [...document.querySelectorAll('[data-testid="codex-child-result"]')].some(element =>
      element.getAttribute('data-child-id') === identity.childId && element.getAttribute('data-native-turn-id') === identity.nativeTurnId
      && element.getAttribute('data-native-item-id') === identity.itemId && element.querySelector('pre')?.textContent === identity.text),
    { childId, nativeTurnId, itemId, text });
    const results = activePage.getByTestId('codex-child-result');
    for (const result of await results.all()) {
      if (await result.getAttribute('data-child-id') !== childId || await result.getAttribute('data-native-turn-id') !== nativeTurnId
        || await result.getAttribute('data-native-item-id') !== itemId) continue;
      const detail = result.locator('xpath=ancestor::details[1]');
      if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click();
      await result.locator('pre').waitFor(); assert.equal(await result.locator('pre').textContent(), text);
      assert.equal(await result.getByRole('status').count(), incomplete ? 1 : 0); return;
    }
    throw new Error('Original child/turn/item result not present in source UI');
  };
  await page.goto(base + '/s/' + session.id);
  await showResult(page, prefixChild.childId, firstParams.turnId, firstParams.itemId, prefix.text, true);
  await page.screenshot({ path: report + '.prefix.png', fullPage: true }); await page.reload();
  await showResult(page, prefixChild.childId, firstParams.turnId, firstParams.itemId, prefix.text, true);
  evidence['prefixRefreshPreserved'] = true;
  await page.screenshot({ path: report + '.prefix-refreshed.png', fullPage: true });
  for (const row of frames.slice(prefixIndex + 1)) feed(row);
  const parentEnd = frames.find(row => row.payload['method'] === 'turn/completed' && params(row).threadId === original.nativeId);
  assert.ok(parentEnd, 'Original parent terminal missing');
  const deadline = Date.now() + 5000;
  while (!ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')) {
    assert.ok(Date.now() < deadline, 'Original parent terminal not committed'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  const events = ctx.store.allEvents(session.id); const children = currentCodexSubagents(events);
  const deltaLinks = childDeltas.map(row => {
    const value = params(row);
    const event = events.find(event => event.kind === 'tool.call' && event.nativeEnvelopeId !== undefined
      && ctx!.store.nativeEvents.get(event.nativeEnvelopeId)?.rawEnvelopeId === rawByOriginal.get(row.id)
      && ((event.data as EventData['tool.call']).output as { resultDelta?: unknown } | undefined)?.resultDelta !== undefined);
    assert.ok(event?.nativeEnvelopeId, 'Original child delta projection missing');
    const mapping = ctx!.store.nativeEvents.get(event.nativeEnvelopeId); assert.ok(mapping?.source === 'mapping' && mapping.rawEnvelopeId !== null);
    const raw = ctx!.store.nativeEvents.get(mapping.rawEnvelopeId); assert.ok(raw?.source === 'transport'); assert.deepEqual(raw.payload, row.payload);
    const data = event.data as EventData['tool.call'];
    assert.deepEqual((data.output as { resultDelta: unknown }).resultDelta, { nativeTurnId: value.turnId, itemId: value.itemId, text: value.delta });
    return { originalEnvelopeId: row.id, mappingEnvelopeId: mapping.id, rawEnvelopeId: raw.id, childId: value.threadId, nativeTurnId: value.turnId, itemId: value.itemId };
  });
  const finals = frames.filter(row => row.direction === 'in' && row.payload['method'] === 'item/completed'
    && params(row).item?.type === 'agentMessage' && children.some(child => child.childId === params(row).threadId));
  assert.ok(finals.length > 0);
  for (const row of finals) {
    const value = params(row); const child = children.find(child => child.childId === value.threadId); assert.ok(child && value.turnId && value.item);
    const result = child.results.find(result => result.nativeTurnId === value.turnId && result.itemId === value.item!.id);
    assert.ok(result && !result.incomplete); assert.equal(result.text, value.item.text); assert.equal(result.nativePhase, value.item.phase);
  }
  assert.equal(events.filter(event => event.kind === 'turn.started').length, 1);
  assert.equal((events.find(event => event.kind === 'turn.completed')?.data as EventData['turn.completed']).status, params(parentEnd).turn?.status);
  assert.equal(events.filter(event => event.kind === 'assistant.message').length, 0);
  await page.reload();
  for (const row of finals) { const value = params(row); await showResult(page, value.threadId!, value.turnId!, value.item!.id, value.item!.text!, false); }
  await page.screenshot({ path: report + '.final-refreshed.png', fullPage: true }); assert.deepEqual(browserErrors, []);
  assert.equal(sourceFingerprint(), evidence['sourceFingerprint'], 'Source changed during replay');
  assert.equal(hash(await readFile(capture)), evidence['captureSha256'], 'Original capture changed');
  Object.assign(evidence, { passed: true, deltaLinks, children, finalItems: finals.map(row => ({ originalEnvelopeId: row.id, ...params(row) })),
    parentStatus: params(parentEnd).turn?.status, finalRefreshPreserved: true, browserErrors, finalSourceFingerprint: sourceFingerprint() });
} catch (error) { evidence['error'] = String(error); evidence['errorStack'] = error instanceof Error ? error.stack : undefined; process.exitCode = 1; }
finally {
  for (const close of [() => browser?.close(), () => ctx?.close()]) {
    try { await close(); } catch (error) { cleanupErrors.push(String(error)); evidence['passed'] = false; process.exitCode = 1; }
  }
  evidence['cleanupErrors'] = cleanupErrors; await save(); await output.close();
  process.stdout.write(JSON.stringify({ report, passed: evidence['passed'], error: evidence['error'], originalCapturePassed: evidence['originalCapturePassed'],
    originalRpcReplayed: evidence['originalRpcReplayed'], originalChildDeltas: evidence['originalChildDeltas'], newNativeRequests: 0, newModelRequests: 0, newPaidRequests: 0 }) + '\n');
}
