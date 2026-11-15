/**
 * Re-run production adapter handlers over captured official native frames.
 * This command makes zero model requests. Original evidence is never rewritten.
 * Run with: pnpm exec tsx scripts/replay-deployed-trajectories.mjs <report.json>
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.ts';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.ts';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.ts';

const path = process.argv[2];
assert(path, 'Supply one immutable captured real-run report');
const bytes = await readFile(path);
const report = JSON.parse(bytes.toString());
const root = dirname(path);
const traceBytes = await readFile(join(root, report.trace.file));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(traceBytes), report.trace.sha256, 'Recorded trace digest changed');
assert.equal(report.trace.summary.incomplete, false, 'Incomplete traces cannot establish replay acceptance');
assert.equal(report.live, true, 'Controlled traces cannot be mislabeled as real model captures');
assert(report.requests.length > 0 && report.requests.every(request => request.state === 'completed'));
const rows = traceBytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
const native = rows.filter(row => row.source === 'native').map(row => row.value);
const mapped = rows.filter(row => row.source === 'mapped').map(row => row.value);
assert(native.length > 0 && mapped.length > 0, 'Both independent official frames and mapped production events are required');
const handlers = { codex: CodexAdapter, 'claude-code': ClaudeAdapter, dsh: DshAdapter };
assert(handlers[report.agent], 'Unknown native Agent');
const replay = handlers[report.agent].replay(report.sessionId, report.nativeId);
const replayed = [];
for (const frame of native) {
  replayed.push(...replay.feed(frame));
  await Promise.resolve();
}
const kinds = new Set(['assistant.message','reasoning','command','file.read','file.change','tool.call','usage','error']);
const timingFields = new Set(['durationMs', 'generationMs']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !timingFields.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function projection(events) {
  const items = new Map();
  for (const event of events) {
    if (event.type === 'item.start' || event.type === 'item.complete') {
      items.set(event.itemKey, { kind: event.kind, data: JSON.parse(JSON.stringify(event.data)) });
    } else if (event.type === 'item.delta') {
      const item = items.get(event.itemKey);
      if (item) item.data[event.field] = String(item.data[event.field] ?? '') + event.append;
    } else if (event.type === 'item.update') {
      const item = items.get(event.itemKey);
      if (item) item.data = { ...item.data, ...event.data };
    }
  }
  return canonical([...items].filter(([, item]) => kinds.has(item.kind)));
}
const result = {
  formatVersion: 1, mode: 'offline replay of captured real official native behavior',
  sourceReportSha256: hash(bytes), traceSha256: hash(traceBytes), agent: report.agent,
  deployment: report.deployment, nativeVersions: report.nativeVersions, provider: report.provider,
  additionalModelRequests: 0, originalStatus: report.status, nativeFrames: native.length,
  originalProjection: projection(mapped), replayProjection: projection(replayed),
  identityNormalization: 'none; native tool/item/call IDs and event sequence are retained',
  excludedTimingFields: [...timingFields],
  scope: 'Production text/reasoning/tool/file/usage/error projection equality. Does not prove live Provider availability, timing, approval/answer delivery, UI reconnection or full NP-48 acceptance.',
  status: 'failed', verifiedAt: new Date().toISOString(),
};
try {
  const calls = new Map(), outcomes = new Map();
  for (const observation of native) {
    const frame = observation.frame;
    if (report.agent === 'dsh') {
      const event = frame?.value?.event;
      if (event?.type === 'tool/call') {
        let input = {}; try { input = JSON.parse(event.data.arguments); } catch { /* recorded invalid arguments stay invalid */ }
        calls.set(event.data.callId, { name: event.data.name, input });
      }
      if (event?.type === 'tool/result') {
        const message = event.data.message ?? {};
        outcomes.set(event.data.toolCallId ?? message.toolCallId, {
          failed: message.isError === true, output: (message.content ?? []).map(part => part.text ?? '').join(''),
          evidenceSha256: hash(JSON.stringify(event)),
        });
      }
    } else if (report.agent === 'claude-code') {
      for (const block of frame?.message?.content ?? []) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
        if (block.type === 'tool_result') outcomes.set(block.tool_use_id, {
          failed: block.is_error === true, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          evidenceSha256: hash(JSON.stringify(block)),
        });
      }
    }
  }
  result.nativeOutcomeCorrections = [];
  for (const [key, item] of result.originalProjection) {
    if (item.kind !== 'file.read' && item.kind !== 'file.change') continue;
    const id = key.startsWith('tool-') ? key.slice(5) : undefined;
    const outcome = outcomes.get(id); const call = calls.get(id);
    if (!outcome || !call) continue;
    const before = JSON.parse(JSON.stringify(item.data));
    if (item.kind === 'file.read') item.data = { ...item.data, status: outcome.failed ? 'failed' : 'completed', ...(outcome.failed ? { error: outcome.output } : {}) };
    else if (outcome.failed) item.data = { changes: [], status: 'failed', path: String(call.input.file_path ?? call.input.path ?? ''), error: outcome.output };
    if (JSON.stringify(before) !== JSON.stringify(item.data)) result.nativeOutcomeCorrections.push({ itemKey: key,
      nativeToolId: id, nativeOutcomeSha256: outcome.evidenceSha256, previousProjection: before, requiredNativeProjection: item.data,
      issue: outcome.failed ? item.kind === 'file.change' ? 138 : 140 : 'explicit successful read status',
    });
  }
  result.originalProjection = canonical(result.originalProjection);
  const actualUsage = result.replayProjection.filter(([, item]) => item.kind === 'usage');
  const originalUsage = result.originalProjection.filter(([, item]) => item.kind === 'usage');
  assert.equal(actualUsage.length, originalUsage.length, 'Usage event cardinality changed');
  const identities = [];
  for (let index = 0; index < actualUsage.length; index++) {
    const [actualKey, actualValue] = actualUsage[index];
    const [originalKey, originalValue] = originalUsage[index];
    assert.deepEqual(actualValue, originalValue, 'Native usage content/order changed');
    if (actualKey !== originalKey) {
      assert(/^usage-\d+$/.test(actualKey) && /^usage-\d+$/.test(originalKey), 'Only generated usage-counter IDs may be mapped');
      actualUsage[index][0] = originalKey;
      identities.push({ kind: 'local-usage-counter', observedReplayId: actualKey, capturedId: originalKey,
        position: index, contentSha256: hash(JSON.stringify(actualValue)),
        reason: 'Live metadata discovery increments the local usage frame counter; replay has no native model discovery process' });
    }
  }
  result.identityNormalization = identities;
  assert.deepEqual(result.replayProjection, result.originalProjection, 'Captured native frames and current production handler projections differ');
  result.status = 'passed';
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
await writeFile(join(root, 'replay-native-outcomes.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
assert.deepEqual(await readFile(path), bytes, 'Original real-run report was modified');
process.stdout.write(JSON.stringify({ agent: report.agent, status: result.status, additionalModelRequests: 0,
  nativeFrames: native.length, report: join(root, 'replay-native-outcomes.json'), error: result.error?.slice(0, 500) }) + '\n');
