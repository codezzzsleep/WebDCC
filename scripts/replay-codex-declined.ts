/** Replay an existing real native capture through the production handler.
 * The trace/model/native inputs are never executed or resubmitted. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AdapterEvent, EventData, StoredEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { reduceTurn } from '../packages/protocol/src/turn.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { sourceFingerprint } from './lib/gate-report.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}
const traceOption = option('--trace'); const reportOption = option('--report');
if (!traceOption || !reportOption) throw new Error('Provide --trace and a private --report path.');
const tracePath = resolve(traceOption); const reportPath = resolve(reportOption);
const raw = await readFile(tracePath, 'utf8');
const traceSha256 = createHash('sha256').update(raw).digest('hex');
const report: Record<string, unknown> = { scope: 'captured-native-declined-command-and-legacy-projection', tracePath, traceSha256,
  sourceFingerprint: sourceFingerprint(), newNativeRequests: 0, newModelRequests: 0, passed: false, startedAt: new Date().toISOString() };
try {
  const expected = option('--sha256'); if (expected) assert.equal(traceSha256, expected, 'Original real capture changed');
  const rows = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
    source: string; context?: { nativeId?: string }; value: TraceFrame;
  });
  const native = rows.filter(row => row.source === 'native');
  const nativeId = native.find(row => typeof row.context?.nativeId === 'string')?.context?.nativeId;
  assert.ok(nativeId, 'NOT_TRIGGERED: native thread identity missing');
  const replay = CodexAdapter.replay('capture-replay', nativeId);
  const events = native.flatMap(row => replay.feed(row.value));
  const declined = events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete'
    && event.kind === 'command' && (event.native as { type?: string; status?: string } | undefined)?.type === 'commandExecution'
    && (event.native as { status?: string }).status === 'declined');
  Object.assign(report, { nativeFrameCount: native.length, declinedCommands: declined });
  assert.ok(declined.length > 0, 'NOT_TRIGGERED: capture has no declined native command');
  for (const event of declined) {
    const item = event.native as { id: string; status: string };
    const original = native.find(row => {
      const frame = row.value.frame as { method?: string; params?: { item?: { id?: string }; turnId?: string } };
      return frame.method === 'item/completed' && frame.params?.item?.id === item.id && frame.params.turnId === event.nativeTurnId;
    });
    assert.ok(original, 'Native command identity changed');
    assert.equal(item.id, event.itemKey);
    const data = event.data as EventData['command'];
    assert.equal(data.status, 'failed', 'Declined native command was presented as successful');
    const legacy: StoredEvent = { sessionId: 'capture-replay', seq: 1, turnId: 'legacy-turn', itemKey: event.itemKey, kind: 'command',
      data: { ...data, status: 'completed' }, native: item, at: new Date(0).toISOString() };
    assert.equal(reduceTurn([legacy]).summary.commands, 0, 'Legacy declined command counted as executed');
  }
  report['nativeIdentityPreserved'] = true; report['legacyProjectionCorrected'] = true; report['passed'] = true;
} catch (error) {
  report['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  report['endedAt'] = new Date().toISOString(); report['finalSourceFingerprint'] = sourceFingerprint();
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report['passed'], error: report['error'], nativeFrames: report['nativeFrameCount'], report: reportPath }) + '\n');
}
